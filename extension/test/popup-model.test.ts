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
  const info: StreamInfo = { kind: "stream", session: "s", device: "TV", mediaType: "file", state: "playing" };

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
