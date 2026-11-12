import type { HostCall } from "../background/index";
import { findCandidates, type Candidate } from "../content/candidates";
import type { Request, Response, StatusEvent } from "../protocol";

const devices = element("devices", HTMLSelectElement);
const videos = element("videos", HTMLUListElement);
const status = element("status", HTMLElement);

function element<T extends HTMLElement>(id: string, type: new () => T): T {
  const found = document.getElementById(id);
  if (!(found instanceof type)) throw new Error(`#${id} missing`);
  return found;
}

type HostReply = { ok: true; response: Response } | { ok: false; error: string };

async function call(request: Request): Promise<Response> {
  const message: HostCall = { kind: "host", request };
  const reply = await chrome.runtime.sendMessage<HostCall, HostReply>(message);
  if (!reply.ok) throw new Error(reply.error);
  if (reply.response.type === "error") throw new Error(reply.response.code.replaceAll("_", " "));
  return reply.response;
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

async function candidates(): Promise<Candidate[]> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab?.id === undefined) return [];
  const results = await chrome.scripting.executeScript({
    target: { tabId: tab.id, allFrames: true },
    func: findCandidates,
  });
  return results.flatMap((r) => r.result ?? []);
}

function render(list: Candidate[]): void {
  if (list.length === 0) {
    videos.replaceChildren(Object.assign(document.createElement("li"), { textContent: "No video on this page." }));
    return;
  }
  videos.replaceChildren(
    ...list.map((candidate) => {
      const item = document.createElement("li");
      const label = Object.assign(document.createElement("span"), { textContent: candidate.title });
      const button = Object.assign(document.createElement("button"), { type: "button", textContent: "Play" });
      if (candidate.drm || candidate.url === undefined) {
        button.disabled = true;
        button.title = candidate.drm ? "DRM-protected: not supported" : "Stream not reachable yet (needs the relay)";
      }
      button.addEventListener("click", () => {
        void play(candidate);
      });
      item.append(label, button);
      return item;
    }),
  );
}

async function play(candidate: Candidate): Promise<void> {
  if (candidate.url === undefined || devices.disabled) return;
  try {
    await call({
      type: "play",
      device: devices.value,
      url: candidate.url,
      title: candidate.title,
      position: candidate.position,
    });
    show("Playing");
  } catch (e) {
    show(e);
  }
}

function show(value: unknown): void {
  status.textContent = value instanceof Error ? value.message : String(value);
}

chrome.runtime.onMessage.addListener((message: { kind?: string; event?: StatusEvent }) => {
  if (message.kind === "status" && message.event) show(message.event.state);
});
element("rescan", HTMLButtonElement).addEventListener("click", () => {
  void scan();
});

void scan();
candidates().then(render, show);
