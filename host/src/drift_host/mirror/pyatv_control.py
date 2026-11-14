"""`Control` over pyatv: pair-verified RTSP, NTP timing server, encrypted event channel.

Uses pyatv internals (pyatv has no mirroring API), so pyatv is pinned to a minor version and
tests/test_pyatv_compat.py imports everything used here.
"""

from __future__ import annotations  # TYPE_CHECKING-only names in annotations (Python < 3.14)

import contextlib
import logging
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


class _BareEventChannel(EventChannel):
    """Answers the receiver's events with a bare 200 OK.

    pyatv's reply adds `Content-Length: 0` and `Audio-Latency: 0`, which reportedly makes receivers render audio as
    silence (airplay2-sender-cpp notes); the spike's audio test used this bare reply.
    """

    def handle_received(self) -> None:
        while self.buffer:
            request, _, self.buffer = self.parse_request(self.buffer)
            if request is None:
                break
            headers = {k: request.headers[k] for k in ("Server", "CSeq") if k in request.headers}
            self.send(self.format_response(HttpResponse(request.protocol, request.version, 200, "OK", headers, b"")))


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
        # pyatv's connection errors aren't OSErrors; MirrorSession handles ConnectionError (an OSError).
        try:
            response = await self._rtsp.exchange(method, uri=uri, body=body, allow_error=True)
        except (exceptions.ConnectionLostError, exceptions.ConnectionFailedError) as e:
            raise ConnectionError("receiver connection lost") from e
        except exceptions.OperationTimeoutError as e:
            raise TimeoutError("receiver did not answer") from e
        return Reply(response.code, decode_bplist_from_body(response) if response.body else {})

    async def open_events(self, port: int) -> None:
        transport, _ = await setup_channel(
            _BareEventChannel, self._verifier, self.remote_ip, port, EVENTS_SALT, EVENTS_READ_INFO, EVENTS_WRITE_INFO
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
