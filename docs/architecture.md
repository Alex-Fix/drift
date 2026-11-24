# Architecture

drift sends a page's `<video>` to an AirPlay 2 receiver in one of two ways, chosen per video
(`background/cast.ts`):

- **Play on TV** — the video has an http(s) MP4/MOV or HLS address: the TV fetches and plays it itself through the
  AirPlay 2 playback queue; drift only sends commands and reads status.
- **Mirroring** — anything else, or when the TV can't play the address: the browser encodes the video and drift
  streams it as AirPlay 2 screen mirroring.

Designs and live findings: [`plans/2026-11-12-airplay-mirroring-design.md`](plans/2026-11-12-airplay-mirroring-design.md)
(mirroring), [`plans/2026-11-14-play-on-tv-design.md`](plans/2026-11-14-play-on-tv-design.md) (Play on TV, popup,
page remote); messages between the extension and the host: [`protocol.md`](protocol.md).

## Play on TV

```
 Browser                                   drift-host                          AirPlay 2 TV            video's server
┌──────────────────────────────┐  stdio   ┌────────────────────────────┐      ┌──────────────┐  HTTP  ┌────────────┐
│ popup / page remote ─────────┼─────────►│ streaming.py               │ RTSP │ playback     │◄───────│ MP4 / HLS  │
│  stream_start / _control /   │  JSON    │  one session, 1 s status,  │─────►│ queue: plays │        └────────────┘
│  _stop                       │          │  8 s start deadline        │ /com-│ the URL      │
│ ◄── stream_status (state,    │◄─────────┤ playback.py                │ mand │              │
│     position, buffer)        │          │  type-130 stream, commands │◄─────┤ event channel│
│ page video paused, remote    │          │  answers + notifications   │      │ (answers,    │
│ over it                      │          │  from the event channel    │      │ state, error)│
└──────────────────────────────┘          └────────────────────────────┘      └──────────────┘
```

1. **Send to TV.** The background reads the video again in its frame, refuses DRM, and sends `stream_start`.
2. **Load.** The host pair-verifies, opens the event channel, sets up a type-130 stream and queues the URL
   (`insertPlayQueueItem`), then plays it. Answers and the TV's notifications arrive on the event channel.
3. **On the TV.** The page's video is paused and the remote covers it. `stream_status` goes out on every state
   change and once a second with position, length and buffer.
4. **Fallback.** If the TV refuses the address (`stream_failed`), reports an error for it, or isn't playing 8 s
   after the load, and the stream never played, the background mirrors the same video instead.
5. **Bring back / Stop.** `stream_stop`; Bring back then resumes the page's video where the TV was.

## Mirroring

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
│  popup: receiver · Pair (PIN) · Send · Stop    (media only │ JSON │   + sealed frames       │     │            │
│   ◄─── mirror_status (state, quality, drops)    from the   │      │  audio.py   ALAC + RTP  │────►│ UDP audio  │
│                                                 session's  │      │   + sync packets        │     │            │
│                                                 tab)       │      │ airplay.py (pyatv):     │◄───►│ mDNS, pair,│
│                                                            │      │  scan, pair, verify     │     │ NTP timing │
└────────────────────────────────────────────────────────────┘      └─────────────────────────┘     └────────────┘
```

### A mirroring session

1. **Popup → Send to TV** (a video the TV can't fetch itself). The background injects `capture.js` into the video's frame, which checks DRM and picks the
   best encoder rung the machine supports.
2. **`mirror_start`.** The host pair-verifies with the TV and sets up the screen and audio streams (retrying while
   the TV releases a previous session).
3. **Media.** The page (or the offscreen tab capture) encodes; `video`/`audio` notifications go page → background →
   host → TV. Sound plays on the TV only.
4. **Status.** The host reports `mirror_status`; when it drops frames, the extension lowers the quality.
5. **Stop.** Popup, page remote, tab close or the TV: stream TEARDOWN, session closed.

The page remote covers the video while mirroring from the page (the TV gets the element's frames, not the screen) and
docks below or above it in tab capture (the TV gets that part of the screen).

## Extension (`extension/src/`)

- `background/` — owns the native port (`native.ts`), the mode choice and fallback decisions (`cast.ts`), the
  session ↔ tab binding and media gate (`mirror.ts`), the remote's action gate (`overlay.ts`), the bitrate meter
  (`meter.ts`), and orchestration (`index.ts`).
- `content/` — `candidates.ts` (finds videos), `capture.ts` (page path; placement reporting for the fallback),
  `page.ts` (pause/resume the page's video), `overlay.ts` + `overlay-layout.ts` (the page remote).
- `offscreen/` — the tab-capture fallback.
- `capture/` — the shared pipeline and its pure helpers (ladder, step-down, clock, crop, sizing, PCM).
- `popup/` — the UI (three themes, cards, now playing, Stats for nerds); decisions in `model.ts`.
- `protocol.ts` — message types and validation (mirrors the host).

## Host (`host/src/drift_host/`)

- `messaging.py` — length-prefixed stdio framing with size limits; stdout is reserved for messages.
- `protocol.py` — message validation (mirrors the extension).
- `app.py` — dispatch: requests as tasks, media inline; two-step pairing; one session across both kinds.
- `mirroring.py` — one mirroring session: queue, drops, timestamps, status and stats.
- `streaming.py` — one Play on TV session: status polling, start deadline, failures.
- `playback.py` — the AirPlay 2 playback queue over a `Control`: load, pause/resume, seek, info, stop.
- `retry.py` — retrying a receiver that is still releasing the previous session.
- `mirror/` — AirPlay 2 mirroring: `session.py` (lifecycle over a `Control`), `pyatv_control.py` (the real
  `Control` on pyatv internals, including `/command` and the decoded event channel), `packets.py`, `video.py`,
  `audio.py`, `clock.py`, `mp4.py` (for `mirror-file`).
- `airplay.py` — receivers through pyatv: scan (with mirror/paired flags), pairing, control channels for mirroring
  and for playback.
- `install.py` — native-messaging manifest + launcher per OS and browser.

## Lifecycle

The browser starts `drift-host` when the service worker connects and stops it when the port closes, which ends any
session. While mirroring, the media port keeps the service worker alive; while a stream plays, the open native port
and the host's status every second do.
