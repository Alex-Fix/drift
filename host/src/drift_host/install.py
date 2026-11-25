"""Register drift-host with Chromium browsers: a host manifest per browser, a launcher when run from source, and
(Windows) a registry key.

https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging#native-messaging-host-location

Two scopes. **user**: the current user's browser profiles (developers, and the per-user Windows installer).
**system**: every user on the machine, from the macOS and Linux installers (run as root). Where each browser looks was
checked against its source or binary (release design 2026-11-25, step 2): Chrome and Edge from their macOS binaries,
Chromium from chrome/common/chrome_paths.cc, Brave from brave-core app/brave_main_delegate.cc — on macOS and Linux
Brave reads Chrome's locations. Vivaldi is closed source; built as unbranded Chromium, it is given Chromium's
locations (best effort).

Run from source, the manifest points at a launcher that starts `python -m drift_host`; a packaged build (PyInstaller)
points it at its own executable.
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
type Browser = Literal["chrome", "chromium", "edge", "brave", "vivaldi"]
BROWSERS: tuple[Browser, ...] = ("chrome", "chromium", "edge", "brave", "vivaldi")
type System = Literal["darwin", "linux", "win32"]
type Scope = Literal["user", "system"]

# The Chrome Web Store id of the published extension: the default for `drift-host install`. Set after the first
# store upload (release design step 10); until then --extension-id is required.
STORE_EXTENSION_ID: str | None = None

_EXTENSION_ID = re.compile(r"[a-p]{32}")

# Per-user manifest directories, relative to the home directory.
_MAC = Path("Library/Application Support")
_USER_DIRS: dict[System, dict[Browser, Path]] = {
    "darwin": {
        "chrome": _MAC / "Google/Chrome/NativeMessagingHosts",
        "chromium": _MAC / "Chromium/NativeMessagingHosts",
        "edge": _MAC / "Microsoft Edge/NativeMessagingHosts",
        "brave": _MAC / "Google/Chrome/NativeMessagingHosts",  # Brave reads Chrome's (brave_main_delegate.cc)
        "vivaldi": _MAC / "Vivaldi/NativeMessagingHosts",
    },
    "linux": {
        "chrome": Path(".config/google-chrome/NativeMessagingHosts"),
        "chromium": Path(".config/chromium/NativeMessagingHosts"),
        "edge": Path(".config/microsoft-edge/NativeMessagingHosts"),
        "brave": Path(".config/google-chrome/NativeMessagingHosts"),  # Brave reads Chrome's
        "vivaldi": Path(".config/vivaldi/NativeMessagingHosts"),
    },
}

# System-wide manifest directories (absolute; macOS and Linux only).
_SYSTEM_DIRS: dict[System, dict[Browser, Path]] = {
    "darwin": {
        "chrome": Path("/Library/Google/Chrome/NativeMessagingHosts"),
        "chromium": Path("/Library/Application Support/Chromium/NativeMessagingHosts"),
        "edge": Path("/Library/Microsoft/Edge/NativeMessagingHosts"),
        "brave": Path("/Library/Google/Chrome/NativeMessagingHosts"),
        "vivaldi": Path("/Library/Application Support/Chromium/NativeMessagingHosts"),
    },
    "linux": {
        "chrome": Path("/etc/opt/chrome/native-messaging-hosts"),
        "chromium": Path("/etc/chromium/native-messaging-hosts"),
        "edge": Path("/etc/opt/edge/native-messaging-hosts"),
        "brave": Path("/etc/opt/chrome/native-messaging-hosts"),
        "vivaldi": Path("/etc/chromium/native-messaging-hosts"),
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
    launcher: Path | None  # None for a packaged build: the manifest names the executable itself
    launcher_text: str | None
    manifest: Path
    manifest_text: str
    registry_key: str | None


def plan(
    browser: Browser,
    extension_id: str,
    *,
    system: System,
    home: Path,
    data_dir: Path,
    python: str,
    executable: Path | None = None,
    scope: Scope = "user",
) -> Plan:
    """What install() writes, without touching anything (tested per OS). `executable`: a packaged drift-host."""
    if not _EXTENSION_ID.fullmatch(extension_id):
        raise ValueError("extension id: 32 letters a-p, as shown on chrome://extensions")
    if scope == "system" and system == "win32":
        raise ValueError("Windows installs per user (the installer needs no admin rights): use the user scope")
    launcher: Path | None = None
    launcher_text: str | None = None
    if executable is None:
        if system == "win32":
            launcher = data_dir / "drift-host.bat"
            launcher_text = f'@echo off\r\n"{python}" -m drift_host %*\r\n'
        else:
            launcher = data_dir / "drift-host"
            launcher_text = f'#!/bin/sh\nexec "{python}" -m drift_host "$@"\n'
    host_path = executable if executable is not None else launcher
    assert host_path is not None
    if system == "win32":
        manifest = data_dir / f"{HOST_NAME}.{browser}.json"
        registry_key: str | None = rf"{_REGISTRY_KEYS[browser]}\{HOST_NAME}"
    else:
        directory = _SYSTEM_DIRS[system][browser] if scope == "system" else home / _USER_DIRS[system][browser]
        manifest = directory / f"{HOST_NAME}.json"
        registry_key = None
    manifest_text = json.dumps(
        {
            "name": HOST_NAME,
            "description": "drift: stream browser video to AirPlay receivers",
            "path": str(host_path),
            "type": "stdio",
            "allowed_origins": [f"chrome-extension://{extension_id}/"],
        },
        indent=2,
    )
    return Plan(launcher, launcher_text, manifest, manifest_text + "\n", registry_key)


def plans(
    browsers: tuple[Browser, ...],
    extension_id: str,
    *,
    system: System,
    home: Path,
    data_dir: Path,
    python: str,
    executable: Path | None = None,
    scope: Scope = "user",
) -> list[Plan]:
    """One plan per distinct manifest: browsers that share a location (Brave reads Chrome's) share a manifest."""
    seen: set[tuple[Path, str | None]] = set()
    out = []
    for browser in browsers:
        p = plan(
            browser,
            extension_id,
            system=system,
            home=home,
            data_dir=data_dir,
            python=python,
            executable=executable,
            scope=scope,
        )
        if (p.manifest, p.registry_key) not in seen:
            seen.add((p.manifest, p.registry_key))
            out.append(p)
    return out


def browser_present(p: Plan) -> bool:
    """Whether the browser this plan is for has a profile here (its user-data directory exists). Per-user installs of
    "all" browsers skip the others, so drift doesn't leave folders for browsers that aren't installed; Windows uses
    registry keys and installs them all."""
    return p.registry_key is not None or p.manifest.parent.parent.is_dir()


def current_system() -> System:
    if sys.platform in ("darwin", "linux", "win32"):
        return sys.platform  # type: ignore[return-value]  # narrowed by the check above
    raise RuntimeError("unsupported platform")


def packaged_executable() -> Path | None:
    """This drift-host's executable when it's a packaged (PyInstaller) build, else None."""
    return Path(sys.executable).resolve() if getattr(sys, "frozen", False) else None


def install(p: Plan) -> None:
    if p.launcher is not None and p.launcher_text is not None:
        p.launcher.parent.mkdir(parents=True, exist_ok=True)
        p.launcher.write_text(p.launcher_text, encoding="utf-8", newline="")
        if p.registry_key is None:
            p.launcher.chmod(p.launcher.stat().st_mode | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)
    p.manifest.parent.mkdir(parents=True, exist_ok=True)
    p.manifest.write_text(p.manifest_text, encoding="utf-8")
    if p.registry_key is None:
        p.manifest.chmod(0o644)  # readable by every user's browser, writable only by its owner (root, system-wide)
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
