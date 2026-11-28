---
name: design
description: drift's visual language and how to design for it — product tone, the three themes and their tokens (where they live in code), type, components (cards, controls, badges, stats), the page remote, icon rules (grids, optical sizes, store and installer formats, third-party marks to avoid), accessibility, and how to explore and verify visuals (design canvas, headless previews). Use when designing or changing anything people see — popup, page remote, icons, store listing, screenshots, installers — or when asked whether something "looks right".
---

# Design

drift's job is to get out of the way: the video goes to the TV, and the UI around it feels calm and cinematic. Every
visual decision serves that. Fancy is welcome; fussy isn't.

## Tone

- **Calm, cinematic, confident.** Dark-first, generous spacing, one accent doing the work. No decoration that doesn't
  carry meaning; status is shown by state (a dot, a progress bar), not by badges everywhere.
- **Plain words.** Buttons say what happens ("Send to TV", "Bring back"); errors say what to do next (`model.ts`
  `EXPLANATIONS`). No jargon in the UI; Stats for nerds is where the numbers live.
- **No AI tropes:** no gradient washes behind content, no emoji, no left-border accent cards, no glow on text.

## Themes and tokens

Three themes, designed on the canvas "drift popup directions" and approved: **Midnight Glass** (dark, default when
the system is dark), **Daylight** (light, default when the system is light), **Neon Cinema** (opt-in, bolder). Users
pick in the popup header; the choice is `theme` in `chrome.storage.local`.

| Token | Midnight Glass | Daylight | Neon Cinema |
|---|---|---|---|
| `--bg` (panel) | `#151927` | `#ffffff` | `#120f1c` |
| `--surface` / `--raised` | `#1a1f30` / `#1c2235` | `#f5f7fb` / `#f5f7fb` | `#17122a` / `#1b1530` |
| `--text` / `--muted` | `#e8ebf5` / `#8a91a8` | `#14161c` / `#5d6577` | `#e8ebf5` / `#8a91a8` |
| `--accent` / `--on-accent` | `#7aa2ff` / `#0b0d14` | `#2f6bff` / `#ffffff` | `#ff4fd8` / `#07060b` |
| `--ok` (dot) | `#48d597` | `#1f9d63` | `#3cf2c8` |
| Card / now-card radius | 14 / 16 px | 14 / 16 px | 18 / 22 px |

- **Source of truth: `extension/src/popup/popup.css`.** `extension/src/content/overlay.ts` (`THEMES`) mirrors the
  subset the page remote uses: change a token in both, in the same commit.
- A new colour is a token, defined for all three themes, never a literal in a rule.
- The page remote can't read the popup's CSS (closed shadow root on someone else's page): it gets the tokens as
  custom properties on its panel.

## Type

- Inter for text, Space Grotesk for the wordmark and Neon's display titles, **only when installed**, else
  `system-ui`. Never load fonts from Google or any other server (CLAUDE.md rule 3: nothing leaves the LAN). Design
  canvases may load them to preview.
- Sizes in the popup: 11 (meta, badges), 12 (labels, small), 13 (body), 14 (card names), 15 (send button),
  16 / 20 (now-playing title, Neon). Numbers that change use `font-variant-numeric: tabular-nums`.

## Components (popup and remote)

- **Selectable cards** (receivers, videos): real `<button role="radio">` in a `role="radiogroup"`, `aria-checked`;
  selected = accent border + raised surface + check; unusable = dashed outline, still selectable if it can do
  something (a receiver that can't mirror may still stream).
- **Primary action:** one per view, full-width accent button (48 px). Secondary: outlined; destructive-ish ("Bring
  back to this computer"): danger outline; quiet: text only.
- **Round controls:** 44 px (56 px primary) in the popup; 40 / 44 px over the video, 34 / 38 px in the docked bar.
- **Progress:** a range input over a drawn track (played, buffered ahead, knob on hover/focus/drag); preview while
  dragging, send on release; arrow keys work.
- **Stats for nerds:** collapsed `<details>`, tabular two-column `dl`, sparkline as an SVG path from `model.ts`.
- Decisions live in `popup/model.ts` (tested); `popup.ts` only wires the DOM; page-derived text only via
  `textContent` (security skill).

## Page remote

- Over the video for streaming and page-path mirroring (the TV never sees the screen); a 56 px bar docked below
  (else above, else hidden) in tab-capture mirroring (the TV sees that part of the screen). Placement:
  `content/overlay-layout.ts`.
- Small videos drop the tile and ±10 s (container queries); the remote never covers page content outside the video.

## Icons

drift's icon appears in the toolbar (16 px, often on a dark toolbar), on `chrome://extensions` (48), in the Web Store
(128) and on the installers (macOS `.icns` up to 1024, Windows `.ico`). Rules:

- **One mark, drawn for each size, not just scaled.** Master on a 128-unit grid; separate drawings for **16 px**
  (pixel-aligned, at most 2–3 shapes, strokes ≥ 2 px = 16 units) and **32 px**; 48 px and up can share the master.
  Check every size at 1× as well as 2×.
- **Web Store 128 px icon:** artwork within the central 96 × 96, 16 px transparent padding on each side (Chrome Web
  Store image guidelines); it should still read on a light and a dark page.
- **Toolbar sizes:** the tile may fill the canvas (1 px margin at 16). A dark tile needs a lighter rim or enough edge
  contrast to separate from Chrome's dark toolbar (`#202124`), and a light one from the light toolbar (`#f1f3f4`).
- **The mark (chosen 2026-11-25, "J · Holo frame" on the canvas "drift icon directions"):** a floating screen on a
  deep-space tile (`#0b0e1c`) with a violet ghost layer behind it (parallax), a wave as a light trail
  (transparent → cyan `#5ce1ff` → white) ending in a bright point, a glow line beneath instead of a stand, and a
  thin gradient rim (`#a9c1ff` → `#2b2f5e` → violet `#c77dff`). Futuristic, but calm: glow only at 48 px and up.
- **No lookalikes of others' marks:** not Apple's AirPlay glyph (screen with a triangle under it), not Google Cast's
  corner arcs, not Apple TV, Chromecast or any streaming service's logo.
- No text or letters smaller than the mark itself; no gradients that the meaning depends on (they vanish at 16).
- Files: SVG sources in `extension/src/icons/` (`icon-16.svg`, `icon-32.svg`, `icon-128.svg`, the master for 48 and
  128). `scripts/render-icons.sh` renders `icon-16/32/48/128.png` with headless Chrome; the PNGs are committed (the
  build stays dependency-free) and referenced from `manifest.json` (`icons`, `action.default_icon`). Use
  `stop-opacity`, not 8-digit hex colours, so every SVG renderer agrees. Installer icons come from the same sources.

## Exploring and verifying visuals

- **Explore on a design canvas** (Artifact "Design" type): 2–4 directions along axes you can name, each with an
  honest tradeoff in the reply, not on the artboard. Keep option names stable across rounds; a new round is a new
  page, not renamed boards.
- **Verify before shipping:** render the real built UI in headless Chrome with a stubbed `chrome` (popup:
  `dist/popup.html` with a `chrome` stub script before `popup.js`, served over `http://127.0.0.1` because module
  scripts don't load from `file://`), all three themes, and look at the screenshots. Layout bugs (wrapping buttons,
  truncated stats) show up there, not in unit tests.
- **Accessibility as drawn:** text contrast ≥ 4.5:1 (3:1 from 24 px), including muted greys and white-on-accent;
  every icon-only button has `aria-label`; focus is visible (`:focus-visible` outline in the accent); motion
  respects `prefers-reduced-motion`.
