// Messages inside the extension (popup ⇄ background ⇄ content script). The host protocol is in protocol.ts.
import type { Placement } from "./capture/crop";
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
  mode: "page" | "tab"; // captureStream() in the page, or the tab-capture fallback
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
  quality: string; // what's being encoded now, e.g. "H.264 1920×1080 @ 60 fps"
  stepDowns: number; // times the quality was lowered mid-stream
}

/** Background → content script (chrome.tabs.sendMessage). */
export type CaptureCommand =
  | { kind: "drift-capture"; action: "prepare"; index: number }
  | { kind: "drift-capture"; action: "start"; session: string }
  | { kind: "drift-capture"; action: "track" } // fallback: only report where the video is on screen
  | { kind: "drift-capture"; action: "stop" };

export type PrepareResult =
  | { ok: true; audio: boolean; codec: VideoCodec; width: number; height: number; fps: number }
  | { ok: false; error: "no_video" | "drm" | "encoder_unavailable" }
  /** captureStream() refused (cross-origin media): the tab-capture fallback can crop to `placement`. */
  | { ok: false; error: "capture_failed"; placement: Placement | null };

/** Content script → background on the media port, in fallback mode: the video moved or resized. */
export interface PlacementMessage {
  kind: "placement";
  placement: Placement | null; // null: unknown (e.g. inside a cross-origin frame) — mirror the whole tab
}

/** Background → offscreen document (tab-capture fallback). */
export type OffscreenCommand =
  | { target: "offscreen"; action: "start"; streamId: string; session: string; placement: Placement | null }
  | { target: "offscreen"; action: "placement"; placement: Placement | null }
  | { target: "offscreen"; action: "stop" };

export type OffscreenStarted =
  | { ok: true; codec: VideoCodec; width: number; height: number; fps: number }
  | { ok: false; error: "capture_failed" | "encoder_unavailable" };

/** Content script → background on the media port (besides video/audio notifications). */
export interface StatsMessage {
  kind: "stats";
  stats: CaptureStats;
}

export const MEDIA_PORT = "drift-media";
