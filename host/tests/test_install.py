import json
from pathlib import Path

import pytest

from drift_host.install import HOST_NAME, plan

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
    assert "\r\n" in p.launcher_text
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
