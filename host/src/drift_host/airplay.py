"""AirPlay receivers. The only module that imports pyatv; the rest of the host sees the Receivers protocol."""

from __future__ import annotations  # TYPE_CHECKING-only names in annotations (Python < 3.14)

import asyncio
import math
import sys
from collections.abc import Awaitable, Callable, Iterator
from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path
from typing import TYPE_CHECKING, Protocol

from drift_host.protocol import ProtocolError

if TYPE_CHECKING:
    from pyatv.interface import BaseConfig, Storage

    from drift_host.mirror.pyatv_control import PyatvControl
    from drift_host.mirror.session import Control


@dataclass(frozen=True)
class Device:
    id: str
    name: str
    model: str | None = None
    mirror: bool = False  # can drift mirror to it (Screen + HomeKit pairing, no FairPlay)
    paired: bool = False  # drift has pairing credentials for it

    def to_message(self) -> dict[str, object]:
        message: dict[str, object] = {"id": self.id, "name": self.name, "mirror": self.mirror, "paired": self.paired}
        if self.model:
            message["model"] = self.model
        return message


class Receivers(Protocol):
    async def scan(self, listen: float) -> list[Device]: ...

    async def pair(self, device: str, read_pin: Callable[[], Awaitable[str]]) -> None: ...

    async def open_mirror(self, device: str) -> Control: ...

    async def open_playback(self, device: str) -> Control: ...

    async def close(self) -> None: ...


class PyatvReceivers:
    """Receivers over pyatv.

    Pairing credentials live in pyatv's file storage at `credentials` (the user data dir, owner-only); scan and
    connect load them, so a paired receiver needs nothing else. Without a path they're kept in memory only.
    """

    def __init__(self, credentials: Path | None = None) -> None:
        self._credentials = credentials
        self._storage: Storage | None = None
        self._configs: dict[str, BaseConfig] = {}

    async def scan(self, listen: float) -> list[Device]:
        import pyatv
        from pyatv.const import Protocol as AtvProtocol

        # pyatv listens for whole seconds.
        storage = await self._load_storage()
        configs = await pyatv.scan(asyncio.get_running_loop(), timeout=max(1, math.ceil(listen)), storage=storage)
        devices = []
        for config in configs:
            service = config.get_service(AtvProtocol.AirPlay)
            if config.identifier is None or service is None:
                continue
            self._configs[config.identifier] = config
            devices.append(
                Device(
                    id=config.identifier,
                    name=config.name,
                    model=config.device_info.model_str or None,
                    mirror=supports_mirroring(service.properties.get("features")),
                    paired=service.credentials is not None,  # loaded from storage by scan
                )
            )
        return devices

    async def close(self) -> None:
        """Nothing to release: sessions own their connections."""

    async def open_mirror(self, device: str) -> PyatvControl:
        """A pair-verified control channel for a mirroring session with a receiver found by the last scan."""
        config = self._configs.get(device)
        if config is None:
            raise ProtocolError("unknown_device")
        from pyatv.const import Protocol as AtvProtocol

        from drift_host.mirror.pyatv_control import PyatvControl

        service = config.get_service(AtvProtocol.AirPlay)
        if service is None or not supports_mirroring(service.properties.get("features")):
            raise ProtocolError("mirror_unsupported")

        with _receiver_errors():
            return await PyatvControl.connect(config)

    async def open_playback(self, device: str) -> PyatvControl:
        """A pair-verified control channel for URL playback with a receiver found by the last scan. No feature check:
        receivers that can't play URLs this way refuse the session, and the extension falls back to mirroring."""
        config = self._configs.get(device)
        if config is None:
            raise ProtocolError("unknown_device")
        from drift_host.mirror.pyatv_control import PyatvControl

        with _receiver_errors():
            return await PyatvControl.connect(config)

    async def pair(self, device: str, read_pin: Callable[[], Awaitable[str]]) -> None:
        """Pair with a receiver found by the last scan; the receiver shows a PIN that `read_pin` returns."""
        import pyatv
        from pyatv import exceptions
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
            try:
                await handler.finish()
            except exceptions.PairingError as e:  # most often a wrong PIN
                raise ProtocolError("pairing_failed") from e
            if not handler.has_paired:
                raise ProtocolError("pairing_failed")
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


_FEATURE_SCREEN = 1 << 7
_FEATURE_FAIRPLAY_AUTH = 1 << 14
_FEATURE_HOMEKIT_PAIRING = 1 << 46


def supports_mirroring(features: str | None) -> bool:
    """Whether the AirPlay `features` TXT value (`0xLOW,0xHIGH` or one number) advertises screen mirroring drift can
    do: Screen set, HomeKit pairing set, FairPlay authentication clear (drift doesn't implement FairPlay)."""
    if not features:
        return False
    try:
        parts = [int(part, 16) for part in features.split(",")]
    except ValueError:
        return False
    value = parts[0] | (parts[1] << 32 if len(parts) > 1 else 0)
    wanted = _FEATURE_SCREEN | _FEATURE_HOMEKIT_PAIRING
    return value & wanted == wanted and not value & _FEATURE_FAIRPLAY_AUTH


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
