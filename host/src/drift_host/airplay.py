"""AirPlay receivers. The only module that imports pyatv; the rest of the host sees the Receivers protocol."""

import asyncio
import math
import sys
from collections.abc import Awaitable, Callable, Iterator
from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path
from typing import TYPE_CHECKING, Literal, Protocol

from drift_host.protocol import ProtocolError

if TYPE_CHECKING:
    from pyatv.interface import AppleTV, BaseConfig, Storage


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
    """Receivers over pyatv. Connections are kept per device for the life of the host process.

    Pairing credentials live in pyatv's file storage at `credentials` (the user data dir, owner-only); scan and
    connect load them, so a paired receiver needs nothing else. Without a path they're kept in memory only.
    """

    def __init__(self, credentials: Path | None = None) -> None:
        self._credentials = credentials
        self._storage: Storage | None = None
        self._configs: dict[str, BaseConfig] = {}
        self._connections: dict[str, AppleTV] = {}

    async def scan(self, listen: float) -> list[Device]:
        import pyatv
        from pyatv.const import Protocol as AtvProtocol

        # pyatv listens for whole seconds.
        storage = await self._load_storage()
        configs = await pyatv.scan(asyncio.get_running_loop(), timeout=max(1, math.ceil(listen)), storage=storage)
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

        with _receiver_errors():
            atv = await pyatv.connect(config, asyncio.get_running_loop(), storage=await self._load_storage())
        self._connections[device] = atv
        return atv

    async def pair(self, device: str, read_pin: Callable[[], Awaitable[str]]) -> None:
        """Pair with a receiver found by the last scan; the receiver shows a PIN that `read_pin` returns."""
        import pyatv
        from pyatv.const import Protocol as AtvProtocol

        config = self._configs.get(device)
        if config is None:
            raise ProtocolError("unknown_device")
        storage = await self._load_storage()
        with _receiver_errors():
            handler = await pyatv.pair(config, AtvProtocol.AirPlay, asyncio.get_running_loop(), storage=storage)
        try:
            with _receiver_errors():
                await handler.begin()
            pin = (await read_pin()).strip()
            if not pin.isdecimal() or len(pin) > 8:
                raise ValueError("the PIN is the digits shown on the receiver")
            handler.pin(int(pin))
            with _receiver_errors():
                await handler.finish()
            if not handler.has_paired:
                raise ProtocolError("pairing_required")
            await storage.save()
            if self._credentials is not None and sys.platform != "win32":
                self._credentials.chmod(0o600)
        finally:
            await handler.close()

    async def _load_storage(self) -> Storage:
        if self._storage is not None:
            return self._storage
        from pyatv.storage.file_storage import FileStorage
        from pyatv.storage.memory_storage import MemoryStorage

        if self._credentials is None:
            self._storage = MemoryStorage()
        else:
            # Owner-only directory, so the file is private from the moment pyatv creates it (Windows: the per-user
            # data dir is already ACL'd to the user).
            self._credentials.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
            if sys.platform != "win32":
                self._credentials.parent.chmod(0o700)
            storage = FileStorage(str(self._credentials), asyncio.get_running_loop())
            await storage.load()
            self._storage = storage
        return self._storage


@contextmanager
def _receiver_errors() -> Iterator[None]:
    """pyatv failures as protocol codes; anything else stays an internal error."""
    from pyatv import exceptions

    try:
        yield
    except (
        exceptions.AuthenticationError,
        exceptions.NoCredentialsError,
        exceptions.InvalidCredentialsError,
        exceptions.PairingError,
    ) as e:
        raise ProtocolError("pairing_required") from e
    except (exceptions.ConnectionFailedError, exceptions.ConnectionLostError, OSError, TimeoutError) as e:
        raise ProtocolError("device_unreachable") from e
