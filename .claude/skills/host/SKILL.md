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
| `airplay.py` | `Receivers` protocol + `PyatvReceivers`; the **only** module importing `pyatv` (imported lazily) |
| `install.py` | `plan()` (pure, tested per OS) + `install()`/`uninstall()` — manifests, launcher, Windows registry |
| `cli.py` | `drift-host chrome-extension://…` → serve; `scan`, `install`, `uninstall` for developers |

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

## pyatv notes

- `pyatv.scan(loop, timeout=…)` → configs; keep those with an AirPlay service. `pyatv.connect(config, loop)` →
  `atv.stream.play_url(url, position=…)`, `atv.remote_control.{play,pause,set_position,stop}`, `atv.push_updater`
  for status. `atv.close()` when done.
- tvOS may require AirPlay pairing depending on "Allow Access": `pyatv.pair(config, Protocol.AirPlay, loop)` → PIN on
  screen → `credentials` stored per device (`security` skill: 0600, never logged).
- Try things without the browser: `uv run drift-host scan`, `uv run atvremote --id <id> play_url=<url>` (pyatv CLI).

## Native messaging per OS

- Chrome starts the host with the extension origin as the first argument (Windows adds `--parent-window=`), kills it
  when the port closes, and reads the manifest from: macOS `~/Library/Application Support/<browser>/NativeMessagingHosts/`,
  Linux `~/.config/<browser>/NativeMessagingHosts/`, Windows the path in `HKCU\Software\<vendor>\<browser>\NativeMessagingHosts\<name>`.
- "Native host has exited" / "Specified native messaging host not found" in the service-worker console: re-run
  `scripts/install-host.sh`, check the extension id, then `host.log`.

## Tooling

- `uv run pytest` (pytest-asyncio auto mode), `uv run ruff format --check`, `uv run ruff check`, `uv run mypy`
  (strict). Tests use fakes (`FakeReceivers`), never the network or the real registry/home directory.
