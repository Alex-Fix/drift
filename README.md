# drift

Stream the video you're watching in Chrome, Edge, Brave or any other Chromium browser to an AirPlay receiver — from
Linux, macOS or Windows.

- **Extension** — finds the videos on the page and lets you pick a receiver from the toolbar popup.
- **Host** — a small Python program the browser starts on demand (native messaging). It discovers receivers on your
  network, pairs with them and drives AirPlay; when a receiver can't fetch a stream itself, it relays it over your LAN.

Nothing leaves your network: no accounts, no cloud, no telemetry. DRM-protected streams are not supported.

> Status: early. Design draft: [`docs/plans/2026-11-12-drift-v1-design.md`](docs/plans/2026-11-12-drift-v1-design.md).

## How it fits together

```
 page <video> ──► content script ──► service worker ══ native messaging (stdio JSON) ══► drift-host ──► AirPlay receiver
                                         ▲    popup: pick receiver, play/pause/seek          │ pyatv        ▲
                                         └───────────────────────────────────────────────────┘              │
                                                                       relay (HTTP/HLS on the LAN, ffmpeg) ─┘
```

Details: [`docs/architecture.md`](docs/architecture.md), messages: [`docs/protocol.md`](docs/protocol.md).

## Development

Requirements: Node 24+, [uv](https://docs.astral.sh/uv/) (Python ≥ 3.12), optionally ffmpeg. `scripts/doctor.sh`
checks them.

```bash
cd extension && npm ci && npm run build      # then chrome://extensions → Developer mode → Load unpacked → extension/dist
cd host && uv sync                           # host dependencies
scripts/install-host.sh --extension-id <id>  # id from chrome://extensions; registers drift-host with the browser
cd host && uv run drift-host scan            # list AirPlay receivers without the browser
```

Tests and lint: `scripts/test.sh`, `scripts/lint.sh`.

## License

[MIT](LICENSE)
