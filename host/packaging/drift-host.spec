# PyInstaller spec for the packaged drift-host (release design 2026-11-25, step 3).
# One folder, not one file: the browser starts the host often, and a one-file build unpacks itself on every start.
# Build and smoke-test: scripts/build-host.sh
# ruff: noqa — PyInstaller injects Analysis, PYZ, EXE, COLLECT and SPECPATH into this file's namespace.
from PyInstaller.utils.hooks import collect_submodules

# drift-host and pyatv load most of their modules lazily (scanning, pairing, mirroring): include them all.
# `drift-host check` imports every one of them, so a missing module fails the build's smoke test, not a user's TV.
hidden = collect_submodules("drift_host") + [
    m for m in collect_submodules("pyatv") if not m.startswith("pyatv.scripts")
]

a = Analysis(
    [f"{SPECPATH}/entry.py"],
    hiddenimports=hidden,
    excludes=["tkinter", "unittest", "pydoc", "test"],
    noarchive=False,
)
pyz = PYZ(a.pure)
exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name="drift-host",
    console=True,  # stdio is the native-messaging channel
    upx=False,
    strip=False,
)
COLLECT(exe, a.binaries, a.datas, name="drift-host", upx=False, strip=False)
