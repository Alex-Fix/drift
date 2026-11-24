// "Send to TV" decisions, free of Chrome APIs so they're unit-tested: stream or mirror, and when to fall back.
import type { StreamInfo } from "../messages";
import type { MediaType, StreamStatusEvent } from "../protocol";

export type Mode = { mode: "stream"; url: string; mediaType: MediaType } | { mode: "mirror" };

const HLS_PATH = /\.m3u8$/i;
const FILE_PATH = /\.(?:mp4|m4v|mov)$/i;
const HLS_TYPES = new Set(["application/vnd.apple.mpegurl", "application/x-mpegurl", "audio/mpegurl"]);
const FILE_TYPES = new Set(["video/mp4", "video/x-m4v", "video/quicktime"]);

/**
 * Streaming (the receiver fetches the URL) when the video has an http(s) address of a format AirPlay receivers play:
 * HLS, or an MP4/MOV file, by path or by the `<source type>`. Anything else (blob/MSE players, DASH, WebM) mirrors.
 */
export function chooseMode(video: { url: string | undefined; mime?: string | undefined }): Mode {
  if (video.url === undefined) return { mode: "mirror" };
  let url: URL;
  try {
    url = new URL(video.url);
  } catch {
    return { mode: "mirror" };
  }
  if ((url.protocol !== "http:" && url.protocol !== "https:") || url.hostname === "") return { mode: "mirror" };
  const mime = video.mime?.split(";")[0]?.trim().toLowerCase() ?? "";
  if (HLS_PATH.test(url.pathname) || HLS_TYPES.has(mime))
    return { mode: "stream", url: video.url, mediaType: "streaming" };
  if (FILE_PATH.test(url.pathname) || FILE_TYPES.has(mime))
    return { mode: "stream", url: video.url, mediaType: "file" };
  return { mode: "mirror" };
}

/** Host errors from stream_start after which mirroring the same video is worth trying. */
export function fallsBackOnError(code: string): boolean {
  return code === "stream_failed";
}

/**
 * Whether a stream that never started playing should become mirroring: the receiver couldn't play the URL (e.g. it
 * needs the browser's cookies) or dropped the session before playing. Once it has played, a failure just ends it.
 */
export function fallsBack(status: Pick<StreamStatusEvent, "state" | "reason">, played: boolean): boolean {
  if (played) return false;
  return status.state === "failed" || (status.state === "stopped" && status.reason !== undefined);
}

/** Where ±`delta` seconds lands, kept inside the video; undefined before the receiver reported a position. */
export function seekTarget(info: StreamInfo, delta: number): number | undefined {
  if (info.position === undefined) return undefined;
  const end = info.duration ?? Number.POSITIVE_INFINITY;
  return Math.min(end, Math.max(0, info.position + delta));
}

export function toggleAction(info: StreamInfo): "pause" | "resume" {
  return info.state === "playing" || info.state === "loading" ? "pause" : "resume";
}
