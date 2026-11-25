#!/usr/bin/env bash
# Render the extension icons (extension/src/icons/*.svg) to the PNGs the manifest uses, with headless Chrome.
# The PNGs are committed, so building the extension needs nothing but npm; run this after changing an icon SVG.
# Each size has its own drawing where it matters (design skill, Icons): 16 and 32 for the toolbar, the 128 master
# (artwork in the central 96 px, as the Chrome Web Store asks) for 48 and 128.
# Usage: scripts/render-icons.sh
source "$(dirname "$0")/_common.sh"

chrome=""
for candidate in \
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  "/Applications/Chromium.app/Contents/MacOS/Chromium" \
  google-chrome google-chrome-stable chromium chromium-browser; do
  if [[ -x "$candidate" ]] || command -v "$candidate" >/dev/null 2>&1; then
    chrome="$candidate"
    break
  fi
done
[[ -n "$chrome" ]] || die "Chrome or Chromium not found (needed to render the icons)"

icons="$EXT_DIR/src/icons"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

render() { # <size> <source svg>
  local size="$1" source="$2"
  cp "$icons/$source" "$work/$source"
  printf '<!doctype html><html><body style="margin:0;background:transparent">%s</body></html>' \
    "<img src=\"$source\" width=\"$size\" height=\"$size\" style=\"display:block\">" >"$work/$size.html"
  "$chrome" --headless=new --disable-gpu --hide-scrollbars --force-device-scale-factor=1 \
    --default-background-color=00000000 --user-data-dir="$work/profile" --window-size="$size,$size" \
    --screenshot="$icons/icon-$size.png" "file://$work/$size.html" >/dev/null 2>&1
  [[ -s "$icons/icon-$size.png" ]] || die "rendering icon-$size.png failed"
  info "icon-$size.png from $source"
}

render 16 icon-16.svg
render 32 icon-32.svg
render 48 icon-128.svg
render 128 icon-128.svg
