"""The extension's stream messages: at most one URL-playback session, reported with `stream_status`.

The receiver fetches and plays the URL itself (`playback.PlaybackSession`). State changes from the receiver's
notifications are reported at once; position, duration and buffer are polled every POLL_INTERVAL. A stream that isn't
playing within START_TIMEOUT of the load has failed, and the extension falls back to mirroring.
"""

import asyncio
import contextlib
import logging
import secrets
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Literal

from drift_host import retry
from drift_host.airplay import Receivers
from drift_host.playback import MediaType, PlaybackError, PlaybackInfo, PlaybackSession, State
from drift_host.protocol import ProtocolError

log = logging.getLogger(__name__)

POLL_INTERVAL = 1.0
START_TIMEOUT = 8.0  # seconds from the load until the receiver must be playing
END_SLACK = 1.0  # a stream that stopped within this many seconds of its end has ended (if itemPlayedToEnd is missed)

type Action = Literal["pause", "resume", "seek"]


@dataclass
class _Active:
    id: str
    session: PlaybackSession
    state: State = "loading"
    info: PlaybackInfo | None = None
    playing: asyncio.Event = field(default_factory=asyncio.Event)
    stopping: bool = False
    tasks: list[asyncio.Task[None]] = field(default_factory=list)


class Streaming:
    def __init__(self, receivers: Receivers, emit: Callable[[dict[str, object]], None]) -> None:
        self._receivers = receivers
        self._emit = emit
        self._active: _Active | None = None

    async def start(self, device: str, url: str, media_type: MediaType, position: float | None) -> str:
        """Play `url` on `device` (replacing any current stream); returns the new session id."""
        if self._active is not None:
            await self._end(self._active, "stopped", reason=None)
        active = await retry.while_unreachable(lambda: self._connect(device))
        self._active = active
        try:
            await active.session.load(url, media_type, position or 0.0)
        except PlaybackError as e:
            log.info("receiver refused the stream: %s", e)
            await self._end(active, "failed", reason="stream_failed", report=False)
            raise ProtocolError("stream_failed") from e
        await asyncio.sleep(0)  # let an error the receiver sent while loading end the session first
        if active.stopping:
            raise ProtocolError("stream_failed")
        active.tasks.extend(
            [
                asyncio.create_task(self._poll(active)),
                asyncio.create_task(self._watch(active)),
                asyncio.create_task(self._deadline(active)),
            ]
        )
        self._status(active)
        return active.id

    async def _connect(self, device: str) -> _Active:
        control = await self._receivers.open_playback(device)
        active: _Active  # bound below; the receiver reports no state before load()
        session = PlaybackSession(control, on_state=lambda state: self._on_state(active, state))
        active = _Active(secrets.token_hex(16), session)
        try:
            await session.start()
        except OSError as e:
            raise ProtocolError("device_unreachable") from e
        except PlaybackError as e:
            log.info("receiver refused URL playback: %s", e)
            raise ProtocolError("stream_failed") from e
        return active

    async def control(self, session_id: str, action: Action, position: float | None) -> None:
        active = self._current(session_id)
        try:
            match action:
                case "pause":
                    await active.session.pause()
                case "resume":
                    await active.session.resume()
                case "seek":
                    await active.session.seek(position or 0.0)
        except PlaybackError as e:
            log.info("receiver refused %s: %s", action, e)
            raise ProtocolError("stream_failed") from e

    async def stop(self, session_id: str) -> None:
        await self._end(self._current(session_id), "stopped", reason=None)

    async def close(self) -> None:
        if self._active is not None:
            await self._end(self._active, "stopped", reason=None)

    def _current(self, session_id: str) -> _Active:
        if self._active is None or self._active.id != session_id or self._active.stopping:
            raise ProtocolError("session_unknown")
        return self._active

    def _on_state(self, active: _Active, state: State) -> None:
        if active.stopping:
            return
        if state == "failed":  # the receiver gave up on the URL: end now rather than at START_TIMEOUT
            active.tasks.append(asyncio.create_task(self._end(active, "failed", reason="stream_failed")))
            return
        if state == "playing":
            active.playing.set()
        if state != active.state:
            active.state = state
            self._status(active)

    async def _poll(self, active: _Active) -> None:
        while True:
            await asyncio.sleep(POLL_INTERVAL)
            try:
                info = await active.session.info()
            except PlaybackError:
                log.debug("no playback info", exc_info=True)  # the session ending is _watch's to report
                continue
            active.info = info
            if info.state is not None and active.state != "ended":
                if info.state == "playing":
                    active.playing.set()
                active.state = info.state
            if _at_end(info) and active.state != "playing":
                active.state = "ended"
            self._status(active)

    async def _watch(self, active: _Active) -> None:
        await active.session.ended.wait()
        if not active.stopping:
            log.info("receiver ended the stream session")
            await self._end(active, "stopped", reason="stream_failed")

    async def _deadline(self, active: _Active) -> None:
        try:
            await asyncio.wait_for(active.playing.wait(), START_TIMEOUT)
        except TimeoutError:
            log.info("stream not playing %.0f s after the load", START_TIMEOUT)
            await self._end(active, "failed", reason="stream_failed")

    async def _end(
        self,
        active: _Active,
        state: Literal["stopped", "failed"],
        *,
        reason: Literal["stream_failed"] | None,
        report: bool = True,
    ) -> None:
        if active.stopping:
            return
        active.stopping = True
        current = asyncio.current_task()
        others = [task for task in active.tasks if task is not current]
        for task in others:
            task.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await asyncio.gather(*others, return_exceptions=True)
        await active.session.stop()
        if self._active is active:
            self._active = None
        if report:
            self._emit(_event(active.id, state, active.info, reason))

    def _status(self, active: _Active) -> None:
        self._emit(_event(active.id, active.state, active.info, None))


def _at_end(info: PlaybackInfo) -> bool:
    return info.duration is not None and info.position is not None and info.position >= info.duration - END_SLACK


def _event(
    session: str,
    state: State | Literal["stopped", "failed"],
    info: PlaybackInfo | None,
    reason: str | None,
) -> dict[str, object]:
    event: dict[str, object] = {"type": "stream_status", "session": session, "state": state}
    if reason is not None:
        event["reason"] = reason
    if info is not None:
        for name in ("position", "duration", "buffered"):
            value = getattr(info, name)
            if value is not None and value >= 0:
                event[name] = round(value, 3)
    return event
