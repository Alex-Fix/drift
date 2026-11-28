import { describe, expect, it } from "vitest";
import type { MirrorInfo, StreamInfo } from "../src/messages";
import {
  blocked,
  cantSend,
  castSummary,
  clock,
  explain,
  mirrorSummary,
  pickReceiver,
  receiverLabel,
  sendHint,
  DOWNLOAD_URL,
  deviceDetail,
  hostCard,
  hostProblem,
  major,
  modeBadge,
  platformOf,
  parseTheme,
  pickVideo,
  progress,
  seekTarget,
  sparkline,
  statRows,
  statsBadge,
  toggleAction,
} from "../src/popup/model";
import type { DeviceInfo } from "../src/protocol";

const tv: DeviceInfo = { id: "TV", name: "Living Room", model: "UCU7000", mirror: true, paired: true };
const mac: DeviceInfo = { id: "MAC", name: "MacBook", mirror: false, paired: false };
const newTv: DeviceInfo = { id: "NEW", name: "Bedroom", mirror: true, paired: false };

describe("receivers", () => {
  it("says why a receiver can't be used", () => {
    expect(blocked(undefined)).toBe("none");
    expect(blocked(mac)).toBe("unsupported");
    expect(blocked(newTv)).toBe("unpaired");
    expect(blocked(tv)).toBeUndefined();
    expect(blocked({ id: "OLD", name: "Older host" })).toBeUndefined(); // unknown capabilities: let the host decide
  });

  it("labels receivers with their model and limits", () => {
    expect(receiverLabel(tv)).toBe("Living Room (UCU7000)");
    expect(receiverLabel(mac)).toBe("MacBook — can't mirror");
    expect(receiverLabel(newTv)).toBe("Bedroom — not paired");
  });

  it("preselects the remembered receiver if it can mirror, else the first that can", () => {
    expect(pickReceiver([mac, tv, newTv], "NEW")).toBe("NEW");
    expect(pickReceiver([mac, tv], "MAC")).toBe("TV");
    expect(pickReceiver([mac, tv], undefined)).toBe("TV");
    expect(pickReceiver([mac], undefined)).toBeUndefined();
  });
});

describe("explain", () => {
  it("turns codes and client errors into sentences", () => {
    expect(explain("mirror_unsupported")).toMatch(/FairPlay/);
    expect(explain("device_unreachable")).toMatch(/20 seconds/);
    expect(explain("drift-host is not running or not installed")).toMatch(/install-host/);
  });

  it("falls back to showing the code", () => {
    expect(explain("something_new")).toBe("Something went wrong (something_new).");
  });
});

describe("mirrorSummary", () => {
  const info: MirrorInfo = {
    kind: "mirror",
    title: "Movie",
    session: "s",
    device: "TV",
    mode: "page",
    codec: "hevc",
    width: 3840,
    height: 2160,
    fps: 60,
  };

  it("describes a running session with its quality and measured cost", () => {
    const summary = mirrorSummary(
      {
        ...info,
        stats: {
          frames: 600,
          droppedByEncoder: 2,
          sendAvgMs: 0.5,
          sendMaxMs: 7,
          longTasks: 0,
          audio: "on",
          quality: "HEVC 3840×2160 @ 60 fps",
          stepDowns: 0,
        },
      },
      "Living Room",
    );
    expect(summary.title).toBe("Mirroring to Living Room");
    expect(summary.detail).toBe(
      "HEVC 3840×2160 @ 60 fps · with sound · 2 frames skipped · page cost 0.5 ms/frame (max 7)",
    );
  });

  it("explains why a session stopped, unless the user stopped it", () => {
    expect(mirrorSummary({ ...info, stopped: "stopped" }, "TV").title).toBe("Stopped mirroring to TV");
    expect(mirrorSummary({ ...info, stopped: "mirror_failed" }, "TV").title).toMatch(/refused/);
    expect(mirrorSummary({ ...info, stopped: "capture_ended" }, "TV").title).toMatch(/stopped being captured/);
  });
});

describe("mirrorSummary in tab-capture mode", () => {
  it("says it's capturing the tab", () => {
    const info: MirrorInfo = {
      kind: "mirror",
      title: "Movie",
      session: "s",
      device: "TV",
      mode: "tab",
      codec: "h264",
      width: 1280,
      height: 720,
      fps: 30,
    };
    expect(mirrorSummary(info, "TV").detail).toBe("H.264 1280×720 @ 30 fps · tab capture");
  });
});

describe("mirrorSummary after a step-down", () => {
  it("shows the current quality and that it was lowered", () => {
    const info: MirrorInfo = {
      kind: "mirror",
      title: "Movie",
      session: "s",
      device: "TV",
      mode: "page",
      codec: "hevc",
      width: 3840,
      height: 2160,
      fps: 60,
      stats: {
        frames: 9000,
        droppedByEncoder: 0,
        sendAvgMs: 0.4,
        sendMaxMs: 6,
        longTasks: 0,
        audio: "on",
        quality: "H.264 1920×1080 @ 60 fps",
        stepDowns: 1,
      },
    };
    expect(mirrorSummary(info, "TV").detail).toBe(
      "H.264 1920×1080 @ 60 fps · with sound · quality lowered 1× to keep up · page cost 0.4 ms/frame (max 6)",
    );
  });
});

describe("sending", () => {
  const hls = { url: "https://cdn.example/a.m3u8", mime: undefined, drm: false };
  const blob = { url: undefined, mime: undefined, drm: false };

  it("lets a receiver that can't mirror still take a stream", () => {
    expect(cantSend(mac, hls)).toBe("unpaired"); // streamable, but not paired yet
    expect(cantSend({ ...mac, paired: true }, hls)).toBeUndefined();
    expect(cantSend({ ...mac, paired: true }, blob)).toBe("unsupported");
  });

  it("never sends DRM video and needs pairing and a receiver", () => {
    expect(cantSend(tv, { ...hls, drm: true })).toBe("drm");
    expect(cantSend(newTv, hls)).toBe("unpaired");
    expect(cantSend(undefined, hls)).toBe("none");
    expect(cantSend(tv, blob)).toBeUndefined();
  });

  it("says how the video will be sent", () => {
    expect(sendHint(hls)).toMatch(/plays this video itself/);
    expect(sendHint(blob)).toMatch(/Mirrored/);
  });
});

describe("stream summaries", () => {
  const info: StreamInfo = {
    kind: "stream",
    title: "Movie",
    session: "s",
    device: "TV",
    mediaType: "file",
    state: "playing",
  };

  it("shows where it is on the TV", () => {
    const summary = castSummary({ ...info, position: 75.4, duration: 3723, buffered: 24.6 }, "Living Room");
    expect(summary).toEqual({
      title: "Playing on Living Room",
      detail: "1:15 / 1:02:03 · 25 s buffered · played by the TV itself",
    });
  });

  it("names each state and marks live streams", () => {
    expect(castSummary({ ...info, state: "loading" }, "TV").title).toBe("Loading on TV…");
    expect(castSummary({ ...info, state: "paused" }, "TV").title).toBe("Paused on TV");
    expect(castSummary({ ...info, state: "ended" }, "TV").title).toBe("Finished on TV");
    expect(castSummary({ ...info, position: 5 }, "TV").detail).toBe("0:05 · live · played by the TV itself");
  });

  it("says when it switches to mirroring, and why a stream stopped", () => {
    expect(castSummary({ ...info, fallingBack: true }, "TV")).toEqual({
      title: "TV couldn't play it directly",
      detail: "Switching to mirroring…",
    });
    expect(castSummary({ ...info, stopped: "brought_back" }, "TV").title).toBe("Back on the page");
    expect(castSummary({ ...info, stopped: "stopped" }, "TV").title).toBe("Stopped playing on TV");
    expect(castSummary({ ...info, stopped: "stream_failed" }, "TV").title).toMatch(/couldn't play this video/);
  });

  it("says a mirror is a fallback from streaming", () => {
    const mirror: MirrorInfo = {
      kind: "mirror",
      title: "Movie",
      fellBack: true,
      session: "s",
      device: "TV",
      mode: "page",
      codec: "h264",
      width: 1280,
      height: 720,
      fps: 30,
    };
    expect(castSummary(mirror, "TV").detail).toBe(
      "streaming wasn't possible, mirroring instead · H.264 1280×720 @ 30 fps",
    );
  });

  it("formats clock times", () => {
    expect(clock(0)).toBe("0:00");
    expect(clock(59.9)).toBe("0:59");
    expect(clock(3600)).toBe("1:00:00");
    expect(clock(-3)).toBe("0:00");
  });
});

describe("the redesigned popup", () => {
  const playing: StreamInfo = {
    kind: "stream",
    title: "Movie",
    session: "s",
    device: "TV",
    mediaType: "streaming",
    state: "playing",
    position: 341,
    duration: 754,
    buffered: 42,
  };

  const omit = (key: "duration" | "position"): StreamInfo =>
    Object.fromEntries(Object.entries(playing).filter(([name]) => name !== key)) as unknown as StreamInfo;

  it("keeps only known themes, defaulting to the system's", () => {
    expect(parseTheme("neon")).toBe("neon");
    expect(parseTheme("daylight")).toBe("daylight");
    expect(parseTheme("hacker")).toBe("auto");
    expect(parseTheme(undefined)).toBe("auto");
  });

  it("describes receivers and how a video will be sent", () => {
    expect(deviceDetail(tv)).toBe("UCU7000 · paired");
    expect(deviceDetail(mac)).toBe("AirPlay · not paired · can't mirror");
    expect(modeBadge({ url: "https://a.example/v.m3u8", mime: undefined })).toBe("Full quality · TV streams it");
    expect(modeBadge({ url: undefined, mime: undefined })).toBe("Mirrored from this tab");
  });

  it("preselects the playing video, never a DRM one if another will do", () => {
    const v = (playing: boolean, drm = false) => ({ playing, drm });
    expect(pickVideo([v(false), v(true)])).toBe(1);
    expect(pickVideo([v(true, true), v(false)])).toBe(1);
    expect(pickVideo([v(false, true)])).toBe(0);
    expect(pickVideo([])).toBeUndefined();
  });

  it("draws progress with what's buffered ahead, and nothing for live streams", () => {
    const shown = progress(playing);
    expect(shown?.played).toBeCloseTo(341 / 754);
    expect(shown?.buffered).toBeCloseTo(42 / 754);
    expect(progress({ ...playing, position: 750, buffered: 30 })?.buffered).toBeCloseTo(4 / 754);
    expect(progress(omit("duration"))).toBeUndefined();
  });

  it("seeks ten seconds either way inside the video", () => {
    expect(seekTarget(playing, 10)).toBe(351);
    expect(seekTarget({ ...playing, position: 4 }, -10)).toBe(0);
    expect(seekTarget({ ...playing, position: 750 }, 10)).toBe(754);
    expect(seekTarget(omit("duration"), 10)).toBe(351);
    expect(seekTarget(omit("position"), 10)).toBeUndefined();
  });

  it("toggles between pause and resume", () => {
    expect(toggleAction(playing)).toBe("pause");
    expect(toggleAction({ ...playing, state: "paused" })).toBe("resume");
    expect(toggleAction({ ...playing, state: "ended" })).toBe("resume");
  });

  it("lists stream stats", () => {
    expect(statsBadge(playing)).toBe("TV streams it");
    expect(statRows(playing)).toEqual([
      ["State", "playing"],
      ["Format", "HLS"],
      ["Position", "5:41"],
      ["Length", "12:34"],
      ["Buffered", "+42 s"],
    ]);
  });

  it("lists mirroring stats with the latest bitrate", () => {
    const mirror: MirrorInfo = {
      kind: "mirror",
      title: "Movie",
      session: "s",
      device: "TV",
      mode: "tab",
      codec: "h264",
      width: 1920,
      height: 1080,
      fps: 60,
      bitrate: [5, 12.34, 0],
      hostDropped: 3,
    };
    expect(statsBadge(mirror)).toBe("Mirroring · tab capture");
    expect(statRows(mirror)).toEqual([
      ["Quality", "H.264 1920×1080 @ 60 fps"],
      ["Bitrate", "12.3 Mbit/s"],
      ["Dropped", "3"],
      ["Skipped", "0"],
      ["Page cost", "—"],
      ["Sound", "—"],
    ]);
  });

  it("draws a sparkline scaled to its peak", () => {
    expect(sparkline([0, 10, 5], 100, 50)).toEqual({
      line: "M0 50 L50 6.4 L100 28.2",
      area: "M0 50 L50 6.4 L100 28.2 L100 50 L0 50 Z",
    });
    expect(sparkline([0, 0], 10, 10).line).toBe("M0 10 L10 10");
  });
});

describe("the companion app", () => {
  it("knows when drift-host is missing", () => {
    expect(hostProblem("drift-host is not running or not installed", undefined, "1.0.0")).toEqual({ kind: "missing" });
    expect(hostProblem("drift-host did not answer", undefined, "1.0.0")).toBeUndefined(); // running, just slow
  });

  it("asks to update a host older than the extension's major version", () => {
    expect(hostProblem(undefined, "0.9.2", "1.0.0")).toEqual({ kind: "outdated", host: "0.9.2", needed: 1 });
    expect(hostProblem(undefined, "1.0.0rc1", "1.2.0")).toBeUndefined();
    expect(hostProblem(undefined, "2.0.0", "1.0.0")).toBeUndefined(); // newer host: the extension updates itself
    expect(hostProblem(undefined, "weird", "1.0.0")).toBeUndefined();
  });

  it("reads major versions", () => {
    expect(major("1.0.0rc1")).toBe(1);
    expect(major("12.3.4")).toBe(12);
    expect(major("v1")).toBeUndefined();
  });

  it("offers the download for the user's OS", () => {
    expect(platformOf("macOS")).toBe("macOS");
    expect(platformOf("MacIntel")).toBe("macOS");
    expect(platformOf("Windows")).toBe("Windows");
    expect(platformOf("Win32")).toBe("Windows");
    expect(platformOf("Linux x86_64")).toBe("Linux");
    expect(platformOf("Chrome OS")).toBeUndefined();
    expect(hostCard({ kind: "missing" }, "Windows").button).toBe("Download for Windows");
    expect(hostCard({ kind: "missing" }, undefined).button).toBe("Download drift-host");
    expect(hostCard({ kind: "outdated", host: "0.9.0", needed: 1 }, "macOS").text).toMatch(
      /needs drift-host 1 or newer \(you have 0\.9\.0\)/,
    );
  });

  it("links only to drift's own releases", () => {
    expect(DOWNLOAD_URL).toBe("https://github.com/Alex-Fix/drift/releases/latest");
  });
});
