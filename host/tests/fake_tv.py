"""A fake AirPlay receiver for mirroring tests (shared by the session, video and audio tests)."""

import asyncio
import contextlib
import functools
import sys
from collections.abc import Callable
from typing import Self

from drift_host.mirror.session import Reply, Timings

FAST = Timings(heartbeat=0.02, feedback=0.03, teardown=0.1)


class _Datagrams(asyncio.DatagramProtocol):
    def __init__(self, inbox: list[bytes]) -> None:
        self.inbox = inbox

    def datagram_received(self, data: bytes, addr: tuple[str | object, int]) -> None:
        self.inbox.append(data)


class FakeTV:
    """A receiver at the RTSP-message level, plus real sockets where media flows: a TCP server for the video data
    connection and UDP sockets for audio data and audio control."""

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
        self.audio_packets: list[bytes] = []
        self.audio_control_packets: list[bytes] = []
        self._udp: list[asyncio.DatagramTransport] = []
        self.sender_control_port: int | None = None

    async def __aenter__(self) -> Self:
        self._server = await asyncio.start_server(self._accept, "127.0.0.1", 0)
        loop = asyncio.get_running_loop()
        for inbox in (self.audio_packets, self.audio_control_packets):
            transport, _ = await loop.create_datagram_endpoint(
                functools.partial(_Datagrams, inbox), local_addr=("127.0.0.1", 0)
            )
            self._udp.append(transport)
        return self

    async def __aexit__(self, *_: object) -> None:
        # Never hang the suite on a failed test that left a connection open.
        for transport in self._udp:
            transport.close()
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

    def send_to_sender_control(self, packet: bytes) -> None:
        """Send a datagram to the sender's audio control socket (e.g. a retransmit request)."""
        assert self.sender_control_port is not None
        self._udp[1].sendto(packet, ("127.0.0.1", self.sender_control_port))

    def drop_data_connection(self) -> None:
        assert self._data_writer
        self._data_writer.close()

    # --- Control ---

    remote_ip = "127.0.0.1"
    local_ip = "127.0.0.1"
    timing_port = 49999

    async def request(self, method: str, uri: str | None = None, body: dict[str, object] | None = None) -> Reply:
        self.requests.append((method, uri, body))
        streams = body.get("streams") if body else None
        stream = streams[0] if isinstance(streams, list) and streams and isinstance(streams[0], dict) else None
        if stream is not None:
            name = "audio SETUP" if stream.get("type") == 96 else "stream SETUP"
        else:
            name = "session SETUP" if method == "SETUP" else method
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
        if name == "audio SETUP":
            assert stream is not None
            control_port = stream.get("controlPort")
            assert isinstance(control_port, int)
            self.sender_control_port = control_port
            data_port = self._udp[0].get_extra_info("sockname")[1]
            control_port = self._udp[1].get_extra_info("sockname")[1]
            return Reply(200, {"streams": [{"type": 96, "dataPort": data_port, "controlPort": control_port}]})
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


async def eventually(predicate: Callable[[], bool]) -> None:
    for _ in range(200):  # up to ~2 s
        if predicate():
            return
        await asyncio.sleep(0.01)
    raise AssertionError("condition not reached")
