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
- `src/protocol.ts` — mirrors the host; see the `protocol` skill.

## Rules

- **MV3 lifetime.** The service worker can stop any time: no state that matters lives in module variables beyond
  the port and pending requests; session state lives in the host. Event listeners are registered synchronously at
  top level.
- **No runtime dependencies** without approval; no `eval`, `new Function`, remote scripts, `innerHTML` with page data.
- **Permissions** are minimal (`activeTab`, `scripting`, `nativeMessaging` today). New ones → `security` skill.
- The background only accepts messages from extension pages (`fromExtensionPage`).
- Host name `io.github.alex_fix.drift` must match `host/src/drift_host/install.py`.

## Tooling

- `npm run check`: Prettier (120 columns), ESLint `strictTypeChecked` + `stylisticTypeChecked`, `tsc --noEmit`,
  Vitest, build. Fix findings; a suppression needs a `--` reason on the same comment.
- Tests use fakes (`FakePort` in `test/native.test.ts`); no Chrome APIs in unit tests. Protocol tests read
  `protocol/fixtures/`.
- Manual run: `npm run build` (or `npm run watch`) → `chrome://extensions` → Developer mode → Load unpacked →
  `extension/dist`; copy the id into `scripts/install-host.sh --extension-id <id>`. Background logs: "service worker"
  link on the extensions page.
