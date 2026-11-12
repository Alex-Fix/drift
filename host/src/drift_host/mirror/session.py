"""The lifecycle of one AirPlay 2 screen-mirroring session.

start(): session SETUP → event channel → screen-stream SETUP (type 110) → data connection → RECORD, then a heartbeat
on the data connection and POST /feedback on the control channel until stop(). The order and field values are the
ones the Phase 0 spike verified on the Samsung (design doc, spike log).

The control channel is RTSP over the pair-verified connection; it sits behind `Control` so the lifecycle can be
tested against a fake TV. `pyatv_control.PyatvControl` is the real one.
"""

import asyncio
import contextlib
import logging
import os
import secrets
import uuid
from dataclasses import dataclass
from typing import Protocol

from drift_host.mirror import packets

log = logging.getLogger(__name__)


@dataclass(frozen=True)
class Reply:
    code: int
    body: dict[str, object]


class Control(Protocol):
    """RTSP control channel to one receiver, already pair-verified and encrypted."""

    @property
    def remote_ip(self) -> str: ...

    @property
    def timing_port(self) -> int: ...

    async def request(self, method: str, uri: str | None = None, body: dict[str, object] | None = None) -> Reply: ...

    async def open_events(self, port: int) -> None:
        """Connect the encrypted event channel and answer the receiver's events (its keep-alive)."""
        ...

    def stream_key(self, stream_connection_id: int) -> bytes:
        """The 32-byte ChaCha20-Poly1305 key for a screen stream (HKDF over the pair-verify secret)."""
        ...

    async def close(self) -> None: ...


class MirrorError(Exception):
    """The receiver refused or ended the session."""


@dataclass(frozen=True)
class Timings:
    heartbeat: float = 1.0
    feedback: float = 2.0
    teardown: float = 2.0  # the Samsung never answers TEARDOWN; don't wait long for it


# Sender description the spike was verified with on the Samsung. Changing it needs a re-test on a receiver.
SENDER: dict[str, object] = {
    "name": "drift",
    "model": "MacBookPro18,1",
    "osName": "macOS",
    "osVersion": "15.0",
    "osBuildVersion": "24A335",
    "sourceVersion": "690.7.1",
}
DEVICE_ID = "AA:BB:CC:DD:EE:FF"  # locally administered; a stable per-install id can replace it later
TIMESTAMP_INFO = [{"name": name} for name in ("SubSu", "BePxT", "AfPxT", "BefEn", "EmEnc")]


class MirrorSession:
    def __init__(self, control: Control, *, latency_ms: int = 90, timings: Timings | None = None) -> None:
        self._control = control
        self._latency_ms = latency_ms
        self._timings = timings or Timings()
        self._writer: asyncio.StreamWriter | None = None
        self._stream_key: bytes | None = None
        self._recording = False
        self._stopped = False
        self._tasks: list[asyncio.Task[None]] = []
        self._ended = asyncio.Event()

    @property
    def stream_key(self) -> bytes:
        if self._stream_key is None:
            raise RuntimeError("session not started")
        return self._stream_key

    @property
    def ended(self) -> asyncio.Event:
        """Set when the session is over: stop() was called or the receiver closed the data connection."""
        return self._ended

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
                "sessionUUID": str(uuid.uuid4()).upper(),
                "isScreenMirroringSession": True,
                "updateSessionRequest": False,
                "combinedGetInfoWithControlSetup": True,
                "timingProtocol": "NTP",
                "timingPort": self._control.timing_port,
                **SENDER,
            },
        )
        session = _expect(reply, "session SETUP")
        event_port = _port(session, "eventPort")
        await self._control.open_events(event_port)

        stream_id = secrets.randbits(63)
        reply = await self._control.request(
            "SETUP",
            body={
                "streams": [
                    {
                        "type": 110,
                        "streamConnectionID": stream_id,
                        "latencyMs": self._latency_ms,
                        "timestampInfo": TIMESTAMP_INFO,
                        "shk": os.urandom(32),
                        "shiv": os.urandom(16),
                    }
                ]
            },
        )
        streams = _expect(reply, "stream SETUP").get("streams")
        if not isinstance(streams, list) or not streams or not isinstance(streams[0], dict):
            raise MirrorError("stream SETUP reply has no stream")
        data_port = _port(streams[0], "dataPort")
        self._stream_key = self._control.stream_key(stream_id)

        # The data connection must be open before RECORD (spike step 2).
        reader, self._writer = await asyncio.open_connection(self._control.remote_ip, data_port)
        if session.get("skipRecord") is not True:
            _expect(await self._control.request("RECORD"), "RECORD")
        self._recording = True
        self._tasks = [
            asyncio.create_task(self._watch(reader)),
            asyncio.create_task(self._heartbeat()),
            asyncio.create_task(self._feedback()),
        ]
        log.info("mirroring session started")

    async def send(self, packet: bytes) -> None:
        if self._writer is None or self._ended.is_set():
            raise MirrorError("session is not running")
        self._writer.write(packet)
        try:
            await self._writer.drain()
        except ConnectionError as e:
            self._ended.set()
            raise MirrorError("receiver closed the data connection") from e

    async def stop(self) -> None:
        """End the session; safe to call more than once and after a failed start()."""
        if self._stopped:
            return
        self._stopped = True
        self._ended.set()
        for task in self._tasks:
            task.cancel()
        await asyncio.gather(*self._tasks, return_exceptions=True)
        if self._recording:
            try:
                await asyncio.wait_for(self._control.request("TEARDOWN"), self._timings.teardown)
            except (TimeoutError, OSError):
                log.info("receiver did not answer TEARDOWN; closing anyway")
        if self._writer is not None:
            self._writer.close()
            with contextlib.suppress(OSError):
                await self._writer.wait_closed()
        await self._control.close()
        log.info("mirroring session stopped")

    async def _watch(self, reader: asyncio.StreamReader) -> None:
        with contextlib.suppress(OSError):
            while await reader.read(4096):
                pass
        if not self._stopped:
            log.info("receiver closed the data connection")
        self._ended.set()

    async def _heartbeat(self) -> None:
        while not self._ended.is_set():
            await asyncio.sleep(self._timings.heartbeat)
            if self._writer is not None and not self._writer.is_closing():
                self._writer.write(packets.heartbeat())

    async def _feedback(self) -> None:
        while not self._ended.is_set():
            await asyncio.sleep(self._timings.feedback)
            try:
                await self._control.request("POST", uri="/feedback")
            except OSError:
                log.debug("feedback failed", exc_info=True)


def _expect(reply: Reply, what: str) -> dict[str, object]:
    if reply.code != 200:
        raise MirrorError(f"receiver refused {what} ({reply.code})")
    return reply.body


def _port(body: dict[str, object], key: str) -> int:
    value = body.get(key)
    if not isinstance(value, int) or isinstance(value, bool) or not 0 < value < 65536:
        raise MirrorError(f"receiver sent no valid {key}")
    return value
