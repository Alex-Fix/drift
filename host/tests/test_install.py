import json
import stat
import sys
from pathlib import Path

import pytest

from drift_host.install import (
    BROWSERS,
    HOST_NAME,
    Browser,
    Scope,
    System,
    browser_present,
    install,
    plan,
    plans,
    uninstall,
)

EXTENSION_ID = "abcdefghijklmnopabcdefghijklmnop"
HOME = Path("/home/u")
DATA = Path("/data/drift")


def test_linux_chrome_manifest_lives_in_the_chrome_config_dir() -> None:
    p = plan("chrome", EXTENSION_ID, system="linux", home=HOME, data_dir=DATA, python="/usr/bin/python3")
    assert p.manifest == HOME / ".config/google-chrome/NativeMessagingHosts" / f"{HOST_NAME}.json"
    assert p.registry_key is None
    assert p.launcher_text == '#!/bin/sh\nexec "/usr/bin/python3" -m drift_host "$@"\n'


def test_macos_edge_manifest_lives_in_application_support() -> None:
    p = plan("edge", EXTENSION_ID, system="darwin", home=HOME, data_dir=DATA, python="python3")
    assert p.manifest == HOME / "Library/Application Support/Microsoft Edge/NativeMessagingHosts" / f"{HOST_NAME}.json"


def test_windows_uses_a_batch_launcher_and_a_registry_key() -> None:
    p = plan("brave", EXTENSION_ID, system="win32", home=HOME, data_dir=DATA, python=r"C:\py\python.exe")
    assert p.launcher == DATA / "drift-host.bat"
    assert p.launcher_text is not None and "\r\n" in p.launcher_text
    assert p.registry_key == rf"Software\BraveSoftware\Brave-Browser\NativeMessagingHosts\{HOST_NAME}"


def test_manifest_allows_only_the_given_extension() -> None:
    p = plan("chrome", EXTENSION_ID, system="linux", home=HOME, data_dir=DATA, python="python3")
    manifest = json.loads(p.manifest_text)
    assert manifest == {
        "name": HOST_NAME,
        "description": manifest["description"],
        "path": str(DATA / "drift-host"),
        "type": "stdio",
        "allowed_origins": [f"chrome-extension://{EXTENSION_ID}/"],
    }


@pytest.mark.parametrize("bad", ["", "ABCDEFGHIJKLMNOPABCDEFGHIJKLMNOP", "abcdefghijklmnopabcdefghijklmnoq", "a/../b"])
def test_malformed_extension_id_is_refused(bad: str) -> None:
    with pytest.raises(ValueError):
        plan("chrome", bad, system="linux", home=HOME, data_dir=DATA, python="python3")


SYSTEM_DIRS = {
    ("darwin", "chrome"): "/Library/Google/Chrome/NativeMessagingHosts",
    ("darwin", "edge"): "/Library/Microsoft/Edge/NativeMessagingHosts",
    ("darwin", "chromium"): "/Library/Application Support/Chromium/NativeMessagingHosts",
    ("linux", "chrome"): "/etc/opt/chrome/native-messaging-hosts",
    ("linux", "edge"): "/etc/opt/edge/native-messaging-hosts",
    ("linux", "chromium"): "/etc/chromium/native-messaging-hosts",
}


@pytest.mark.parametrize(("system", "browser"), list(SYSTEM_DIRS))
def test_system_manifests_go_where_each_browser_reads_them(system: System, browser: Browser) -> None:
    p = plan(browser, EXTENSION_ID, system=system, home=HOME, data_dir=DATA, python="python3", scope="system")
    assert p.manifest == Path(SYSTEM_DIRS[(system, browser)]) / f"{HOST_NAME}.json"


@pytest.mark.parametrize("system", ["darwin", "linux"])
@pytest.mark.parametrize("scope", ["user", "system"])
def test_brave_reads_chromes_locations_on_macos_and_linux(system: System, scope: Scope) -> None:
    where = {"system": system, "home": HOME, "data_dir": DATA, "python": "python3", "scope": scope}
    brave = plan("brave", EXTENSION_ID, **where)  # type: ignore[arg-type]
    chrome = plan("chrome", EXTENSION_ID, **where)  # type: ignore[arg-type]
    assert brave.manifest == chrome.manifest


def test_windows_has_no_system_scope() -> None:
    with pytest.raises(ValueError, match="per user"):
        plan("chrome", EXTENSION_ID, system="win32", home=HOME, data_dir=DATA, python="python.exe", scope="system")


@pytest.mark.parametrize("system", ["darwin", "linux", "win32"])
def test_a_packaged_build_needs_no_launcher(system: System) -> None:
    exe = Path("/opt/drift/drift-host")
    p = plan("chrome", EXTENSION_ID, system=system, home=HOME, data_dir=DATA, python="unused", executable=exe)
    assert p.launcher is None and p.launcher_text is None
    assert json.loads(p.manifest_text)["path"] == str(exe)


def test_browsers_sharing_a_location_get_one_manifest() -> None:
    all_ = plans(BROWSERS, EXTENSION_ID, system="linux", home=HOME, data_dir=DATA, python="python3", scope="system")
    manifests = [p.manifest.parent for p in all_]
    assert len(manifests) == len(set(manifests)) == 3  # chrome (+brave), chromium (+vivaldi), edge


@pytest.mark.skipif(sys.platform == "win32", reason="POSIX file modes")
def test_install_writes_a_manifest_every_browser_can_read_and_only_its_owner_change(tmp_path: Path) -> None:
    p = plan("chrome", EXTENSION_ID, system="linux", home=tmp_path, data_dir=tmp_path / "data", python="python3")
    install(p)
    assert stat.S_IMODE(p.manifest.stat().st_mode) == 0o644
    assert p.launcher is not None and p.launcher.stat().st_mode & stat.S_IXUSR
    uninstall(p)
    assert not p.manifest.exists()


def test_a_browser_counts_as_present_when_its_profile_directory_exists(tmp_path: Path) -> None:
    (tmp_path / ".config/google-chrome").mkdir(parents=True)
    chrome = plan("chrome", EXTENSION_ID, system="linux", home=tmp_path, data_dir=DATA, python="python3")
    edge = plan("edge", EXTENSION_ID, system="linux", home=tmp_path, data_dir=DATA, python="python3")
    assert browser_present(chrome) and not browser_present(edge)
    windows = plan("edge", EXTENSION_ID, system="win32", home=tmp_path, data_dir=DATA, python="python.exe")
    assert browser_present(windows)  # registry keys: nothing to leave behind
