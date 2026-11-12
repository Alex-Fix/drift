# Drift v1 — design
Status: **draft** (not approved) · Date: 2026-11-12

Written while initialising the repository. The earlier discussions about drift weren't available here, so every
decision below is a proposal: correct it, then run the `brainstorming` skill to turn this into an approved design.

## Problem

Chromium browsers can cast to Chromecast but not to AirPlay receivers, and AirPlay senders only exist on Apple
devices. People with an Apple TV (or an AirPlay TV) and a Linux/Windows machine, or a Mac running Chrome, have no way
to send the video on a web page to it.

## Goals / Non-goals

Goals
- One click in a Chromium browser sends the page's video to an AirPlay receiver on the LAN; play/pause/seek/stop
  from the popup, and the receiver's position reflected back.
- Linux, macOS and Windows; Chrome, Chromium, Edge, Brave, Vivaldi (any browser with native messaging).
- Works for direct files (MP4/MOV/M4V), HLS, and — via relay — URLs the receiver can't fetch on its own.

Non-goals (v1)
- DRM-protected streams (Netflix, Disney+, …): detected and reported as unsupported.
- Screen/desktop mirroring and the AirPlay mirroring protocol (FairPlay handshake; not in `pyatv`).
- Audio-only AirPlay (RAOP) — maybe later.
- Firefox / Safari, mobile browsers, stores (Chrome Web Store, PyPI) — packaging comes after v1 works.

## Constraints check

| Constraint | Answer |
|---|---|
| **MV3** | Service worker is ephemeral: the native port is opened on demand and the session state lives in the host. Tab capture (phase 3) needs an offscreen document. |
| **Browser sandbox** | An extension can't open raw sockets or do mDNS, so AirPlay needs a native process → native messaging host in Python. |
| **Untrusted input** | Pages control `<video>` URLs and titles; the host validates everything (schemes, sizes, device ids) — `security` skill. |
| **LAN only** | The receiver must reach any relay we run: bind to the interface on the receiver's subnet, random-token URLs, stop with the session. |
| **Cross-platform** | Host manifests differ per OS and browser (files on macOS/Linux, registry on Windows) → `drift-host install`. |
| **Licences** | `pyatv` (MIT), ffmpeg (LGPL/GPL, invoked as an external binary, not bundled in v1). |

## Approaches

1. **URL hand-off (recommended first)** — the extension finds the media URL (`<video src>`, `<source>`, HLS/DASH
   manifests seen via `webRequest`), the host tells the receiver to fetch it (`pyatv` `stream.play_url`). Lowest
   latency, best quality, no transcoding. Fails when the URL needs the page's cookies/referer or isn't a format the
   receiver plays. Size S.
2. **Relay** — the host fetches the URL with the page's headers and re-serves it on the LAN; HLS playlists are
   rewritten to point at the relay; formats the receiver can't play (WebM, DASH) are remuxed/transcoded by ffmpeg into
   HLS (fMP4/TS). Covers cookie-bound and non-Apple formats. Size M.
3. **Tab capture** — for MSE/blob players whose segments can't be fetched independently: capture the tab
   (`chrome.tabCapture` in an offscreen document), `MediaRecorder` chunks to the host, ffmpeg → HLS → `play_url`.
   Works for any non-DRM player, but adds seconds of latency and transcoding load. Size M–L.

Not chosen: implementing AirPlay mirroring ourselves (FairPlay, reverse-engineered, fragile); a WebRTC/WebSocket
companion instead of native messaging (needs a listening port and its own auth; native messaging gives us an
authenticated channel for free).

Proposal: phase 1 = approach 1, phase 2 = 2, phase 3 = 3, each shipping on its own.

## Design (outline)

- **Extension** — content script lists candidate videos (URL, type, duration, poster, title, `isDrm` via
  `MediaKeys`); background keeps a per-tab map of manifests seen via `webRequest`; popup shows receivers (host
  `scan`) and candidates, sends `play`/`control`/`stop`, and renders `status` events.
- **Host** — asyncio loop reading framed messages from stdin; `airplay.py` wraps `pyatv` (scan, connect with stored
  credentials, `play_url`, push updates → `status`); `relay.py` (phase 2) runs an `aiohttp` server; `install.py`
  writes the native-messaging manifest and launcher for each OS/browser.
- **Pairing** — tvOS asks for AirPlay pairing (PIN on the TV) depending on its "Allow Access" setting; credentials
  are stored per device in the user data dir (`platformdirs`), file mode 0600.
- **Protocol** — `docs/protocol.md`; fixtures in `protocol/fixtures/`.

## Security notes

See the `security` skill: host validates every message; URLs `http(s)` only; no shell; relay LAN-bound with random
tokens; cookies used only by the relay and never logged; no DRM capture.

## Testing

Extension: Vitest (protocol validation against fixtures, candidate detection on DOM fixtures). Host: pytest
(framing, validation against fixtures, install paths per OS with a fake home/registry, airplay adapter with a fake
`pyatv`). Manual matrix: Apple TV 4K (tvOS current) × Chrome on macOS/Linux/Windows.

## Open questions

1. What did the earlier conversations settle? (receiver types, phases, Python vs a compiled host, naming)
2. Receivers beyond Apple TV: AirPlay 2 TVs (Samsung, LG, Sony) support `play_url` inconsistently — in scope?
3. Packaging the host for non-developers: `uv tool install`, PyInstaller single binary, or an installer per OS?
4. Do we need a fixed extension id (`key` in the manifest) before store publishing, for `allowed_origins`?
5. YouTube & co: phase 3 tab capture, or special-case extractors (e.g. `yt-dlp` in the host)?

## Implementation steps

1. Scaffolding, tooling, CI (this commit).
2. Protocol v1 `hello`/`scan`/`devices` end to end; `drift-host install` for Chrome on all three OSes.
3. `play`/`stop`/`control`/`status` with URL hand-off; pairing flow.
4. Candidate detection (DOM + `webRequest` manifests), DRM detection, popup UX.
5. Relay (phase 2), then tab capture (phase 3) — each with its own design doc.
