import {
  MEDIA_PORT,
  type CaptureCommand,
  type MirrorInfo,
  type PopupCall,
  type PrepareResult,
  type StatsMessage,
} from "../messages";
import type { HostEvent } from "../protocol";
import { MirrorSessions } from "./mirror";
import { HOST_NAME, NativeClient } from "./native";

const sessions = new MirrorSessions();
const infos = new Map<number, MirrorInfo>(); // per tab; kept after a stop so the popup can say why
const frames = new Map<number, number>(); // tab → frame running the capture
const mediaPorts = new Map<number, chrome.runtime.Port>();

const client = new NativeClient(() => chrome.runtime.connectNative(HOST_NAME), onHostEvent);

function onHostEvent(event: HostEvent): void {
  // The popup may be closed: nobody listening is fine.
  chrome.runtime.sendMessage({ kind: "event", event }).catch(() => undefined);
  if (event.type === "mirror_status" && event.state === "stopped") {
    const tabId = sessions.tabOf(event.session);
    if (tabId !== undefined) void stopMirror(tabId, event.reason ?? "stopped");
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
      return { response: await client.request(call.request) };
    case "mirror":
      return { info: await startMirror(call.tabId, call.frameId, call.index, call.device) };
    case "mirror_stop":
      await stopMirror(call.tabId, "stopped");
      return {};
    case "mirror_info":
      return { info: infos.get(call.tabId) };
  }
}

/** Media from the content script mirroring in a tab: forwarded only if it's for that tab's session. */
chrome.runtime.onConnect.addListener((port) => {
  const tabId = port.sender?.tab?.id;
  if (port.name !== MEDIA_PORT || port.sender?.id !== chrome.runtime.id || tabId === undefined) {
    port.disconnect();
    return;
  }
  if (sessions.session(tabId) === undefined) {
    port.disconnect();
    return;
  }
  mediaPorts.set(tabId, port);
  port.onMessage.addListener((raw: unknown) => {
    if (isStats(raw)) {
      const info = infos.get(tabId);
      if (info) info.stats = raw.stats;
      return;
    }
    const notification = sessions.accept(tabId, raw);
    if (notification !== undefined) client.notify(notification);
  });
  port.onDisconnect.addListener(() => {
    if (mediaPorts.get(tabId) === port) mediaPorts.delete(tabId);
    void stopMirror(tabId, "capture_ended");
  });
});

async function startMirror(tabId: number, frameId: number, index: number, device: string): Promise<MirrorInfo> {
  if (sessions.session(tabId) !== undefined) await stopMirror(tabId, "replaced");
  await chrome.scripting.executeScript({ target: { tabId, frameIds: [frameId] }, files: ["capture.js"] });
  const prepared = await toFrame<PrepareResult>(tabId, frameId, { kind: "drift-capture", action: "prepare", index });
  if (!prepared.ok) throw new Error(prepared.error);
  const response = await client.request({
    type: "mirror_start",
    device,
    ...(prepared.audio ? { audio: { format: "pcm_s16", rate: 44100, channels: 2 } as const } : {}),
  });
  if (response.type === "error") throw new Error(response.code);
  if (response.type !== "mirror_started") throw new Error("unexpected answer from drift-host");
  sessions.bind(tabId, response.session);
  frames.set(tabId, frameId);
  const info: MirrorInfo = { session: response.session, device, ...prepared };
  infos.set(tabId, info);
  await toFrame(tabId, frameId, { kind: "drift-capture", action: "start", session: response.session });
  return info;
}

async function stopMirror(tabId: number, why: string): Promise<void> {
  const session = sessions.unbind(tabId);
  if (session === undefined) return;
  const info = infos.get(tabId);
  if (info) info.stopped = why;
  mediaPorts.get(tabId)?.postMessage({ kind: "stop" });
  mediaPorts.delete(tabId);
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

chrome.tabs.onRemoved.addListener((tabId) => {
  void stopMirror(tabId, "tab_closed");
  infos.delete(tabId);
});
