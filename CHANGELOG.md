# Changelog

All notable changes to drift. The extension and the host share one version
([semantic versioning](https://semver.org/)); the format follows [Keep a Changelog](https://keepachangelog.com/).

## [Unreleased] — to be 1.0.0

The first public release.

### Added
- **Send to TV**: one button picks the best way to get a page's video onto an AirPlay 2 TV.
- **Play on TV**: when the video has an http(s) MP4/MOV or HLS address, the TV fetches and plays it itself, in full
  quality (AirPlay 2 playback queue). Pause, seek, ±10 s, replay after the end, and live position, length and
  buffer.
- **Mirroring** for everything else: the page's video encoded with the browser's hardware encoder (HEVC up to 4K60,
  H.264 up to 1080p60) with sound on the TV only; tab capture cropped to the video when the page doesn't allow
  capturing it directly; quality steps down by itself when the computer or network can't keep up.
- **Automatic fallback** to mirroring when the TV can't play a video's address.
- **Popup** with three themes (Midnight Glass, Daylight, Neon Cinema; follows the system by default), receiver and
  video cards, a now-playing card with a seekable progress bar, and Stats for nerds (position and buffer when
  streaming; quality, a bitrate graph, drops and page cost when mirroring).
- **A remote on the web page** over the video (docked below it in tab capture, so the TV never shows it):
  play/pause, ±10 s, seeking, and Bring back, which continues on the page where the TV was.
- **Pairing** with AirPlay receivers from the popup (PIN shown on the TV).
- **Icons** ("Holo frame").
- `drift-host` developer commands: `scan`, `pair`, `mirror-file`, `stream-url`, `install`/`uninstall`.

### Security
- DRM-protected video is never captured or sent. Nothing leaves the local network: no accounts, no telemetry.
- The host validates every message; only http(s) URLs reach a receiver; pairing credentials are stored owner-only.

[Unreleased]: https://github.com/Alex-Fix/drift/commits/main
