"""AirPlay 2 URL playback through the playback queue: the receiver fetches and plays the URL itself.

start(): session SETUP (not mirroring, NTP timing) → event channel → RECORD → SETUP of a type-130 stream (remote
control). Commands then go as POST /command on the control channel; the receiver acknowledges each with an empty
200, and sends answers (to commands carrying `kind: request` and a `messageID`) and notifications on the event
channel. Order and values are the ones the Play on TV spike verified on the Samsung (design doc 2026-11-14); the
recipe follows airkast's DefaultVideoSession (Apache-2.0).
"""

import asyncio
import contextlib
import itertools
import logging
import uuid
from collections.abc import Callable
from dataclasses import dataclass
from typing import Literal

from drift_host.mirror.session import DEVICE_ID, SENDER, Control, Reply

log = logging.getLogger(__name__)

CLIENT_TYPE = "A6B27562-B43A-4F2D-B75F-82391E250194"  # the URL-playback client type Apple senders use
MediaType = Literal["file", "streaming"]  # `file`: MP4/MOV; `streaming`: HLS
# "ended" comes from itemPlayedToEnd, "failed" from an error about the item (e.g. -12927 for an MP4 the Samsung can't
# open); the rest from playbackState.
State = Literal["loading", "playing", "paused", "ended", "failed"]


class PlaybackError(Exception):
    """The receiver refused, didn't answer, or ended the session."""


@dataclass(frozen=True)
class Timings:
    reply: float = 3.0
    teardown: float = 2.0  # the Samsung never answers the session TEARDOWN


@dataclass(frozen=True)
class PlaybackInfo:
    state: State | None
    rate: float
    position: float | None  # seconds
    duration: float | None  # seconds; None for live streams
    buffered: float | None  # seconds loaded ahead of the position


def cmtime(seconds: float) -> dict[str, object]:
    return {"value": round(seconds * 1000), "timescale": 1000, "flags": 1, "epoch": 0}


def seconds(value: object) -> float | None:
    """A CMTime in seconds; None when it isn't a valid, finite time (flags bit 0 unset, or indefinite)."""
    if not isinstance(value, dict):
        return None
    count, scale, flags = value.get("value"), value.get("timescale"), value.get("flags")
    if not all(isinstance(n, int) and not isinstance(n, bool) for n in (count, scale, flags)):
        return None
    assert isinstance(count, int) and isinstance(scale, int) and isinstance(flags, int)
    if scale <= 0 or flags & 0x1D != 1:  # valid, and not +/- infinity or indefinite
        return None
    return count / scale


def buffered_ahead(ranges: object, position: float | None) -> float | None:
    """How far the loaded time range holding `position` reaches past it."""
    if not isinstance(ranges, list) or position is None:
        return None
    for entry in ranges:
        if not isinstance(entry, dict):
            continue
        start, length = seconds(entry.get("start")), seconds(entry.get("duration"))
        if start is not None and length is not None and start <= position <= start + length:
            return start + length - position
    return 0.0


def _uuid() -> str:
    return str(uuid.uuid4()).upper()


class PlaybackSession:
    def __init__(
        self,
        control: Control,
        *,
        timings: Timings | None = None,
        on_state: Callable[[State], None] | None = None,
    ) -> None:
        self._control = control
        self._timings = timings or Timings()
        self._on_state = on_state
        self._command_session = _uuid()
        self._stream_id: int | None = None
        self._recording = False
        self._stopped = False
        self._ended = asyncio.Event()
        self._ids = itertools.count(1)
        self._pending: dict[int, asyncio.Future[dict[str, object]]] = {}
        self._item: str | None = None
        self._taken = asyncio.Event()
        self.state: State | None = None

    @property
    def ended(self) -> asyncio.Event:
        """Set when the session is over: stop() was called or the receiver closed the event channel."""
        return self._ended

    @property
    def taken(self) -> asyncio.Event:
        """Set once the receiver names the loaded item in a message: it accepted it."""
        return self._taken

    async def start(self) -> None:
        try:
            await self._start()
        except BaseException:
            await self.stop()
            raise

    async def _start(self) -> None:
        reply = await self._control.request(
            "SETUP",
            body={
                "deviceID": DEVICE_ID,
                "macAddress": DEVICE_ID,
                "sessionUUID": _uuid(),
                "timingProtocol": "NTP",
                "timingPort": self._control.timing_port,
                "isMultiSelectAirPlay": True,
                "groupContainsGroupLeader": False,
                "senderSupportsRelay": False,
                "statsCollectionEnabled": False,
                **SENDER,
            },
        )
        session = _expect(reply, "session SETUP")
        await self._control.open_events(_port(session, "eventPort"), self._on_message, self._on_events_closed)
        # Without RECORD a receiver plays but sends no events (airkast compatibility notes).
        _expect(await self._control.request("RECORD"), "RECORD")
        self._recording = True
        reply = await self._control.request(
            "SETUP",
            body={
                "streams": [
                    {
                        "type": 130,
                        "controlType": 1,
                        "clientTypeUUID": CLIENT_TYPE,
                        "channelID": f"{DEVICE_ID}-RCS-1",
                        "clientUUID": _uuid(),
                    }
                ]
            },
        )
        streams = _expect(reply, "playback stream SETUP").get("streams")
        stream = streams[0] if isinstance(streams, list) and streams and isinstance(streams[0], dict) else None
        stream_id = stream.get("streamID") if stream is not None else None
        if not isinstance(stream_id, int) or isinstance(stream_id, bool) or stream_id < 0:
            raise PlaybackError("playback stream SETUP reply has no stream id")
        self._stream_id = stream_id
        log.info("playback session started")

    async def load(self, url: str, media_type: MediaType, position: float = 0.0) -> None:
        """Queue `url` on the receiver and play it from `position` seconds."""
        item = _uuid()
        self._item = item
        self._taken.clear()
        await self._command(
            {
                "type": "insertPlayQueueItem",
                "item": {
                    "uuid": item,
                    "mediaType": media_type,
                    "Content-Location": url,
                    "Start-Position": cmtime(position),
                },
            }
        )
        await self._command(
            {"type": "setProperty", "property": "isInterestedInDateRange", "value": True, "item": {"uuid": item}}
        )
        await self._command({"type": "setProperty", "property": "actionAtItemEnd", "value": 1})
        await self._command({"type": "setRate", "rate": 1.0})

    async def pause(self) -> None:
        await self._command({"type": "setRate", "rate": 0.0})

    async def resume(self) -> None:
        await self._command({"type": "setRate", "rate": 1.0})

    async def seek(self, position: float) -> float | None:
        """Jump to `position` seconds; returns where the receiver landed, when it says."""
        if self._item is None:
            raise PlaybackError("nothing loaded")
        zero = cmtime(0)
        reply = await self._request(
            {
                "type": "seek",
                "time": cmtime(position),
                "toleranceBefore": zero,
                "toleranceAfter": zero,
                "item": {"uuid": self._item},
            }
        )
        return seconds(reply.get("position"))

    async def info(self) -> PlaybackInfo:
        info = (await self._request({"type": "playbackInfo"})).get("info")
        if not isinstance(info, dict):
            info = {}
        state = info.get("playbackState")
        rate = info.get("rate")
        position = seconds(info.get("position"))
        return PlaybackInfo(
            state=_state(state),
            rate=float(rate) if isinstance(rate, int | float) and not isinstance(rate, bool) else 0.0,
            position=position,
            duration=seconds(info.get("duration")),
            buffered=buffered_ahead(info.get("loadedTimeRanges"), position),
        )

    async def stop(self) -> None:
        """Stop playback and end the session; safe to call more than once and after a failed start()."""
        if self._stopped:
            return
        self._stopped = True
        if self._stream_id is not None and not self._ended.is_set():
            with contextlib.suppress(PlaybackError, TimeoutError, OSError):
                await asyncio.wait_for(self._command({"type": "stop"}), self._timings.teardown)
        self._ended.set()
        self._fail_pending()
        if self._recording:
            # Stream first, then session, as for mirroring: the Samsung ignores the session TEARDOWN.
            bodies: tuple[dict[str, object] | None, ...] = ({"streams": [{"type": 130}]}, None)
            for body in bodies:
                try:
                    await asyncio.wait_for(self._control.request("TEARDOWN", body=body), self._timings.teardown)
                except (TimeoutError, OSError):
                    log.info("receiver did not answer TEARDOWN; closing anyway")
                    break
        await self._control.close()
        log.info("playback session stopped")

    async def _command(self, payload: dict[str, object]) -> None:
        if self._stream_id is None or self._ended.is_set():
            raise PlaybackError("session is not running")
        try:
            code = await self._control.command(payload, session_id=self._command_session, stream_id=self._stream_id)
        except (TimeoutError, OSError) as e:
            raise PlaybackError(f"receiver did not take {payload['type']}") from e
        if not 200 <= code < 300:
            raise PlaybackError(f"receiver refused {payload['type']} ({code})")

    async def _request(self, payload: dict[str, object]) -> dict[str, object]:
        message_id = next(self._ids)
        answer = asyncio.get_running_loop().create_future()
        self._pending[message_id] = answer
        try:
            await self._command({**payload, "kind": "request", "messageID": message_id})
            return await asyncio.wait_for(answer, self._timings.reply)
        except TimeoutError as e:
            raise PlaybackError(f"no answer to {payload['type']}") from e
        finally:
            self._pending.pop(message_id, None)

    def _on_message(self, message: dict[str, object]) -> None:
        if message.get("kind") == "response":
            message_id = message.get("messageID")
            answer = self._pending.get(message_id) if isinstance(message_id, int) else None
            if answer is not None and not answer.done():
                answer.set_result(message)
            return
        if self._item is not None and self._item in (_item_uuid(message, "item"), _item_uuid(message, "itemCurrent")):
            self._taken.set()
        kind, name = message.get("type"), message.get("name")
        state = _state(name) if kind == "playbackState" else None
        if state is not None:
            self._set_state(state)
        elif kind == "notification" and name == "itemPlayedToEnd" and _item_uuid(message, "item") == self._item:
            self._set_state("ended")
        elif kind == "error" and self._item is not None and message.get("uuid") == self._item:
            error = message.get("error")
            code = error.get("code") if isinstance(error, dict) else None
            log.info("receiver can't play the item (%s)", code if isinstance(code, int) else "no code")
            self._set_state("failed")

    def _set_state(self, state: State) -> None:
        if state == self.state:
            return
        self.state = state
        log.info("playback %s", state)
        if self._on_state is not None:
            self._on_state(state)

    def _on_events_closed(self) -> None:
        if not self._stopped:
            log.info("receiver closed the event channel")
        self._ended.set()
        self._fail_pending()

    def _fail_pending(self) -> None:
        for answer in self._pending.values():
            if not answer.done():
                answer.set_exception(PlaybackError("session ended"))


def _state(name: object) -> State | None:
    """A `playbackState` name we know; receivers send others (e.g. while seeking) that change nothing here."""
    match name:
        case "loading" | "playing" | "paused":
            return name
        case _:
            return None


def _item_uuid(message: dict[str, object], key: str) -> str | None:
    item = message.get(key)
    value = item.get("uuid") if isinstance(item, dict) else None
    return value if isinstance(value, str) else None


def _expect(reply: Reply, what: str) -> dict[str, object]:
    if reply.code != 200:
        raise PlaybackError(f"receiver refused {what} ({reply.code})")
    return reply.body


def _port(body: dict[str, object], key: str) -> int:
    value = body.get(key)
    if not isinstance(value, int) or isinstance(value, bool) or not 0 < value < 65536:
        raise PlaybackError(f"receiver sent no valid {key}")
    return value
