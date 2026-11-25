// The popup's decisions, kept free of the DOM and Chrome APIs so they're unit-tested.
import { chooseMode } from "../background/cast";

export { seekTarget, toggleAction } from "../background/cast";
import type { Candidate } from "../content/candidates";
import type { CastInfo, CaptureStats, MirrorInfo, StreamInfo } from "../messages";
import type { DeviceInfo } from "../protocol";

/** Why the user can't mirror to this receiver right now, or undefined if they can. */
export function blocked(device: DeviceInfo | undefined): "none" | "unsupported" | "unpaired" | undefined {
  if (device === undefined) return "none";
  if (device.mirror === false) return "unsupported";
  if (device.paired === false) return "unpaired";
  return undefined;
}

/** Why this video can't be sent to this receiver, or undefined. A receiver that can't mirror can still stream. */
export function cantSend(
  device: DeviceInfo | undefined,
  video: Pick<Candidate, "url" | "mime" | "drm">,
): "drm" | "none" | "unsupported" | "unpaired" | undefined {
  if (video.drm) return "drm";
  if (device === undefined) return "none";
  if (device.mirror === false && chooseMode(video).mode === "mirror") return "unsupported";
  if (device.paired === false) return "unpaired";
  return undefined;
}

/** How "Send to TV" will send this video. */
export function sendHint(video: Pick<Candidate, "url" | "mime">): string {
  return chooseMode(video).mode === "stream"
    ? "The TV plays this video itself, in full quality."
    : "Mirrored from this tab (the TV can't fetch this video itself).";
}

export function receiverLabel(device: DeviceInfo): string {
  const name = device.model ? `${device.name} (${device.model})` : device.name;
  switch (blocked(device)) {
    case "unsupported":
      return `${name} — can't mirror`;
    case "unpaired":
      return `${name} — not paired`;
    default:
      return name;
  }
}

/** The receiver to preselect: the remembered one if it can still mirror, else the first that can. */
export function pickReceiver(devices: readonly DeviceInfo[], remembered: string | undefined): string | undefined {
  const usable = devices.filter((d) => d.mirror !== false);
  return (usable.find((d) => d.id === remembered) ?? usable[0])?.id;
}

const EXPLANATIONS: Record<string, string> = {
  // host
  mirror_unsupported: "This receiver can't mirror from drift (it needs Apple's FairPlay).",
  mirror_failed: "The receiver refused to mirror. Check that AirPlay is on and try again.",
  device_unreachable:
    "Couldn't reach the receiver. If you just stopped mirroring, it needs up to 20 seconds; otherwise check it's on.",
  unknown_device: "That receiver isn't on the network any more. Search again.",
  pairing_required: "Pair with this receiver first.",
  pairing_failed: "Pairing didn't work. Check the PIN on the TV and try again.",
  session_unknown: "That session already ended.",
  stream_failed: "The receiver couldn't play this video.",
  internal_error: "drift-host hit an internal error; its log has the details.",
  // extension
  no_video: "That video isn't on the page any more.",
  drm: "This video is DRM-protected; drift can't mirror it.",
  capture_failed: "Chrome can't capture this video (it may come from another site). Try the site's own page.",
  encoder_unavailable: "This computer can't encode video for mirroring.",
  "drift-host is not running or not installed":
    "drift-host isn't installed for this browser. Run scripts/install-host.sh --extension-id <this extension's id>.",
  "drift-host did not answer": "drift-host didn't answer in time. Try again.",
  // why the background ended a session
  capture_ended: "the video stopped being captured — the page may have changed or reloaded",
  replaced: "you sent something else",
  brought_back: "you brought it back to the page",
  tab_closed: "the tab was closed",
};

export function explain(error: string): string {
  return EXPLANATIONS[error] ?? EXPLANATIONS[error.replaceAll(" ", "_")] ?? `Something went wrong (${error}).`;
}

export function castSummary(info: CastInfo, receiver: string): { title: string; detail: string } {
  return info.kind === "stream" ? streamSummary(info, receiver) : mirrorSummary(info, receiver);
}

const STREAM_TITLES: Record<StreamInfo["state"], (receiver: string) => string> = {
  loading: (r) => `Loading on ${r}…`,
  playing: (r) => `Playing on ${r}`,
  paused: (r) => `Paused on ${r}`,
  ended: (r) => `Finished on ${r}`,
  stopped: (r) => `Stopped playing on ${r}`,
  failed: (r) => `${r} couldn't play it`,
};

export function streamSummary(info: StreamInfo, receiver: string): { title: string; detail: string } {
  if (info.fallingBack === true) {
    return { title: `${receiver} couldn't play it directly`, detail: "Switching to mirroring…" };
  }
  if (info.stopped === "brought_back") return { title: "Back on the page", detail: "" };
  if (info.stopped !== undefined) {
    const why = info.stopped === "stopped" ? "" : ` (${explain(info.stopped)})`;
    return { title: `Stopped playing on ${receiver}${why}`, detail: "" };
  }
  const time =
    info.position === undefined
      ? []
      : [
          info.duration === undefined
            ? `${clock(info.position)} · live`
            : `${clock(info.position)} / ${clock(info.duration)}`,
        ];
  const buffered = info.buffered === undefined ? [] : [`${String(Math.round(info.buffered))} s buffered`];
  return {
    title: STREAM_TITLES[info.state](receiver),
    detail: [...time, ...buffered, "played by the TV itself"].join(" · "),
  };
}

/** 75 → "1:15", 3723 → "1:02:03". */
export function clock(seconds: number): string {
  const whole = Math.max(0, Math.floor(seconds));
  const [h, m, s] = [Math.floor(whole / 3600), Math.floor((whole % 3600) / 60), whole % 60];
  const pad = (n: number) => String(n).padStart(2, "0");
  return h > 0 ? `${String(h)}:${pad(m)}:${pad(s)}` : `${String(m)}:${pad(s)}`;
}

export function mirrorSummary(info: MirrorInfo, receiver: string): { title: string; detail: string } {
  const started = `${info.codec === "hevc" ? "HEVC" : "H.264"} ${String(info.width)}×${String(info.height)} @ ${String(info.fps)} fps`;
  const quality = info.stats?.quality ?? started; // stats follow resizes and step-downs
  if (info.stopped !== undefined) {
    const why = info.stopped === "stopped" ? "" : ` (${explain(info.stopped)})`;
    return { title: `Stopped mirroring to ${receiver}${why}`, detail: quality };
  }
  const mode = info.mode === "tab" ? ["tab capture"] : [];
  const fellBack = info.fellBack === true ? ["streaming wasn't possible, mirroring instead"] : [];
  return {
    title: `Mirroring to ${receiver}`,
    detail: [...fellBack, quality, ...mode, ...statsLine(info.stats)].join(" · "),
  };
}

function statsLine(stats: CaptureStats | undefined): string[] {
  if (stats === undefined) return [];
  const audio =
    stats.audio === "on" ? "with sound" : stats.audio === "off" ? "no sound on the page" : "sound unavailable";
  const parts = [audio];
  if (stats.stepDowns > 0) parts.push(`quality lowered ${String(stats.stepDowns)}× to keep up`);
  if (stats.droppedByEncoder > 0) parts.push(`${String(stats.droppedByEncoder)} frames skipped`);
  parts.push(`page cost ${String(stats.sendAvgMs)} ms/frame (max ${String(stats.sendMaxMs)})`);
  if (stats.longTasks > 0) parts.push(`${String(stats.longTasks)} long tasks`);
  return parts;
}

// ---- the redesigned popup (Play on TV design, implementation step 6) ----------------------------------------------

export type ThemeChoice = "auto" | "midnight" | "daylight" | "neon";

/** "auto" follows the system: Midnight Glass when it's dark, Daylight when it's light. */
export const THEMES: readonly { id: ThemeChoice; name: string }[] = [
  { id: "auto", name: "Match the system" },
  { id: "midnight", name: "Midnight Glass" },
  { id: "daylight", name: "Daylight" },
  { id: "neon", name: "Neon Cinema" },
];

export function parseTheme(value: unknown): ThemeChoice {
  return THEMES.find((theme) => theme.id === value)?.id ?? "auto";
}

/** The line under a receiver's name. */
export function deviceDetail(device: DeviceInfo): string {
  const parts = [device.model ?? "AirPlay", device.paired === false ? "not paired" : "paired"];
  if (device.mirror === false) parts.push("can't mirror");
  return parts.join(" · ");
}

export function modeBadge(video: Pick<Candidate, "url" | "mime">): string {
  return chooseMode(video).mode === "stream" ? "Full quality · TV streams it" : "Mirrored from this tab";
}

/** The video to preselect: the first one playing, else the first one drift may send. */
export function pickVideo(videos: readonly Pick<Candidate, "drm" | "playing">[]): number | undefined {
  const index = videos.findIndex((v) => v.playing && !v.drm);
  if (index >= 0) return index;
  const sendable = videos.findIndex((v) => !v.drm);
  return sendable >= 0 ? sendable : videos.length > 0 ? 0 : undefined;
}

/** How much of the stream has played and how much more is loaded, as fractions of its length (none when live). */
export function progress(info: StreamInfo): { played: number; buffered: number } | undefined {
  if (info.duration === undefined || info.duration <= 0 || info.position === undefined) return undefined;
  const fraction = (seconds: number) => Math.min(1, Math.max(0, seconds / (info.duration ?? 1)));
  const played = fraction(info.position);
  return { played, buffered: fraction(info.position + (info.buffered ?? 0)) - played };
}

export function statsBadge(info: CastInfo): string {
  if (info.kind === "stream") return "TV streams it";
  return info.mode === "tab" ? "Mirroring · tab capture" : "Mirroring";
}

/** Stats for nerds: label → value rows. */
export function statRows(info: CastInfo): [string, string][] {
  if (info.kind === "stream") {
    return [
      ["State", info.state],
      ["Format", info.mediaType === "streaming" ? "HLS" : "File"],
      ["Position", info.position === undefined ? "—" : clock(info.position)],
      ["Length", info.duration === undefined ? "live" : clock(info.duration)],
      ["Buffered", info.buffered === undefined ? "—" : `+${String(Math.round(info.buffered))} s`],
    ];
  }
  const codec = info.codec === "hevc" ? "HEVC" : "H.264";
  const quality =
    info.stats?.quality ?? `${codec} ${String(info.width)}×${String(info.height)} @ ${String(info.fps)} fps`;
  const latest = [...(info.bitrate ?? [])].reverse().find((mbps) => mbps > 0);
  const stats = info.stats;
  return [
    ["Quality", quality],
    ["Bitrate", latest === undefined ? "—" : `${latest.toFixed(1)} Mbit/s`],
    ["Dropped", String(info.hostDropped ?? 0)],
    ["Skipped", String(stats?.droppedByEncoder ?? 0)],
    ["Page cost", stats === undefined ? "—" : `${String(stats.sendAvgMs)} ms`], // per frame, on the page's thread
    [
      "Sound",
      stats === undefined ? "—" : stats.audio === "on" ? "on the TV" : stats.audio === "off" ? "none" : "unavailable",
    ],
  ];
}

/** SVG paths for a sparkline of `values` in a `width`×`height` box: the line, and the area under it. */
export function sparkline(values: readonly number[], width: number, height: number): { line: string; area: string } {
  const top = Math.max(...values, 0.001) * 1.1;
  const step = values.length > 1 ? width / (values.length - 1) : width;
  const point = (value: number, i: number) =>
    `${String(Math.round(i * step * 10) / 10)} ${String(Math.round((height - (value / top) * (height - 2)) * 10) / 10)}`;
  const line = values.map((value, i) => `${i === 0 ? "M" : "L"}${point(value, i)}`).join(" ");
  return { line, area: `${line} L${String(width)} ${String(height)} L0 ${String(height)} Z` };
}

// ---- the companion app (release design 2026-11-25, step 5) ---------------------------------------------------------

/** Where users get drift-host: a fixed address, never built from anything the host or a page sends. */
export const DOWNLOAD_URL = "https://github.com/Alex-Fix/drift/releases/latest";
export const HOST_MISSING = "drift-host is not running or not installed"; // NativeClient's error when the port fails

export type HostProblem = { kind: "missing" } | { kind: "outdated"; host: string; needed: number };

/** The leading number of a version ("1.0.0rc1" → 1), or undefined. */
export function major(version: string): number | undefined {
  const match = /^(\d+)\./.exec(version);
  return match?.[1] === undefined ? undefined : Number(match[1]);
}

/**
 * Whether drift-host needs installing or updating: the native port failed, or the host's major version is older
 * than the extension's (`hello` reports it). A newer host is fine; the extension updates itself from the store.
 */
export function hostProblem(
  error: string | undefined,
  hostVersion: string | undefined,
  extensionVersion: string,
): HostProblem | undefined {
  if (error === HOST_MISSING) return { kind: "missing" };
  const host = hostVersion === undefined ? undefined : major(hostVersion);
  const needed = major(extensionVersion);
  if (hostVersion !== undefined && host !== undefined && needed !== undefined && host < needed) {
    return { kind: "outdated", host: hostVersion, needed };
  }
  return undefined;
}

export type Platform = "macOS" | "Windows" | "Linux";

/** The OS to offer a download for, from `navigator.userAgentData.platform` or `navigator.platform`. */
export function platformOf(platform: string): Platform | undefined {
  const name = platform.toLowerCase();
  if (name.startsWith("mac")) return "macOS";
  if (name.startsWith("win")) return "Windows";
  if (name.includes("linux") || name.includes("x11")) return "Linux";
  return undefined;
}

export function hostCard(
  problem: HostProblem,
  platform: Platform | undefined,
): { title: string; text: string; button: string } {
  const button = platform === undefined ? "Download drift-host" : `Download for ${platform}`;
  if (problem.kind === "missing") {
    return {
      title: "drift needs its companion app",
      text: "drift-host talks to your TV over your local network. Install it once, then open this popup again.",
      button,
    };
  }
  return {
    title: "Update drift-host",
    text: `This version of drift needs drift-host ${String(problem.needed)} or newer (you have ${problem.host}).`,
    button,
  };
}
