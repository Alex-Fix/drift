# Native-messaging protocol

The extension's service worker talks to `drift-host` over
[Chrome native messaging](https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging): each
message is a 32-bit length in native byte order followed by that many bytes of UTF-8 JSON.

Code: `extension/src/protocol.ts`, `host/src/drift_host/protocol.py`. Fixtures: `protocol/fixtures/*.json`. Changing a
message: `protocol` skill.

## Envelope

Every message is a JSON object with:

| Field | Type | Notes |
|---|---|---|
| `v` | `1` | Protocol version. Any other value → `error` `unsupported_version`. |
| `type` | string | One of the types below. Unknown → `error` `unknown_type`. |
| `id` | string, 1–64 chars | Set on requests; echoed on the response. Events have none. |

Unknown fields are rejected (`invalid_message`), never ignored.

## Limits

- Extension → host: at most 1 MiB per message (Chrome allows 64 MiB; the host refuses larger before reading it).
- Host → extension: at most 1 MiB (Chrome's limit).
- Strings: ids 64 chars, device ids 128, names/titles 256, URLs 8 KiB.

## Requests (extension → host) and responses

| Request | Fields | Response |
|---|---|---|
| `hello` | — | `hello` with `host` (version string) |
| `scan` | `timeout_ms` (500–10000, optional, default 3000) | `devices` with `devices: [{ id, name, model? }]` |
| `play` | `device`, `url` (`http`/`https`), `title?`, `position?` (seconds ≥ 0) | `ok` |
| `control` | `device`, `action` (`pause` \| `resume` \| `seek`), `position?` (required for `seek`) | `ok` |
| `stop` | `device` | `ok` |

Any request can instead get `error` with `code` (snake_case constant) and the request's `id`.

## Events (host → extension, no `id`)

| Event | Fields |
|---|---|
| `status` | `device`, `state` (`idle` \| `loading` \| `playing` \| `paused`), `position?`, `duration?` |

## Error codes

`invalid_message`, `unsupported_version`, `unknown_type`, `message_too_large`, `unknown_device`,
`unsupported_url`, `pairing_required`, `device_unreachable`, `internal_error`.

Error messages are constant per code; they never echo URLs, headers or page content.
