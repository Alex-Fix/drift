#!/usr/bin/env bash
# Build the macOS installer (.pkg) around the packaged drift-host (scripts/build-host.sh first).
# Called by scripts/build-installer.sh with: <version> <extension id> <host dist dir> <output dir>
# Signing (release design: unsigned until secrets exist): with APPLE_INSTALLER_IDENTITY set, productbuild signs the
# .pkg with that "Developer ID Installer" identity (the keychain must hold it).
set -euo pipefail
version="$1" extension_id="$2" dist="$3" out="$4"
here="$(cd "$(dirname "$0")" && pwd)"
root_dir="$(cd "$here/../../.." && pwd)"
arch="$(uname -m)"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

fill() { sed -e "s/@EXTENSION_ID@/$extension_id/g" -e "s/@VERSION@/$version/g" -e "s/@ARCH@/$arch/g" "$1" >"$2"; }

# Payload: /Library/Application Support/drift/{drift-host/, uninstall.sh}, owned by root, writable only by root.
payload="$work/root/Library/Application Support/drift"
mkdir -p "$payload"
cp -R "$dist" "$payload/drift-host"
fill "$here/uninstall.sh.in" "$payload/uninstall.sh"
chmod 755 "$payload/uninstall.sh"
chmod -R u+rwX,go+rX,go-w "$work/root"
# Drop extended attributes (e.g. quarantine), which pkgbuild records as AppleDouble entries. macOS's protected
# com.apple.provenance can't be removed on a developer Mac; the Installer turns such entries back into attributes,
# never "._*" files (verify_install.py checks).
xattr -cr "$work/root" 2>/dev/null || true
export COPYFILE_DISABLE=1

mkdir -p "$work/scripts" "$work/resources"
cp "$here/scripts/preinstall" "$work/scripts/preinstall"
fill "$here/scripts/postinstall.in" "$work/scripts/postinstall"
chmod 755 "$work/scripts/preinstall" "$work/scripts/postinstall"

cp "$here/resources/welcome.html" "$here/resources/conclusion.html" "$work/resources/"
cp "$root_dir/LICENSE" "$work/resources/LICENSE.txt"
fill "$here/distribution.xml.in" "$work/distribution.xml"

pkgbuild --root "$work/root" --install-location / --scripts "$work/scripts" --ownership recommended \
  --identifier io.github.alex-fix.drift --version "$version" --quiet "$work/drift-host.pkg"

mkdir -p "$out"
target="$out/drift-host-$version-macos-$arch.pkg"
sign=()
if [[ -n "${APPLE_INSTALLER_IDENTITY:-}" ]]; then sign=(--sign "$APPLE_INSTALLER_IDENTITY"); fi
productbuild --distribution "$work/distribution.xml" --resources "$work/resources" --package-path "$work" \
  ${sign[@]+"${sign[@]}"} --quiet "$target"
echo "$target"
