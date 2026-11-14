// The toolbar popup: pick a receiver (pairing it if needed), send a video from this tab to it, watch and stop it.
// Decisions live in model.ts; this file only wires the DOM and Chrome. Page-derived text is set with textContent.
import { findCandidates, type Candidate } from "../content/candidates";
import type { CastInfo, PopupCall } from "../messages";
import type { DeviceInfo, HostEvent, Request, Response } from "../protocol";
import { blocked, cantSend, castSummary, explain, pickReceiver, receiverLabel, sendHint } from "./model";

const RECEIVER_KEY = "receiver";
const SLOW_START_MS = 3000;

/** A video in a frame of the active tab: where it is, to send it. */
interface Located {
  tabId: number;
  frameId: number;
  index: number;
  candidate: Candidate;
}

const $ = <T extends HTMLElement>(id: string, type: new () => T): T => {
  const found = document.getElementById(id);
  if (!(found instanceof type)) throw new Error(`#${id} missing`);
  return found;
};
const ui = {
  devices: $("devices", HTMLSelectElement),
  rescan: $("rescan", HTMLButtonElement),
  pairing: $("pairing", HTMLDivElement),
  pairingText: $("pairing-text", HTMLParagraphElement),
  pairBegin: $("pair-begin", HTMLButtonElement),
  pinForm: $("pin-form", HTMLFormElement),
  pin: $("pin", HTMLInputElement),
  pinCancel: $("pin-cancel", HTMLButtonElement),
  mirroring: $("mirroring", HTMLElement),
  mirrorTitle: $("mirror-title", HTMLParagraphElement),
  mirrorDetail: $("mirror-detail", HTMLParagraphElement),
  stop: $("stop", HTMLButtonElement),
  bringBack: $("bring-back", HTMLButtonElement),
  videos: $("videos", HTMLUListElement),
  status: $("status", HTMLElement),
};

let devices: DeviceInfo[] = [];
let videos: Located[] = [];
let sendingHere = false;
let busy = false;

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

// ---- receivers ---------------------------------------------------------------------------------------------------

const selected = (): DeviceInfo | undefined => devices.find((d) => d.id === ui.devices.value);

async function scan(): Promise<void> {
  ui.devices.disabled = true;
  ui.devices.replaceChildren(new Option("Searching…"));
  try {
    const response = await call({ type: "scan" });
    devices = response.type === "devices" ? response.devices : [];
    const remembered = await recall();
    if (devices.length === 0) {
      ui.devices.replaceChildren(new Option("No receivers found"));
    } else {
      ui.devices.replaceChildren(
        ...devices.map((d) => {
          const option = new Option(receiverLabel(d), d.id);
          return option;
        }),
      );
      ui.devices.value = pickReceiver(devices, remembered) ?? "";
      ui.devices.disabled = false;
    }
    say("");
  } catch (e) {
    devices = [];
    ui.devices.replaceChildren(new Option("drift-host unavailable"));
    sayError(e);
  }
  renderReceiver();
  renderVideos();
}

function renderReceiver(): void {
  const device = selected();
  const unpaired = blocked(device) === "unpaired";
  ui.pairing.hidden = !unpaired;
  if (unpaired && device !== undefined) {
    ui.pairingText.textContent = `drift needs to pair with ${device.name} once.`;
  }
  ui.pinForm.hidden = true;
  ui.pairBegin.hidden = false;
}

async function recall(): Promise<string | undefined> {
  try {
    const stored = await chrome.storage.local.get(RECEIVER_KEY);
    const value = stored[RECEIVER_KEY];
    return typeof value === "string" ? value : undefined;
  } catch {
    return undefined;
  }
}

ui.devices.addEventListener("change", () => {
  void chrome.storage.local.set({ [RECEIVER_KEY]: ui.devices.value }).catch(() => undefined);
  renderReceiver();
  renderVideos();
});

// ---- pairing -----------------------------------------------------------------------------------------------------

ui.pairBegin.addEventListener("click", () => {
  const device = selected();
  if (device === undefined) return;
  ui.pairBegin.disabled = true; // one pairing at a time: a second pair_begin would cancel the first
  say(`Asking ${device.name} for a PIN…`);
  call({ type: "pair_begin", device: device.id })
    .then(() => {
      ui.pairBegin.hidden = true;
      ui.pinForm.hidden = false;
      ui.pin.value = "";
      ui.pin.focus();
      say(`Type the PIN shown on ${device.name}.`);
    }, sayError)
    .finally(() => {
      ui.pairBegin.disabled = false;
    });
});

ui.pinForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const device = selected();
  if (device === undefined || !ui.pin.checkValidity()) return;
  say("Pairing…");
  call({ type: "pair_pin", device: device.id, pin: ui.pin.value }).then(
    async () => {
      say(`Paired with ${device.name}.`);
      await scan();
    },
    (e: unknown) => {
      sayError(e);
      renderReceiver(); // a failed PIN ends the attempt on the receiver; start over
    },
  );
});

ui.pinCancel.addEventListener("click", () => {
  renderReceiver();
  say("");
});

// ---- videos and mirroring ----------------------------------------------------------------------------------------

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
  renderVideos();
}

function renderVideos(): void {
  if (videos.length === 0) {
    ui.videos.replaceChildren(Object.assign(document.createElement("li"), { textContent: "No video on this page." }));
    return;
  }
  ui.videos.replaceChildren(
    ...videos.map((located) => {
      const { candidate } = located;
      const item = document.createElement("li");
      const label = Object.assign(document.createElement("span"), { textContent: candidate.title });
      label.title = candidate.title;
      const button = Object.assign(document.createElement("button"), {
        type: "button",
        textContent: sendingHere ? "Send this instead" : "Send to TV",
        title: sendHint(candidate),
      });
      const reason = cantSend(selected(), candidate);
      if (reason !== undefined || busy) {
        button.disabled = true;
        if (reason === "drm") button.title = explain("drm");
        else if (reason === "unpaired") button.title = explain("pairing_required");
        else if (reason !== undefined) button.title = "Pick a receiver that can play it";
      }
      button.addEventListener("click", () => {
        void send(located);
      });
      item.append(label, button);
      return item;
    }),
  );
}

async function send(located: Located): Promise<void> {
  const device = selected();
  if (device === undefined) return;
  busy = true;
  renderVideos();
  say(`Connecting to ${device.name}…`);
  const slow = setTimeout(() => {
    say(`Waiting for ${device.name}… a TV can take up to 20 seconds after the last session.`);
  }, SLOW_START_MS);
  try {
    const { tabId, frameId, index } = located;
    await background({ kind: "send", tabId, frameId, index, device: device.id });
    say("");
  } catch (e) {
    sayError(e);
  } finally {
    clearTimeout(slow);
    busy = false;
    await refresh();
  }
}

function onTab(call: (tabId: number) => PopupCall): () => void {
  return () => {
    void activeTab().then(async (tabId) => {
      if (tabId === undefined) return;
      try {
        await background(call(tabId));
      } catch (e) {
        sayError(e);
      }
      await refresh();
    });
  };
}

ui.stop.addEventListener(
  "click",
  onTab((tabId) => ({ kind: "stop", tabId })),
);
ui.bringBack.addEventListener(
  "click",
  onTab((tabId) => ({ kind: "bring_back", tabId })),
);

async function refresh(): Promise<void> {
  const tabId = await activeTab();
  if (tabId === undefined) return;
  const { info } = await background<{ info?: CastInfo }>({ kind: "info", tabId });
  const running = info !== undefined && info.stopped === undefined;
  if (running !== sendingHere) {
    sendingHere = running;
    renderVideos();
  }
  ui.mirroring.hidden = info === undefined;
  ui.stop.hidden = !running;
  ui.bringBack.hidden = !(running && info.kind === "stream" && info.fallingBack !== true);
  if (info === undefined) return;
  const receiver = devices.find((d) => d.id === info.device)?.name ?? "the receiver";
  const { title, detail } = castSummary(info, receiver);
  ui.mirrorTitle.textContent = title;
  ui.mirrorDetail.textContent = detail;
}

// ---- start -------------------------------------------------------------------------------------------------------

chrome.runtime.onMessage.addListener((message: { kind?: string; event?: HostEvent }) => {
  if (message.kind === "event" && message.event !== undefined) void refresh();
});
ui.rescan.addEventListener("click", () => {
  void scan();
});
setInterval(() => void refresh().catch(() => undefined), 1000);

void scan();
void findVideos();
void refresh().catch(() => undefined);
