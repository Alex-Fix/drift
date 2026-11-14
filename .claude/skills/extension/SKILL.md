---
name: extension
description: Conventions for the drift Chromium extension (extension/, Manifest V3, TypeScript) — layout (background service worker owning the native port, popup, injected candidate finder), esbuild build into dist/, permissions, messaging between popup and background, MV3 lifetime rules, tooling (strict TS, ESLint strictTypeChecked, Prettier, Vitest) and how to load it unpacked. Use when changing anything under extension/.
---

# Extension

## Layout

- `src/manifest.json` — copied to `dist/` by `build.mjs`; entry points are bundled by esbuild (ESM, `chrome120`).
- `src/background/` — `index.ts` wires Chrome events; `native.ts` (`NativeClient`) owns the native port: lazy
  connect, `id` matching, timeouts, reconnect after the host exits. Nothing else calls `connectNative`.
- `src/popup/` — `popup.html` / `.ts` / `.css`; plain DOM, no framework. Talks to the background with
  `chrome.runtime.sendMessage({ kind: "host", request })`.
- `src/content/candidates.ts` — `findCandidates`, injected with `chrome.scripting.executeScript({ func })`: it must
  stay self-contained (Chrome serialises its source) and return plain JSON.
- `src/content/capture.ts` — injected on demand with `executeScript({ files: ["capture.js"] })` into the frame with
  the chosen video, so it's bundled as an **IIFE** (classic script), not a module. Captures with `captureStream()`,
  encodes with WebCodecs (`src/capture/ladder.ts` picks the rung), sends `video`/`audio` notifications over the
  `drift-media` port. Runs on the page thread by decision (design doc, step 6): keep per-frame work small and
  measured (`CaptureStats`).
- `src/capture/` — pure helpers (ladder, step-down, clock, PCM, base64, crop, sizing), unit-tested, and `pipeline.ts`: the
  capture → encode → send pipeline shared by both paths (crop per frame, reconfigure on size changes).
- `src/offscreen/` — the tab-capture fallback: an offscreen document opened by the background with a
  `tabCapture` stream id, cropping the tab to the video's placement (reported by `capture.ts` in `track` mode).
- While mirroring, sound plays on the receiver only (user decision): the page path mutes the element, tab capture
  leaves the tab muted.
- `src/messages.ts` — messages inside the extension (popup ⇄ background ⇄ content); `src/background/mirror.ts`
  (`MirrorSessions`) is the gate for media: only valid `video`/`audio` for the sending tab's session.
- `src/platform.d.ts` — Chrome APIs missing from TypeScript's DOM types (`MediaStreamTrackProcessor`,
  `HTMLMediaElement.captureStream`, `Uint8Array.toBase64`).
- `src/protocol.ts` — mirrors the host; see the `protocol` skill.

## Rules

- **MV3 lifetime.** The service worker can stop any time: no state that matters lives in module variables beyond
  the port and pending requests; session state lives in the host. Event listeners are registered synchronously at
  top level.
- **No runtime dependencies** without approval; no `eval`, `new Function`, remote scripts, `innerHTML` with page data.
- **Permissions** are minimal: `activeTab`, `scripting`, `nativeMessaging`, `storage`, `tabCapture`, `offscreen`.
  New ones → `security` skill.
- The background only accepts **requests** from extension pages (`fromExtensionPage`); content scripts may only
  open the `drift-media` port, and only for a tab with a running session.
- Manual mirroring test: `artifacts/clips/test.html` served on `127.0.0.1` (the unpacked id from `extension/dist`
  is `bcdfkknnkmjnopbhjollimphhhdnbeid` on this machine; Chrome derives it from the folder path).
- Host name `io.github.alex_fix.drift` must match `host/src/drift_host/install.py`.

## Tooling

- `npm run check`: Prettier (120 columns), ESLint `strictTypeChecked` + `stylisticTypeChecked`, `tsc --noEmit`,
  Vitest, build. Fix findings; a suppression needs a `--` reason on the same comment.
- Tests use fakes (`FakePort` in `test/native.test.ts`); no Chrome APIs in unit tests. Protocol tests read
  `protocol/fixtures/`.
- Manual run: `npm run build` (or `npm run watch`) → `chrome://extensions` → Developer mode → Load unpacked →
  `extension/dist`; copy the id into `scripts/install-host.sh --extension-id <id>`. Background logs: "service worker"
  link on the extensions page.
