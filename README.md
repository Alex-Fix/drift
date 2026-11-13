# drift

Mirror the video you're watching in Chrome (or another Chromium browser) to an AirPlay 2 TV — from macOS, Linux or
Windows — with picture and sound in sync, up to 4K.

- **Extension** — captures the page's `<video>` (or, when the page doesn't allow that, the tab cropped to the video),
  encodes it with the browser's hardware encoder and streams it to the host.
- **Host** (`drift-host`) — a small Python program the browser starts on demand. It pairs with the TV and speaks
  AirPlay 2 screen mirroring: encrypted video (H.264 or HEVC) and audio, on the TV's clock.

Nothing leaves your network: no accounts, no cloud, no telemetry. DRM-protected video is never captured.

## What works with it

| Receiver | Status |
|---|---|
| AirPlay 2 TVs with HomeKit pairing (tested: Samsung UCU7000 / UE55CU7100) | ✅ H.264 up to 1080p60, HEVC up to 4K60, sound in sync |
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
2. Pick your TV. The first time, click **Pair…** and type the PIN the TV shows.
3. Click **Mirror** next to the video. The sound moves to the TV; **Stop mirroring** brings it back.

After a session ends, the TV needs up to ~20 seconds before it accepts the next one; drift waits and retries.

## Limitations

- **DRM-protected video** (Netflix, Disney+, …) can't be mirrored.
- When a page doesn't allow capturing the video directly (video from another site without CORS), drift captures the
  tab cropped to the video: anything drawn over the video — the player's controls until they fade, captions — shows
  on the TV too, and the TV holds the picture while the video is scrolled partly out of view.
- One mirroring session at a time.

## How it fits together

See [`docs/architecture.md`](docs/architecture.md) (diagram and flow) and [`docs/protocol.md`](docs/protocol.md)
(extension ⇄ host messages). The design and the live findings it rests on are in
[`docs/plans/2026-11-12-airplay-mirroring-design.md`](docs/plans/2026-11-12-airplay-mirroring-design.md).

## Development

```bash
scripts/test.sh                 # extension (Vitest) + host (pytest)
scripts/lint.sh                 # Prettier, ESLint, tsc; ruff, mypy; shellcheck
cd host && uv run drift-host scan                                # receivers on the network
cd host && uv run drift-host mirror-file --device <id> clip.mp4  # mirror a pre-encoded clip (--audio sound.wav)
```

Host logs: `~/Library/Logs/drift/host.log` (macOS), `~/.local/state/drift/log/host.log` (Linux),
`%LOCALAPPDATA%\drift\Logs\host.log` (Windows).

## License

[MIT](LICENSE)
