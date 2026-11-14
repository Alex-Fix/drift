import { describe, expect, it } from "vitest";
import type { MirrorInfo } from "../src/messages";
import { blocked, explain, mirrorSummary, pickReceiver, receiverLabel } from "../src/popup/model";
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
