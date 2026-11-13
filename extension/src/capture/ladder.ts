// The quality ladder (design: "Quality ladder"): the first rung the machine can encode wins. Rungs cap size, frame
// rate and bitrate; the source is never upscaled, and bitrate scales with the pixels and frames actually sent.
import type { VideoCodec } from "../protocol";

export interface Rung {
  codec: VideoCodec;
  codecString: string; // WebCodecs codec string
  maxWidth: number;
  maxHeight: number;
  fps: number;
  bitrate: number; // at the rung's full size and frame rate
}

/** Limits from the Samsung's /info: HEVC Main up to 2160p60 (level 5.1), H.264 High up to 1080p60 (level 4.2). */
export const LADDER: readonly Rung[] = [
  { codec: "hevc", codecString: "hvc1.1.6.L153.B0", maxWidth: 3840, maxHeight: 2160, fps: 60, bitrate: 40_000_000 },
  { codec: "hevc", codecString: "hvc1.1.6.L150.B0", maxWidth: 2560, maxHeight: 1440, fps: 60, bitrate: 20_000_000 },
  { codec: "h264", codecString: "avc1.64002A", maxWidth: 1920, maxHeight: 1080, fps: 60, bitrate: 12_000_000 },
  { codec: "h264", codecString: "avc1.640020", maxWidth: 1280, maxHeight: 720, fps: 60, bitrate: 6_000_000 },
  { codec: "h264", codecString: "avc1.64001F", maxWidth: 1280, maxHeight: 720, fps: 30, bitrate: 4_000_000 },
];

const MIN_BITRATE = 1_000_000;

export interface Source {
  width: number;
  height: number;
  fps: number | undefined;
}

export interface Choice {
  rung: Rung;
  config: VideoEncoderConfig;
}

/** Scale `source` down (never up) to fit the rung, keeping its aspect ratio; even sizes, at least 16. */
export function fit(source: Source, rung: Rung): { width: number; height: number } {
  const scale = Math.min(1, rung.maxWidth / source.width, rung.maxHeight / source.height);
  const even = (n: number) => Math.max(16, Math.round((n * scale) / 2) * 2);
  return { width: even(source.width), height: even(source.height) };
}

export function encoderConfig(source: Source, rung: Rung): VideoEncoderConfig {
  const { width, height } = fit(source, rung);
  const fps = Math.min(source.fps ?? 30, rung.fps);
  const share = ((width * height) / (rung.maxWidth * rung.maxHeight)) * (fps / rung.fps);
  return {
    codec: rung.codecString,
    width,
    height,
    framerate: fps,
    bitrate: Math.max(MIN_BITRATE, Math.round(rung.bitrate * share)),
    latencyMode: "realtime",
    // Chrome has no software HEVC encoder; H.264 may fall back to software.
    hardwareAcceleration: rung.codec === "hevc" ? "prefer-hardware" : "no-preference",
    // Length-prefixed NAL units plus an avcC / hvcC description: what the host expects.
    ...(rung.codec === "h264" ? { avc: { format: "avc" } } : { hevc: { format: "hevc" } }),
  };
}

export async function chooseVideoConfig(
  source: Source,
  isSupported: (config: VideoEncoderConfig) => Promise<boolean>,
  ladder: readonly Rung[] = LADDER,
): Promise<Choice | undefined> {
  for (const rung of ladder) {
    const config = encoderConfig(source, rung);
    if (await isSupported(config)) return { rung, config };
  }
  return undefined;
}
