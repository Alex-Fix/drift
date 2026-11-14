#!/usr/bin/env bash
# Format, lint and type-check. Usage: scripts/lint.sh [--extension|--host]
source "$(dirname "$0")/_common.sh"

lint_extension() {
  require npm; info "Extension: prettier, eslint, tsc"
  (cd "$EXT_DIR" && npm run format && npm run lint && npm run typecheck)
}
lint_host() {
  require uv; info "Host: ruff, mypy"
  (cd "$HOST_DIR" && uv run ruff format --check && uv run ruff check && uv run mypy)
}
lint_scripts() {
  if command -v shellcheck >/dev/null; then info "shellcheck"; shellcheck -x "$ROOT"/scripts/*.sh
  else warn "shellcheck not installed, skipped"; fi
}

case "${1:-all}" in
  --extension) lint_extension ;;
  --host)      lint_host ;;
  all)         lint_extension; lint_host; lint_scripts ;;
  *)           die "usage: $0 [--extension|--host]" ;;
esac
