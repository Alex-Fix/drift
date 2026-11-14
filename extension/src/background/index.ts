import {
  MEDIA_PORT,
  type CaptureCommand,
  type MirrorInfo,
  type OffscreenCommand,
  type OffscreenStarted,
  type PlacementMessage,
  type PopupCall,
  type PrepareResult,
  type StatsMessage,
} from "../messages";
import type { Placement } from "../capture/crop";
import type { HostEvent } from "../protocol";
import { MirrorSessions } from "./mirror";
import { HOST_NAME, NativeClient } from "./native";

// The host retries an unreachable receiver for up to 30 s (the Samsung needs ~10-17 s after the last session).
const MIRROR_START_TIMEOUT_MS = 45_000;
const sessions = new MirrorSessions();
const infos = new Map<number, MirrorInfo>(); // per tab; kept after a stop so the popup can say why
const frames = new Map<number, number>(); // tab → frame running the capture
const mediaPorts = new Map<number, chrome.runtime.Port>(); // tab → its content script's media port
const OFFSCREEN_URL = "offscreen.html";
let offscreenTab: number | undefined; // the tab the offscreen document is capturing (one fallback at a time)
let offscreenPort: chrome.runtime.Port | undefined;
const AUDIO = { format: "pcm_s16", rate: 44100, channels: 2 } as const;
const hostDropped = new Map<string, number>(); // session → frames the host had dropped at its last status

const client = new NativeClient(() => chrome.runtime.connectNative(HOST_NAME), onHostEvent);

function onHostEvent(event: HostEvent): void {
  // The popup may be closed: nobody listening is fine.
  chrome.runtime.sendMessage({ kind: "event", event }).catch(() => undefined);
  if (event.type !== "mirror_status") return;
  const tabId = sessions.tabOf(event.session);
  if (tabId === undefined) return;
  if (event.state === "stopped") {
    void stopMirror(tabId, event.reason ?? "stopped");
    return;
  }
  // The host drops frames when the receiver or network can't keep up: ask the capture to lower the quality.
  const dropped = event.dropped ?? 0;
  if (dropped > (hostDropped.get(event.session) ?? 0)) {
    hostDropped.set(event.session, dropped);
    (offscreenTab === tabId ? offscreenPort : mediaPorts.get(tabId))?.postMessage({ kind: "step_down" });
  }
}

const fromExtensionPage = (sender: chrome.runtime.MessageSender): boolean =>
  sender.id === chrome.runtime.id &&
  sender.tab === undefined &&
  sender.url?.startsWith(chrome.runtime.getURL("")) === true;

/** Popup → background. Only extension pages may make requests; content scripts may only send media (below). */
chrome.runtime.onMessage.addListener((message: PopupCall, sender, sendResponse) => {
  if (!fromExtensionPage(sender) || typeof message !== "object") return false;
  answer(message).then(
    (result) => {
      sendResponse({ ok: true, ...result });
    },
    (error: unknown) => {
      sendResponse({ ok: false, error: error instanceof Error ? error.message : "drift failed" });
    },
  );
  return true; // answered asynchronously
});

async function answer(call: PopupCall): Promise<object> {
  switch (call.kind) {
    case "host":
      // pair_begin waits for the receiver to show its PIN; pair_pin for pairing to finish.
      return {
        response: await client.request(call.request, call.request.type.startsWith("pair_") ? 30_000 : undefined),
      };
    case "mirror":
      return { info: await startMirror(call.tabId, call.frameId, call.index, call.device) };
    case "mirror_stop":
      await stopMirror(call.tabId, "stopped");
      return {};
    case "mirror_info":
      return { info: infos.get(call.tabId) };
  }
}

/**
 * Media ports. From a content script: media for its own tab's session (page path) or placement updates (fallback).
 * From the offscreen document: media for the tab it captures. Anything else is dropped.
 */
chrome.runtime.onConnect.addListener((port) => {
  const fromOffscreen = port.sender?.url === chrome.runtime.getURL(OFFSCREEN_URL);
  const tabId = fromOffscreen ? offscreenTab : port.sender?.tab?.id;
  if (port.name !== MEDIA_PORT || port.sender?.id !== chrome.runtime.id || tabId === undefined) {
    port.disconnect();
    return;
  }
  if (sessions.session(tabId) === undefined) {
    port.disconnect();
    return;
  }
  if (fromOffscreen) offscreenPort = port;
  else mediaPorts.set(tabId, port);
  port.onMessage.addListener((raw: unknown) => {
    if (isStats(raw)) {
      const info = infos.get(tabId);
      if (info) info.stats = raw.stats;
      return;
    }
    if (!fromOffscreen && isPlacement(raw)) {
      if (offscreenTab === tabId)
        void toOffscreen({ target: "offscreen", action: "placement", placement: raw.placement });
      return;
    }
    const notification = sessions.accept(tabId, raw);
    if (notification !== undefined) client.notify(notification);
  });
  port.onDisconnect.addListener(() => {
    if (fromOffscreen) {
      if (offscreenPort === port) offscreenPort = undefined;
    } else if (mediaPorts.get(tabId) === port) {
      mediaPorts.delete(tabId);
    }
    void stopMirror(tabId, "capture_ended");
  });
});

async function startMirror(tabId: number, frameId: number, index: number, device: string): Promise<MirrorInfo> {
  if (sessions.session(tabId) !== undefined) await stopMirror(tabId, "replaced");
  await chrome.scripting.executeScript({ target: { tabId, frameIds: [frameId] }, files: ["capture.js"] });
  const prepared = await toFrame<PrepareResult>(tabId, frameId, { kind: "drift-capture", action: "prepare", index });
  if (!prepared.ok) {
    if (prepared.error === "capture_failed") return startTabCapture(tabId, frameId, device, prepared.placement);
    throw new Error(prepared.error);
  }
  const session = await mirrorStart(device, prepared.audio);
  sessions.bind(tabId, session);
  frames.set(tabId, frameId);
  const { codec, width, height, fps } = prepared;
  const info: MirrorInfo = { session, device, mode: "page", codec, width, height, fps };
  infos.set(tabId, info);
  await toFrame(tabId, frameId, { kind: "drift-capture", action: "start", session });
  return info;
}

/** Fallback (implementation step 8): capture the whole tab in the offscreen document, cropped to the video. */
async function startTabCapture(
  tabId: number,
  frameId: number,
  device: string,
  placement: Placement | null,
): Promise<MirrorInfo> {
  if (offscreenTab !== undefined) await stopMirror(offscreenTab, "replaced");
  const session = await mirrorStart(device, true); // tab capture always has a sound track
  sessions.bind(tabId, session);
  frames.set(tabId, frameId);
  offscreenTab = tabId;
  try {
    // After mirror_start, which may retry for a while: stream ids are short-lived.
    const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tabId });
    await ensureOffscreen();
    const started = await toOffscreen<OffscreenStarted>({
      target: "offscreen",
      action: "start",
      streamId,
      session,
      placement,
    });
    if (!started.ok) throw new Error(started.error);
    const { codec, width, height, fps } = started;
    const info: MirrorInfo = { session, device, mode: "tab", codec, width, height, fps };
    infos.set(tabId, info);
    await toFrame(tabId, frameId, { kind: "drift-capture", action: "track" });
    return info;
  } catch (e) {
    await stopMirror(tabId, "capture_failed");
    throw e;
  }
}

async function mirrorStart(device: string, audio: boolean): Promise<string> {
  const response = await client.request(
    { type: "mirror_start", device, ...(audio ? { audio: AUDIO } : {}) },
    MIRROR_START_TIMEOUT_MS,
  );
  if (response.type === "error") throw new Error(response.code);
  if (response.type !== "mirror_started") throw new Error("unexpected answer from drift-host");
  return response.session;
}

async function ensureOffscreen(): Promise<void> {
  const url = chrome.runtime.getURL(OFFSCREEN_URL);
  const existing = await chrome.runtime.getContexts({ contextTypes: ["OFFSCREEN_DOCUMENT"], documentUrls: [url] });
  if (existing.length > 0) return;
  await chrome.offscreen.createDocument({
    url: OFFSCREEN_URL,
    reasons: ["USER_MEDIA"],
    justification: "Mirror a video whose page doesn't allow capturing it directly, by capturing the tab.",
  });
}

function toOffscreen<T = unknown>(command: OffscreenCommand): Promise<T> {
  return chrome.runtime.sendMessage<OffscreenCommand, T>(command);
}

async function stopMirror(tabId: number, why: string): Promise<void> {
  const session = sessions.unbind(tabId);
  if (session === undefined) return;
  const info = infos.get(tabId);
  if (info) info.stopped = why;
  mediaPorts.get(tabId)?.postMessage({ kind: "stop" });
  mediaPorts.delete(tabId);
  if (offscreenTab === tabId) {
    offscreenTab = undefined;
    offscreenPort = undefined;
    await toOffscreen({ target: "offscreen", action: "stop" }).catch(() => undefined);
    await chrome.offscreen.closeDocument().catch(() => undefined); // releases the tab: it's audible again
  }
  const frameId = frames.get(tabId);
  frames.delete(tabId);
  if (frameId !== undefined) {
    await toFrame(tabId, frameId, { kind: "drift-capture", action: "stop" }).catch(() => undefined);
  }
  await client.request({ type: "mirror_stop", session }).catch(() => undefined); // may already be stopped
}

function toFrame<T>(tabId: number, frameId: number, command: CaptureCommand): Promise<T> {
  return chrome.tabs.sendMessage<CaptureCommand, T>(tabId, command, { frameId });
}

function isStats(raw: unknown): raw is StatsMessage {
  return typeof raw === "object" && raw !== null && (raw as { kind?: unknown }).kind === "stats";
}

function isPlacement(raw: unknown): raw is PlacementMessage {
  return typeof raw === "object" && raw !== null && (raw as { kind?: unknown }).kind === "placement";
}

chrome.tabs.onRemoved.addListener((tabId) => {
  void stopMirror(tabId, "tab_closed");
  infos.delete(tabId);
});
