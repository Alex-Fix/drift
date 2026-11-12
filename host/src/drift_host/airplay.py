"""AirPlay receivers. The only module that imports pyatv; the rest of the host sees the Receivers protocol."""

import asyncio
import math
from collections.abc import Iterator
from contextlib import contextmanager
from dataclasses import dataclass
from typing import TYPE_CHECKING, Literal, Protocol

from drift_host.protocol import ProtocolError

if TYPE_CHECKING:
    from pyatv.interface import AppleTV, BaseConfig


@dataclass(frozen=True)
class Device:
    id: str
    name: str
    model: str | None = None

    def to_message(self) -> dict[str, object]:
        message: dict[str, object] = {"id": self.id, "name": self.name}
        if self.model:
            message["model"] = self.model
        return message


type Action = Literal["pause", "resume", "seek"]


class Receivers(Protocol):
    async def scan(self, listen: float) -> list[Device]: ...

    async def play(self, device: str, url: str, position: float | None) -> None: ...

    async def control(self, device: str, action: Action, position: float | None) -> None: ...

    async def stop(self, device: str) -> None: ...

    async def close(self) -> None: ...


class PyatvReceivers:
    """Receivers over pyatv. Connections are kept per device for the life of the host process."""

    def __init__(self) -> None:
        self._configs: dict[str, BaseConfig] = {}
        self._connections: dict[str, AppleTV] = {}

    async def scan(self, listen: float) -> list[Device]:
        import pyatv
        from pyatv.const import Protocol as AtvProtocol

        # pyatv listens for whole seconds.
        configs = await pyatv.scan(asyncio.get_running_loop(), timeout=max(1, math.ceil(listen)))
        devices = []
        for config in configs:
            if config.identifier is None or config.get_service(AtvProtocol.AirPlay) is None:
                continue
            self._configs[config.identifier] = config
            devices.append(Device(id=config.identifier, name=config.name, model=config.device_info.model_str or None))
        return devices

    async def play(self, device: str, url: str, position: float | None) -> None:
        atv = await self._connect(device)
        with _receiver_errors():
            await atv.stream.play_url(url, **({"position": int(position)} if position else {}))

    async def control(self, device: str, action: Action, position: float | None) -> None:
        atv = await self._connect(device)
        with _receiver_errors():
            match action:
                case "pause":
                    await atv.remote_control.pause()
                case "resume":
                    await atv.remote_control.play()
                case "seek":
                    await atv.remote_control.set_position(int(position or 0))

    async def stop(self, device: str) -> None:
        atv = self._connections.pop(device, None)
        if atv is not None:
            try:
                with _receiver_errors():
                    await atv.remote_control.stop()
            finally:
                await asyncio.gather(*atv.close())

    async def close(self) -> None:
        connections = list(self._connections.values())
        self._connections.clear()
        for atv in connections:
            await asyncio.gather(*atv.close())

    async def _connect(self, device: str) -> AppleTV:
        if device in self._connections:
            return self._connections[device]
        config = self._configs.get(device)
        if config is None:
            raise ProtocolError("unknown_device")
        import pyatv

        # TODO(pairing): load stored AirPlay credentials into config (design doc → "Pairing").
        with _receiver_errors():
            atv = await pyatv.connect(config, asyncio.get_running_loop())
        self._connections[device] = atv
        return atv


@contextmanager
def _receiver_errors() -> Iterator[None]:
    """pyatv failures as protocol codes; anything else stays an internal error."""
    from pyatv import exceptions

    try:
        yield
    except (exceptions.AuthenticationError, exceptions.NoCredentialsError, exceptions.InvalidCredentialsError) as e:
        raise ProtocolError("pairing_required") from e
    except (exceptions.ConnectionFailedError, exceptions.ConnectionLostError, OSError, TimeoutError) as e:
        raise ProtocolError("device_unreachable") from e
