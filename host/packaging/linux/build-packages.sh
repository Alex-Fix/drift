#!/usr/bin/env bash
# Build the Linux packages (.deb and .rpm, with nfpm) around the packaged drift-host (scripts/build-host.sh first).
# Called by scripts/build-installer.sh with: <version (semver)> <extension id> <host dist dir> <output dir>
set -euo pipefail
version="$1" extension_id="$2" dist="$3" out="$4"
here="$(cd "$(dirname "$0")" && pwd)"
root_dir="$(cd "$here/../../.." && pwd)"
command -v nfpm >/dev/null || { echo "nfpm not found (https://nfpm.goreleaser.com/install/)" >&2; exit 1; }
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

fill() {
  sed -e "s|@EXTENSION_ID@|$extension_id|g" -e "s|@VERSION@|$version|g" -e "s|@DIST@|$dist|g" \
    -e "s|@LICENSE@|$root_dir/LICENSE|g" -e "s|@WORK@|$work|g" "$1" >"$2"
}
fill "$here/nfpm.yaml.in" "$work/nfpm.yaml"
fill "$here/postinstall.sh.in" "$work/postinstall.sh"
fill "$here/preremove.sh.in" "$work/preremove.sh"
chmod -R u+rwX,go+rX,go-w "$dist"

mkdir -p "$out"
for packager in deb rpm; do
  nfpm package --config "$work/nfpm.yaml" --packager "$packager" --target "$out/" >/dev/null
done
ls "$out"/drift-host*.deb "$out"/drift-host*.rpm
