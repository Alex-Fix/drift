# drift

Send the video you're watching in Chrome (or another Chromium browser) to an AirPlay 2 TV — from macOS, Linux or
Windows. One button, **Send to TV**, picks the best way:

- **Play on TV** — when the video has a plain address the TV can fetch (MP4/MOV or HLS), the TV plays it itself, in
  full quality; the browser only sends commands.
- **Mirroring** — for everything else (and when the TV can't play the address), the page's video is encoded with the
  browser's hardware encoder and streamed to the TV: picture and sound in sync, up to 4K.

While the video is on the TV, a remote sits over it on the page (play/pause, ±10 s, **Bring back**), and the popup
shows what's playing with Stats for nerds.

- **Extension** — finds the videos, chooses the mode, captures and encodes when mirroring, and draws the popup and
  the page remote.
- **Host** (`drift-host`) — a small Python program the browser starts on demand. It pairs with the TV and speaks
  AirPlay 2: the playback queue for Play on TV, screen mirroring (encrypted H.264/HEVC video and audio on the TV's
  clock) for the rest.

Nothing leaves your network: no accounts, no cloud, no telemetry. DRM-protected video is never captured.

## What works with it

| Receiver | Status |
|---|---|
| AirPlay 2 TVs with HomeKit pairing (tested: Samsung UCU7000 / UE55CU7100) | ✅ Play on TV (HLS, MP4); mirroring H.264 up to 1080p60, HEVC up to 4K60, sound in sync |
| Apple TV, Macs, other receivers that require FairPlay | ❌ shown as "can't mirror" — drift doesn't implement FairPlay |

Video quality is picked per machine: HEVC 4K60 with a hardware HEVC encoder, otherwise H.264 1080p60 and lower, and it
steps down by itself if the encoder or the network can't keep up.

## Setup

Requirements: Chrome/Edge/Brave/Vivaldi with WebCodecs, Node 24+, [uv](https://docs.astral.sh/uv/) (Python ≥ 3.12).
`scripts/doctor.sh` checks them.

```bash
cd extension && npm ci && npm run build      # chrome://extensions → Developer mode → Load unpacked → extension/dist
cd host && uv sync
scripts/install-host.sh --extension-id <id>  # the id shown on the drift card in chrome://extensions
```

## Using it

1. Play a video in a tab and click the drift icon.
2. Pick your TV under **Your screens**. The first time, click **Pair…** and type the PIN the TV shows.
3. Pick the video under **On this page** — its badge says how it will go: *Full quality · TV streams it* or
   *Mirrored from this tab* — and click **Send to TV**.
4. Drive it from the popup or the remote on the page. **Bring back** stops it on the TV and continues on the page
   where the TV was.

The theme button in the popup's header picks Midnight Glass, Daylight or Neon Cinema; by default drift follows the
system's light or dark setting.

After a session ends, the TV needs up to ~20 seconds before it accepts the next one; drift waits and retries.

## Limitations

- **DRM-protected video** (Netflix, Disney+, …) is never sent.
- **Play on TV** needs an address the TV can fetch on its own: not blob/MSE players (YouTube and most streaming
  sites), not videos that need your login cookies. Those are mirrored. Some MP4 files the TV refuses (e.g. its error
  -12927); drift notices within seconds and mirrors instead.
- When a page doesn't allow capturing the video directly (video from another site without CORS), drift captures the
  tab cropped to the video: anything drawn over the video — the player's controls until they fade, captions — shows
  on the TV too, and the TV holds the picture while the video is scrolled partly out of view.
- One session at a time: sending another video replaces the current one.

## How it fits together

See [`docs/architecture.md`](docs/architecture.md) (diagram and flow) and [`docs/protocol.md`](docs/protocol.md)
(extension ⇄ host messages). The designs and the live findings they rest on are in
[`docs/plans/2026-11-12-airplay-mirroring-design.md`](docs/plans/2026-11-12-airplay-mirroring-design.md) (mirroring)
and [`docs/plans/2026-11-14-play-on-tv-design.md`](docs/plans/2026-11-14-play-on-tv-design.md) (Play on TV, popup,
page remote). The playback-queue recipe follows [airkast](https://github.com/aivanyuk/airkast) (Apache-2.0).

## Development

```bash
scripts/test.sh                 # extension (Vitest) + host (pytest)
scripts/lint.sh                 # Prettier, ESLint, tsc; ruff, mypy; shellcheck
cd host && uv run drift-host scan                                # receivers on the network
cd host && uv run drift-host mirror-file --device <id> clip.mp4  # mirror a pre-encoded clip (--audio sound.wav)
cd host && uv run drift-host stream-url --device <id> <url>      # the TV plays a URL itself (--controls, --seconds)
```

Host logs: `~/Library/Logs/drift/host.log` (macOS), `~/.local/state/drift/log/host.log` (Linux),
`%LOCALAPPDATA%\drift\Logs\host.log` (Windows).

## License

[MIT](LICENSE)
