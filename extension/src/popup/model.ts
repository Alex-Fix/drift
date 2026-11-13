// The popup's decisions, kept free of the DOM and Chrome APIs so they're unit-tested.
import type { CaptureStats, MirrorInfo } from "../messages";
import type { DeviceInfo } from "../protocol";

/** Why the user can't mirror to this receiver right now, or undefined if they can. */
export function blocked(device: DeviceInfo | undefined): "none" | "unsupported" | "unpaired" | undefined {
  if (device === undefined) return "none";
  if (device.mirror === false) return "unsupported";
  if (device.paired === false) return "unpaired";
  return undefined;
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
  session_unknown: "Mirroring already ended.",
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
  replaced: "you started mirroring something else",
  tab_closed: "the tab was closed",
};

export function explain(error: string): string {
  return EXPLANATIONS[error] ?? EXPLANATIONS[error.replaceAll(" ", "_")] ?? `Something went wrong (${error}).`;
}

export function mirrorSummary(info: MirrorInfo, receiver: string): { title: string; detail: string } {
  const started = `${info.codec === "hevc" ? "HEVC" : "H.264"} ${String(info.width)}×${String(info.height)} @ ${String(info.fps)} fps`;
  const quality = info.stats?.quality ?? started; // stats follow resizes and step-downs
  if (info.stopped !== undefined) {
    const why = info.stopped === "stopped" ? "" : ` (${explain(info.stopped)})`;
    return { title: `Stopped mirroring to ${receiver}${why}`, detail: quality };
  }
  const mode = info.mode === "tab" ? ["tab capture"] : [];
  return { title: `Mirroring to ${receiver}`, detail: [quality, ...mode, ...statsLine(info.stats)].join(" · ") };
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
