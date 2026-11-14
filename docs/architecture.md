# Architecture

drift mirrors a page's `<video>` to an AirPlay 2 receiver. Design and live findings:
[`plans/2026-11-12-airplay-mirroring-design.md`](plans/2026-11-12-airplay-mirroring-design.md); messages between
the extension and the host: [`protocol.md`](protocol.md).

```
 Browser (Chromium, MV3)                                             drift-host (Python)              AirPlay 2 TV
┌────────────────────────────────────────────────────────────┐      ┌─────────────────────────┐     ┌────────────┐
│  web page                                                  │      │ app.py                  │     │            │
│   <video> ──captureStream()──┐  (muted locally)            │      │  requests → tasks       │     │            │
│                              ▼                             │      │  media → inline, in     │     │            │
│  content script (capture.js, page thread)                  │      │          arrival order  │     │            │
│   pipeline: frames → VideoEncoder (H.264 / HEVC)           │      │ mirroring.py            │     │            │
│             sound → AudioContext 44.1 kHz → PCM            │      │  one session, queue,    │     │            │
│             → video / audio notifications ─────┐           │      │  drop-to-keyframe, NTP  │     │            │
│                                                │           │      │ mirror/                 │     │            │
│  fallback (captureStream refused):             │           │      │  session.py  SETUP,     │────►│ RTSP over  │
│  offscreen document: tab capture cropped to ───┤           │      │   RECORD, heartbeat,    │ HAP │ ChaCha20   │
│  the video (page script reports its position)  ▼           │ stdio│   feedback, TEARDOWN    │     │            │
│                              background service worker ────┼═════►│  video.py   avcC / hvc1 │────►│ TCP video  │
│  popup: receiver · Pair (PIN) · Mirror · Stop  (media only │ JSON │   + sealed frames       │     │            │
│   ◄─── mirror_status (state, quality, drops)    from the   │      │  audio.py   ALAC + RTP  │────►│ UDP audio  │
│                                                 session's  │      │   + sync packets        │     │            │
│                                                 tab)       │      │ airplay.py (pyatv):     │◄───►│ mDNS, pair,│
│                                                            │      │  scan, pair, verify     │     │ NTP timing │
└────────────────────────────────────────────────────────────┘      └─────────────────────────┘     └────────────┘
```

## A mirroring session

1. **Popup → Mirror.** The background injects `capture.js` into the video's frame, which checks DRM and picks the
   best encoder rung the machine supports.
2. **`mirror_start`.** The host pair-verifies with the TV and sets up the screen and audio streams (retrying while
   the TV releases a previous session).
3. **Media.** The page (or the offscreen tab capture) encodes; `video`/`audio` notifications go page → background →
   host → TV. Sound plays on the TV only.
4. **Status.** The host reports `mirror_status`; when it drops frames, the extension lowers the quality.
5. **Stop.** Popup, tab close or the TV: stream TEARDOWN, session closed.

## Extension (`extension/src/`)

- `background/` — owns the native port (`native.ts`), the session ↔ tab binding and media gate (`mirror.ts`),
  orchestration and the fallback (`index.ts`).
- `content/` — `candidates.ts` (finds videos), `capture.ts` (page path; placement reporting for the fallback).
- `offscreen/` — the tab-capture fallback.
- `capture/` — the shared pipeline and its pure helpers (ladder, step-down, clock, crop, sizing, PCM).
- `popup/` — the UI; decisions in `model.ts`.
- `protocol.ts` — message types and validation (mirrors the host).

## Host (`host/src/drift_host/`)

- `messaging.py` — length-prefixed stdio framing with size limits; stdout is reserved for messages.
- `protocol.py` — message validation (mirrors the extension).
- `app.py` — dispatch: requests as tasks, media inline; two-step pairing.
- `mirroring.py` — one mirroring session: queue, drops, timestamps, retries, status and stats.
- `mirror/` — AirPlay 2 mirroring: `session.py` (lifecycle over a `Control`), `pyatv_control.py` (the real
  `Control`, on pyatv internals), `packets.py`, `video.py`, `audio.py`, `clock.py`, `mp4.py` (for `mirror-file`).
- `airplay.py` — receivers through pyatv: scan (with mirror/paired flags), pairing, URL playback (not offered by the
  popup in v1: the Samsung has no URL playback).
- `install.py` — native-messaging manifest + launcher per OS and browser.

## Lifecycle

The browser starts `drift-host` when the service worker connects and stops it when the port closes, which ends any
mirroring session. While mirroring, the media port keeps the service worker alive.
