"""AirPlay receivers. The only module that imports pyatv; the rest of the host sees the Receivers protocol."""

import asyncio
from dataclasses import dataclass
from typing import Any, Literal, Protocol

from drift_host.protocol import ProtocolError


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
        self._configs: dict[str, Any] = {}
        self._connections: dict[str, Any] = {}

    async def scan(self, listen: float) -> list[Device]:
        import pyatv
        from pyatv.const import Protocol as AtvProtocol

        configs = await pyatv.scan(asyncio.get_running_loop(), timeout=listen)
        devices = []
        for config in configs:
            if config.get_service(AtvProtocol.AirPlay) is None:
                continue
            self._configs[config.identifier] = config
            model = config.device_info.model_str if config.device_info else None
            devices.append(Device(id=config.identifier, name=config.name, model=model))
        return devices

    async def play(self, device: str, url: str, position: float | None) -> None:
        atv = await self._connect(device)
        await atv.stream.play_url(url, **({"position": int(position)} if position else {}))

    async def control(self, device: str, action: Action, position: float | None) -> None:
        atv = await self._connect(device)
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
            await atv.remote_control.stop()
            atv.close()

    async def close(self) -> None:
        for atv in self._connections.values():
            atv.close()
        self._connections.clear()

    async def _connect(self, device: str) -> Any:
        if device in self._connections:
            return self._connections[device]
        config = self._configs.get(device)
        if config is None:
            raise ProtocolError("unknown_device")
        import pyatv

        # TODO(pairing): load stored AirPlay credentials into config (design doc → "Pairing").
        try:
            atv = await pyatv.connect(config, asyncio.get_running_loop())
        except OSError as e:
            raise ProtocolError("device_unreachable") from e
        self._connections[device] = atv
        return atv
