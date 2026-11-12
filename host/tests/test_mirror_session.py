import asyncio
import contextlib
import struct
import sys
from collections.abc import Callable
from typing import Self

import pytest

from drift_host.mirror import packets
from drift_host.mirror.session import MirrorError, MirrorSession, Reply, Timings

FAST = Timings(heartbeat=0.02, feedback=0.03, teardown=0.1)


class FakeTV:
    """A receiver at the RTSP-message level plus a real TCP server for the mirroring data connection."""

    def __init__(
        self,
        *,
        refuse: str | None = None,
        skip_record: bool = False,
        answer_teardown: bool = False,
        lose_connection_on: str | None = None,
    ) -> None:
        self.refuse = refuse
        self.lose_connection_on = lose_connection_on
        self.skip_record = skip_record
        self.answer_teardown = answer_teardown
        self.log: list[str] = []
        self.requests: list[tuple[str, str | None, dict[str, object] | None]] = []
        self.received = bytearray()
        self.closed = False
        self.events_port: int | None = None
        self._server: asyncio.Server | None = None
        self._data_writer: asyncio.StreamWriter | None = None
        self.data_connected = asyncio.Event()
        self.data_eof = asyncio.Event()

    async def __aenter__(self) -> Self:
        self._server = await asyncio.start_server(self._accept, "127.0.0.1", 0)
        return self

    async def __aexit__(self, *_: object) -> None:
        # Never hang the suite on a failed test that left a connection open.
        if self._data_writer:
            self._data_writer.close()
        assert self._server
        self._server.close()
        if sys.version_info >= (3, 13):
            self._server.close_clients()
        with contextlib.suppress(TimeoutError):
            await asyncio.wait_for(self._server.wait_closed(), 1)

    async def _accept(self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
        self._data_writer = writer
        self.data_connected.set()
        while chunk := await reader.read(65536):
            self.received += chunk
        self.data_eof.set()

    def drop_data_connection(self) -> None:
        assert self._data_writer
        self._data_writer.close()

    # --- Control ---

    remote_ip = "127.0.0.1"
    timing_port = 49999

    async def request(self, method: str, uri: str | None = None, body: dict[str, object] | None = None) -> Reply:
        self.requests.append((method, uri, body))
        streams = body.get("streams") if body else None
        name = "stream SETUP" if streams else "session SETUP" if method == "SETUP" else method
        if uri:
            name += f" {uri}"
        self.log.append(name)
        if name == self.lose_connection_on:
            raise ConnectionError("receiver connection lost")
        if method == "RECORD":
            # The accept callback runs asynchronously, so give an already-open connection a moment to show up; a
            # connection drift only opens after RECORD returns would never appear here.
            with contextlib.suppress(TimeoutError):
                await asyncio.wait_for(self.data_connected.wait(), 0.5)
            self.log.insert(-1, "data connected" if self.data_connected.is_set() else "no data connection")
        if name == self.refuse:
            return Reply(403, {})
        if name == "session SETUP":
            return Reply(200, {"eventPort": 50001, "timingPort": 50002, "skipRecord": self.skip_record})
        if name == "stream SETUP":
            assert self._server
            port = self._server.sockets[0].getsockname()[1]
            return Reply(200, {"streams": [{"type": 110, "dataPort": port}]})
        if method == "TEARDOWN" and not self.answer_teardown:
            await asyncio.sleep(3600)  # the Samsung never answers TEARDOWN
        return Reply(200, {})

    async def open_events(self, port: int) -> None:
        self.events_port = port
        self.log.append("events opened")

    def stream_key(self, stream_connection_id: int) -> bytes:
        return stream_connection_id.to_bytes(32, "big")

    async def close(self) -> None:
        self.closed = True


def stream_setup(tv: FakeTV) -> dict[str, object]:
    body = next(b for m, _, b in tv.requests if b and "streams" in b)
    streams = body["streams"]
    assert isinstance(streams, list) and isinstance(streams[0], dict)
    stream: dict[str, object] = streams[0]
    return stream


async def eventually(predicate: Callable[[], bool]) -> None:
    for _ in range(200):  # up to ~2 s
        if predicate():
            return
        await asyncio.sleep(0.01)
    raise AssertionError("condition not reached")


async def test_start_follows_the_verified_handshake_order() -> None:
    async with FakeTV() as tv:
        session = MirrorSession(tv, timings=FAST)
        await session.start()
        assert tv.log[:5] == ["session SETUP", "events opened", "stream SETUP", "data connected", "RECORD"]
        assert tv.events_port == 50001
        await session.stop()


async def test_session_setup_asks_for_screen_mirroring_with_our_timing_port() -> None:
    async with FakeTV() as tv:
        session = MirrorSession(tv, timings=FAST)
        await session.start()
        _, _, body = tv.requests[0]
        assert body is not None
        assert body["isScreenMirroringSession"] is True
        assert body["timingProtocol"] == "NTP"
        assert body["timingPort"] == tv.timing_port
        await session.stop()


async def test_stream_setup_is_a_screen_stream_with_fresh_keys_and_the_derived_stream_key() -> None:
    async with FakeTV() as tv:
        session = MirrorSession(tv, latency_ms=120, timings=FAST)
        await session.start()
        stream = stream_setup(tv)
        assert stream["type"] == 110
        assert stream["latencyMs"] == 120
        assert isinstance(stream["shk"], bytes) and len(stream["shk"]) == 32
        assert isinstance(stream["shiv"], bytes) and len(stream["shiv"]) == 16
        stream_id = stream["streamConnectionID"]
        assert isinstance(stream_id, int) and 0 <= stream_id < 2**63
        assert session.stream_key == tv.stream_key(stream_id)
        await session.stop()


async def test_record_is_skipped_when_the_receiver_says_so() -> None:
    async with FakeTV(skip_record=True) as tv:
        session = MirrorSession(tv, timings=FAST)
        await session.start()
        assert "RECORD" not in tv.log
        await session.stop()


@pytest.mark.parametrize("step", ["session SETUP", "stream SETUP", "RECORD"])
async def test_a_refused_step_fails_start_and_releases_the_receiver(step: str) -> None:
    async with FakeTV(refuse=step) as tv:
        session = MirrorSession(tv, timings=FAST)
        with pytest.raises(MirrorError, match="refused"):
            await session.start()
        assert tv.closed
        assert "TEARDOWN" not in tv.log  # nothing was recording yet


async def test_heartbeats_flow_on_the_data_connection() -> None:
    async with FakeTV() as tv:
        session = MirrorSession(tv, timings=FAST)
        await session.start()
        await eventually(lambda: len(tv.received) >= 2 * packets.HEADER_SIZE)
        await session.stop()
        first = bytes(tv.received[: packets.HEADER_SIZE])
        size, kind, _, option = struct.unpack_from("<IBBH", first)
        assert (size, kind, option) == (0, packets.TYPE_HEARTBEAT, packets.OPTION_HEARTBEAT)


async def test_feedback_is_posted_while_mirroring() -> None:
    async with FakeTV() as tv:
        session = MirrorSession(tv, timings=FAST)
        await session.start()
        await eventually(lambda: tv.log.count("POST /feedback") >= 2)
        await session.stop()


async def test_stop_does_not_hang_on_an_unanswered_teardown_and_closes_everything() -> None:
    async with FakeTV() as tv:
        session = MirrorSession(tv, timings=FAST)
        await session.start()
        async with asyncio.timeout(1):
            await session.stop()
        assert "TEARDOWN" in tv.log
        assert tv.closed
        await asyncio.wait_for(tv.data_eof.wait(), 1)
        assert session.ended.is_set()


async def test_stop_is_idempotent() -> None:
    async with FakeTV(answer_teardown=True) as tv:
        session = MirrorSession(tv, timings=FAST)
        await session.start()
        await session.stop()
        await session.stop()
        assert tv.log.count("TEARDOWN") == 1


async def test_sent_packets_reach_the_receiver() -> None:
    async with FakeTV() as tv:
        session = MirrorSession(tv, timings=Timings(heartbeat=60, feedback=60, teardown=0.1))
        await session.start()
        await session.send(b"\x01" * 300)
        await eventually(lambda: len(tv.received) >= 300)
        await session.stop()
        assert bytes(tv.received[:300]) == b"\x01" * 300


async def test_receiver_closing_the_data_connection_ends_the_session() -> None:
    async with FakeTV() as tv:
        session = MirrorSession(tv, timings=FAST)
        await session.start()
        tv.drop_data_connection()
        await asyncio.wait_for(session.ended.wait(), 1)
        with pytest.raises(MirrorError):
            await session.send(b"frame")
        await session.stop()


async def test_send_before_start_is_refused() -> None:
    async with FakeTV() as tv:
        with pytest.raises(MirrorError):
            await MirrorSession(tv, timings=FAST).send(b"frame")
        with contextlib.suppress(RuntimeError), pytest.raises(RuntimeError):
            _ = MirrorSession(tv).stream_key


async def test_losing_the_control_connection_during_teardown_still_closes_everything() -> None:
    async with FakeTV(lose_connection_on="TEARDOWN") as tv:
        session = MirrorSession(tv, timings=FAST)
        await session.start()
        await session.stop()
        assert tv.closed
        await asyncio.wait_for(tv.data_eof.wait(), 1)


async def test_failing_feedback_does_not_end_the_session() -> None:
    async with FakeTV(lose_connection_on="POST /feedback") as tv:
        session = MirrorSession(tv, timings=FAST)
        await session.start()
        await eventually(lambda: tv.log.count("POST /feedback") >= 3)
        assert not session.ended.is_set()
        await session.stop()
