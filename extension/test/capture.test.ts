import { describe, expect, it } from "vitest";
import { MediaClock } from "../src/capture/clock";
import { base64, toS16Stereo } from "../src/capture/pcm";

describe("MediaClock", () => {
  it("puts each track's first frame at its arrival time, then follows the track's own timestamps", () => {
    let now = 1000; // ms
    const clock = new MediaClock(() => now);
    now = 1010;
    expect(clock.map("video", 5_000_000)).toBe(10_000); // 10 ms after the start
    now = 1500; // a late frame doesn't move the timeline
    expect(clock.map("video", 5_033_333)).toBe(43_333);
    now = 1020;
    expect(clock.map("audio", 99)).toBe(20_000); // a different clock base, same timeline
    expect(clock.map("audio", 100_099)).toBe(120_000);
  });

  it("never goes below zero", () => {
    let now = 0;
    const clock = new MediaClock(() => now);
    now = 0;
    clock.map("video", 1_000_000);
    expect(clock.map("video", 0)).toBe(0);
  });
});

describe("toS16Stereo", () => {
  const samples = (bytes: Uint8Array) => Array.from(new Int16Array(bytes.buffer));

  it("interleaves left and right as s16le with clamping", () => {
    const out = toS16Stereo([new Float32Array([1, -1, 0.5]), new Float32Array([-2, 2, 0])]);
    expect(samples(out)).toEqual([32767, -32768, -32768, 32767, 16384, 0]);
  });

  it("duplicates mono and drops channels past the second", () => {
    expect(samples(toS16Stereo([new Float32Array([0.25])]))).toEqual([8192, 8192]);
    const three = [new Float32Array([0]), new Float32Array([1]), new Float32Array([-1])];
    expect(samples(toS16Stereo(three))).toEqual([0, 32767]);
  });
});

describe("base64", () => {
  it("matches Node's encoding, including large buffers", () => {
    const bytes = Uint8Array.from({ length: 100_000 }, (_, i) => (i * 31) % 256);
    expect(base64(bytes)).toBe(Buffer.from(bytes).toString("base64"));
    expect(base64(new Uint8Array(0))).toBe("");
  });
});
