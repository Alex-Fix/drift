import { describe, expect, it } from "vitest";
import { BAR_HEIGHT, overlayBox } from "../src/content/overlay-layout";

const viewport = { width: 1280, height: 800 };
const video = { left: 100, top: 80, width: 640, height: 360 };

describe("overlayBox", () => {
  it("covers the video while streaming or mirroring from the page", () => {
    expect(overlayBox(video, viewport, false)).toEqual({ ...video, dock: "over" });
  });

  it("docks a bar below the video in tab capture, outside what the TV sees", () => {
    expect(overlayBox(video, viewport, true)).toEqual({
      left: 100,
      top: 448,
      width: 640,
      height: BAR_HEIGHT,
      dock: "below",
    });
  });

  it("docks above when there's no room below, and hides when neither fits", () => {
    const low = { ...video, top: 400 };
    expect(overlayBox(low, viewport, true)).toMatchObject({ top: 400 - 8 - BAR_HEIGHT, dock: "above" });
    expect(overlayBox({ left: 0, top: 0, width: 1280, height: 800 }, viewport, true)).toBeUndefined();
  });

  it("keeps a docked bar on screen when the video is wider or off to a side", () => {
    expect(overlayBox({ ...video, left: -50, width: 2000 }, viewport, true)).toMatchObject({ left: 0, width: 1280 });
    expect(overlayBox({ ...video, left: 1000 }, viewport, true)).toMatchObject({ left: 640, width: 640 });
  });

  it("shows nothing for a video with no size", () => {
    expect(overlayBox({ ...video, width: 0 }, viewport, false)).toBeUndefined();
  });
});
