# AirPlay mirroring of a page's video — design
Status: approved · Date: 2026-11-12

Supersedes the receiver and transport parts of `2026-11-12-drift-v1-design.md` (draft): v1 is mirroring-first.

## Problem

drift must put a web page's video on the owner's Samsung TV (UCU7000 / UE55CU7100, Tizen, AirPlay SDK 3.5,
AirTunes 377.40) over **AirPlay** — AirPlay itself is the point, not just "video on a TV". Live tests showed the TV
pairs (HAP, PIN on screen) but has **no AirPlay URL playback**: `POST /play` → 404, `PUT /setProperty` → 501. Its
`/info` explains why and what's left:

| Capability (`/info`) | Value |
|---|---|
| Feature bits | `Screen` (7) ✓, `Audio` (9) ✓, `HKPairingAndAccessControl` (46) ✓; `Video` (0) ✗, `VideoFairPlay` (2) ✗; `VideoHTTPLiveStreams` (4) ✓ (see Open questions) |
| Display | 1920×1080 native mirroring, max 3840×2160, max 60 fps |
| Codecs | `avc1.64002a` (H.264 High 4.2 → up to 1080p60), `hvc1.2.4.L153.B0` (HEVC Main10 5.1 → 4K60, SDR/HDR10/HLG) |

So the only AirPlay route for video on this TV is **screen mirroring** — which pyatv doesn't implement.

## Goals / Non-goals

Goals
- Mirror one page's `<video>` (picture + audio, not the page) to the Samsung over AirPlay 2 mirroring.
- Near-native quality: HEVC up to 4K60 with a hardware encoder; otherwise degrade gracefully (H.264 1080p60 and
  lower) on every OS — never refuse just because 4K isn't possible.
- Pause/seek/stop from the popup or the page's own player; the TV follows the page. Pairing from the popup.
- Linux, macOS, Windows; any Chromium browser with WebCodecs.

Non-goals (v1)
- DRM content (EME): detected and refused.
- HDR passthrough (v1 sends SDR), whole-screen/desktop mirroring, DLNA, multiple receivers at once.
- AirPlay URL hand-off for Apple receivers — kept as a later, separate item.

## Constraints check

| Constraint | Answer |
|---|---|
| **MV3** | Content script (`scripting`) does `captureStream()` + WebCodecs. Fallback needs an **offscreen document** + `tabCapture` (new permissions, justified by the blank-capture case). An open native port keeps the worker alive for a session. |
| **Untrusted input** | **Conflict, resolved narrowly:** the content script sends media to the host. Control stays popup-only; media is accepted only for a host-issued session id, size- and bitrate-capped, never decoded by the host. Worst case: a hostile page corrupts the stream the user started, for its own tab. |
| **LAN only** | Host → TV direct; nothing leaves the LAN. The optional WebSocket fallback is `127.0.0.1` only, token-gated. |
| **Cross-platform** | Capture and encoding in the browser (same code on all OSes). Only the hardware-encoder ladder differs (Linux Chrome often lacks HEVC encode → H.264 1080p). |
| **Protocol** | New control messages, one event and a media message — all within `"v": 1` (old peers answer `unknown_type`). |
| **Receivers** | Samsung via mirroring (`Screen`), HAP-paired. Apple TV / Mac mirroring expected to work through the same path (untested). |
| **No DRM** | `captureStream()` fails on EME video; `mediaKeys !== null` is refused up front. |
| **Dependencies** | Our own AirPlay 2 mirroring sender in the host (no OSS sender library assumed). pyatv stays for scan/pair. ffmpeg only for making spike test clips, never at runtime. **Unverified:** that HAP-derived keys suffice without FairPlay `fp-setup` → Phase 0. |

## Chosen approach

Browser-side capture and encoding (WebCodecs) of the `<video>` element; encoded chunks relayed through the service
worker to drift-host over native messaging; the host packages them into an AirPlay 2 screen-mirroring session keyed
from the stored HAP pairing. A time-boxed spike proves the receiver side first.

Not chosen: **DLNA** (the TV supports it, but AirPlay is the point); **AirPlay URL hand-off** (the TV has no URL
playback); **whole-tab / whole-screen capture** (user wants only the video; tab capture survives only as the
blank-capture fallback); **host-side ffmpeg encoding** (heavy raw-frame transfer, ffmpeg dependency); **WebSocket
media channel from the start** (a listening port we may not need — kept as a pre-approved fallback).

## Design

### Phase 0 — go/no-go spike (≈ 2 working days, throwaway code in `artifacts/spikes/`)

1. **Handshake:** with the stored HAP credentials, RTSP `SETUP` a screen stream on the Samsung. Go = TV accepts and
   enters mirroring.
2. **Pixels:** stream a pre-encoded H.264 1080p clip. Go = it plays.
3. **4K:** the same in HEVC 2160p60. Go = it plays (else the ceiling is 1080p60, still in scope).
4. **Audio:** AAC test tone alongside, in sync by ear. Go = it plays.
5. **Throughput:** pump 40 Mbit/s of dummy chunks from an extension page through native messaging. Keep native
   messaging if it sustains ≥ 1.5× the 4K60 target bitrate; otherwise use the WebSocket media channel.

If 1 or 2 fails because FairPlay is required: **stop**, record the evidence here, and re-decide (reverse-engineered
FairPlay — legal/maintenance risk; the TV's HLS video path; DLNA). Nothing is built on a guess.

#### Spike log

- **2026-11-12, step 1 (handshake): GO signal.** HAP pair-verify ok; `SETUP` with `isScreenMirroringSession`
  (no `ekey`/`eiv`, no `fp-setup`) → 200 with `eventPort`, `timingPort`, `uiPreloaded`; event channel connects;
  `SETUP` `streams: [{type: 110}]` with **no key** → 200 with a `dataPort`. The session then dropped within 2 s
  (nothing connected to the data port); an immediate second session also dropped. Open: which key/cipher the TV
  expects for the video stream under HAP (step 2), and the idle timeout.
- **2026-11-12, step 2 (pixels): GO.** A 1080p30 H.264 test pattern (`drift H2`) showed on the Samsung over a
  HAP-only mirroring session. What it took (wire format as documented by
  [airmirror](https://github.com/sleechie/airmirror) `docs/PROTOCOL.md`, MIT, checked against the same AirTunes
  377.40; implemented independently in the spike):
  - SETUP 1 adds `updateSessionRequest: false`, `combinedGetInfoWithControlSetup: true`; the stream SETUP adds
    `latencyMs: 90`, `shk` (32 random bytes), `shiv` (16).
  - Data TCP connection opened **before** `RECORD`; heartbeat packet (type 2, option `1e 00`) every 1 s;
    `POST /feedback` every 2 s.
  - Codec packet: avcC record + trailer `02 00 00 00`, unencrypted.
  - Video: AVCC access unit sealed with **ChaCha20-Poly1305**, key = HKDF-SHA512(pair-verify secret,
    salt `DataStream-Salt<streamConnectionID>`, info `DataStream-Output-Encryption-Key`) — pyatv's
    `verifier.encryption_keys(...)`; nonce = 4 zero bytes + LE64 frame counter; AAD = the 128-byte header;
    length field includes the 16-byte tag.
  - Failed first: plaintext (H0) and UxPlay's AES-CTR schedule keyed by `shk` (H1) — the TV entered mirroring but
    showed no picture. AES-CTR is the FairPlay receivers' path only.
  - Still open: TEARDOWN gets no answer (session ends when the connection closes); not yet tried: HEVC/4K (step 3,
    the TV sets feature bit 42 — multi-codec screen — which suggests HEVC is accepted), audio (step 4), native
    messaging throughput (step 5).
- **2026-11-12, step 5 (native-messaging throughput): GO — keep native messaging, drop the WebSocket fallback.**
  Bench extension page → native host (base64 in JSON, host decodes), M1 Pro Mac, Chrome 157:

  | Profile | Delivered | Host latency p50 / p99 / max | JS per frame avg / worst |
  |---|---|---|---|
  | burst 64 KiB × 2000 | 3.4 Gbit/s | 107 / 191 / 193 ms (queueing) | 0.06 ms |
  | burst 1 MiB × 200 | 3.8 Gbit/s | 88 / 160 / 160 ms (queueing) | 1.4 ms |
  | 4K60, 40 Mbit/s + 10× keyframe each second | 46 Mbit/s | 2.5 / 12.3 / 15.0 ms | 0.53 / 6.7 ms |
  | 2×, 80 Mbit/s + 10× keyframe each second | 92 Mbit/s | 3.7 / 21.1 / 24.4 ms | 0.93 / 12.4 ms |
  | 1080p60, 12 Mbit/s | 14 Mbit/s | 1.4 / 5.1 / 6.2 ms | 0.19 / 1.7 ms |

  Consequence: base64 of a 4K keyframe costs up to ~12 ms on the sending thread — encoding and chunking run in a
  **worker**, never on the page's main thread. Not yet measured: the real path's extra hop (content script →
  service worker → host), Linux and Windows; re-check in the soak test.
- **2026-11-12, step 4 (audio): GO — sound plays, in sync by eye and ear.** 30 s session: video (as step 2) plus a
  1 s flash/beep pattern on a **type-96 realtime audio stream** in the same session. What it took (recipe notes:
  [akustikrausch/airplay2-sender-cpp](https://github.com/akustikrausch/airplay2-sender-cpp) README, Apache-2.0;
  implemented independently, reusing pyatv's RTP/sync packet and cipher classes):
  - Stream SETUP `{type: 96, ct: 2, audioFormat: 0x40000, spf: 352, sr: 44100, latencyMin: 11025,
    latencyMax: 88200, controlPort, shk: 32 random bytes, streamConnectionID}` → 200 with `dataPort`, `controlPort`
    (UDP); sent after the video stream SETUP and before `RECORD`.
  - **Uncompressed ALAC** frames (352 stereo 16-bit samples, 1412 B): MSB-first `3b CPE=1 · 4b 0 · 12b 0 · 1b 0 ·
    2b 0 · 1b isNotCompressed=1 · samples · 3b END=7 · byte-align`.
  - RTP header (12 B; `0xE0` marker on the first packet, then `0x60`; RTP time starts at a random offset and wraps
    at 2³²) + payload sealed with ChaCha20-Poly1305 under `shk`, AAD = header bytes 4–12, then the 8-byte nonce.
  - Sync packet (`0xD4`) to the TV's control port once a second mapping RTP time → NTP on the same clock as the
    video timestamps; RTP `now − latency` in the first field.
  - Event channel answered with a **bare** `200 OK` (`Server`, `CSeq` only): pyatv's `EventChannel` adds
    `Content-Length: 0` and `Audio-Latency: 0`, which the notes report makes receivers render silence (not tried
    with pyatv's reply on this TV).
  - No retransmit requests from the TV. Not yet tested: sessions longer than ~30 s (reported event-channel
    keep-alive timeout) — the soak test covers it.
  - **Design consequence:** no audio encoder anywhere — the browser sends raw PCM (resampled to 44.1 kHz stereo
    s16) and the host wraps it in uncompressed ALAC frames (~1.4 Mbit/s).
- **2026-11-12, step 3 (HEVC 4K60): GO — crisp and smooth.** 12 s of 3840×2160@60 HEVC Main, level 5.1, from
  VideoToolbox (hardware), no B-frames, keyframe every second. Nothing in SETUP announces HEVC: the receiver tells
  the codecs apart by the codec packet alone.
  - Codec packet: option bytes `1e 01`, size floats 3840/2160, payload = the MP4 **`hvc1` sample-entry box**
    (VisualSampleEntry, 86 B, then the `hvcC` box; its VPS/SPS/PPS arrays start at payload offset `0x75`, where
    UxPlay's receiver looks for them). **No** `02 00 00 00` trailer (unlike H.264). The spike lifted the box from an
    in-memory MP4 rather than building `hvcC` by hand.
  - Video packets: MP4 samples (4-byte length-prefixed NALs, SEI prefix before the IDR) sealed exactly as for H.264.
  - Caveat: the simple pattern only needed ~1.2 Mbit/s, so this proves decode and display of 4K60, not bandwidth
    (step 5 covers throughput; the soak test will cover real 4K content over the TV's network link).

**Phase 0 result (2026-11-12): GO on all five steps.** No FairPlay; native messaging; H.264 up to 1080p60 and HEVC
up to 4K60; uncompressed-ALAC audio in sync. Implementation starts at step 2.

### User flow

1. Open a page with a video, click drift.
2. Popup lists videos (DRM ones greyed with the reason) and receivers; unpaired ones show **Pair…** (PIN typed in
   the popup).
3. **Mirror to TV** → the popup shows the active quality ("HEVC 4K60 · hardware", "H.264 1080p60 · no HEVC
   encoder").
4. Pause/seek from the popup or the page; the TV follows the page.
5. Tab close, navigation, or **Stop** ends the session; the TV leaves mirroring.

### Architecture and data flow

```
page <video> ── captureStream() ──► worker: VideoEncoder (WebCodecs) + raw PCM audio (44.1 kHz s16)
                                         │ encoded chunks (media channel, one-way, session-gated)
popup ── control (start/stop/pair) ──► service worker ══ native messaging (WS fallback) ══► drift-host
                                                                                              │ mirror/
                                                         Samsung ◄── AirPlay 2 screen stream
                                                         (RTSP SETUP · encrypted video stream · RTP audio · timing)
```

- **Extension:** capture + encode in the content script (raw frames never leave the page process). Fallback when
  `captureStream()` yields blank/muted tracks (cross-origin players): offscreen document + `tabCapture`, cropped to
  the video's on-screen rectangle. The service worker relays chunks and owns the port.
- **Host, new package `drift_host/mirror/`:** `session.py` (RTSP screen-stream SETUP/TEARDOWN, keys from pairing),
  `video.py` (frame + encrypt the video stream), `audio.py` (AAC → realtime RTP), `timing.py` (one clock for A/V).
  `airplay.py` keeps discovery and pairing.

### Quality ladder

Chosen at start via `VideoEncoder.isConfigSupported()`, hardware first:
HEVC 2160p60 → HEVC 1440p60 → H.264 1080p60 → H.264 720p60 → H.264 720p30. Capped by the source's real size (no
upscaling) and the TV's `/info` `displays` limits. If the encoder falls behind (growing queue), step down one rung
mid-stream and tell the popup. Audio: raw PCM from the browser, 44.1 kHz stereo s16, wrapped by the host in
uncompressed ALAC on the type-96 stream (Phase 0 step 4) — no audio encoder.

### Error handling

New codes: `mirror_unsupported` (receiver lacks `Screen`), `encoder_unavailable` (nothing on the ladder works),
`capture_failed` (blank capture and fallback failed), `session_unknown` (media for a session the host didn't issue).
`pairing_required` reuses the existing code and opens the popup's PIN prompt.

## Protocol changes

| Message | Direction | Fields |
|---|---|---|
| `pair_begin` → `ok` | popup → host | `device` |
| `pair_pin` → `ok` | popup → host | `device`, `pin` (4–8 digits) |
| `mirror_start` → `mirror_started` | popup → host | `device`, `video {codec, width, height, fps}`, `audio {format: "pcm_s16", rate: 44100, channels: 2}` → `session` (random, 128-bit) |
| `mirror_stop` → `ok` | popup → host | `session` |
| `mirror_status` (event) | host → popup | `session`, `state`, `codec`, `width`, `height`, `fps`, `dropped` |
| `media` (no response) | content script → host | `session`, `track` (`video`/`audio`), `ts`, `key`, `data` (base64, ≤ 2 MiB decoded) |

All within `"v": 1`; fixtures for each shape and each new rule.

## Security notes

- Media is the **only** thing a content script may send, and only for an active, host-issued session id bound to the
  tab that started it; everything else from a content script is dropped by the service worker.
- The host never parses media payloads (it frames and encrypts opaque bytes); per-chunk size cap and per-session
  bitrate ceiling bound memory and CPU.
- Pairing PIN travels popup → host only; credentials stay in the owner-only file and never reach the extension.
- WebSocket fallback (if chosen): `127.0.0.1`, random port, one-time token passed over native messaging, closed with
  the session.
- DRM refused before capture. Logs: session ids, codecs, sizes — never URLs, titles or media.
- Update the `security` skill with the media-channel exception and the review checklist item for it.

## Testing

- **Host (pytest, no network):** golden-byte tests for SETUP bodies, video framing/encryption (fixed keys and nonces),
  RTP audio packets, timing; a fake TV (asyncio TCP server) for session lifecycle incl. the TV dropping the
  connection.
- **Extension (Vitest):** ladder selection with a fake `isConfigSupported`, chunk framing and limits, session gating;
  fixtures for every new message.
- **Bench:** the spike's throughput measurement kept as `npm run bench:native`.
- **Manual matrix:** Samsung × {YouTube, Vimeo, plain MP4, HLS page} × {Mac HEVC 4K60, Linux H.264 1080p}; A/V sync
  by ear; 30-minute soak for drift and drops.

## Open questions

1. ~~Does the TV accept HAP-keyed mirroring without FairPlay `fp-setup`?~~ Yes (Phase 0, steps 1–2).
2. ~~Does native messaging sustain ≥ 1.5× the 4K60 bitrate?~~ Yes (Phase 0, step 5: 2× held, ~85× burst headroom).
3. ~~Which audio formats does the TV accept on the mirroring path?~~ Uncompressed ALAC on a type-96 stream, in
   sync (Phase 0, step 4). Compressed codecs not needed.
4. The TV sets `VideoHTTPLiveStreams` and reports an HLS-capable web engine: is there a newer AirPlay video path that
   would let it fetch HLS itself at full quality? Research item, not on the v1 path.
5. HDR10 passthrough for HDR sources — after v1.

## Implementation steps

Branch `feat/airplay-mirroring`, one commit (or small PR) each:

1. ~~Phase 0 spike; record go/no-go results in this doc.~~ Done 2026-11-12: GO on all five steps (spike log above).
2. Host: `mirror/session.py` — RTSP screen-stream setup/teardown + fake-TV tests.
3. Host: video framing + encryption with golden tests; `drift-host mirror-file <clip>` plays a pre-encoded clip.
4. Host: audio + timing; the CLI clip plays with sound in sync.
5. Protocol: new messages on both sides, fixtures, `docs/protocol.md`.
6. Extension: capture + WebCodecs encoding + quality ladder in the content script; media channel.
7. Popup: mirror flow, pairing UI, status.
8. Tab-capture fallback (offscreen document) for blank `captureStream()`.
9. Mid-stream step-down, 30-minute soak, README.
10. ~~Localhost WebSocket media channel~~ — not needed (Phase 0 step 5: native messaging sustains 2× the 4K60 target).
