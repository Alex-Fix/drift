#!/usr/bin/env bash
# Register drift-host (this checkout, via uv's venv) with a browser.
# Usage: scripts/install-host.sh --extension-id <id> [--browser chrome|chromium|edge|brave|vivaldi|all] [--uninstall]
# Default: every Chromium browser with a profile on this machine.
source "$(dirname "$0")/_common.sh"
require uv

command=install args=()
while (( $# )); do
  case "$1" in
    --uninstall) command=uninstall ;;
    --extension-id|--browser) args+=("$1" "${2:?$1 needs a value}"); shift ;;
    *) die "unknown argument: $1" ;;
  esac
  shift
done

cd "$HOST_DIR" || die "$HOST_DIR not found"
uv sync --quiet
uv run drift-host "$command" "${args[@]}"
