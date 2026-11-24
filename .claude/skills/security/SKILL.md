---
name: security
description: drift security guidance — threat model for a browser extension plus a native host that fetches and serves media on the LAN (hostile pages, LAN neighbours, malicious receivers), rules for message validation, URL handling, the relay, cookies and pairing credentials, extension permissions and CSP, logging, dependencies, and a review checklist. Use when reviewing changes for security, adding messages or permissions, touching URL handling, the relay, ffmpeg invocation, pairing/credential storage, native-host install, before releases, or when the user asks "is this secure?".
---

# Security

The extension reads pages the user visits; the host is a local process that talks to the LAN and (relay) fetches
URLs and serves them. A hostile page must not be able to turn either into a tool against the user or their network.

## Threat model

| Asset | Why it matters |
|---|---|
| The user's machine (files, processes) | The host runs as the user; `file:` URLs, path arguments or a shell would expose it. |
| Session cookies / auth headers of sites | The relay may need them to fetch a stream; leaking them hands over the user's accounts. |
| The LAN (routers, NAS, admin UIs) | A host that fetches arbitrary URLs is an SSRF proxy into the LAN. |
| Pairing credentials for receivers | Let anyone on the LAN control the user's Apple TV. |
| Browsing activity | Which videos the user watches: never logged in bulk, never sent anywhere. |

| Adversary | Can | Mitigation |
|---|---|---|
| **Hostile page** | Control `<video>` URLs, titles, DOM; message the extension | Content scripts never talk to the host; popup validates candidates; host validates every message; `http(s)` only; no shell |
| **Compromised/buggy host or extension** | Send malformed messages | Both sides validate every message against the protocol (`parse`) |
| **LAN neighbour** | Fetch relay URLs, impersonate a receiver via mDNS | Random per-session tokens, relay bound to one interface and stopped with the session; pairing pins the receiver identity |
| **Supply chain** | Malicious npm/PyPI update | Lockfiles (`package-lock.json`, `uv.lock`), Dependabot with cooldown, `npm audit`, no runtime npm deps |

Out of scope (document, don't hide): a malicious receiver seeing what it's asked to play; other software on the
same machine (it can talk to the host the same way the browser does).

## Rules

### Extension
- Only extension pages (popup, offscreen) send **requests** to the background, checked by `sender` (id, no tab,
  extension URL). `externally_connectable` never reaches the host.
- **One exception: media.** Capture runs in the page, so the content script may send `video`/`audio` notifications —
  only for the active session id, bound to the tab that started it, and nothing else. The host accepts media only for
  the session it issued, caps chunk sizes, never parses payloads beyond framing them, and answers a wrong session
  with one rate-limited `session_unknown`. Worst case: a hostile page corrupts the stream the user started from that
  tab.
- **Second exception: the page remote** (`content/overlay.ts`). Its clicks reach the background as exactly
  `{ kind: "drift-overlay-action", action }` with `toggle` / `back` / `forward` / `bring_back`, accepted only from the
  frame the background put this tab's remote in (`background/overlay.ts`). The remote is a closed shadow root, built
  with DOM APIs, and counts only trusted clicks. Worst case: a hostile page in that frame pauses, seeks or brings back
  the video the user sent from it.
- Page-derived strings are text: `textContent`, never `innerHTML`. CSP stays `script-src 'self'`.
- Permissions: `activeTab` + `scripting` over broad host permissions; anything new is optional where possible and
  justified in the PR.
  Current set: `activeTab`, `scripting`, `nativeMessaging`, `storage` (the last chosen receiver's id, the theme and
  whether Stats for nerds is open, in `chrome.storage.local`: conveniences, nothing sensitive), `tabCapture` +
  `offscreen` (the fallback: captures only the tab the user mirrors, only after they click Send to TV, cropped to the
  video, and never for DRM video).
- The popup shows a page's poster as a thumbnail: http(s) only, loaded with no referrer. It is the same image the page
  itself loads.

### Host
- Every message goes through `protocol.parse` before use; unknown fields/types/versions are errors. Frames over the
  limit end the session before they're read.
- URLs: `http`/`https` with a host only. When the host itself fetches (relay), resolve the name and refuse loopback,
  link-local and the receiver's own address unless the page itself was served from there.
- **Play on TV**: the host never fetches the URL; the TV does. A hostile page could make the TV request a LAN
  address, as with any AirPlay sender: accepted and documented, since only the user's click on Send to TV starts it.
  Messages from the TV's event channel are decoded only when they are binary plists of at most 256 KiB; answers are
  matched by `messageID`, anything else is ignored.
- Never `shell=True`, `os.system` or string commands; ffmpeg runs via `asyncio.create_subprocess_exec` with an
  argument list, input from our relay URL or a pipe, `-protocol_whitelist` restricted.
- stdout is the message channel: nothing else writes to it. Logs go to the user log dir, contain codes, device ids
  and hostnames — never full URLs (they carry tokens), cookies, headers or titles.
- Error messages to the extension are constant per code.

### Relay (phase 2+)
- Binds to the interface on the receiver's subnet (not `0.0.0.0`), random port, paths prefixed by a 128-bit random
  token per session; stops when the session ends or the host exits.
- Cookies/headers forwarded from the page are kept in memory for that session only and sent only to the origin they
  came from.

### Credentials and install
- Pairing credentials: user data dir, file mode 0600 (ACL'd to the user on Windows), never logged.
- The native-host manifest lists only the drift extension id in `allowed_origins`; the launcher path is absolute.

## Review checklist
- [ ] New/changed message: validated on both sides, fixture added, limits defined?
- [ ] Media path: can anything but the session's own tab send media, or anything but media and the remote's four
      actions (from the remote's own frame) come from a content script?
- [ ] Can a page-controlled value reach a filesystem path, a command line, or a URL the host fetches without checks?
- [ ] Any new extension permission or host-permission pattern — justified, optional if possible?
- [ ] `innerHTML`, `eval`, `new Function` or remote code anywhere? → reject.
- [ ] Logs/errors free of URLs, cookies, headers, titles?
- [ ] Relay: interface-bound, token-scoped, stopped with the session, no open proxy?
- [ ] Credentials stored with restrictive permissions, never sent to the extension?
- [ ] New dependency: free/OSS, lockfile updated, `npm audit` / Dependabot clean?
