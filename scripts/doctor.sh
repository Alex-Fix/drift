#!/usr/bin/env bash
# Check the local toolchain.
source "$(dirname "$0")/_common.sh"

ok=1
check() {
  local name=$1 cmd=$2 hint=$3 required=${4:-1}
  if command -v "$cmd" >/dev/null 2>&1; then
    printf '  \033[32m✓\033[0m %-10s %s\n' "$name" "$("$cmd" --version 2>/dev/null | head -1)"
  else
    printf '  \033[31m✗\033[0m %-10s missing — %s\n' "$name" "$hint"; (( required )) && ok=0 || true
  fi
}

info "Required"
check node node "brew install node  (24+)"
check npm  npm  "comes with node"
check uv   uv   "brew install uv  (or https://docs.astral.sh/uv/)"
info "Optional"
check ffmpeg     ffmpeg     "brew install ffmpeg  (relay / tab capture, later phases)" 0
check shellcheck shellcheck "brew install shellcheck  (scripts/lint.sh)" 0

if command -v node >/dev/null && (( $(node -p 'process.versions.node.split(".")[0]') < 24 )); then
  warn "Node 24+ required"; ok=0
fi
if command -v uv >/dev/null && ! uv python find '>=3.12' >/dev/null 2>&1; then
  warn "no Python ≥ 3.12 — uv python install 3.13"; ok=0
fi

if (( ok )); then info "All required tools present"; else die "Fix the items above"; fi
