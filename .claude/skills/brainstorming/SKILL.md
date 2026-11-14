---
name: brainstorming
description: Turn a rough drift feature idea into an agreed design before any code is written — clarify with one question at a time, check it against the project's hard constraints (MV3, untrusted pages, LAN-only, cross-platform host, no DRM), compare 2–3 approaches, then write a design doc to docs/plans/. Use when the user wants to brainstorm, explore, or design a feature (new source type, receiver support, relay, UX), or says "let's think about…", "how should we…", "what if…", or starts a new feature without a clear spec.
---

# Brainstorming

Goal: leave with a **design the user has approved**, written down. Don't write code, scaffold files or change
config during brainstorming. The output is a design doc.

## 1. Understand the context first (silently)
Before asking anything, read what's relevant so you don't ask what the repo already answers:
- `CLAUDE.md`, `docs/architecture.md`, `docs/protocol.md`, `docs/plans/` (especially `2026-11-12-drift-v1-design.md`)
- The code the feature would touch, and `git log --oneline -15`

## 2. Clarify — one question at a time
- Ask **one** question per message. Wait for the answer before the next.
- Prefer multiple choice (use AskUserQuestion with 2–4 options, recommended option first) over open questions.
- Focus on: which sites/players and receivers it's for, what the user clicks, which side does the work (extension vs
  host), what "done" looks like, and what's explicitly out of scope.
- Stop asking once you could explain the feature back in two sentences. Usually 3–6 questions.
- If an answer touches a concept the user may not know (MSE/blob URLs, HLS vs DASH, AirPlay pairing, native
  messaging, MV3 service-worker lifetime), explain it plainly in 2–4 lines.

## 3. Check against drift's hard constraints
Every idea gets checked against these before approaches are proposed. Name any conflict out loud.

| Constraint | Ask |
|---|---|
| **MV3** | Does it work with an ephemeral service worker, no remote code, `activeTab`-first permissions? Need an offscreen document? New permission → justify. |
| **Untrusted input** | Can a hostile page use it to make the host fetch/serve something (SSRF, local files, LAN probing), leak cookies, or exhaust memory? Which validation/limit bounds it? (→ `security` skill) |
| **LAN only, no cloud** | Does anything leave the LAN or need an account/server? Relay bound to the right interface, token-scoped, stopped with the session? |
| **Cross-platform** | Linux, macOS, Windows — paths, process spawning, ffmpeg availability, browser variants? |
| **Protocol** | New message or field? Backward compatible within `"v": 1`, or a version bump? (→ `protocol` skill) |
| **Receivers** | Apple TV only, or AirPlay 2 TVs too? Pairing? Formats the receiver plays (HLS, MP4/H.264/HEVC, AAC)? |
| **No DRM** | Could it capture or decrypt protected content? → out. |
| **Dependencies** | Free/OSS? Bundled or required on PATH (ffmpeg)? Licence compatible with MIT distribution? |

## 4. Propose 2–3 approaches
For each: one-paragraph summary, what changes (extension / host / protocol / docs), trade-offs, rough size (S/M/L),
and the constraint risks from step 3. **Lead with your recommendation and say why.** Let the user pick or mix. Don't
list options you wouldn't actually recommend just to reach three.

## 5. Present the design in small sections
Walk through the chosen approach in chunks of ~200–300 words, checking after each: "Does this look right so far?"
Cover what applies:
- User flow in the popup (and what the page sees, if anything)
- Messages exchanged (valid and invalid examples) and the host's behaviour per message
- Receiver interaction (pyatv calls, pairing, status updates) and relay/ffmpeg pipeline
- Permissions, limits and defaults
- Error handling (codes, what the user sees)
- Testing (Vitest, pytest with fakes, fixtures, the manual receiver matrix)
- Docs/README updates

Go back to earlier steps whenever something doesn't fit. YAGNI: cut anything not needed for the core use case.

## 6. Write the design doc
When the user approves, write `docs/plans/YYYY-MM-DD-<topic>-design.md` (today's date):

```markdown
# <Feature> — design
Status: approved · Date: YYYY-MM-DD

## Problem
## Goals / Non-goals
## Constraints check        (table from step 3, with this feature's answers)
## Chosen approach          (+ why not the alternatives, one line each)
## Design                   (sections from step 5)
## Protocol changes
## Security notes           (validation, limits, what a hostile page can do)
## Testing
## Open questions
## Implementation steps     (ordered, each small enough for one commit)
```

Then ask whether to start implementing — on a feature branch (`feat/<topic>`), following the implementation steps.
Don't commit the design doc unless asked.

## Anti-patterns
- Asking several questions in one message.
- Jumping to code or file scaffolding before approval.
- Presenting the whole design in one wall of text.
- Silently dropping a constraint conflict instead of raising it.
- Re-asking things already decided in `CLAUDE.md`, `docs/plans/`, or memory.
