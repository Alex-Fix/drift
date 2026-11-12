# drift-host

The native-messaging host for the drift extension: the browser starts it on demand, and it discovers AirPlay
receivers (via [pyatv](https://pyatv.dev)) and streams to them. Protocol: [`../docs/protocol.md`](../docs/protocol.md).

```bash
uv sync
uv run drift-host scan                                    # list receivers
uv run drift-host install --extension-id <id> [--browser chrome|chromium|edge|brave|vivaldi]
uv run pytest && uv run ruff check && uv run mypy
```

Logs: the user log dir (`~/Library/Logs/drift/host.log` on macOS, `~/.local/state/drift/log/host.log` on Linux,
`%LOCALAPPDATA%\drift\Logs\host.log` on Windows).
