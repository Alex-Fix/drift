#!/usr/bin/env bash
# Build this OS's installer around the packaged drift-host (run scripts/build-host.sh first):
#   macOS → .pkg · Windows → .exe (Inno Setup) · Linux → .deb and .rpm (nfpm).   Output: artifacts/installers/
# The installer registers drift-host for one extension id: DRIFT_EXTENSION_ID, else the Chrome Web Store id
# (install.py STORE_EXTENSION_ID, set once the extension is published).
# Usage: [DRIFT_EXTENSION_ID=<32 letters a-p>] scripts/build-installer.sh
source "$(dirname "$0")/_common.sh"
require uv
require python3

dist="$ROOT/artifacts/host/dist/drift-host"
out="$ROOT/artifacts/installers"
[[ -d "$dist" ]] || die "no packaged drift-host: run scripts/build-host.sh first"

version="$(python3 -c 'import json, sys; print(json.load(open(sys.argv[1]))["version"])' "$EXT_DIR/package.json")"
store_id="$(cd "$HOST_DIR" && uv run python -c 'from drift_host.install import STORE_EXTENSION_ID as i; print(i or "")')"
extension_id="${DRIFT_EXTENSION_ID:-$store_id}"
[[ "$extension_id" =~ ^[a-p]{32}$ ]] ||
  die "no extension id: set DRIFT_EXTENSION_ID (32 letters a-p) until the Chrome Web Store id is in install.py"

case "$(uname -s)" in
  Darwin)
    info "building the macOS installer (drift-host $version)"
    "$HOST_DIR/packaging/macos/build-pkg.sh" "$version" "$extension_id" "$dist" "$out"
    ;;
  Linux)
    info "building the Linux packages (drift-host $version)"
    "$HOST_DIR/packaging/linux/build-packages.sh" "$version" "$extension_id" "$dist" "$out"
    ;;
  MINGW* | MSYS* | CYGWIN*)
    info "building the Windows installer (drift-host $version)"
    iscc="$(command -v iscc || true)"
    [[ -n "$iscc" ]] || iscc="/c/Program Files (x86)/Inno Setup 6/ISCC.exe"
    [[ -x "$iscc" ]] || die "Inno Setup (ISCC.exe) not found"
    mkdir -p "$out"
    # MSYS_NO_PATHCONV: Git Bash would turn the /Q switch into a path (the paths here are converted already).
    MSYS_NO_PATHCONV=1 DRIFT_VERSION="$version" DRIFT_VERSION_NUMBER="${version%%-*}" DRIFT_EXTENSION_ID="$extension_id" \
      DRIFT_HOST_DIST="$(cygpath -w "$dist")" DRIFT_OUTPUT="$(cygpath -w "$out")" DRIFT_ROOT="$(cygpath -w "$ROOT")" \
      "$iscc" /Q "$(cygpath -w "$HOST_DIR/packaging/windows/drift.iss")"
    ls "$out"/*.exe
    ;;
  *) die "unsupported OS: $(uname -s)" ;;
esac
