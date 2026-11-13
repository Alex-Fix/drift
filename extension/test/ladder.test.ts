import { describe, expect, it } from "vitest";
import { chooseVideoConfig, encoderConfig, fit, LADDER, type Rung } from "../src/capture/ladder";

const [hevc4k, , h264p1080, , h264p720p30] = LADDER as [Rung, Rung, Rung, Rung, Rung];

describe("fit", () => {
  it("never upscales", () => {
    expect(fit({ width: 1280, height: 720, fps: 30 }, hevc4k)).toEqual({ width: 1280, height: 720 });
  });

  it("scales down keeping the aspect ratio, to even sizes", () => {
    expect(fit({ width: 3840, height: 2160, fps: 60 }, h264p1080)).toEqual({ width: 1920, height: 1080 });
    expect(fit({ width: 1000, height: 1001, fps: 30 }, h264p720p30)).toEqual({ width: 720, height: 720 });
  });
});

describe("encoderConfig", () => {
  it("scales the bitrate with pixels and frame rate, with a floor", () => {
    expect(encoderConfig({ width: 3840, height: 2160, fps: 60 }, hevc4k).bitrate).toBe(40_000_000);
    expect(encoderConfig({ width: 1920, height: 1080, fps: 30 }, hevc4k).bitrate).toBe(5_000_000);
    expect(encoderConfig({ width: 320, height: 180, fps: 24 }, h264p1080).bitrate).toBe(1_000_000);
  });

  it("caps the frame rate at the rung and assumes 30 when unknown", () => {
    expect(encoderConfig({ width: 1280, height: 720, fps: 120 }, h264p720p30).framerate).toBe(30);
    expect(encoderConfig({ width: 1280, height: 720, fps: undefined }, h264p1080).framerate).toBe(30);
  });

  it("asks for length-prefixed output with a description, and hardware for HEVC", () => {
    const h = encoderConfig({ width: 3840, height: 2160, fps: 60 }, hevc4k) as VideoEncoderConfig & { hevc?: object };
    expect(h).toMatchObject({
      codec: "hvc1.1.6.L153.B0",
      hardwareAcceleration: "prefer-hardware",
      hevc: { format: "hevc" },
    });
    expect(encoderConfig({ width: 1920, height: 1080, fps: 30 }, h264p1080)).toMatchObject({
      codec: "avc1.64002A",
      avc: { format: "avc" },
      latencyMode: "realtime",
    });
  });
});

describe("chooseVideoConfig", () => {
  const source = { width: 3840, height: 2160, fps: 60 };

  it("takes the first rung the encoder supports", async () => {
    const choice = await chooseVideoConfig(source, (c) => Promise.resolve(c.codec.startsWith("avc1")));
    expect(choice?.rung.codec).toBe("h264");
    expect(choice?.config).toMatchObject({ width: 1920, height: 1080, framerate: 60 });
  });

  it("prefers HEVC 4K when available", async () => {
    const choice = await chooseVideoConfig(source, () => Promise.resolve(true));
    expect(choice?.rung).toBe(hevc4k);
  });

  it("gives up when nothing is supported", async () => {
    expect(await chooseVideoConfig(source, () => Promise.resolve(false))).toBeUndefined();
  });
});
