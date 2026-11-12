"""Register drift-host with a Chromium browser: a launcher, a host manifest, and (Windows) a registry key.

https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging#native-messaging-host-location
"""

import contextlib
import json
import re
import stat
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Literal

HOST_NAME = "io.github.alex_fix.drift"
BROWSERS = ("chrome", "chromium", "edge", "brave", "vivaldi")
type Browser = Literal["chrome", "chromium", "edge", "brave", "vivaldi"]
type System = Literal["darwin", "linux", "win32"]

_EXTENSION_ID = re.compile(r"[a-p]{32}")

# Per-user manifest directories, relative to the home directory.
_MAC = Path("Library/Application Support")
_MANIFEST_DIRS: dict[System, dict[Browser, Path]] = {
    "darwin": {
        "chrome": _MAC / "Google/Chrome/NativeMessagingHosts",
        "chromium": _MAC / "Chromium/NativeMessagingHosts",
        "edge": _MAC / "Microsoft Edge/NativeMessagingHosts",
        "brave": _MAC / "BraveSoftware/Brave-Browser/NativeMessagingHosts",
        "vivaldi": _MAC / "Vivaldi/NativeMessagingHosts",
    },
    "linux": {
        "chrome": Path(".config/google-chrome/NativeMessagingHosts"),
        "chromium": Path(".config/chromium/NativeMessagingHosts"),
        "edge": Path(".config/microsoft-edge/NativeMessagingHosts"),
        "brave": Path(".config/BraveSoftware/Brave-Browser/NativeMessagingHosts"),
        "vivaldi": Path(".config/vivaldi/NativeMessagingHosts"),
    },
}

# Windows: HKCU\<key>\<HOST_NAME> → default value = manifest path. Vivaldi reads Chrome's key.
_REGISTRY_KEYS: dict[Browser, str] = {
    "chrome": r"Software\Google\Chrome\NativeMessagingHosts",
    "chromium": r"Software\Chromium\NativeMessagingHosts",
    "edge": r"Software\Microsoft\Edge\NativeMessagingHosts",
    "brave": r"Software\BraveSoftware\Brave-Browser\NativeMessagingHosts",
    "vivaldi": r"Software\Google\Chrome\NativeMessagingHosts",
}


@dataclass(frozen=True)
class Plan:
    launcher: Path
    launcher_text: str
    manifest: Path
    manifest_text: str
    registry_key: str | None


def plan(browser: Browser, extension_id: str, *, system: System, home: Path, data_dir: Path, python: str) -> Plan:
    """What install() writes, without touching anything (tested per OS)."""
    if not _EXTENSION_ID.fullmatch(extension_id):
        raise ValueError("extension id: 32 letters a-p, as shown on chrome://extensions")
    if system == "win32":
        launcher = data_dir / "drift-host.bat"
        launcher_text = f'@echo off\r\n"{python}" -m drift_host %*\r\n'
        manifest = data_dir / f"{HOST_NAME}.{browser}.json"
        registry_key: str | None = rf"{_REGISTRY_KEYS[browser]}\{HOST_NAME}"
    else:
        launcher = data_dir / "drift-host"
        launcher_text = f'#!/bin/sh\nexec "{python}" -m drift_host "$@"\n'
        manifest = home / _MANIFEST_DIRS[system][browser] / f"{HOST_NAME}.json"
        registry_key = None
    manifest_text = json.dumps(
        {
            "name": HOST_NAME,
            "description": "drift: stream browser video to AirPlay receivers",
            "path": str(launcher),
            "type": "stdio",
            "allowed_origins": [f"chrome-extension://{extension_id}/"],
        },
        indent=2,
    )
    return Plan(launcher, launcher_text, manifest, manifest_text + "\n", registry_key)


def current_system() -> System:
    if sys.platform in ("darwin", "linux", "win32"):
        return sys.platform  # type: ignore[return-value]  # narrowed by the check above
    raise RuntimeError("unsupported platform")


def install(p: Plan) -> None:
    p.launcher.parent.mkdir(parents=True, exist_ok=True)
    p.launcher.write_text(p.launcher_text, encoding="utf-8", newline="")
    if p.registry_key is None:
        p.launcher.chmod(p.launcher.stat().st_mode | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)
    p.manifest.parent.mkdir(parents=True, exist_ok=True)
    p.manifest.write_text(p.manifest_text, encoding="utf-8")
    if p.registry_key is not None and sys.platform == "win32":
        import winreg

        with winreg.CreateKey(winreg.HKEY_CURRENT_USER, p.registry_key) as key:
            winreg.SetValueEx(key, "", 0, winreg.REG_SZ, str(p.manifest))


def uninstall(p: Plan) -> None:
    p.manifest.unlink(missing_ok=True)
    if p.registry_key is not None and sys.platform == "win32":
        import winreg

        with contextlib.suppress(FileNotFoundError):
            winreg.DeleteKey(winreg.HKEY_CURRENT_USER, p.registry_key)
