import { findCandidates, type Candidate } from "../content/candidates";
import type { MirrorInfo, PopupCall } from "../messages";
import type { HostEvent, Request, Response } from "../protocol";

/** A video in a frame of the active tab: where capture.js must be injected to mirror it. */
interface Located {
  tabId: number;
  frameId: number;
  index: number;
  candidate: Candidate;
}

const devices = element("devices", HTMLSelectElement);
const videos = element("videos", HTMLUListElement);
const status = element("status", HTMLElement);

function element<T extends HTMLElement>(id: string, type: new () => T): T {
  const found = document.getElementById(id);
  if (!(found instanceof type)) throw new Error(`#${id} missing`);
  return found;
}

type Reply<T> = ({ ok: true } & T) | { ok: false; error: string };

async function background<T>(message: PopupCall): Promise<T> {
  const reply = await chrome.runtime.sendMessage<PopupCall, Reply<T>>(message);
  if (!reply.ok) throw new Error(reply.error.replaceAll("_", " "));
  return reply;
}

async function call(request: Request): Promise<Response> {
  const { response } = await background<{ response: Response }>({ kind: "host", request });
  if (response.type === "error") throw new Error(response.code.replaceAll("_", " "));
  return response;
}

async function scan(): Promise<void> {
  devices.disabled = true;
  devices.replaceChildren(new Option("Searching…"));
  try {
    const response = await call({ type: "scan" });
    const found = response.type === "devices" ? response.devices : [];
    devices.replaceChildren(...found.map((d) => new Option(d.model ? `${d.name} (${d.model})` : d.name, d.id)));
    if (found.length === 0) devices.replaceChildren(new Option("No receivers found"));
    devices.disabled = found.length === 0;
  } catch (e) {
    devices.replaceChildren(new Option("Host unavailable"));
    show(e);
  }
}

async function activeTab(): Promise<number | undefined> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab?.id;
}

async function candidates(): Promise<Located[]> {
  const tabId = await activeTab();
  if (tabId === undefined) return [];
  const results = await chrome.scripting.executeScript({ target: { tabId, allFrames: true }, func: findCandidates });
  return results.flatMap((r) =>
    (r.result ?? []).map((candidate, index) => ({ tabId, frameId: r.frameId, index, candidate })),
  );
}

function render(list: Located[]): void {
  if (list.length === 0) {
    videos.replaceChildren(Object.assign(document.createElement("li"), { textContent: "No video on this page." }));
    return;
  }
  videos.replaceChildren(
    ...list.map((located) => {
      const { candidate } = located;
      const item = document.createElement("li");
      const label = Object.assign(document.createElement("span"), { textContent: candidate.title });
      const mirror = Object.assign(document.createElement("button"), { type: "button", textContent: "Mirror" });
      if (candidate.drm) {
        mirror.disabled = true;
        mirror.title = "DRM-protected: not supported";
      }
      mirror.addEventListener("click", () => {
        void startMirror(located);
      });
      item.append(label, mirror);
      return item;
    }),
  );
}

async function startMirror(located: Located): Promise<void> {
  if (devices.disabled) return;
  show("Starting…");
  try {
    const { tabId, frameId, index } = located;
    await background({ kind: "mirror", tabId, frameId, index, device: devices.value });
    await refresh();
  } catch (e) {
    show(e);
  }
}

/** Mirroring state of this tab (step 6: a status line with the measured page-thread cost; step 7 does the UX). */
async function refresh(): Promise<void> {
  const tabId = await activeTab();
  if (tabId === undefined) return;
  const { info } = await background<{ info?: MirrorInfo }>({ kind: "mirror_info", tabId });
  stopButton.hidden = info === undefined || info.stopped !== undefined;
  if (info === undefined) return;
  const quality = `${info.codec.toUpperCase()} ${String(info.width)}x${String(info.height)}@${String(info.fps)}`;
  if (info.stopped !== undefined) {
    show(`Stopped (${info.stopped.replaceAll("_", " ")}) · ${quality}`);
    return;
  }
  const s = info.stats;
  show(
    s === undefined
      ? `Mirroring · ${quality}`
      : `Mirroring · ${quality} · audio ${s.audio} · ${String(s.frames)} frames, ${String(s.droppedByEncoder)} skipped · ` +
          `page thread ${String(s.sendAvgMs)} ms avg / ${String(s.sendMaxMs)} ms max per send · ` +
          `${String(s.longTasks)} long tasks`,
  );
}

const stopButton = Object.assign(document.createElement("button"), {
  type: "button",
  textContent: "Stop",
  hidden: true,
});
stopButton.addEventListener("click", () => {
  void activeTab().then(async (tabId) => {
    if (tabId !== undefined) await background({ kind: "mirror_stop", tabId });
    await refresh();
  });
});
status.after(stopButton);
setInterval(() => void refresh().catch(show), 1000);

function show(value: unknown): void {
  status.textContent = value instanceof Error ? value.message : String(value);
}

chrome.runtime.onMessage.addListener((message: { kind?: string; event?: HostEvent }) => {
  if (message.kind === "event" && message.event?.type === "mirror_status") void refresh();
});
element("rescan", HTMLButtonElement).addEventListener("click", () => {
  void scan();
});

void scan();
candidates().then(render, show);
void refresh().catch(show);
