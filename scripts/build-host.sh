#!/usr/bin/env bash
# Build the packaged drift-host (PyInstaller, one folder) for this OS, then smoke-test it.
# Output: artifacts/host/dist/drift-host/ (the drift-host executable and its libraries).
# Usage: scripts/build-host.sh
source "$(dirname "$0")/_common.sh"
require uv

out="$ROOT/artifacts/host"
cd "$HOST_DIR"
uv sync --quiet --group build
info "building drift-host with PyInstaller"
uv run --group build pyinstaller --noconfirm --clean --log-level WARN \
  --distpath "$out/dist" --workpath "$out/work" packaging/drift-host.spec

binary="$out/dist/drift-host/drift-host"
[[ -x "$binary" ]] || binary="$binary.exe"
version="$(uv run python -c 'import drift_host; print(drift_host.__version__)')"
info "smoke-testing $binary"
uv run python packaging/smoke.py "$binary" "$version"
du -sh "$out/dist/drift-host" | awk '{print "size: " $1}'
