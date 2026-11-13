import { describe, expect, it } from "vitest";
import { FrameSizer } from "../src/capture/sizing";

const p720 = { width: 1280, height: 720 };
const p1080 = { width: 1920, height: 1080 };

describe("FrameSizer", () => {
  it("encodes frames of the configured size", () => {
    const sizer = new FrameSizer(p720, 3);
    expect([sizer.next(p720), sizer.next(p720)]).toEqual(["encode", "encode"]);
  });

  it("reconfigures once a new size has held for long enough, skipping until then", () => {
    const sizer = new FrameSizer(p720, 3);
    expect([sizer.next(p1080), sizer.next(p1080)]).toEqual(["skip", "skip"]);
    expect(sizer.next(p1080)).toEqual({ reconfigure: p1080 });
    expect(sizer.next(p1080)).toBe("encode");
  });

  it("doesn't reconfigure on sizes that keep changing (a resize animation)", () => {
    const sizer = new FrameSizer(p720, 3);
    for (let w = 1290; w < 1400; w += 10) expect(sizer.next({ width: w, height: 720 })).toBe("skip");
    expect(sizer.next(p720)).toBe("encode"); // back to the old size: nothing to do
  });
});
