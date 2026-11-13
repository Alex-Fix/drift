import { describe, expect, it } from "vitest";
import { cropRect, type Placement } from "../src/capture/crop";

const viewport = { width: 1280, height: 720 };
const at = (x: number, y: number, width: number, height: number): Placement => ({
  rect: { x, y, width, height },
  viewport,
});

describe("cropRect", () => {
  it("scales the CSS box to the captured frame, inset by a CSS pixel (e.g. a 2x display)", () => {
    expect(cropRect(at(100, 50, 640, 360), { width: 2560, height: 1440 })).toEqual({
      x: 202,
      y: 102,
      width: 1276,
      height: 716,
    });
  });

  it("rounds inward to even pixels", () => {
    expect(cropRect(at(10.6, 7.3, 301.2, 200.1), { width: 1280, height: 720 })).toEqual({
      x: 12,
      y: 10,
      width: 298,
      height: 196,
    });
  });

  it("accounts for black bars when the tab's aspect ratio differs from the frame", () => {
    // A 1280x720 tab fitted into a 1920x1440 frame: scale 1.5, 180 px bars top and bottom.
    expect(cropRect(at(0, 0, 1280, 720), { width: 1920, height: 1440 })).toEqual({
      x: 2,
      y: 182,
      width: 1916,
      height: 1076,
    });
    // ...and into a 2560x1080 frame: scale 1.5, 320 px bars left and right.
    expect(cropRect(at(100, 100, 400, 200), { width: 2560, height: 1080 })).toEqual({
      x: 472,
      y: 152,
      width: 596,
      height: 296,
    });
  });

  it("gives null while the video is partly scrolled out (the receiver holds the last full frame)", () => {
    expect(cropRect(at(-100, 0, 640, 360), { width: 1280, height: 720 })).toBeNull();
    expect(cropRect(at(0, 500, 640, 360), { width: 1280, height: 720 })).toBeNull();
  });

  it("gives null when the video is off screen or tiny", () => {
    expect(cropRect(at(0, 800, 640, 360), { width: 1280, height: 720 })).toBeNull();
    expect(cropRect(at(0, 0, 10, 10), { width: 1280, height: 720 })).toBeNull();
    const empty = { rect: { x: 0, y: 0, width: 10, height: 10 }, viewport: { width: 0, height: 0 } };
    expect(cropRect(empty, { width: 1, height: 1 })).toBeNull();
  });

  it("covers a fullscreen video, minus the inset", () => {
    expect(cropRect(at(0, 0, 1280, 720), { width: 1920, height: 1080 })).toEqual({
      x: 2,
      y: 2,
      width: 1916,
      height: 1076,
    });
  });
});
