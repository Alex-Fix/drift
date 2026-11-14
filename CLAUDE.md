# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Drift streams the video playing in a Chromium-based browser (Chrome, Edge, Brave, Vivaldi, Arc…) to an AirPlay
receiver (Apple TV, AirPlay-capable TVs and speakers) from Linux, macOS and Windows. Design:
`docs/plans/2026-11-12-drift-v1-design.md` (draft until approved) — read it before changing behaviour or the protocol.

- **Extension** (`extension/`, Manifest V3, TypeScript): finds the videos on a page (direct URLs, HLS/DASH manifests
  seen on the network), shows receivers in the popup and sends commands to the host. No AirPlay code lives here.
- **Host** (`host/`, Python, `drift-host`): a native-messaging host started by the browser. Discovers receivers
  (mDNS), pairs, and drives AirPlay through `pyatv`; for sources a receiver can't fetch itself (blob/MSE players,
  cookie-bound URLs) it relays or remuxes the stream (ffmpeg) and serves it on the LAN.
- **Protocol:** versioned JSON messages (`"v"`) over Chrome native messaging (`docs/protocol.md`); every message
  shape has a fixture in `protocol/fixtures/` that both sides' tests read.

Everything the host receives is untrusted (a page can influence what the extension sends) — see the `security` skill.

## Layout (target — create code here, don't invent new top-level dirs)

```
extension/                     MV3 extension (npm): src/{background,content,popup}/, src/protocol.ts, test/ (Vitest)
  src/manifest.json            copied to dist/ by build.mjs (esbuild); dist/ is what "Load unpacked" points at
host/                          Python package drift_host (uv): src/drift_host/, tests/ (pytest)
  src/drift_host/              messaging (framing), protocol (message types), airplay (pyatv adapter),
                               relay (local HTTP/HLS server, ffmpeg), install (native-host manifests per OS/browser)
protocol/fixtures/             one JSON file per message shape, read by extension and host tests
scripts/                       dev scripts (bash, run from repo root)
docs/                          architecture.md, protocol.md; plans/ = approved designs (`brainstorming` skill)
artifacts/                     gitignored: builds, packed extension, logs, local repro runs
```

## Commands

All scripts run from the repo root.

- `scripts/doctor.sh` — check the toolchain (node, npm, uv, Python ≥ 3.12; ffmpeg optional)
- `scripts/test.sh [--extension|--host]` — Vitest + pytest
- `scripts/lint.sh [--extension|--host]` — Prettier, ESLint, `tsc`; ruff format/check, mypy (strict); shellcheck
- `scripts/install-host.sh --extension-id <id> [--browser chrome|chromium|edge|brave|vivaldi]` — register the
  native-messaging host for the local browser (macOS/Linux; on Windows: `uv run drift-host install …` from `host/`)
- Extension (`cd extension`): `npm ci`, `npm run build` (→ `extension/dist`, load unpacked), `npm run watch`,
  `npm run check` (format, lint, typecheck, test, build)
- Host (`cd host`): `uv sync`, `uv run pytest`, `uv run drift-host scan` (list receivers without the browser)

## Rules

1. **The protocol is shared.** Any message change updates `extension/src/protocol.ts`,
   `host/src/drift_host/protocol.py`, `docs/protocol.md` and `protocol/fixtures/` in the same change. Breaking changes
   bump `"v"` and need explicit approval and a design-doc update. See the `protocol` skill.
2. **The host trusts nothing.** It validates every message (types, sizes, URL schemes: `http`/`https` only, never
   `file:` or local paths), never runs a shell, and only talks to receivers the user picked.
3. **Stay on the LAN, stay quiet.** No telemetry, no cloud services, no third-party servers. The relay binds to the
   interface facing the receiver, serves only the session's own random-token paths, and stops with the session.
4. **No DRM circumvention.** Widevine/PlayReady-protected streams are reported as unsupported, never captured or
   decrypted.
5. **Least privilege.** New extension permissions or host-permission patterns need a reason in the PR; prefer
   `activeTab` and optional permissions. Free/open-source dependencies only.
6. **Cross-platform by default.** Linux, macOS and Windows; paths via `pathlib`/`platformdirs`, no POSIX-only calls
   without a Windows branch. CI runs the host tests on all three.

## Conventions

- TypeScript (`extension/`): strict + `noUncheckedIndexedAccess` + `exactOptionalPropertyTypes`, ESLint
  `strictTypeChecked` + `stylisticTypeChecked`, Prettier (120 columns), Vitest. No runtime dependencies unless
  approved; no `eval`/`new Function`/remote code (MV3 forbids it anyway). Details: `extension` skill.
- Python (`host/`): ≥ 3.12, `uv`, src layout, asyncio throughout, full type hints (mypy strict), ruff (format + lint,
  120 columns), pytest + pytest-asyncio. `pyatv` only behind `airplay.py`; tests never touch the network. Logs go to
  a file in the user log dir — **never stdout** (stdout is the native-messaging channel). Details: `host` skill.
- Tests: names read as sentences (`test_oversized_message_is_rejected`, `it("rejects an unknown version")`).
- Design new features with the `brainstorming` skill first; designs land in `docs/plans/YYYY-MM-DD-<topic>-design.md`.

## Skills in this repo

- `brainstorming` — turn an idea into an approved design doc in `docs/plans/` before coding
- `security` — threat model (hostile pages, LAN), host/extension hardening, review checklist
- `protocol` — how to add or change a native-messaging message end to end
- `extension` — MV3 extension conventions and scaffolding
- `host` — Python host conventions, pyatv/ffmpeg notes, native-host registration per OS and browser
