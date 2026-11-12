# Architecture

```
┌──────────────── browser (Chromium, MV3) ────────────────┐        ┌──────────── drift-host (Python) ────────────┐
│ content script ── candidates ──► service worker ◄─► popup│ stdio  │ messaging ─► protocol ─► session ─► airplay │──► receiver
│  (<video>, DRM check)            (webRequest manifests,  │◄══════►│  (framing)  (validation)      │  (pyatv)    │  (mDNS,
│                                   native port)           │  JSON  │                               └► relay ─────│──► AirPlay)
└──────────────────────────────────────────────────────────┘        └─────────────────────────────────────────────┘
```

## Extension (`extension/`)

- `src/content/` — injected on demand (`activeTab` + `scripting`); reports candidate videos and whether they're
  DRM-protected. Never talks to the host.
- `src/background/` — the only owner of the native port (`chrome.runtime.connectNative`). Opens it lazily, matches
  responses by `id`, forwards `status` events to the popup. MV3 may stop the worker: anything that must survive lives
  in the host.
- `src/popup/` — receivers, candidates, transport controls. Plain DOM + TypeScript, no framework.
- `src/protocol.ts` — message types and validation (mirrors the host).

## Host (`host/src/drift_host/`)

- `messaging.py` — length-prefixed stdio framing with size limits. stdout is reserved for messages; logs go to a file.
- `protocol.py` — message dataclasses, parse/validate, error codes.
- `app.py` — dispatch loop: request → handler → response; one task per request so `scan` doesn't block `control`.
- `airplay.py` — the only module importing `pyatv`: scan, connect (stored credentials), play/control/stop, push
  updates → `status` events.
- `relay.py` — (phase 2) LAN HTTP server re-serving / remuxing streams.
- `install.py` — writes the native-messaging host manifest + launcher for each OS and browser
  (macOS/Linux: JSON files in the browser's `NativeMessagingHosts` dir; Windows: manifest file + `HKCU` registry key).

## Lifecycle

The browser starts `drift-host` when the service worker connects and kills it when the port closes. A playing session
continues on the receiver after the host exits (the receiver fetches the URL itself) — except relayed streams, which
need the host alive: the background keeps the port open while a relay session is active.
