"""drift has one version for extension and host (release design 2026-11-25); scripts/set-version.sh writes it in each
file's own form. These checks keep a hand edit from splitting them."""

import json
import re
import tomllib
from pathlib import Path

from drift_host import __version__

ROOT = Path(__file__).resolve().parents[2]
PEP440 = re.compile(r"(\d+\.\d+\.\d+)(?:(a|b|rc)(\d+))?")
SEMVER = re.compile(r"(\d+\.\d+\.\d+)(?:-(alpha|beta|rc)\.(\d+))?")
SHORT = {"alpha": "a", "beta": "b", "rc": "rc"}


def as_pep440(semver: str) -> str:
    match = SEMVER.fullmatch(semver)
    assert match, f"not X.Y.Z[-alpha|beta|rc.N]: {semver}"
    core, kind, n = match.groups()
    return core + (f"{SHORT[kind]}{n}" if kind else "")


def test_the_host_package_and_module_agree() -> None:
    pyproject = tomllib.loads((ROOT / "host/pyproject.toml").read_text())
    assert pyproject["project"]["version"] == __version__
    assert PEP440.fullmatch(__version__)


def test_the_extension_has_the_hosts_version() -> None:
    package = json.loads((ROOT / "extension/package.json").read_text())
    lock = json.loads((ROOT / "extension/package-lock.json").read_text())
    assert as_pep440(package["version"]) == __version__
    assert lock["version"] == lock["packages"][""]["version"] == package["version"]


def test_the_manifest_carries_the_numeric_version_and_names_a_prerelease() -> None:
    manifest = json.loads((ROOT / "extension/src/manifest.json").read_text())
    package = json.loads((ROOT / "extension/package.json").read_text())
    core = package["version"].partition("-")[0]
    assert manifest["version"] == core  # Chrome: numbers only
    if "-" in package["version"]:
        assert manifest["version_name"] == package["version"]
    else:
        assert "version_name" not in manifest
