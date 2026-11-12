#!/usr/bin/env bash
# Run tests. Usage: scripts/test.sh [--extension|--host]
source "$(dirname "$0")/_common.sh"

run_extension() { require npm; info "Extension tests"; npm test --prefix "$EXT_DIR"; }
run_host()      { require uv;  info "Host tests"; (cd "$HOST_DIR" && uv run pytest); }

case "${1:-all}" in
  --extension) run_extension ;;
  --host)      run_host ;;
  all)         run_extension; run_host ;;
  *)           die "usage: $0 [--extension|--host]" ;;
esac
