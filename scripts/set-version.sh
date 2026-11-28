#!/usr/bin/env bash
# Set drift's version everywhere it's written: extension manifest + package.json, host pyproject.toml + __version__.
# One version for extension and host (release design 2026-11-25). Each file gets the form its ecosystem wants:
#   1.0.0-rc.1 → manifest "version": "1.0.0" + "version_name": "1.0.0-rc.1" (Chrome allows only numbers in version),
#                package.json "1.0.0-rc.1", pyproject/__version__ "1.0.0rc1" (PEP 440).
# host/tests/test_version.py checks they agree.
# Usage: scripts/set-version.sh <X.Y.Z[-alpha.N|-beta.N|-rc.N]>
source "$(dirname "$0")/_common.sh"
require python3

version="${1:-}"
[[ "$version" =~ ^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-(alpha|beta|rc)\.([1-9][0-9]*))?$ ]] ||
  die "usage: scripts/set-version.sh X.Y.Z[-alpha.N|-beta.N|-rc.N] (got '${version}')"

python3 - "$version" "$ROOT" <<'PY'
import json, re, sys
from pathlib import Path

version, root = sys.argv[1], Path(sys.argv[2])
core, _, pre = version.partition("-")
pep440 = core + (re.sub(r"^(alpha|beta|rc)\.", lambda m: {"alpha": "a", "beta": "b", "rc": "rc"}[m[1]], pre) if pre else "")

def edit_json(path: Path, change) -> None:
    data = json.loads(path.read_text())
    change(data)
    path.write_text(json.dumps(data, indent=2, ensure_ascii=False) + "\n")

def manifest(data: dict) -> None:
    data["version"] = core
    if pre:
        data["version_name"] = version
    else:
        data.pop("version_name", None)

edit_json(root / "extension/src/manifest.json", manifest)
edit_json(root / "extension/package.json", lambda d: d.__setitem__("version", version))

lock = root / "extension/package-lock.json"
data = json.loads(lock.read_text())
data["version"] = version
data["packages"][""]["version"] = version
lock.write_text(json.dumps(data, indent=2, ensure_ascii=False) + "\n")

pyproject = root / "host/pyproject.toml"
text, n = re.subn(r'(?m)^version = "[^"]*"$', f'version = "{pep440}"', pyproject.read_text(), count=1)
assert n == 1, "no version line in pyproject.toml"
pyproject.write_text(text)

init = root / "host/src/drift_host/__init__.py"
text, n = re.subn(r'(?m)^__version__ = "[^"]*"$', f'__version__ = "{pep440}"', init.read_text(), count=1)
assert n == 1, "no __version__ in drift_host/__init__.py"
init.write_text(text)
print(f"extension {version} (manifest {core}), host {pep440}")
PY

# Keep the files as the formatters write them; uv.lock records the project's own version too.
(cd "$EXT_DIR" && npx --no-install prettier --log-level warn --write src/manifest.json package.json)
(cd "$HOST_DIR" && uv lock --quiet)
info "version set to $version — update CHANGELOG.md"
