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
| `id` | string, 1–64 chars | Set on requests; echoed on the response. Events and notifications have none. |

Unknown fields are rejected (`invalid_message`), never ignored.

## Limits

- Extension → host: at most 3 MiB per message — a 2 MiB video chunk, base64-encoded, plus JSON (Chrome allows
  64 MiB; the host refuses larger before reading it).
- Host → extension: at most 1 MiB (Chrome's limit).
- Strings: ids 64 chars, device ids 128, names/titles 256, URLs 8 KiB. Session ids: 32 lowercase hex characters.
- Media: video chunks at most 2 MiB decoded, decoder records 64 KiB, audio chunks 256 KiB. Base64 must be padded and
  non-empty.

## Requests (extension → host) and responses

| Request | Fields | Response |
|---|---|---|
| `hello` | — | `hello` with `host` (version string) |
| `scan` | `timeout_ms` (500–10000, optional, default 3000) | `devices` with `devices: [{ id, name, model? }]` |
| `play` | `device`, `url` (`http`/`https`), `title?`, `position?` (seconds ≥ 0) | `ok` |
| `control` | `device`, `action` (`pause` \| `resume` \| `seek`), `position?` (required for `seek`) | `ok` |
| `stop` | `device` | `ok` |
| `pair_begin` | `device` | `ok` once the receiver shows its PIN |
| `pair_pin` | `device`, `pin` (4–8 digits) | `ok` when paired; `pairing_failed` for a wrong PIN or no pairing waiting |
| `mirror_start` | `device`, `audio?` = `{ format: "pcm_s16", rate: 44100, channels: 2 }` (absent: video only) | `mirror_started` with `session`; replaces a running session |
| `mirror_stop` | `session` | `ok` |

Any request can instead get `error` with `code` (snake_case constant) and the request's `id`.

## Events (host → extension, no `id`)

| Event | Fields |
|---|---|
| `status` | `device`, `state` (`idle` \| `loading` \| `playing` \| `paused`), `position?`, `duration?` |
| `mirror_status` | `session`, `state` (`mirroring` \| `stopped`), `reason?` (an error code; `mirror_failed` when the receiver ended it), `codec?`, `width?`, `height?`, `dropped?` (frames dropped so far) |

## Notifications (extension → host, no `id`, no response)

Media for a running mirroring session, at frame rate. The host handles them in arrival order; `ts` is microseconds on
the capture clock (the host anchors the first one of a session to its NTP clock, so audio and video share an origin).

| Notification | Fields |
|---|---|
| `video` | `session`, `ts`, `key` (keyframe), `data` (base64: NAL units, each with a 4-byte big-endian length), `config?` = `{ codec: "h264" \| "hevc", record (base64 avcC / hvcC), width, height }` — required with the first keyframe and whenever the decoder setup changes |
| `audio` | `session`, `ts`, `data` (base64: interleaved s16le stereo, 44.1 kHz) |

Media for a session that isn't running gets one `error` `session_unknown` without `id` (at most one per code per
second). When the host falls behind it drops media and, after a dropped video frame, skips deltas until the next
keyframe; `mirror_status.dropped` counts them.

## Error codes

`invalid_message`, `unsupported_version`, `unknown_type`, `message_too_large`, `unknown_device`,
`unsupported_url`, `pairing_required`, `device_unreachable`, `internal_error`, `mirror_unsupported` (the receiver
can't mirror: no Screen feature, or it needs FairPlay), `mirror_failed` (the receiver refused or ended the session),
`session_unknown`, `pairing_failed`.

Error messages are constant per code; they never echo URLs, headers or page content.
