"""The extension's mirroring messages: at most one session, fed by `video`/`audio` notifications in arrival order.

Media is queued per session and sent by one task, so frames reach the receiver in the order the browser produced
them. When the receiver or network can't keep up the queue fills and frames are dropped; after a dropped video frame,
deltas are skipped until the next keyframe so the picture never decodes against a missing reference.
"""

import asyncio
import base64
import binascii
import contextlib
import itertools
import logging
import secrets
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Literal, cast

from drift_host.airplay import Receivers
from drift_host.mirror.audio import AudioStream
from drift_host.mirror.clock import ntp_after, ntp_now
from drift_host.mirror.packets import VideoConfig
from drift_host.mirror.session import MirrorError, MirrorSession
from drift_host.mirror.video import VideoStream
from drift_host.protocol import ProtocolError

log = logging.getLogger(__name__)

QUEUE_SIZE = 240  # ~2 s of video plus audio at 60 fps
# The Samsung refuses a new session for ~10-17 s after the previous one (it never answers the session TEARDOWN), so
# an unreachable receiver is retried for a while; the extension waits RETRY_FOR + margin for mirror_start.
RETRY_FOR = 30.0
RETRY_DELAYS = (2.0, 3.0, 4.0, 5.0)  # then 5 s each


@dataclass
class _Active:
    id: str
    session: MirrorSession
    queue: asyncio.Queue[dict[str, object]] = field(default_factory=lambda: asyncio.Queue(QUEUE_SIZE))
    video: VideoStream | None = None
    config: VideoConfig | None = None
    audio: AudioStream | None = None
    anchor: tuple[int, int] | None = None  # (first media ts in µs, its NTP time)
    need_keyframe: bool = False
    dropped: int = 0
    stopping: bool = False
    tasks: list[asyncio.Task[None]] = field(default_factory=list)

    def ntp(self, ts: int) -> int:
        if self.anchor is None:
            self.anchor = (ts, ntp_now())
        first, at = self.anchor
        return ntp_after(at, (ts - first) / 1_000_000)


class Mirroring:
    def __init__(self, receivers: Receivers, emit: Callable[[dict[str, object]], None]) -> None:
        self._receivers = receivers
        self._emit = emit
        self._active: _Active | None = None

    async def start(self, device: str, *, audio: bool) -> str:
        """Start mirroring to `device` (replacing any current session); returns the new session id."""
        if self._active is not None:
            await self._end(self._active, reason=None)
        session = await self._connect(device, audio=audio)
        active = _Active(secrets.token_hex(16), session)
        active.tasks = [asyncio.create_task(self._pump(active)), asyncio.create_task(self._watch(active))]
        self._active = active
        self._status(active, "mirroring")
        return active.id

    async def _connect(self, device: str, *, audio: bool) -> MirrorSession:
        """A started session; retries while the receiver is unreachable (e.g. still releasing the last session)."""
        loop = asyncio.get_running_loop()
        deadline = loop.time() + RETRY_FOR
        for attempt in itertools.count():
            try:
                control = await self._receivers.open_mirror(device)
                session = MirrorSession(control, audio=audio)
                try:
                    await session.start()
                except OSError as e:
                    raise ProtocolError("device_unreachable") from e
                return session
            except MirrorError as e:
                log.info("receiver refused mirroring: %s", e)
                raise ProtocolError("mirror_failed") from e
            except ProtocolError as e:
                delay = RETRY_DELAYS[min(attempt, len(RETRY_DELAYS) - 1)]
                if e.code != "device_unreachable" or loop.time() + delay > deadline:
                    raise
                log.info("receiver unreachable; retrying in %.0f s", delay)
                await asyncio.sleep(delay)
        raise AssertionError("unreachable")

    async def stop(self, session_id: str) -> None:
        active = self._current(session_id)
        await self._end(active, reason=None)

    def media(self, message: dict[str, object]) -> None:
        """A `video` or `audio` notification (already validated). Never blocks: drops when the queue is full."""
        active = self._current(cast(str, message["session"]))
        if message["type"] == "video":
            if active.need_keyframe and not message["key"]:
                active.dropped += 1
                return
            active.need_keyframe = False
        try:
            active.queue.put_nowait(message)
        except asyncio.QueueFull:
            active.dropped += 1
            if message["type"] == "video":
                active.need_keyframe = True

    async def close(self) -> None:
        if self._active is not None:
            await self._end(self._active, reason=None)

    def _current(self, session_id: str) -> _Active:
        if self._active is None or self._active.id != session_id or self._active.stopping:
            raise ProtocolError("session_unknown")
        return self._active

    async def _pump(self, active: _Active) -> None:
        while True:
            message = await active.queue.get()
            try:
                await self._send(active, message)
            except MirrorError:
                return  # the session ended; _watch reports it
            except (ValueError, binascii.Error):
                active.dropped += 1  # undecodable or out-of-order media; the stream recovers at the next keyframe
                if message["type"] == "video":
                    active.need_keyframe = True

    async def _send(self, active: _Active, message: dict[str, object]) -> None:
        data = base64.b64decode(cast(str, message["data"]), validate=True)
        timestamp = active.ntp(cast(int, message["ts"]))
        if message["type"] == "audio":
            if active.audio is None:
                active.audio = AudioStream(active.session, start=timestamp)
            active.audio.send(data)
            return
        config = message.get("config")
        if isinstance(config, dict):
            new = VideoConfig(
                cast(Literal["h264", "hevc"], config["codec"]),
                base64.b64decode(cast(str, config["record"]), validate=True),
                cast(int, config["width"]),
                cast(int, config["height"]),
            )
            if active.video is None:
                active.video = VideoStream(active.session, new)
            elif new != active.config:
                active.video.reconfigure(new)
            if new != active.config:
                active.config = new
                self._status(active, "mirroring")
        if active.video is None:
            raise ValueError("video before its decoder setup")
        await active.video.send(data, keyframe=cast(bool, message["key"]), timestamp=timestamp)

    async def _watch(self, active: _Active) -> None:
        await active.session.ended.wait()
        if not active.stopping:
            log.info("receiver ended the mirroring session")
            await self._end(active, reason="mirror_failed")

    async def _end(self, active: _Active, *, reason: Literal["mirror_failed"] | None) -> None:
        if active.stopping:
            return
        active.stopping = True
        current = asyncio.current_task()
        for task in active.tasks:
            if task is not current:
                task.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await asyncio.gather(*(t for t in active.tasks if t is not current), return_exceptions=True)
        if active.audio is not None:
            active.audio.flush()
        await active.session.stop()
        if self._active is active:
            self._active = None
        self._status(active, "stopped", reason=reason)

    def _status(self, active: _Active, state: str, *, reason: str | None = None) -> None:
        event: dict[str, object] = {"type": "mirror_status", "session": active.id, "state": state}
        if reason is not None:
            event["reason"] = reason
        if active.config is not None:
            event.update(codec=active.config.codec, width=active.config.width, height=active.config.height)
        event["dropped"] = active.dropped
        self._emit(event)
