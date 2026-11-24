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

History within `"v": 1`: `play` / `control` / `stop` / `status` (pyatv's `POST /play`, which AirPlay 2 TVs refuse)
were replaced by the `stream_*` messages (design 2026-11-14). The extension and host ship together and nothing else
spoke them, so the version stayed 1.

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
| `pair_begin` | `device` | `ok` once the receiver shows its PIN |
| `pair_pin` | `device`, `pin` (4–8 digits) | `ok` when paired; `pairing_failed` for a wrong PIN or no pairing waiting |
| `mirror_start` | `device`, `audio?` = `{ format: "pcm_s16", rate: 44100, channels: 2 }` (absent: video only) | `mirror_started` with `session`; replaces a running session |
| `mirror_stop` | `session` | `ok` |
| `stream_start` | `device`, `url` (`http`/`https`), `media_type` (`file`: MP4/MOV \| `streaming`: HLS), `position?` (seconds ≥ 0) | `stream_started` with `session`; the receiver fetches the URL itself. Replaces a running session (mirroring or stream) |
| `stream_control` | `session`, `action` (`pause` \| `resume` \| `seek`), `position?` (seconds; required for `seek`) | `ok` |
| `stream_stop` | `session` | `ok` |

Any request can instead get `error` with `code` (snake_case constant) and the request's `id`.

## Events (host → extension, no `id`)

| Event | Fields |
|---|---|
| `mirror_status` | `session`, `state` (`mirroring` \| `stopped`), `reason?` (an error code; `mirror_failed` when the receiver ended it), `codec?`, `width?`, `height?`, `dropped?` (frames dropped so far) |
| `stream_status` | `session`, `state` (`loading` \| `playing` \| `paused` \| `ended` \| `stopped` \| `failed`), `reason?` (an error code, with `stopped` / `failed`; `stream_failed` when the receiver couldn't play the URL), `position?`, `duration?` (absent for live streams), `buffered?` (seconds loaded ahead of the position) |

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
`session_unknown`, `pairing_failed`, `stream_failed` (the receiver refused the URL, couldn't play it, or ended the
stream session).

Error messages are constant per code; they never echo URLs, headers or page content.
