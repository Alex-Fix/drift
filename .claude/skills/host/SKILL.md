---
name: host
description: Conventions for drift-host (host/, Python ≥ 3.12, uv) — module boundaries (messaging framing, protocol validation, app dispatch, airplay via pyatv, relay, install), asyncio rules, stdout-is-the-channel logging, native-messaging registration per OS and browser, pyatv and ffmpeg notes, tooling (ruff, mypy strict, pytest-asyncio with fakes). Use when changing anything under host/ or debugging the host from the browser.
---

# Host

## Modules (`src/drift_host/`)

| Module | Owns |
|---|---|
| `messaging.py` | stdio framing (32-bit native-endian length + UTF-8 JSON), size limits, binary stdio on Windows |
| `protocol.py` | `MESSAGES` table, `parse`, `ProtocolError`, `error()` — mirrors `extension/src/protocol.ts` |
| `app.py` | `Host.handle` (one task per request, never raises), `serve` loop |
| `airplay.py` | `Receivers` protocol + `PyatvReceivers` (scan, pair, URL playback, `open_mirror`); imports `pyatv` lazily |
| `mirror/session.py` | `MirrorSession`: one mirroring session's lifecycle over a `Control` (no pyatv; tested with a fake TV) |
| `mirror/pyatv_control.py` | `PyatvControl`: the real `Control` — pyatv **internals** (pair-verify, RTSP, timing, event channel) |
| `mirror/packets.py` | data-channel packets: header (128 B, LE), heartbeat, codec packets (avcC + trailer / `hvc1` box), `FrameSealer` (ChaCha20-Poly1305) |
| `mirror/video.py` | `VideoStream`: decoder setup before every keyframe, then sealed access units |
| `mirror/audio.py` | `AudioStream`: s16le stereo 44.1 kHz PCM → uncompressed ALAC → sealed RTP; sync packets each second on the video clock; resends on request |
| `mirror/clock.py` | NTP timestamps on the timing server's clock |
| `mirror/mp4.py` | first video track of a plain MP4 (for `mirror-file`): avcC/hvcC + sample table; no B-frames |
| `install.py` | `plan()` (pure, tested per OS) + `install()`/`uninstall()` — manifests, launcher, Windows registry |
| `cli.py` | `drift-host chrome-extension://…` → serve; `scan`, `pair`, `mirror-file`, `install`, `uninstall` for developers |

## Rules

- **stdout is the message channel.** No `print` outside `cli.py` developer commands; logging goes to
  `platformdirs.user_log_dir("drift")/host.log`.
- asyncio throughout; blocking I/O (stdin) via `asyncio.to_thread`. Subprocesses only with
  `asyncio.create_subprocess_exec` and argument lists.
- Handlers raise `ProtocolError(code)` for anything the extension should see; unexpected exceptions become
  `internal_error` and are logged with a traceback (no URLs/cookies in the message).
- Paths via `pathlib` + `platformdirs`; anything OS-specific has a branch for `darwin`, `linux` and `win32` and a
  test for each (CI runs all three).
- New dependencies: free/OSS, added with `uv add`, lockfile committed.
- `pyatv` is imported only in `airplay.py` and `mirror/pyatv_control.py`. The latter uses pyatv internals, so pyatv
  is pinned to a minor version (`<0.19`); bumping it means updating `tests/test_pyatv_compat.py` and re-running a
  live mirroring check on a receiver.
- Mirroring protocol facts (handshake order, keys, packet formats) come from the Phase 0 spike log in
  `docs/plans/2026-11-12-airplay-mirroring-design.md` — change them only with a live re-test.

## pyatv notes

- pyatv is typed (`py.typed`): use `pyatv.interface.AppleTV` / `BaseConfig` under `TYPE_CHECKING`, not `Any`.
- `pyatv.scan(loop, timeout=<int seconds>)` → configs; keep those with an `identifier` and an AirPlay service. `pyatv.connect(config, loop)` →
  `atv.stream.play_url(url, position=…)`, `atv.remote_control.{play,pause,set_position,stop}`, `atv.push_updater`
  for status. `await asyncio.gather(*atv.close())` when done (close returns tasks).
  pyatv exceptions map to codes in `_receiver_errors()` (auth → `pairing_required`, connection → `device_unreachable`).
- tvOS may require AirPlay pairing depending on "Allow Access": `pyatv.pair(config, Protocol.AirPlay, loop)` → PIN on
  screen → `credentials` stored per device (`security` skill: 0600, never logged); pyatv's
  `pyatv.storage.file_storage.FileStorage(filename, loop)` can persist them (pass `storage=` to scan/connect/pair).
- `srptools` is pinned `<2` (pyatv passes `private` positionally, 2.0 made it keyword-only);
  `tests/test_pyatv_compat.py` fails when that breaks again. Check it before accepting a Dependabot bump.
- Credentials: `user_data_dir("drift")/receivers.json` (pyatv `FileStorage`, owner-only dir); `drift-host pair
  --device <id>` writes them; the Samsung UCU7000 (AirPlay 2 TV) needs pairing before `play_url`.
- `atv.stream.play_url` blocks until the media ends — run it as a task, never await it in a request handler. It
  also serves a local file if the URL string is an existing path: only ever pass validated `http(s)` URLs.
- Third-party AirPlay 2 TVs may not implement URL playback at all (Samsung UCU7000: `POST /play` → 404); see the
  v1 design's "Receiver findings". `drift-host pair --pin-file <f>` pairs without a terminal (PIN written to `<f>`).
- Try things without the browser: `uv run drift-host scan`, `uv run atvremote --id <id> play_url=<url>` (pyatv CLI).

## Native messaging per OS

`install.py` plans every manifest (pure, tested per OS) for two scopes: **user** (developers; the per-user Windows
installer) and **system** (`drift-host install --system`, run as root by the macOS and Linux installers). Paths were
checked against each browser's source or binary (release design 2026-11-25, step 2); notably **Brave reads Chrome's
locations** on macOS and Linux, and Vivaldi (closed source) gets Chromium's, best effort. A packaged (PyInstaller)
build points the manifest at its own executable; from source, at a launcher running `python -m drift_host`.
`--browser all` (the default) writes one manifest per distinct location; per user, only for browsers with a profile.


- Chrome starts the host with the extension origin as the first argument (Windows adds `--parent-window=`), kills it
  when the port closes, and reads the manifest from: macOS `~/Library/Application Support/<browser>/NativeMessagingHosts/`,
  Linux `~/.config/<browser>/NativeMessagingHosts/`, Windows the path in `HKCU\Software\<vendor>\<browser>\NativeMessagingHosts\<name>`.
- "Native host has exited" / "Specified native messaging host not found" in the service-worker console: re-run
  `scripts/install-host.sh`, check the extension id, then `host.log`.

## Tooling

- `uv run pytest` (pytest-asyncio auto mode), `uv run ruff format --check`, `uv run ruff check`, `uv run mypy`
  (strict). Tests use fakes (`FakeReceivers`), never the network or the real registry/home directory.
