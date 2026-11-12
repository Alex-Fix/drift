---
name: protocol
description: How to add or change a drift native-messaging message end to end — TypeScript and Python validators, docs/protocol.md, shared fixtures in protocol/fixtures (valid/ and invalid/<code>--<name>.json), versioning rules, size limits, and the tests on both sides. Use when adding a request, response, event or field, changing limits or error codes, or when the extension and host disagree about a message.
---

# Protocol

Contract: `docs/protocol.md`. Implementations: `extension/src/protocol.ts` (`MESSAGES` table + `parse`) and
`host/src/drift_host/protocol.py` (same table + `parse`). They must accept and reject exactly the same messages.

## Changing a message — in one change

1. `docs/protocol.md`: the table row, limits, error codes.
2. Both `MESSAGES` tables (and the `Request`/`Response` TS types, the Python handler in `app.py`).
3. Fixtures: `protocol/fixtures/valid/<name>.json` for each new shape, and `invalid/<code>--<what>.json` for each new
   rule (the file name before `--` is the expected error code). Both test suites pick them up automatically.
4. Run `scripts/test.sh` — both sides read the same fixtures.

## Rules

- **Versioning.** Adding an optional field or a new message type the other side can refuse is compatible within
  `"v": 1` only if old peers fail cleanly (`unknown_type`). Changing meaning, renaming, or making a field required is
  a version bump — needs approval and a design-doc update.
- **Closed shapes.** Unknown fields are rejected, never ignored. Every string has a max length, every number a range,
  every list a max size.
- **Envelope.** Requests and their responses carry `id`; events never do; `error` may lack `id` when the request
  couldn't be read.
- **Errors** are snake_case constants from the shared list; no free-text from input.
- **Sizes.** 1 MiB per message both ways; big payloads (media) never go over native messaging — they go through the
  relay.
