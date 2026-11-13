// Messages inside the extension (popup ⇄ background ⇄ content script). The host protocol is in protocol.ts.
import type { Request, VideoCodec } from "./protocol";

/** Popup → background. */
export type PopupCall =
  | { kind: "host"; request: Request }
  | { kind: "mirror"; tabId: number; frameId: number; index: number; device: string }
  | { kind: "mirror_stop"; tabId: number }
  | { kind: "mirror_info"; tabId: number };

export interface MirrorInfo {
  session: string;
  device: string;
  codec: VideoCodec;
  width: number;
  height: number;
  fps: number;
  stats?: CaptureStats;
  stopped?: string; // why, once the session ended
}

/** Measured in the content script: what mirroring costs the page's own thread. */
export interface CaptureStats {
  frames: number;
  droppedByEncoder: number; // frames skipped because the encoder queue was full
  sendAvgMs: number; // base64 + postMessage per encoded chunk, on the page thread
  sendMaxMs: number;
  longTasks: number; // page tasks over 50 ms since mirroring started
  audio: "on" | "off" | "unavailable";
}

/** Background → content script (chrome.tabs.sendMessage). */
export type CaptureCommand =
  | { kind: "drift-capture"; action: "prepare"; index: number }
  | { kind: "drift-capture"; action: "start"; session: string }
  | { kind: "drift-capture"; action: "stop" };

export type PrepareResult =
  | { ok: true; audio: boolean; codec: VideoCodec; width: number; height: number; fps: number }
  | { ok: false; error: "no_video" | "drm" | "capture_failed" | "encoder_unavailable" };

/** Content script → background on the media port (besides video/audio notifications). */
export interface StatsMessage {
  kind: "stats";
  stats: CaptureStats;
}

export const MEDIA_PORT = "drift-media";
