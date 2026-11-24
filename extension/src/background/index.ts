import { findCandidates, type Candidate } from "../content/candidates";
import { pauseVideo, resumeVideo } from "../content/page";
import {
  MEDIA_PORT,
  type CaptureCommand,
  type CastInfo,
  type MirrorInfo,
  type OffscreenCommand,
  type OffscreenStarted,
  type OverlayAction,
  type OverlayCommand,
  type OverlayMode,
  type PlacementMessage,
  type PopupCall,
  type PrepareResult,
  type StatsMessage,
  type StreamInfo,
} from "../messages";
import type { Placement } from "../capture/crop";
import type { HostEvent, StreamAction, StreamStatusEvent } from "../protocol";
import { chooseMode, fallsBack, fallsBackOnError, seekTarget, toggleAction } from "./cast";
import { Meter, base64Bytes } from "./meter";
import { parseOverlayAction } from "./overlay";
import { MirrorSessions } from "./mirror";
import { HOST_NAME, NativeClient } from "./native";

// The host retries an unreachable receiver for up to 30 s (the Samsung needs ~10-17 s after the last session).
const START_TIMEOUT_MS = 45_000;
const sessions = new MirrorSessions();
const infos = new Map<number, CastInfo>(); // per tab; kept after a stop so the popup can say why
const frames = new Map<number, number>(); // tab → frame running the capture
const mediaPorts = new Map<number, chrome.runtime.Port>(); // tab → its content script's media port
const OFFSCREEN_URL = "offscreen.html";
let offscreenTab: number | undefined; // the tab the offscreen document is capturing (one fallback at a time)
let offscreenPort: chrome.runtime.Port | undefined;
const AUDIO = { format: "pcm_s16", rate: 44100, channels: 2 } as const;
const hostDropped = new Map<string, number>(); // session → frames the host had dropped at its last status
const meters = new Map<number, Meter>(); // tab → video bytes sent per second (Stats for nerds)
const overlays = new Map<number, number>(); // tab → frame showing the page remote
const deviceNames = new Map<string, string>(); // receiver id → name, from the last scan (the remote shows it)

/** A stream the receiver plays itself, and the page video it came from (paused meanwhile). */
interface Streamed {
  session: string;
  device: string;
  frameId: number;
  index: number;
  played: boolean; // it reached "playing" once: a failure from here on doesn't fall back
}
// Kept in memory like mirroring sessions: the open native port keeps the service worker alive while the host runs,
// and the host sends stream_status every second.
const streams = new Map<number, Streamed>(); // tab → its stream

const client = new NativeClient(() => chrome.runtime.connectNative(HOST_NAME), onHostEvent);

function onHostEvent(event: HostEvent): void {
  // The popup may be closed: nobody listening is fine.
  chrome.runtime.sendMessage({ kind: "event", event }).catch(() => undefined);
  if (event.type === "stream_status") {
    onStreamStatus(event);
    return;
  }
  const tabId = sessions.tabOf(event.session);
  if (tabId === undefined) return;
  if (event.state === "stopped") {
    void stopMirror(tabId, event.reason ?? "stopped");
    return;
  }
  // The host drops frames when the receiver or network can't keep up: ask the capture to lower the quality.
  const dropped = event.dropped ?? 0;
  const info = infos.get(tabId);
  if (info?.kind === "mirror") info.hostDropped = dropped;
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
  // The page remote's clicks: fixed actions, only from the frame showing this tab's remote.
  const action = parseOverlayAction(message);
  const remoteTab = sender.tab?.id;
  if (action !== undefined && sender.id === chrome.runtime.id && remoteTab !== undefined) {
    if (overlays.get(remoteTab) === sender.frameId) void onRemote(remoteTab, action).catch(() => undefined);
    return false;
  }
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
    case "host": {
      // pair_begin waits for the receiver to show its PIN; pair_pin for pairing to finish.
      const response = await client.request(call.request, call.request.type.startsWith("pair_") ? 30_000 : undefined);
      if (response.type === "devices") for (const d of response.devices) deviceNames.set(d.id, d.name);
      return { response };
    }
    case "send":
      return { info: await send(call.tabId, call.frameId, call.index, call.device) };
    case "stop":
      await stopCast(call.tabId, "stopped");
      return {};
    case "stream_control":
      await streamControl(call.tabId, call.action, call.position);
      return {};
    case "bring_back":
      await bringBack(call.tabId);
      return {};
    case "info": {
      const info = infos.get(call.tabId);
      const meter = meters.get(call.tabId);
      if (info?.kind === "mirror" && meter !== undefined) info.bitrate = meter.mbps(Date.now());
      return { info };
    }
  }
}

// ---- Send to TV: stream when the receiver can fetch the video, else (or when it can't play it) mirror -----------

async function send(tabId: number, frameId: number, index: number, device: string): Promise<CastInfo> {
  const video = await readVideo(tabId, frameId, index);
  if (video.drm) throw new Error("drm");
  await stopCast(tabId, "replaced");
  const mode = chooseMode(video);
  const title = video.title;
  if (mode.mode === "mirror") return startMirror(tabId, frameId, index, device, { title });
  const response = await client.request(
    { type: "stream_start", device, url: mode.url, media_type: mode.mediaType, position: video.position },
    START_TIMEOUT_MS,
  );
  if (response.type === "error") {
    if (!fallsBackOnError(response.code)) throw new Error(response.code);
    return startMirror(tabId, frameId, index, device, { title, fellBack: true });
  }
  if (response.type !== "stream_started") throw new Error("unexpected answer from drift-host");
  const { session } = response;
  streams.set(tabId, { session, device, frameId, index, played: false });
  const info: StreamInfo = { kind: "stream", title, session, device, mediaType: mode.mediaType, state: "loading" };
  infos.set(tabId, info);
  await inFrame(tabId, frameId, pauseVideo, [index]).catch(() => undefined); // sound and picture on the TV only
  await showOverlay(tabId, frameId, index, "stream", device);
  return info;
}

async function readVideo(tabId: number, frameId: number, index: number): Promise<Candidate> {
  const video = (await inFrame(tabId, frameId, findCandidates, []))?.[index];
  if (video === undefined) throw new Error("no_video");
  return video;
}

function onStreamStatus(event: StreamStatusEvent): void {
  const tabId = streamTab(event.session);
  if (tabId === undefined) return; // an earlier stream, or one this worker doesn't know
  const stream = streams.get(tabId);
  const info = infos.get(tabId);
  if (stream === undefined || info?.kind !== "stream") return;
  if (event.state === "playing") stream.played = true;
  info.state = event.state;
  for (const field of ["position", "duration", "buffered"] as const) {
    if (event[field] !== undefined) info[field] = event[field];
  }
  if (event.state !== "failed" && event.state !== "stopped") {
    const { position, duration, buffered } = info;
    toOverlay(tabId, {
      kind: "drift-overlay",
      action: "update",
      state: event.state,
      ...(position === undefined ? {} : { position }),
      ...(duration === undefined ? {} : { duration }),
      ...(buffered === undefined ? {} : { buffered }),
    });
    return;
  }
  streams.delete(tabId);
  void hideOverlay(tabId);
  if (fallsBack(event, stream.played)) {
    info.fallingBack = true;
    void fallBackToMirror(tabId, stream, info);
  } else {
    info.stopped = event.reason ?? "stopped";
  }
}

/** The receiver couldn't play the URL (e.g. it needs the browser's cookies): mirror the same video instead. */
async function fallBackToMirror(tabId: number, stream: Streamed, info: StreamInfo): Promise<void> {
  try {
    // Mirroring captures what the page plays: start it again where it was paused.
    if (!(await inFrame(tabId, stream.frameId, resumeVideo, [stream.index, null]))) throw new Error("no_video");
    await startMirror(tabId, stream.frameId, stream.index, stream.device, { title: info.title, fellBack: true });
  } catch (e) {
    info.fallingBack = false;
    info.stopped = e instanceof Error ? e.message : "mirror_failed";
  }
}

async function streamControl(tabId: number, action: StreamAction, position: number | undefined): Promise<void> {
  const stream = streams.get(tabId);
  if (stream === undefined) throw new Error("session_unknown");
  const response = await client.request({
    type: "stream_control",
    session: stream.session,
    action,
    ...(position === undefined ? {} : { position }),
  });
  if (response.type === "error") throw new Error(response.code);
}

/** Stop on the receiver and continue on the page from where the receiver was. */
async function bringBack(tabId: number): Promise<void> {
  const stream = streams.get(tabId);
  const info = infos.get(tabId);
  if (stream === undefined || info?.kind !== "stream") throw new Error("session_unknown");
  await stopStream(tabId, "brought_back");
  const resumed = await inFrame(tabId, stream.frameId, resumeVideo, [stream.index, info.position ?? null]);
  if (resumed !== true) throw new Error("no_video");
}

async function stopStream(tabId: number, why: string): Promise<void> {
  const stream = streams.get(tabId);
  if (stream === undefined) return;
  streams.delete(tabId);
  const info = infos.get(tabId);
  if (info?.kind === "stream") info.stopped = why;
  await hideOverlay(tabId);
  await client.request({ type: "stream_stop", session: stream.session }).catch(() => undefined); // may have ended
}

async function stopCast(tabId: number, why: string): Promise<void> {
  await stopMirror(tabId, why);
  await stopStream(tabId, why);
}

function streamTab(session: string): number | undefined {
  for (const [tabId, stream] of streams) if (stream.session === session) return tabId;
  return undefined;
}

// ---- the page remote (content/overlay.ts) -------------------------------------------------------------------------

/** Best effort: the remote is a convenience, and the popup has every control too. */
async function showOverlay(tabId: number, frameId: number, index: number, mode: OverlayMode, device: string) {
  try {
    await chrome.scripting.executeScript({ target: { tabId, frameIds: [frameId] }, files: ["overlay.js"] });
    overlays.set(tabId, frameId);
    const receiver = deviceNames.get(device) ?? "the TV";
    await toFrame(tabId, frameId, { kind: "drift-overlay", action: "show", index, mode, receiver });
  } catch {
    overlays.delete(tabId);
  }
}

function toOverlay(tabId: number, command: OverlayCommand): void {
  const frameId = overlays.get(tabId);
  if (frameId !== undefined) void toFrame(tabId, frameId, command).catch(() => undefined);
}

async function hideOverlay(tabId: number): Promise<void> {
  const frameId = overlays.get(tabId);
  overlays.delete(tabId);
  if (frameId !== undefined)
    await toFrame(tabId, frameId, { kind: "drift-overlay", action: "hide" }).catch(() => undefined);
}

async function onRemote(tabId: number, action: OverlayAction): Promise<void> {
  if (action === "bring_back") {
    if (streams.has(tabId)) await bringBack(tabId);
    else await stopMirror(tabId, "stopped"); // the capture unmutes the page's video: back to the page with sound
    return;
  }
  const info = infos.get(tabId);
  if (info?.kind !== "stream" || !streams.has(tabId)) return; // while mirroring the remote drives the video itself
  if (action === "toggle") {
    await streamControl(tabId, toggleAction(info), undefined);
    return;
  }
  const position = seekTarget(info, action === "back" ? -10 : 10);
  if (position !== undefined) await streamControl(tabId, "seek", position);
}

/** Run a self-contained function (content/page.ts, content/candidates.ts) in one frame of the tab. */
async function inFrame<Args extends unknown[], Result>(
  tabId: number,
  frameId: number,
  func: (...args: Args) => Result,
  args: Args,
): Promise<Awaited<Result> | undefined> {
  const [result] = await chrome.scripting.executeScript({ target: { tabId, frameIds: [frameId] }, func, args });
  return result?.result;
}

// ---- mirroring ---------------------------------------------------------------------------------------------------

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
      if (info?.kind === "mirror") info.stats = raw.stats;
      return;
    }
    if (!fromOffscreen && isPlacement(raw)) {
      if (offscreenTab === tabId)
        void toOffscreen({ target: "offscreen", action: "placement", placement: raw.placement });
      return;
    }
    const notification = sessions.accept(tabId, raw);
    if (notification === undefined) return;
    if (notification.type === "video") {
      let meter = meters.get(tabId);
      if (meter === undefined) meters.set(tabId, (meter = new Meter()));
      meter.add(base64Bytes(notification.data), Date.now());
    }
    client.notify(notification);
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

async function startMirror(
  tabId: number,
  frameId: number,
  index: number,
  device: string,
  extra: Pick<MirrorInfo, "fellBack" | "title">,
): Promise<MirrorInfo> {
  if (sessions.session(tabId) !== undefined) await stopMirror(tabId, "replaced");
  await chrome.scripting.executeScript({ target: { tabId, frameIds: [frameId] }, files: ["capture.js"] });
  const prepared = await toFrame<PrepareResult>(tabId, frameId, { kind: "drift-capture", action: "prepare", index });
  if (!prepared.ok) {
    if (prepared.error === "capture_failed") {
      return startTabCapture(tabId, frameId, index, device, prepared.placement, extra);
    }
    throw new Error(prepared.error);
  }
  const session = await mirrorStart(device, prepared.audio);
  sessions.bind(tabId, session);
  frames.set(tabId, frameId);
  const { codec, width, height, fps } = prepared;
  const info: MirrorInfo = { kind: "mirror", ...extra, session, device, mode: "page", codec, width, height, fps };
  infos.set(tabId, info);
  await toFrame(tabId, frameId, { kind: "drift-capture", action: "start", session });
  await showOverlay(tabId, frameId, index, "mirror", device);
  return info;
}

/** Fallback (implementation step 8): capture the whole tab in the offscreen document, cropped to the video. */
async function startTabCapture(
  tabId: number,
  frameId: number,
  index: number,
  device: string,
  placement: Placement | null,
  extra: Pick<MirrorInfo, "fellBack" | "title">,
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
    const info: MirrorInfo = { kind: "mirror", ...extra, session, device, mode: "tab", codec, width, height, fps };
    infos.set(tabId, info);
    await toFrame(tabId, frameId, { kind: "drift-capture", action: "track" });
    await showOverlay(tabId, frameId, index, "tab", device);
    return info;
  } catch (e) {
    await stopMirror(tabId, "capture_failed");
    throw e;
  }
}

async function mirrorStart(device: string, audio: boolean): Promise<string> {
  const response = await client.request(
    { type: "mirror_start", device, ...(audio ? { audio: AUDIO } : {}) },
    START_TIMEOUT_MS,
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
  meters.delete(tabId);
  if (session === undefined) return;
  const info = infos.get(tabId);
  if (info?.kind === "mirror") info.stopped = why;
  await hideOverlay(tabId);
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

function toFrame<T>(tabId: number, frameId: number, command: CaptureCommand | OverlayCommand): Promise<T> {
  return chrome.tabs.sendMessage<CaptureCommand | OverlayCommand, T>(tabId, command, { frameId });
}

function isStats(raw: unknown): raw is StatsMessage {
  return typeof raw === "object" && raw !== null && (raw as { kind?: unknown }).kind === "stats";
}

function isPlacement(raw: unknown): raw is PlacementMessage {
  return typeof raw === "object" && raw !== null && (raw as { kind?: unknown }).kind === "placement";
}

chrome.tabs.onRemoved.addListener((tabId) => {
  void stopCast(tabId, "tab_closed");
  infos.delete(tabId);
  overlays.delete(tabId);
});
