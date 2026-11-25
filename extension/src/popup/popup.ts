// The toolbar popup: pick a TV (pairing it if needed) and a video on this tab, send it, then watch and drive it.
// Decisions live in model.ts; this file only wires the DOM and Chrome. Page-derived text is set with textContent, and
// page-derived URLs only ever become an <img src> (http(s) posters).
import { findCandidates, type Candidate } from "../content/candidates";
import type { CastInfo, PopupCall } from "../messages";
import type { DeviceInfo, HostEvent, Request, Response } from "../protocol";
import {
  DOWNLOAD_URL,
  HOST_MISSING,
  THEMES,
  cantSend,
  castSummary,
  clock,
  deviceDetail,
  explain,
  hostCard,
  hostProblem,
  modeBadge,
  parseTheme,
  pickReceiver,
  pickVideo,
  platformOf,
  progress,
  seekTarget,
  sendHint,
  sparkline,
  statRows,
  statsBadge,
  toggleAction,
  type ThemeChoice,
} from "./model";

const RECEIVER_KEY = "receiver";
const THEME_KEY = "theme";
const STATS_KEY = "statsOpen";
const SLOW_START_MS = 3000;
const SPARK = { width: 320, height: 52 };

/** A video in a frame of the active tab: where it is, to send it. */
interface Located {
  tabId: number;
  frameId: number;
  index: number;
  candidate: Candidate;
}

const $ = <T extends Element>(id: string, type: new () => T): T => {
  const found = document.getElementById(id);
  if (!(found instanceof type)) throw new Error(`#${id} missing`);
  return found;
};
const ui = {
  theme: $("theme", HTMLButtonElement),
  themes: $("themes", HTMLDivElement),
  rescan: $("rescan", HTMLButtonElement),
  host: $("host", HTMLElement),
  hostTitle: $("host-title", HTMLParagraphElement),
  hostText: $("host-text", HTMLParagraphElement),
  hostDownload: $("host-download", HTMLButtonElement),
  hostDownloadLabel: $("host-download-label", HTMLSpanElement),
  now: $("now", HTMLElement),
  nowState: $("now-state", HTMLSpanElement),
  nowTitle: $("now-title", HTMLParagraphElement),
  nowDetail: $("now-detail", HTMLParagraphElement),
  nowProgress: $("now-progress", HTMLDivElement),
  nowPlayed: $("now-played", HTMLDivElement),
  nowKnob: $("now-knob", HTMLDivElement),
  nowSeek: $("now-seek", HTMLInputElement),
  nowBuffered: $("now-buffered", HTMLDivElement),
  nowPosition: $("now-position", HTMLSpanElement),
  nowDuration: $("now-duration", HTMLSpanElement),
  nowControls: $("now-controls", HTMLDivElement),
  back10: $("back10", HTMLButtonElement),
  toggle: $("toggle", HTMLButtonElement),
  iconPause: $("icon-pause", SVGSVGElement),
  iconPlay: $("icon-play", SVGSVGElement),
  forward10: $("forward10", HTMLButtonElement),
  bringBack: $("bring-back", HTMLButtonElement),
  stop: $("stop", HTMLButtonElement),
  stats: $("stats", HTMLDetailsElement),
  statsBadge: $("stats-badge", HTMLSpanElement),
  spark: $("spark", SVGSVGElement),
  sparkLine: $("spark-line", SVGPathElement),
  sparkArea: $("spark-area", SVGPathElement),
  statsRows: $("stats-rows", HTMLElement),
  devices: $("devices", HTMLDivElement),
  pairing: $("pairing", HTMLDivElement),
  pairingText: $("pairing-text", HTMLParagraphElement),
  pairBegin: $("pair-begin", HTMLButtonElement),
  pinForm: $("pin-form", HTMLFormElement),
  pin: $("pin", HTMLInputElement),
  pinCancel: $("pin-cancel", HTMLButtonElement),
  videos: $("videos", HTMLDivElement),
  send: $("send", HTMLButtonElement),
  sendLabel: $("send-label", HTMLSpanElement),
  status: $("status", HTMLElement),
};

let devices: DeviceInfo[] = [];
let deviceNote = "Searching…"; // what the receiver list says while it's empty
let device: string | undefined;
let videos: Located[] = [];
let video: number | undefined;
let info: CastInfo | undefined;
let busy = false;
let scrubbing = false; // the user is dragging the progress bar: status updates don't move it meanwhile

// ---- background --------------------------------------------------------------------------------------------------

type Reply<T> = ({ ok: true } & T) | { ok: false; error: string };

async function background<T>(message: PopupCall): Promise<T> {
  const reply = await chrome.runtime.sendMessage<PopupCall, Reply<T>>(message);
  if (!reply.ok) throw new Error(reply.error);
  return reply;
}

async function call(request: Request): Promise<Response> {
  const { response } = await background<{ response: Response }>({ kind: "host", request });
  if (response.type === "error") throw new Error(response.code);
  return response;
}

async function activeTab(): Promise<number | undefined> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab?.id;
}

function say(message: string): void {
  ui.status.textContent = message;
}

function sayError(e: unknown): void {
  say(explain(e instanceof Error ? e.message : String(e)));
}

async function stored(key: string): Promise<unknown> {
  try {
    return (await chrome.storage.local.get(key))[key];
  } catch {
    return undefined;
  }
}

function store(key: string, value: unknown): void {
  void chrome.storage.local.set({ [key]: value }).catch(() => undefined);
}

// ---- small DOM helpers -------------------------------------------------------------------------------------------

const SVG = "http://www.w3.org/2000/svg";
const ICONS = {
  tv: ["M4 4h16a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z", "M8 21h8"],
  laptop: ["M5 5h14a1.5 1.5 0 0 1 1.5 1.5V16h-17V6.5A1.5 1.5 0 0 1 5 5z", "M1 19h22"],
  check: ["M5 12l5 5 9-10"],
} as const;

function icon(name: keyof typeof ICONS, size: number): SVGSVGElement {
  const svg = document.createElementNS(SVG, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("width", String(size));
  svg.setAttribute("height", String(size));
  svg.setAttribute("aria-hidden", "true");
  for (const d of ICONS[name]) {
    const path = document.createElementNS(SVG, "path");
    path.setAttribute("d", d);
    svg.append(path);
  }
  return svg;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

/** A selectable card in a radio group. */
function card(checked: boolean, onSelect: () => void): HTMLButtonElement {
  const button = el("button", "card");
  button.type = "button";
  button.setAttribute("role", "radio");
  button.setAttribute("aria-checked", String(checked));
  button.addEventListener("click", onSelect);
  return button;
}

function empty(text: string): HTMLDivElement {
  return el("div", "card empty", text);
}

// ---- themes ------------------------------------------------------------------------------------------------------

const SWATCHES: Record<ThemeChoice, string> = {
  auto: "linear-gradient(135deg, #151927 50%, #ffffff 50%)",
  midnight: "#7aa2ff",
  daylight: "#2f6bff",
  neon: "#ff4fd8",
};

function applyTheme(choice: ThemeChoice): void {
  if (choice === "auto") delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = choice;
  ui.themes.replaceChildren(
    ...THEMES.map((theme) => {
      const button = el("button", "");
      button.type = "button";
      button.setAttribute("role", "radio");
      button.setAttribute("aria-checked", String(theme.id === choice));
      const swatch = el("span", "swatch");
      swatch.style.background = SWATCHES[theme.id];
      button.append(swatch, theme.name);
      button.addEventListener("click", () => {
        store(THEME_KEY, theme.id);
        applyTheme(theme.id);
      });
      return button;
    }),
  );
}

ui.theme.addEventListener("click", () => {
  ui.themes.hidden = !ui.themes.hidden;
  ui.theme.setAttribute("aria-expanded", String(!ui.themes.hidden));
});

// ---- the companion app (drift-host) ------------------------------------------------------------------------------

/** Ask drift-host its version; show the install or update card when it's missing or too old. False only when it's
 * missing (no point scanning). */
async function checkHost(): Promise<boolean> {
  let error: string | undefined;
  let version: string | undefined;
  try {
    const response = await call({ type: "hello" });
    if (response.type === "hello") version = response.host;
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }
  const problem = hostProblem(error, version, chrome.runtime.getManifest().version);
  ui.host.hidden = problem === undefined;
  if (problem === undefined) return true; // usable, or another error the scan will report
  const platform = (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData?.platform;
  const card = hostCard(problem, platformOf(platform ?? navigator.platform));
  ui.hostTitle.textContent = card.title;
  ui.hostText.textContent = card.text;
  ui.hostDownloadLabel.textContent = card.button;
  return problem.kind === "outdated"; // an old host still works for what it supports
}

ui.hostDownload.addEventListener("click", () => {
  void chrome.tabs.create({ url: DOWNLOAD_URL }).then(() => {
    window.close();
  });
});

// ---- receivers ---------------------------------------------------------------------------------------------------

const selected = (): DeviceInfo | undefined => devices.find((d) => d.id === device);

async function scan(): Promise<void> {
  devices = [];
  deviceNote = "Searching…";
  ui.rescan.disabled = true;
  renderDevices();
  try {
    const response = await call({ type: "scan" });
    devices = response.type === "devices" ? response.devices : [];
    const remembered = await stored(RECEIVER_KEY);
    const known = devices.find((d) => d.id === remembered)?.id;
    device = known ?? pickReceiver(devices, undefined) ?? devices[0]?.id;
    deviceNote = "No TVs found. Check that the TV is on and AirPlay is enabled.";
    say("");
  } catch (e) {
    const missing = e instanceof Error && e.message === HOST_MISSING;
    deviceNote = missing ? "Install drift-host to find your TVs." : "drift-host unavailable";
    if (missing) void checkHost();
    else sayError(e);
  } finally {
    ui.rescan.disabled = false;
  }
  renderDevices();
  renderVideos();
}

function renderDevices(): void {
  if (devices.length === 0) {
    ui.devices.replaceChildren(empty(deviceNote));
  } else {
    ui.devices.replaceChildren(
      ...devices.map((d) => {
        const button = card(d.id === device, () => {
          device = d.id;
          store(RECEIVER_KEY, d.id);
          renderDevices();
          renderVideos();
        });
        if (d.mirror === false) button.classList.add("unusable");
        const tile = el("div", "tile");
        tile.append(icon(d.mirror === false ? "laptop" : "tv", 22));
        const text = el("div", "text");
        text.append(el("div", "name", d.name), el("div", "sub", deviceDetail(d)));
        const check = el("div", "check");
        check.append(icon("check", 12));
        button.append(tile, text, check);
        return button;
      }),
    );
  }
  renderPairing();
}

function renderPairing(): void {
  const current = selected();
  const unpaired = current?.paired === false;
  ui.pairing.hidden = !unpaired;
  if (current !== undefined && unpaired) ui.pairingText.textContent = `drift needs to pair with ${current.name} once.`;
  ui.pinForm.hidden = true;
  ui.pairBegin.hidden = false;
}

// ---- pairing -----------------------------------------------------------------------------------------------------

ui.pairBegin.addEventListener("click", () => {
  const current = selected();
  if (current === undefined) return;
  ui.pairBegin.disabled = true; // one pairing at a time: a second pair_begin would cancel the first
  say(`Asking ${current.name} for a PIN…`);
  call({ type: "pair_begin", device: current.id })
    .then(() => {
      ui.pairBegin.hidden = true;
      ui.pinForm.hidden = false;
      ui.pin.value = "";
      ui.pin.focus();
      say(`Type the PIN shown on ${current.name}.`);
    }, sayError)
    .finally(() => {
      ui.pairBegin.disabled = false;
    });
});

ui.pinForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const current = selected();
  if (current === undefined || !ui.pin.checkValidity()) return;
  say("Pairing…");
  call({ type: "pair_pin", device: current.id, pin: ui.pin.value }).then(
    async () => {
      say(`Paired with ${current.name}.`);
      await scan();
    },
    (e: unknown) => {
      sayError(e);
      renderPairing(); // a failed PIN ends the attempt on the receiver; start over
    },
  );
});

ui.pinCancel.addEventListener("click", () => {
  renderPairing();
  say("");
});

// ---- videos ------------------------------------------------------------------------------------------------------

async function findVideos(): Promise<void> {
  const tabId = await activeTab();
  if (tabId === undefined) return;
  try {
    const results = await chrome.scripting.executeScript({ target: { tabId, allFrames: true }, func: findCandidates });
    videos = results.flatMap((r) =>
      (r.result ?? []).map((candidate, index) => ({ tabId, frameId: r.frameId, index, candidate })),
    );
  } catch {
    videos = []; // e.g. chrome:// pages, where extensions can't run
  }
  video = pickVideo(videos.map((v) => v.candidate));
  renderVideos();
}

function renderVideos(): void {
  if (videos.length === 0) {
    ui.videos.replaceChildren(empty("No video on this page."));
  } else {
    ui.videos.replaceChildren(
      ...videos.map(({ candidate }, i) => {
        const button = card(i === video, () => {
          video = i;
          renderVideos();
        });
        button.classList.add("video");
        const thumb = el("div", "thumb");
        if (candidate.poster !== undefined) {
          const image = el("img", "");
          image.alt = "";
          image.referrerPolicy = "no-referrer";
          image.src = candidate.poster;
          image.addEventListener("error", () => {
            image.remove();
          });
          thumb.append(image);
        }
        if (candidate.duration !== undefined) thumb.append(el("span", "length", clock(candidate.duration)));
        const text = el("div", "text");
        const name = el("div", "name", candidate.title);
        name.title = candidate.title;
        const tags = el("div", "tags");
        tags.append(el("span", "badge", candidate.drm ? "DRM-protected" : modeBadge(candidate)));
        text.append(name, tags);
        button.append(thumb, text);
        return button;
      }),
    );
  }
  renderSend();
}

function renderSend(): void {
  const chosen = video === undefined ? undefined : videos[video];
  const running = info !== undefined && info.stopped === undefined;
  ui.sendLabel.textContent = running ? "Send this instead" : "Send to TV";
  const reason = chosen === undefined ? "no_video" : cantSend(selected(), chosen.candidate);
  ui.send.disabled = busy || reason !== undefined;
  if (chosen === undefined) ui.send.title = "";
  else if (reason === "drm") ui.send.title = explain("drm");
  else if (reason === "unpaired") ui.send.title = explain("pairing_required");
  else if (reason !== undefined) ui.send.title = "Pick a TV that can play it";
  else ui.send.title = sendHint(chosen.candidate);
}

ui.send.addEventListener("click", () => {
  const chosen = video === undefined ? undefined : videos[video];
  if (chosen !== undefined) void send(chosen);
});

async function send(located: Located): Promise<void> {
  const current = selected();
  if (current === undefined) return;
  busy = true;
  renderSend();
  say(`Connecting to ${current.name}…`);
  const slow = setTimeout(() => {
    say(`Waiting for ${current.name}… a TV can take up to 20 seconds after the last session.`);
  }, SLOW_START_MS);
  try {
    const { tabId, frameId, index } = located;
    await background({ kind: "send", tabId, frameId, index, device: current.id });
    say("");
  } catch (e) {
    sayError(e);
  } finally {
    clearTimeout(slow);
    busy = false;
    await refresh();
  }
}

// ---- now playing and stats ---------------------------------------------------------------------------------------

async function refresh(): Promise<void> {
  const tabId = await activeTab();
  if (tabId === undefined) return;
  ({ info } = await background<{ info?: CastInfo }>({ kind: "info", tabId }));
  renderNow();
  renderStats();
  renderSend();
}

function renderNow(): void {
  ui.now.hidden = info === undefined;
  if (info === undefined) return;
  const receiver = devices.find((d) => d.id === info?.device)?.name ?? "the TV";
  const { title, detail } = castSummary(info, receiver);
  const running = info.stopped === undefined;
  const stream = info.kind === "stream" ? info : undefined;
  const waiting = running && (stream?.state === "loading" || stream?.fallingBack === true);
  ui.now.dataset.tone = !running ? "off" : waiting ? "wait" : "on";
  ui.nowState.textContent = title;
  ui.nowTitle.textContent = info.title;
  ui.nowTitle.hidden = !running;
  // Streams show time in the progress bar; their detail line is for live streams and stops.
  const shown = stream === undefined || !running ? detail : stream.duration === undefined ? detail : "";
  ui.nowDetail.textContent = shown;
  ui.nowDetail.hidden = shown === "";

  const live = running && stream !== undefined && stream.fallingBack !== true ? stream : undefined;
  const bar = live === undefined ? undefined : progress(live);
  ui.nowProgress.hidden = bar === undefined;
  if (bar !== undefined && live !== undefined && !scrubbing) {
    showPlayed(bar.played);
    ui.nowBuffered.style.left = `${String(bar.played * 100)}%`;
    ui.nowBuffered.style.width = `${String(bar.buffered * 100)}%`;
    ui.nowSeek.value = String(Math.round(bar.played * 1000));
    ui.nowPosition.textContent = clock(live.position ?? 0);
    ui.nowDuration.textContent = clock(live.duration ?? 0);
  }
  ui.nowControls.hidden = live === undefined;
  if (live !== undefined) {
    const pausing = toggleAction(live) === "pause";
    ui.toggle.setAttribute("aria-label", pausing ? "Pause" : "Play");
    ui.iconPause.toggleAttribute("hidden", !pausing);
    ui.iconPlay.toggleAttribute("hidden", pausing);
    ui.back10.disabled = ui.forward10.disabled = live.position === undefined;
  }
  ui.bringBack.hidden = live === undefined;
  ui.stop.hidden = !running || stream?.fallingBack === true;
  ui.stop.textContent = info.kind === "mirror" ? "Stop mirroring" : "Stop";
  ui.stop.className = info.kind === "mirror" ? "danger" : "quiet"; // the only action while mirroring
}

function showPlayed(fraction: number): void {
  ui.nowPlayed.style.width = `${String(fraction * 100)}%`;
  ui.nowKnob.style.left = `${String(fraction * 100)}%`;
}

/** The moment the progress bar's thumb points at, in seconds (streams with a known length only). */
function scrubbed(): number | undefined {
  if (info?.kind !== "stream" || info.duration === undefined) return undefined;
  return (Number(ui.nowSeek.value) / 1000) * info.duration;
}

ui.nowSeek.addEventListener("input", () => {
  const position = scrubbed();
  if (position === undefined || info?.kind !== "stream" || info.duration === undefined) return;
  scrubbing = true;
  ui.nowSeek.parentElement?.classList.add("dragging");
  showPlayed(position / info.duration);
  ui.nowPosition.textContent = clock(position);
});

ui.nowSeek.addEventListener("change", () => {
  const position = scrubbed();
  ui.nowSeek.parentElement?.classList.remove("dragging");
  if (position === undefined) {
    scrubbing = false;
    return;
  }
  void activeTab()
    .then(async (tabId) => {
      if (tabId !== undefined) await background({ kind: "stream_control", tabId, action: "seek", position });
    })
    .catch(sayError)
    .finally(() => {
      scrubbing = false;
      void refresh().catch(() => undefined);
    });
});

function renderStats(): void {
  const running = info !== undefined && info.stopped === undefined;
  ui.stats.hidden = !running || (info?.kind === "stream" && info.fallingBack === true);
  if (info === undefined || ui.stats.hidden) return;
  ui.statsBadge.textContent = statsBadge(info);
  const samples = info.kind === "mirror" ? info.bitrate : undefined;
  ui.spark.toggleAttribute("hidden", samples === undefined || samples.length < 2);
  if (samples !== undefined && samples.length >= 2) {
    const { line, area } = sparkline(samples, SPARK.width, SPARK.height);
    ui.sparkLine.setAttribute("d", line);
    ui.sparkArea.setAttribute("d", area);
  }
  ui.statsRows.replaceChildren(
    ...statRows(info).map(([label, value]) => {
      const row = el("div", label === "Quality" ? "wide" : "");
      row.append(el("dt", "", label), el("dd", "", value));
      return row;
    }),
  );
}

ui.stats.addEventListener("toggle", () => {
  store(STATS_KEY, ui.stats.open);
});

function onTab(make: (tabId: number) => PopupCall | undefined): () => void {
  return () => {
    void activeTab().then(async (tabId) => {
      const message = tabId === undefined ? undefined : make(tabId);
      if (message === undefined) return;
      try {
        await background(message);
      } catch (e) {
        sayError(e);
      }
      await refresh();
    });
  };
}

const seek = (delta: number) =>
  onTab((tabId) => {
    const position = info?.kind === "stream" ? seekTarget(info, delta) : undefined;
    return position === undefined ? undefined : { kind: "stream_control", tabId, action: "seek", position };
  });

ui.back10.addEventListener("click", seek(-10));
ui.forward10.addEventListener("click", seek(10));
ui.toggle.addEventListener(
  "click",
  onTab((tabId) =>
    info?.kind === "stream" ? { kind: "stream_control", tabId, action: toggleAction(info) } : undefined,
  ),
);
ui.bringBack.addEventListener(
  "click",
  onTab((tabId) => ({ kind: "bring_back", tabId })),
);
ui.stop.addEventListener(
  "click",
  onTab((tabId) => ({ kind: "stop", tabId })),
);

// ---- start -------------------------------------------------------------------------------------------------------

chrome.runtime.onMessage.addListener((message: { kind?: string; event?: HostEvent }) => {
  if (message.kind === "event" && message.event !== undefined) void refresh().catch(() => undefined);
});
ui.rescan.addEventListener("click", () => {
  void scan();
});
setInterval(() => void refresh().catch(() => undefined), 1000);

applyTheme("auto");
void stored(THEME_KEY).then((value) => {
  applyTheme(parseTheme(value));
});
void stored(STATS_KEY).then((value) => {
  ui.stats.open = value === true;
});
renderDevices();
void checkHost().then((usable) => {
  if (usable) void scan();
  else {
    deviceNote = "Install drift-host to find your TVs.";
    renderDevices();
  }
});
void findVideos();
void refresh().catch(() => undefined);
