"""Check an installed (or removed) drift-host against what install.py plans: every browser manifest (and Windows
registry key) present and pointing at the installed binary for exactly one extension, files root-owned and writable
only by root on macOS and Linux, and the installed binary passing the smoke test. After uninstalling: all gone.

Usage (from host/): uv run python packaging/verify_install.py installed|removed <path to drift-host> <extension id>
"""

import json
import os
import stat
import subprocess
import sys
from pathlib import Path

import platformdirs

from drift_host import __version__
from drift_host.install import BROWSERS, Plan, current_system, plans

HERE = Path(__file__).resolve().parent


def expected(binary: Path, extension_id: str) -> list[Plan]:
    system = current_system()
    return plans(
        BROWSERS,
        extension_id,
        system=system,
        home=Path.home(),
        data_dir=Path(platformdirs.user_data_dir("drift", appauthor=False)),
        python="unused",
        executable=binary,
        scope="user" if system == "win32" else "system",
    )


def registry_value(key: str) -> str | None:
    import winreg  # type: ignore[import-not-found,unused-ignore]

    try:
        with winreg.OpenKey(winreg.HKEY_CURRENT_USER, key) as handle:
            return str(winreg.QueryValueEx(handle, "")[0])
    except FileNotFoundError:
        return None


def root_owned_and_protected(path: Path) -> None:
    info = path.stat()
    assert info.st_uid == 0, f"{path} is owned by uid {info.st_uid}, not root"
    assert not info.st_mode & (stat.S_IWGRP | stat.S_IWOTH), f"{path} is writable by others: {oct(info.st_mode)}"


def check_installed(binary: Path, extension_id: str) -> None:
    assert binary.is_file(), f"{binary} missing"
    if os.name != "nt":
        root_owned_and_protected(binary)
        for parent in binary.parents:  # every directory down to the binary: nobody else can swap a file in
            if parent == Path(parent.anchor) or parent in (
                Path("/Library"),
                Path("/Library/Application Support"),
                Path("/opt"),
            ):
                break
            root_owned_and_protected(parent)
    stray = [path for path in binary.parent.rglob("._*")]
    assert not stray, f"AppleDouble files installed: {stray[:3]}"
    for p in expected(binary, extension_id):
        manifest = json.loads(p.manifest.read_text(encoding="utf-8"))
        assert manifest["path"] == str(binary), (p.manifest, manifest["path"])
        assert manifest["allowed_origins"] == [f"chrome-extension://{extension_id}/"], manifest
        if p.registry_key is not None:
            assert registry_value(p.registry_key) == str(p.manifest), p.registry_key
        else:
            root_owned_and_protected(p.manifest)
        print(f"ok  {p.manifest}" + (f"  ({p.registry_key})" if p.registry_key else ""))
    smoke = subprocess.run([sys.executable, str(HERE / "smoke.py"), str(binary), __version__], check=False)  # noqa: S603
    assert smoke.returncode == 0, "the installed drift-host failed its smoke test"


def check_removed(binary: Path, extension_id: str) -> None:
    assert not binary.exists(), f"{binary} still installed"
    for p in expected(binary, extension_id):
        assert not p.manifest.exists(), f"{p.manifest} left behind"
        if p.registry_key is not None:
            assert registry_value(p.registry_key) is None, f"{p.registry_key} left behind"
    print("ok  nothing left behind")


def main() -> int:
    state, binary, extension_id = sys.argv[1], Path(sys.argv[2]), sys.argv[3]
    {"installed": check_installed, "removed": check_removed}[state](binary, extension_id)
    print(f"verified: {state}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
