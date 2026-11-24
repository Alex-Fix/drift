// The remote on the web page while the video plays on the TV. Injected on demand into the video's frame
// (chrome.scripting.executeScript with files) and driven by the background (OverlayCommand).
//
// Streaming: the page's video stays paused under the remote, whose buttons drive the TV through the background.
// Page-path mirroring: the remote covers the video, which keeps playing muted underneath; its buttons drive that video
// (the TV shows what it plays). Tab-capture mirroring: the remote docks outside the video, so the TV never shows it.
//
// The page never sees inside it: a closed shadow root built with DOM APIs, text set with textContent, and only
// trusted clicks count (a page can't script a click on a button it can't reach anyway).
import type { OverlayAction, OverlayActionMessage, OverlayCommand, OverlayMode } from "../messages";
import type { StreamState } from "../protocol";
import { overlayBox } from "./overlay-layout";

const SEEK_SECONDS = 10;

// The popup's themes (popup/popup.css), the tokens the remote uses.
const THEMES = {
  midnight: {
    bg: "#151927",
    raised: "#1c2235",
    text: "#e8ebf5",
    muted: "#8a91a8",
    accent: "#7aa2ff",
    onAccent: "#0b0d14",
    track: "#2b3352",
    buffer: "#3a4466",
    control: "#2f3756",
    ok: "#48d597",
    warn: "#ffcf6b",
    radius: "14px",
    titleFont: "inherit",
  },
  daylight: {
    bg: "#ffffff",
    raised: "#f5f7fb",
    text: "#14161c",
    muted: "#5d6577",
    accent: "#2f6bff",
    onAccent: "#ffffff",
    track: "#e4e8f1",
    buffer: "#cfd6e6",
    control: "#d5dae6",
    ok: "#1f9d63",
    warn: "#b7791f",
    radius: "14px",
    titleFont: "inherit",
  },
  neon: {
    bg: "#120f1c",
    raised: "#1b1530",
    text: "#e8ebf5",
    muted: "#8a91a8",
    accent: "#ff4fd8",
    onAccent: "#07060b",
    track: "#35295a",
    buffer: "#4a3a7a",
    control: "#35295a",
    ok: "#3cf2c8",
    warn: "#ffe14d",
    radius: "22px",
    titleFont: '"Space Grotesk", ui-rounded, system-ui, sans-serif',
  },
} as const;
type Theme = keyof typeof THEMES;

const CSS = `
:host { all: initial; }
.remote {
  position: absolute; inset: 0; box-sizing: border-box; container-type: size;
  display: flex; align-items: center; justify-content: center; gap: 12px;
  font: 13px/1.4 Inter, system-ui, sans-serif; color: var(--text);
  background: color-mix(in srgb, var(--bg) 94%, transparent);
  border-radius: 10px; overflow: hidden; user-select: none;
}
.remote[data-dock="over"] { flex-direction: column; padding: 16px; }
.remote[data-dock="below"], .remote[data-dock="above"] {
  padding: 0 10px; justify-content: flex-start; border: 1px solid var(--track);
  background: var(--bg); border-radius: var(--radius);
}
.tile {
  width: 52px; height: 52px; border-radius: var(--radius); background: var(--raised);
  border: 1px solid var(--track); display: grid; place-items: center; color: var(--accent); flex: none;
}
.info { display: flex; flex-direction: column; align-items: center; gap: 10px; width: min(300px, 80%); min-width: 0; }
.remote:not([data-dock="over"]) .tile { display: none; }
.remote:not([data-dock="over"]) .info { align-items: stretch; gap: 4px; flex: 1; width: auto; }
.state { display: flex; align-items: center; gap: 8px; margin: 0; max-width: 100%; }
.dot { width: 8px; height: 8px; border-radius: 4px; background: var(--ok); flex: none; }
.remote[data-tone="wait"] .dot { background: var(--warn); }
.remote[data-tone="off"] .dot { background: var(--muted); }
.title {
  font: 600 15px/1.3 var(--title-font); overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.remote:not([data-dock="over"]) .title { font-size: 12px; }
.scrub { position: relative; width: 100%; padding: 6px 0; }
.scrub input {
  all: unset; position: absolute; inset: 0; width: 100%; opacity: 0; cursor: pointer;
  -webkit-appearance: none; appearance: none;
}
.scrub input:disabled { cursor: default; }
.knob {
  position: absolute; top: 50%; width: 12px; height: 12px; margin: -6px 0 0 -6px; border-radius: 6px;
  background: var(--accent); opacity: 0; transition: opacity 0.15s; pointer-events: none;
}
.scrub:hover .knob, .scrub:focus-within .knob, .scrub.dragging .knob { opacity: 1; }
.scrub:has(input:disabled) .knob { display: none; }
.scrub:focus-within { outline: 2px solid var(--accent); outline-offset: 2px; border-radius: 4px; }
.track { position: relative; height: 4px; width: 100%; border-radius: 2px; background: var(--track); overflow: hidden; }
.played, .buffered { position: absolute; top: 0; bottom: 0; }
.played { left: 0; background: var(--accent); border-radius: 2px; }
.buffered { background: var(--buffer); }
.times { display: flex; justify-content: space-between; width: 100%; font-size: 11px; color: var(--muted);
  font-variant-numeric: tabular-nums; }
.remote:not([data-dock="over"]) .times { display: none; }
.controls { display: flex; align-items: center; gap: 10px; flex: none; }
button {
  all: unset; box-sizing: border-box; cursor: pointer; display: grid; place-items: center;
  width: 40px; height: 40px; border-radius: 20px; border: 1px solid var(--control); color: var(--text);
}
button:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
button.primary { width: 44px; height: 44px; border-radius: 22px; border: 0; background: var(--accent); color: var(--on-accent); }
button.text { width: auto; padding: 0 16px; height: 40px; font-weight: 600; font-size: 13px; }
.remote:not([data-dock="over"]) button { width: 34px; height: 34px; }
.remote:not([data-dock="over"]) button.primary { width: 38px; height: 38px; }
.remote:not([data-dock="over"]) button.text { width: auto; height: 34px; padding: 0 12px; }
svg { fill: none; stroke: currentColor; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; }
svg.solid { fill: currentColor; stroke: none; }
@container (max-height: 190px) or (max-width: 300px) {
  .remote[data-dock="over"] .tile, .remote[data-dock="over"] .times { display: none; }
  .remote[data-dock="over"] { gap: 8px; padding: 8px; }
  .remote[data-dock="over"] .back, .remote[data-dock="over"] .forward { display: none; }
}
@container (max-height: 110px) {
  .remote[data-dock="over"] .info { display: none; }
}
`;

const SVG = "http://www.w3.org/2000/svg";
const ICONS = {
  tv: {
    paths: [
      "M4 4h16a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z",
      "M8 21h8",
      "M6 8c2-1.5 4 1.5 6 0s4 1.5 6 0",
    ],
    solid: false,
  },
  back: { paths: ["M11 7L6 12l5 5", "M18 7l-5 5 5 5"], solid: false },
  forward: { paths: ["M13 7l5 5-5 5", "M6 7l5 5-5 5"], solid: false },
  pause: { paths: ["M7 5h3v14H7z", "M14 5h3v14h-3z"], solid: true },
  play: { paths: ["M8 5.5v13l11-6.5z"], solid: true },
} as const;

function icon(name: keyof typeof ICONS, size: number): SVGSVGElement {
  const svg = document.createElementNS(SVG, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("width", String(size));
  svg.setAttribute("height", String(size));
  svg.setAttribute("aria-hidden", "true");
  if (ICONS[name].solid) svg.setAttribute("class", "solid");
  for (const d of ICONS[name].paths) {
    const path = document.createElementNS(SVG, "path");
    path.setAttribute("d", d);
    svg.append(path);
  }
  return svg;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className: string): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  element.className = className;
  return element;
}

function clock(seconds: number): string {
  const whole = Math.max(0, Math.floor(seconds));
  const [h, m, s] = [Math.floor(whole / 3600), Math.floor((whole % 3600) / 60), whole % 60];
  const pad = (n: number) => String(n).padStart(2, "0");
  return h > 0 ? `${String(h)}:${pad(m)}:${pad(s)}` : `${String(m)}:${pad(s)}`;
}

const TITLES: Record<StreamState, string> = {
  loading: "Loading on",
  playing: "Playing on",
  paused: "Paused on",
  ended: "Finished on",
  stopped: "Stopped on",
  failed: "Couldn't play on",
};

class Remote {
  private readonly host = document.createElement("drift-remote");
  private readonly panel = el("div", "remote");
  private readonly title = el("span", "title");
  private readonly played = el("div", "played");
  private readonly knob = el("div", "knob");
  private readonly seek = el("input", "");
  private scrubbing = false; // the user is dragging the bar: updates don't move it meanwhile
  private length: number | undefined; // the video's length, as last reported
  private readonly buffered = el("div", "buffered");
  private readonly position = el("span", "");
  private readonly duration = el("span", "");
  private readonly toggle = this.button("primary", "Pause", icon("pause", 18));
  private readonly cleanups: (() => void)[] = [];
  private scheduled = false;

  constructor(
    private readonly video: HTMLVideoElement,
    private readonly mode: OverlayMode,
    private readonly receiver: string,
  ) {
    const root = this.host.attachShadow({ mode: "closed" });
    const style = document.createElement("style");
    style.textContent = CSS;
    const tile = el("div", "tile");
    tile.append(icon("tv", 26));
    const state = el("p", "state");
    state.append(el("span", "dot"), this.title);
    const track = el("div", "track");
    track.append(this.played, this.buffered);
    const scrub = el("div", "scrub");
    Object.assign(this.seek, { type: "range", min: "0", max: "1000", step: "1", value: "0" });
    this.seek.setAttribute("aria-label", "Position in the video");
    scrub.append(track, this.knob, this.seek);
    this.scrubber(scrub);
    const times = el("div", "times");
    times.append(this.position, this.duration);
    const info = el("div", "info");
    info.append(state, scrub, times);
    const controls = el("div", "controls");
    const back = this.button("back", `Back ${String(SEEK_SECONDS)} seconds`, icon("back", 16));
    const forward = this.button("forward", `Forward ${String(SEEK_SECONDS)} seconds`, icon("forward", 16));
    const bring = this.button("text", "Bring back to this page", document.createTextNode("Bring back"));
    this.on(back, "back");
    this.on(forward, "forward");
    this.on(this.toggle, "toggle");
    this.on(bring, "bring_back");
    controls.append(back, this.toggle, forward, bring);
    this.panel.append(tile, info, controls);
    root.append(style, this.panel);
    Object.assign(this.host.style, { position: "fixed", zIndex: "2147483647", display: "none", contain: "strict" });
    void this.applyTheme();

    if (mode === "stream") {
      // The page's own player may try to play again (autoplay, a click through): the TV has the video.
      const keepPaused = () => {
        this.video.pause();
      };
      video.addEventListener("play", keepPaused);
      this.cleanups.push(() => {
        video.removeEventListener("play", keepPaused);
      });
    } else {
      const render = () => {
        this.renderLocal();
      };
      const events = ["play", "pause", "timeupdate", "durationchange", "progress"] as const;
      for (const event of events) video.addEventListener(event, render);
      this.cleanups.push(() => {
        for (const event of events) video.removeEventListener(event, render);
      });
      this.renderLocal();
    }
    this.track();
    if (mode === "stream") this.update("loading", undefined, undefined, undefined);
  }

  /** Streaming: what the TV reported. */
  update(state: StreamState, position?: number, duration?: number, buffered?: number): void {
    this.render(
      `${TITLES[state]} ${this.receiver}`,
      state,
      state !== "playing" && state !== "loading",
      position,
      duration,
      buffered,
    );
  }

  destroy(): void {
    for (const cleanup of this.cleanups.splice(0)) cleanup();
    this.host.remove();
  }

  private renderLocal(): void {
    const { video } = this;
    const duration = Number.isFinite(video.duration) ? video.duration : undefined;
    let ahead: number | undefined;
    for (let i = 0; i < video.buffered.length; i++) {
      if (video.buffered.start(i) <= video.currentTime && video.currentTime <= video.buffered.end(i)) {
        ahead = video.buffered.end(i) - video.currentTime;
      }
    }
    const title = `Mirroring to ${this.receiver}${video.paused ? " · paused" : ""}`;
    this.render(title, video.paused ? "paused" : "playing", video.paused, video.currentTime, duration, ahead);
  }

  private render(
    title: string,
    state: StreamState,
    paused: boolean,
    position: number | undefined,
    duration: number | undefined,
    buffered: number | undefined,
  ): void {
    this.title.textContent = title;
    this.panel.dataset.tone = state === "loading" ? "wait" : state === "playing" ? "on" : "off";
    this.toggle.replaceChildren(icon(paused ? "play" : "pause", 18));
    this.toggle.setAttribute("aria-label", paused ? "Play" : "Pause");
    const known = position !== undefined && duration !== undefined && duration > 0;
    const played = known ? Math.min(1, position / duration) : 0;
    const ahead = known && buffered !== undefined ? Math.min(1 - played, buffered / duration) : 0;
    this.length = known ? duration : undefined;
    this.seek.disabled = !known;
    if (this.scrubbing) return;
    this.showPlayed(played);
    this.seek.value = String(Math.round(played * 1000));
    this.buffered.style.left = `${String(played * 100)}%`;
    this.buffered.style.width = `${String(ahead * 100)}%`;
    this.position.textContent = position === undefined ? "" : clock(position);
    this.duration.textContent = duration === undefined ? (position === undefined ? "" : "live") : clock(duration);
  }

  private showPlayed(fraction: number): void {
    this.played.style.width = `${String(fraction * 100)}%`;
    this.knob.style.left = `${String(fraction * 100)}%`;
  }

  /** Drag or click the bar (or use the arrow keys on it) to pick a moment; it's sent when let go. */
  private scrubber(scrub: HTMLElement): void {
    const picked = () => (this.length === undefined ? undefined : (Number(this.seek.value) / 1000) * this.length);
    this.seek.addEventListener("input", (event) => {
      const position = picked();
      if (!event.isTrusted || position === undefined || this.length === undefined) return;
      this.scrubbing = true;
      scrub.classList.add("dragging");
      this.showPlayed(position / this.length);
      this.position.textContent = clock(position);
    });
    this.seek.addEventListener("change", (event) => {
      scrub.classList.remove("dragging");
      this.scrubbing = false;
      const position = picked();
      if (!event.isTrusted || position === undefined) return;
      if (this.mode === "stream") {
        const message: OverlayActionMessage = { kind: "drift-overlay-action", action: "seek", position };
        chrome.runtime.sendMessage(message).catch(() => undefined);
      } else {
        this.video.currentTime = position; // mirroring: the TV shows what the page's video plays
      }
    });
    // Keys on the remote are the remote's: the page's own shortcuts (e.g. arrows to seek) mustn't fire as well.
    this.panel.addEventListener("keydown", (event) => {
      event.stopPropagation();
    });
  }

  private button(className: string, label: string, content: Node): HTMLButtonElement {
    const button = el("button", className);
    button.type = "button";
    button.setAttribute("aria-label", label);
    button.append(content);
    return button;
  }

  private on(button: HTMLButtonElement, action: OverlayAction): void {
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      if (!event.isTrusted) return;
      if (this.mode !== "stream" && action !== "bring_back") {
        this.local(action);
        return;
      }
      const message: OverlayActionMessage = { kind: "drift-overlay-action", action };
      chrome.runtime.sendMessage(message).catch(() => undefined);
    });
  }

  /** Mirroring: the TV shows what the page's video plays, so the buttons drive it directly. */
  private local(action: OverlayAction): void {
    const { video } = this;
    if (action === "toggle") {
      if (video.paused) video.play().catch(() => undefined);
      else video.pause();
    } else {
      const end = Number.isFinite(video.duration) ? video.duration : Number.POSITIVE_INFINITY;
      const delta = action === "back" ? -SEEK_SECONDS : SEEK_SECONDS;
      video.currentTime = Math.min(end, Math.max(0, video.currentTime + delta));
    }
  }

  /** Follow the video as it moves, resizes or goes fullscreen (inside a fullscreen container, not over the video). */
  private track(): void {
    const place = () => {
      this.scheduled = false;
      const container = document.fullscreenElement;
      const parent =
        container !== null && container !== this.video && container.contains(this.video)
          ? container
          : document.documentElement;
      if (this.host.parentNode !== parent) parent.append(this.host);
      const rect = this.video.getBoundingClientRect();
      const box = overlayBox(
        { left: rect.left, top: rect.top, width: rect.width, height: rect.height },
        { width: window.innerWidth, height: window.innerHeight },
        this.mode === "tab",
      );
      if (box === undefined || container === this.video) {
        this.host.style.display = "none";
        return;
      }
      this.panel.dataset.dock = box.dock;
      Object.assign(this.host.style, {
        display: "block",
        left: `${String(box.left)}px`,
        top: `${String(box.top)}px`,
        width: `${String(box.width)}px`,
        height: `${String(box.height)}px`,
      });
    };
    const schedule = () => {
      if (!this.scheduled) {
        this.scheduled = true;
        requestAnimationFrame(place);
      }
    };
    place();
    const observer = new ResizeObserver(schedule);
    observer.observe(this.video);
    const events = ["scroll", "resize", "fullscreenchange"] as const;
    for (const event of events) window.addEventListener(event, schedule, { capture: true, passive: true });
    document.addEventListener("fullscreenchange", schedule);
    const poll = setInterval(schedule, 500); // layout changes no event reports
    this.cleanups.push(() => {
      observer.disconnect();
      for (const event of events) window.removeEventListener(event, schedule, { capture: true });
      document.removeEventListener("fullscreenchange", schedule);
      clearInterval(poll);
    });
  }

  private async applyTheme(): Promise<void> {
    let choice: unknown;
    try {
      choice = (await chrome.storage.local.get("theme")).theme;
    } catch {
      choice = undefined;
    }
    const dark = window.matchMedia("(prefers-color-scheme: dark)").matches;
    const theme: Theme =
      choice === "midnight" || choice === "daylight" || choice === "neon" ? choice : dark ? "midnight" : "daylight";
    const tokens = THEMES[theme];
    const set = (name: string, value: string) => {
      this.panel.style.setProperty(name, value);
    };
    set("--bg", tokens.bg);
    set("--raised", tokens.raised);
    set("--text", tokens.text);
    set("--muted", tokens.muted);
    set("--accent", tokens.accent);
    set("--on-accent", tokens.onAccent);
    set("--track", tokens.track);
    set("--buffer", tokens.buffer);
    set("--control", tokens.control);
    set("--ok", tokens.ok);
    set("--warn", tokens.warn);
    set("--radius", tokens.radius);
    set("--title-font", tokens.titleFont);
    this.panel.style.colorScheme = theme === "daylight" ? "light" : "dark";
  }
}

function isCommand(raw: unknown): raw is OverlayCommand {
  return typeof raw === "object" && raw !== null && (raw as { kind?: unknown }).kind === "drift-overlay";
}

declare global {
  var __driftOverlay: boolean | undefined; // one listener per frame's isolated world
}

if (globalThis.__driftOverlay !== true) {
  globalThis.__driftOverlay = true;
  let remote: Remote | undefined;
  chrome.runtime.onMessage.addListener((raw: unknown, sender, sendResponse) => {
    if (sender.id !== chrome.runtime.id || !isCommand(raw)) return false;
    switch (raw.action) {
      case "show": {
        remote?.destroy();
        const video = document.querySelectorAll("video")[raw.index];
        remote = video === undefined ? undefined : new Remote(video, raw.mode, raw.receiver);
        break;
      }
      case "update":
        remote?.update(raw.state, raw.position, raw.duration, raw.buffered);
        break;
      case "hide":
        remote?.destroy();
        remote = undefined;
        break;
    }
    sendResponse({ ok: true });
    return false;
  });
}
