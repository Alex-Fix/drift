// Messages inside the extension (popup ⇄ background ⇄ content script). The host protocol is in protocol.ts.
import type { Placement } from "./capture/crop";
import type { MediaType, Request, StreamAction, StreamState, VideoCodec } from "./protocol";

/** Popup → background. `send` streams or mirrors the video, whichever works (`background/cast.ts`). */
export type PopupCall =
  | { kind: "host"; request: Request }
  | { kind: "send"; tabId: number; frameId: number; index: number; device: string }
  | { kind: "stop"; tabId: number }
  | { kind: "stream_control"; tabId: number; action: StreamAction; position?: number }
  | { kind: "bring_back"; tabId: number }
  | { kind: "info"; tabId: number };

/** What's on the receiver from a tab: the answer to `info`. */
export type CastInfo = MirrorInfo | StreamInfo;

export interface StreamInfo {
  kind: "stream";
  title: string; // the page's title (page data: shown as text only)
  session: string;
  device: string;
  mediaType: MediaType;
  state: StreamState;
  position?: number; // seconds, as the receiver last reported
  duration?: number; // absent for live streams
  buffered?: number; // seconds loaded ahead
  fallingBack?: boolean; // the receiver couldn't play it: switching to mirroring
  stopped?: string; // why, once the session ended
}

export interface MirrorInfo {
  kind: "mirror";
  fellBack?: boolean; // streaming wasn't possible, so this mirrors instead
  title: string; // the page's title (page data: shown as text only)
  session: string;
  device: string;
  mode: "page" | "tab"; // captureStream() in the page, or the tab-capture fallback
  codec: VideoCodec;
  width: number;
  height: number;
  fps: number;
  stats?: CaptureStats;
  bitrate?: number[]; // Mbit/s sent per second over the last minute, oldest first (filled in when the popup asks)
  hostDropped?: number; // frames the host dropped because the receiver or network couldn't keep up
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

/** How the page remote sits: over the video (stream, page-path mirroring) or docked outside it (tab capture). */
export type OverlayMode = "stream" | "mirror" | "tab";

/** Background → the remote on the page (content/overlay.ts), in the video's frame. */
export type OverlayCommand =
  | { kind: "drift-overlay"; action: "show"; index: number; mode: OverlayMode; receiver: string }
  | {
      kind: "drift-overlay";
      action: "update";
      state: StreamState;
      position?: number;
      duration?: number;
      buffered?: number;
    }
  | { kind: "drift-overlay"; action: "hide" };

/**
 * The remote → background: a button the user clicked, or a moment picked on the progress bar. Fixed actions only, accepted from the frame the background
 * put the remote in (background/overlay.ts). While mirroring the remote drives the page's own video itself and only
 * sends `bring_back` (stop mirroring, back to the page with sound).
 */
export const OVERLAY_ACTIONS = ["toggle", "back", "forward", "bring_back"] as const;
export type OverlayAction = (typeof OVERLAY_ACTIONS)[number];
/** A button, or a jump to `position` seconds from the progress bar. */
export type OverlayRequest = { action: OverlayAction } | { action: "seek"; position: number };
export type OverlayActionMessage = { kind: "drift-overlay-action" } & OverlayRequest;
export const MAX_POSITION = 10_000_000; // seconds (~115 days): beyond any video
