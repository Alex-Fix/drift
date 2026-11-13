import io
import json
import struct
from collections.abc import Awaitable, Callable

from drift_host import __version__, messaging
from drift_host.airplay import Action, Device
from drift_host.app import Host, serve
from drift_host.mirror.session import Control
from drift_host.protocol import ProtocolError
from tests.fake_tv import FakeTV


class FakeReceivers:
    def __init__(self) -> None:
        self.calls: list[tuple[object, ...]] = []
        self.closed = False

    async def scan(self, listen: float) -> list[Device]:
        return [Device("AA:BB", "Living Room", "Apple TV 4K", mirror=True, paired=True)]

    async def play(self, device: str, url: str, position: float | None) -> None:
        if device != "AA:BB":
            raise ProtocolError("unknown_device")
        self.calls.append(("play", device, url, position))

    async def control(self, device: str, action: Action, position: float | None) -> None:
        self.calls.append(("control", device, action, position))

    async def stop(self, device: str) -> None:
        self.calls.append(("stop", device))

    tv: FakeTV | None = None
    pin = "4321"

    async def open_mirror(self, device: str) -> Control:
        if device != "AA:BB":
            raise ProtocolError("unknown_device")
        assert self.tv is not None
        return self.tv

    async def pair(self, device: str, read_pin: Callable[[], Awaitable[str]]) -> None:
        if device != "AA:BB":
            raise ProtocolError("unknown_device")
        if await read_pin() != self.pin:
            raise ProtocolError("pairing_failed")
        self.calls.append(("paired", device))

    async def close(self) -> None:
        self.closed = True


def frames(data: bytes) -> list[object]:
    out, stream = [], io.BytesIO(data)
    while (payload := messaging.read_frame(stream)) is not None:
        out.append(json.loads(payload))
    return out


async def ask(request: object, receivers: FakeReceivers | None = None) -> object:
    stdout = io.BytesIO()
    await Host(receivers or FakeReceivers(), messaging.Writer(stdout)).handle(json.dumps(request).encode())
    [response] = frames(stdout.getvalue())
    return response


async def test_hello_reports_the_host_version() -> None:
    assert await ask({"v": 1, "type": "hello", "id": "1"}) == {"v": 1, "type": "hello", "id": "1", "host": __version__}


async def test_scan_lists_receivers() -> None:
    response = await ask({"v": 1, "type": "scan", "id": "2"})
    assert response == {
        "v": 1,
        "type": "devices",
        "id": "2",
        "devices": [{"id": "AA:BB", "name": "Living Room", "model": "Apple TV 4K", "mirror": True, "paired": True}],
    }


async def test_play_reaches_the_receiver() -> None:
    receivers = FakeReceivers()
    request = {"v": 1, "type": "play", "id": "3", "device": "AA:BB", "url": "https://example.com/a.m3u8"}
    assert await ask(request, receivers) == {"v": 1, "type": "ok", "id": "3"}
    assert receivers.calls == [("play", "AA:BB", "https://example.com/a.m3u8", None)]


async def test_unknown_device_is_an_error_with_the_request_id() -> None:
    request = {"v": 1, "type": "play", "id": "3", "device": "nope", "url": "https://example.com/a.mp4"}
    assert await ask(request) == {"v": 1, "type": "error", "id": "3", "code": "unknown_device"}


async def test_file_url_never_reaches_the_receiver() -> None:
    receivers = FakeReceivers()
    request = {"v": 1, "type": "play", "id": "3", "device": "AA:BB", "url": "file:///etc/passwd"}
    assert await ask(request, receivers) == {"v": 1, "type": "error", "id": "3", "code": "unsupported_url"}
    assert receivers.calls == []


async def test_a_response_sent_to_the_host_is_refused() -> None:
    assert await ask({"v": 1, "type": "ok", "id": "9"}) == {"v": 1, "type": "error", "id": "9", "code": "unknown_type"}


async def test_serve_answers_until_the_pipe_closes_then_closes_receivers() -> None:
    receivers = FakeReceivers()
    stdin = io.BytesIO(messaging.encode({"v": 1, "type": "hello", "id": "1"}))
    stdout = io.BytesIO()
    await serve(receivers, stdin, stdout)
    assert [m["type"] for m in frames(stdout.getvalue())] == ["hello"]  # type: ignore[index]
    assert receivers.closed


async def test_serve_ends_the_session_on_an_oversized_frame() -> None:
    stdin = io.BytesIO(struct.pack("=I", messaging.MAX_INCOMING + 1))
    stdout = io.BytesIO()
    await serve(FakeReceivers(), stdin, stdout)
    assert frames(stdout.getvalue()) == [{"v": 1, "type": "error", "code": "message_too_large"}]
