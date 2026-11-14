"""`Control` over pyatv: pair-verified RTSP, NTP timing server, encrypted event channel, playback-queue commands.

Uses pyatv internals (pyatv has no mirroring API), so pyatv is pinned to a minor version and
tests/test_pyatv_compat.py imports everything used here.
"""

from __future__ import annotations  # TYPE_CHECKING-only names in annotations (Python < 3.14)

import contextlib
import logging
import plistlib
from collections.abc import Callable, Iterator
from typing import TYPE_CHECKING, Self

from pyatv import exceptions
from pyatv.auth.hap_channel import setup_channel
from pyatv.const import Protocol as AtvProtocol
from pyatv.protocols.airplay.auth import extract_credentials, verify_connection
from pyatv.protocols.airplay.channels import EventChannel
from pyatv.protocols.airplay.player import timing_server
from pyatv.protocols.raop.protocols.airplayv2 import EVENTS_READ_INFO, EVENTS_SALT, EVENTS_WRITE_INFO
from pyatv.support.http import HttpConnection, HttpResponse, decode_bplist_from_body, http_connect
from pyatv.support.rtsp import RtspSession

from drift_host.mirror.session import Reply

if TYPE_CHECKING:
    from pyatv.auth.hap_pairing import PairVerifyProcedure
    from pyatv.interface import BaseConfig

log = logging.getLogger(__name__)


COMMAND_USER_AGENT = "AirPlay/870.14.1"  # what the playback-queue spike sent (design doc 2026-11-14)
MAX_EVENT_BODY = 256 * 1024  # a playbackInfo answer is about 1 KiB


def decode_event(body: bytes) -> dict[str, object] | None:
    """A message from the receiver's event channel: a binary plist, possibly wrapped like our commands
    (`{params: {data: <bplist>}}`). None for anything else."""
    if len(body) > MAX_EVENT_BODY or not body.startswith(b"bplist00"):
        return None
    try:
        message = plistlib.loads(body)
        params = message.get("params") if isinstance(message, dict) else None
        if isinstance(params, dict) and set(params) == {"data"} and isinstance(params["data"], bytes):
            message = plistlib.loads(params["data"])
    except (plistlib.InvalidFileException, ValueError, TypeError, OverflowError):
        return None
    return message if isinstance(message, dict) else None


class _EventChannel(EventChannel):
    """Answers the receiver's events with a bare 200 OK and hands decoded messages to `on_message`.

    pyatv's reply adds `Content-Length: 0` and `Audio-Latency: 0`, which reportedly makes receivers render audio as
    silence (airplay2-sender-cpp notes); the spike's audio test used this bare reply.
    """

    def __init__(
        self,
        output_key: bytes,
        input_key: bytes,
        on_message: Callable[[dict[str, object]], None] | None,
        on_close: Callable[[], None] | None,
    ) -> None:
        super().__init__(output_key, input_key)
        self._on_message = on_message
        self._on_close = on_close

    def handle_received(self) -> None:
        while self.buffer:
            request, _, self.buffer = self.parse_request(self.buffer)
            if request is None:
                break
            headers = {k: request.headers[k] for k in ("Server", "CSeq") if k in request.headers}
            self.send(self.format_response(HttpResponse(request.protocol, request.version, 200, "OK", headers, b"")))
            if self._on_message is not None and isinstance(request.body, bytes):
                message = decode_event(request.body)
                if message is not None:
                    self._on_message(message)

    def connection_lost(self, exc: Exception | None) -> None:
        super().connection_lost(exc)
        if self._on_close is not None:
            self._on_close()


@contextlib.contextmanager
def _translated_errors() -> Iterator[None]:
    # pyatv's connection errors aren't OSErrors; the sessions handle ConnectionError (an OSError) and TimeoutError.
    try:
        yield
    except (exceptions.ConnectionLostError, exceptions.ConnectionFailedError) as e:
        raise ConnectionError("receiver connection lost") from e
    except exceptions.OperationTimeoutError as e:
        raise TimeoutError("receiver did not answer") from e


class PyatvControl:
    def __init__(
        self,
        connection: HttpConnection,
        rtsp: RtspSession,
        verifier: PairVerifyProcedure,
        timing_port: int,
        stack: contextlib.AsyncExitStack,
    ) -> None:
        self._connection = connection
        self._rtsp = rtsp
        self._verifier = verifier
        self._timing_port = timing_port
        self._stack = stack

    @classmethod
    async def connect(cls, config: BaseConfig) -> Self:
        service = config.get_service(AtvProtocol.AirPlay)
        if service is None:
            raise ValueError("receiver has no AirPlay service")
        connection = await http_connect(str(config.address), service.port)
        stack = contextlib.AsyncExitStack()
        stack.callback(connection.close)
        try:
            rtsp = RtspSession(connection)
            verifier = await verify_connection(extract_credentials(service), connection)
            timing = await stack.enter_async_context(timing_server(rtsp))
            return cls(connection, rtsp, verifier, timing.port, stack)
        except BaseException:
            await stack.aclose()
            raise

    @property
    def remote_ip(self) -> str:
        return self._connection.remote_ip

    @property
    def local_ip(self) -> str:
        return self._connection.local_ip

    @property
    def timing_port(self) -> int:
        return self._timing_port

    async def request(self, method: str, uri: str | None = None, body: dict[str, object] | None = None) -> Reply:
        with _translated_errors():
            response = await self._rtsp.exchange(method, uri=uri, body=body, allow_error=True)
        return Reply(response.code, decode_bplist_from_body(response) if response.body else {})

    async def command(self, payload: dict[str, object], *, session_id: str, stream_id: int) -> int:
        with _translated_errors():
            response = await self._rtsp.exchange(
                "POST",
                uri="/command",
                protocol="HTTP/1.1",
                allow_error=True,
                headers={
                    "User-Agent": COMMAND_USER_AGENT,
                    "X-Apple-ProtocolVersion": "1",
                    "X-Apple-Session-ID": session_id,
                    "X-Apple-StreamID": str(stream_id),
                },
                body={"params": {"data": plistlib.dumps(payload, fmt=plistlib.FMT_BINARY)}},
            )
        return response.code

    async def open_events(
        self,
        port: int,
        on_message: Callable[[dict[str, object]], None] | None = None,
        on_close: Callable[[], None] | None = None,
    ) -> None:
        transport, _ = await setup_channel(
            lambda output_key, input_key: _EventChannel(output_key, input_key, on_message, on_close),
            self._verifier,
            self.remote_ip,
            port,
            EVENTS_SALT,
            EVENTS_READ_INFO,
            EVENTS_WRITE_INFO,
        )
        self._stack.callback(transport.close)

    def stream_key(self, stream_connection_id: int) -> bytes:
        key, _ = self._verifier.encryption_keys(
            f"DataStream-Salt{stream_connection_id}",
            "DataStream-Output-Encryption-Key",
            "DataStream-Input-Encryption-Key",
        )
        return key

    async def close(self) -> None:
        await self._stack.aclose()
