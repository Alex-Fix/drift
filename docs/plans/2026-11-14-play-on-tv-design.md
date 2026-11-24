# Play on TV, a remote on the page, and a new popup — design
Status: approved · Date: 2026-11-14

## Problem

drift v1 mirrors: the browser plays the video, encodes it and streams it to the TV. That works for any non-DRM video,
but it re-encodes the picture and keeps the computer busy for as long as the video plays. Many pages play a plain
MP4/HLS file the TV could fetch itself. It would then play in full quality, and the computer would only send
commands. Separately, the popup is plain, and the page gives no sign that the video is playing on the TV.

## Goals / Non-goals

Goals
- **Send to TV**: one button per video. **Streaming** (the TV fetches the URL) when the video has an http(s) MP4/MOV/
  HLS address. **Mirroring** otherwise, and as an automatic fallback when the TV can't play the URL.
- **A remote on the page**: while the video is on the TV, an overlay on the page shows "Playing on …" with progress,
  play/pause, ±10 s and **Bring back**, which stops on the TV and resumes on the page at the TV's position.
- **A new popup**: the three looks from the mockups (Midnight Glass, Daylight, Neon Cinema) as themes. The popup
  follows the system light/dark setting by default, with a picker to pin one. It gets a now-playing card and **Stats
  for nerds** (live session numbers).

Non-goals
- YouTube and sites whose videos have no fetchable address (MSE/blob). They keep mirroring; no site-specific
  extractors.
- Login- or cookie-protected URLs (the TV fetches without the browser's cookies). These fall back to mirroring; a
  relay is not planned.
- Apple receivers (Mac, Apple TV): separate work (FairPlay vs HomeKit findings, 2026-11-14).
- Session history, accent pickers, multiple sessions at once.

## Constraints check

| Constraint | This design |
|---|---|
| **MV3** | Overlay injected with `scripting` into the video's frame (`activeTab`). The theme choice lives in `chrome.storage.local` (`storage` permission already granted). No new permissions. |
| **Untrusted input** | A page can't make the host fetch anything: the **TV** fetches the URL. The host passes on only `http(s)` URLs with a host, checked as in `protocol.py`. A hostile page could point the TV at a LAN address; that's the TV's own fetch, as with any AirPlay sender (noted in security). Overlay: closed Shadow DOM, `textContent` only, no page data as HTML. |
| **LAN only** | Commands go host → TV on the LAN. The TV talks to the video's server directly. |
| **Cross-platform** | Nothing OS-specific is added. |
| **Protocol** | New messages `stream_start` / `stream_started`, `stream_control`, `stream_stop` and `stream_status`. The old `play` / `control` / `stop` / `status` (pyatv's `/play`, refused by the Samsung and unused since step 7) are **removed**. Strictly a breaking change within `"v": 1`, accepted because the extension and host ship together and nothing outside this repository uses them. |
| **Receivers** | Samsung UCU7000: the playback queue was verified live on 2026-11-14 (type-130 stream + `POST /command`). Formats are the TV's (HLS, MP4/H.264/HEVC, AAC). |
| **No DRM** | Unchanged: DRM videos are neither streamed nor mirrored. |
| **Dependencies** | None new. The playback-queue recipe comes from airkast (Apache-2.0, `DefaultVideoSession.kt`), implemented independently and credited. |

## Chosen approach

Use the AirPlay 2 playback queue (`insertPlayQueueItem` and friends over `POST /command` on a type-130 stream). Your
TV accepts it, and it's what Apple senders and airkast use. Why not the alternatives:
- `POST /play`: the Samsung answers 404.
- DLNA: AirPlay is the point.
- A relay: out of scope.

## Design

### Host: the playback engine (`drift_host/playback.py`)

- **Session start** reuses `PyatvControl`: pair-verify, timing server, and the event channel answered with a bare
  200. The session `SETUP` has no `isScreenMirroringSession` and uses NTP timing. Then `RECORD`, then `SETUP`
  `streams: [{type: 130, controlType: 1, clientTypeUUID: "A6B27562-B43A-4F2D-B75F-82391E250194",
  channelID: "<deviceId>-RCS-1", clientUUID}]` → `streamID`.
- **Commands** are `POST /command` over HTTP/1.1 on the control connection. Headers: `X-Apple-ProtocolVersion: 1`,
  `X-Apple-Session-ID`, `X-Apple-StreamID`. Body: a binary plist `{params: {data: <binary plist payload>}}`.
  - `load(url, media_type, start)`: `insertPlayQueueItem {uuid, mediaType: "file"|"streaming", Content-Location,
    Start-Position (CMTime)}`, then `setProperty isInterestedInDateRange`, `setProperty actionAtItemEnd`, and
    `setRate 1`.
  - `pause` / `resume`: `setRate 0/1`. `seek(seconds)`: `seek {time, toleranceBefore: 0, toleranceAfter: 0,
    item: {uuid}}`. `info()`: `playbackInfo`. `stop()`: `stop`, then TEARDOWN as in mirroring.
- **Replies come on the event channel, not in the HTTP response.** The response to `POST /command` is only an
  acknowledgement (an empty plist). A command that expects an answer (`playbackInfo`, `seek`) carries
  `kind: "request"` and a `messageID`. The TV then sends `POST /command` on the event channel with
  `{kind: "response", messageID, …}`.
- The event channel also carries the TV's **notifications**: `playbackState` (`loading` / `playing` / `paused`, with
  full info when playing), `timeJumped`, `rateChanged`, `loadedTimeRangesChanged`, `playbackLikelyToKeepUp`,
  `currentItemChanged`, `itemPlayedToEnd`. So the bare event channel becomes a decoding one: it still answers with a
  bare 200, and it passes decoded messages to the session (bounded size, unknown types ignored).
- `Control` gains `command(payload)` (headers, HTTP/1.1, binary-plist body) with the same error mapping as
  `request`, plus a callback for decoded event-channel messages.

### Host: sessions (`mirroring.py` → one manager for both modes)

- **One session at a time**, mirror or stream; starting one ends the other. Both kinds share the retry while the TV
  releases a session (up to 30 s).
- **Stream status**: state changes come from `playbackState` / `itemPlayedToEnd` notifications and are sent at once.
  Once a second the host also asks `playbackInfo` for position, duration and buffered-ahead (from `loadedTimeRanges`),
  and emits `stream_status` (`loading` | `playing` | `paused` | `ended` | `failed`). A TV error, or not `playing`
  within 8 s of `load`, makes it `failed`.

### Extension

- **Mode choice** (background): a candidate with an http(s) URL ending in or typed as MP4/M4V/MOV/HLS → `stream`.
  Anything else → `mirror`. If the stream reaches `failed` before it starts playing → stop it and start mirroring the
  same video, and the popup says "Streaming wasn't possible, mirroring instead".
- **Page during streaming**: the background pauses the page's video (through the injected script) and shows the
  overlay. **Bring back** stops the stream, seeks the page's video to the last reported position and plays it.
- **Overlay** (`content/overlay.ts`, injected with the capture script): a closed Shadow DOM element positioned over
  the video, following it as in the tab-capture placement tracking. Its controls go through the background:
  streaming → `stream_control`; mirroring → the page's own video, which the TV mirrors. In tab-capture mirroring it
  docks below the video, outside the crop.
- **Popup**: rebuilt to the mockups (canvas "drift popup directions").
  - **Themes** are CSS custom properties per theme. The default follows `prefers-color-scheme` (Midnight Glass /
    Daylight); a picker adds Neon Cinema and pins a choice in `chrome.storage.local`.
  - **Receiver cards**: unusable receivers are greyed out with the reason. **Video cards** show the poster as a
    thumbnail when the page has one, and a mode badge. **Now-playing card**: progress, play/pause, ±10 s, Bring back.
  - **Stats for nerds** (collapsed by default). Streaming: state, position, duration, buffered ahead. Mirroring:
    codec, size, fps, a bitrate graph over the last 60 s (SVG sparkline), dropped and skipped frames, page cost.
- Popup decisions stay in `popup/model.ts`, unit-tested.

## Protocol changes

| Message | Direction | Fields |
|---|---|---|
| `stream_start` → `stream_started` | extension → host | `device`, `url` (http/https), `media_type` (`file` \| `streaming`), `position?` (s) → `session` |
| `stream_control` → `ok` | extension → host | `session`, `action` (`pause` \| `resume` \| `seek`), `position?` (required for `seek`) |
| `stream_stop` → `ok` | extension → host | `session` |
| `stream_status` (event) | host → extension | `session`, `state` (`loading` \| `playing` \| `paused` \| `ended` \| `stopped` \| `failed`), `position?`, `duration?`, `buffered?` (s ahead), `reason?` (error code) |

Removed: `play`, `control`, `stop`, `status`. New error code: `stream_failed`. `stopped` (added in step 3) is the end
of the session — `stream_stop`, replaced by another session, or the receiver left — as `mirror_status` has it;
`ended` is the video reaching its end with the session still open.

## Security notes

- URLs: `http(s)` with a host only, validated on both sides as today. The host never fetches them; the TV does. A
  hostile page could make the TV request a LAN address. That's inherent to AirPlay video for any sender; noted in the
  `security` skill.
- Overlay: closed Shadow DOM, built with DOM APIs, `textContent` only. Clicks go to the background as fixed commands
  for the tab's own session; the page can't send them. Page titles are shown as text, never markup.
- Logs: session ids, states and codes only, never URLs or titles.

## Testing

- **Host**: the fake TV learns type-130 SETUP and `/command`, with recorded payloads and scripted `playbackInfo`.
  Tests cover load sequence and payload shapes, pause/resume/seek/stop, status polling and `failed` detection, the
  replace-session rules, and retry.
- **Protocol**: fixtures for every new message and rule; removed messages leave the fixtures.
- **Extension**: mode choice, fallback decisions, theme resolution, stats formatting and the sparkline data in
  `model.ts`; the overlay's placement math reuses `crop`-style helpers.
- **Live**: streaming a plain MP4 and an HLS page (pause, seek, Bring back), a cookie-protected or refused URL falling
  back to mirroring, mirroring with the overlay in both capture modes, and the three themes.

## Open questions

Settled by the step 1 spike (2026-11-14, Samsung UCU7000, Apple's bipbop HLS):
1. ~~Is `playbackInfo` informative enough?~~ Yes, once read from the event channel (see Design): `rate`,
   `position`, `duration`, `loadedTimeRanges`, `seekableTimeRanges`, `playbackState`, `playbackLikelyToKeepUp`,
   dropped/total video frames.
2. ~~Does the Samsung send playback events?~~ Yes: see the notification list in Design. Pause (`setRate 0`) →
   `playbackState paused` at once; `seek` to 60 s → a response with `position` 60000; resume → `playing` from 60 s;
   `stop` → 200.

Still open:
- Whether `itemPlayedToEnd` arrives on the Samsung (the spike stopped before the end). Fallback: position ≥ duration
  − 1 s while not playing counts as `ended`.

## Implementation steps

1. ~~Spike follow-up (live): decode `playbackInfo`, try pause, seek and stop, and record the results here.~~ Done
   2026-11-14 (Open questions, Design).
2. ~~Host: `playback.py` + `Control` command support + fake-TV tests.~~ Done 2026-11-14. `playback.py`:
   `PlaybackSession` (start, load, pause/resume, seek, info, stop), with answers matched by `messageID`, state from
   `playbackState`/`itemPlayedToEnd`, `taken` once the TV names the item, and `ended` when the TV closes the event
   channel. `Control` gains `command()` and event callbacks; `pyatv_control.decode_event` decodes event messages, plain
   or wrapped in `params.data`, up to 256 KiB. The fake TV answers requests on its event channel. Not run on the TV
   yet (the user asked to hold live tests).
3. ~~Protocol: the `stream_*` messages, the old ones removed, fixtures, `docs/protocol.md`.~~ Done 2026-11-14. Also
   removed pyatv's `/play` path (`Receivers.play/control/stop`); the host refuses a request it has no handler for
   with `unknown_type` until step 4 handles `stream_*`.
4. ~~Host: one session manager for both modes, status polling, `failed` detection.~~ Done 2026-11-14, as two managers
   rather than one: `streaming.py` (`Streaming`) next to `mirroring.py`, with `Host` keeping one session across both
   (starting either kind closes the other) and the retry loop shared in `retry.py`. `stream_status` goes out on every
   state change and once a second with position/duration/buffer; `failed` (`stream_failed`) when not playing 8 s after
   the load, `stopped` with `stream_failed` when the receiver leaves; `ended` from `itemPlayedToEnd`, or when polled
   within 1 s of the end while not playing. `Receivers.open_playback` connects without the mirroring feature check.
   Not run on the TV yet (live tests on hold).
5. ~~Extension: background mode choice, stream orchestration, fallback, Bring back.~~ Done 2026-11-14.
   `background/cast.ts` (unit-tested) chooses the mode, by path (`.m3u8`, `.mp4`/`.m4v`/`.mov`) or by the
   `<source type>` the page gives (`candidates.ts` now reports it), and decides fallbacks: `stream_start` answered
   `stream_failed`, or a stream that is `failed`/dropped before it ever played, mirrors the same video instead; once
   it has played, a failure just ends it. The popup's single call is `send`, and the background pauses the page video
   once the stream starts (`content/page.ts`, injected functions). `bring_back` stops the stream and resumes the page
   at the receiver's last position. Interim popup: a "Send to TV" button with a hint saying how it will be sent, a
   stream summary (state, time, buffer), and Bring back/Stop; receivers that can't mirror are selectable, since they
   may still stream. The full popup comes in step 6. Not run in the browser or on the TV yet.
6. ~~Popup rebuild: themes, cards, now-playing, Stats for nerds.~~ Done 2026-11-24.
   - **Themes:** Midnight Glass, Daylight and Neon Cinema are CSS custom properties. Without a choice the popup
     follows the system; the picker in the header pins one (`theme` in `chrome.storage.local`).
   - **Fonts:** the mockups' fonts (Inter, Space Grotesk) are used when installed, else system fonts. Nothing is
     loaded from Google Fonts (no third-party servers).
   - **Cards:** receivers are a radio group; ones that can't mirror are dashed but selectable, since they may
     stream. Videos show the page's poster (http(s), no referrer) with their length and a mode badge.
   - **Now playing:** Playing/Paused/Loading with a pulsing dot while waiting, progress with the buffer ahead,
     ±10 s and play/pause, Bring back and Stop.
   - **Stats for nerds:** a collapsible panel, its open state remembered. Streaming shows state, format, position,
     length and buffer. Mirroring shows quality, bitrate (a 60 s sparkline from `background/meter.ts`, which counts
     the video bytes the background forwards), host drops, encoder skips, page cost and sound.
   - Decisions are in `popup/model.ts`, unit-tested. All three themes were checked in headless Chrome against the
     mockups, with a stubbed `chrome`.
7. ~~Page overlay (remote) for streaming and both mirroring modes.~~ Done 2026-11-24.
   - **The remote:** `content/overlay.ts`, injected as `overlay.js` into the video's frame. It is a closed shadow
     root built with DOM APIs, only trusted clicks count, and it uses the popup's theme (`theme` in storage, or the
     system's).
   - **Placement** (`content/overlay-layout.ts`, unit-tested): over the video for streaming and page-path
     mirroring; a 56 px bar below the video (above if no room, hidden if neither fits) in tab-capture mirroring,
     so the TV never shows it. It follows scrolls, resizes and fullscreen containers. Small videos drop the tile
     and the ±10 s buttons.
   - **Streaming:** the page's video is kept paused. The buttons go to the background as
     `{kind: "drift-overlay-action", action}`, with actions `toggle`/`back`/`forward`/`bring_back`. That is the
     one message the background takes from a content script besides media, and only from the frame it put this
     tab's remote in (`background/overlay.ts`).
   - **Mirroring:** the buttons drive the page's video directly. `bring_back` stops mirroring, and the capture
     unmutes the video.
   - Checked in headless Chrome with a stubbed `chrome`, in all modes and themes and on a small video.
8. Live checks, README, architecture, security skill.
