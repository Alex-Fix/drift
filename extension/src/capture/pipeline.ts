// The capture → encode → send pipeline, shared by the page path (content/capture.ts, captureStream) and the
// tab-capture fallback (offscreen/offscreen.ts). Video frames go through WebCodecs; audio through a 44.1 kHz
// AudioContext so the browser resamples; output is `video`/`audio` notifications plus periodic stats.
import type { CaptureStats, StatsMessage } from "../messages";
import type { Notification, VideoConfigMessage } from "../protocol";
import { MediaClock } from "./clock";
import type { Box } from "./crop";
import { encoderConfig, type Choice } from "./ladder";
import { FrameSizer } from "./sizing";
import { base64, toS16Stereo } from "./pcm";

const KEYFRAME_INTERVAL_US = 2_000_000;
const MAX_ENCODE_QUEUE = 3; // frames waiting in the encoder before new ones are skipped
const AUDIO_SAMPLE_RATE = 44100;
const AUDIO_BATCH_FRAMES = 4410; // 100 ms per audio message
const STATS_INTERVAL_MS = 1000;

export interface PipelineOptions {
  session: string;
  choice: Choice;
  video: MediaStreamTrack;
  audio: MediaStreamTrack | undefined;
  send: (message: Notification | StatsMessage) => void;
  /** Per frame: a crop box, `undefined` for the whole frame, `null` to skip the frame (video off screen). */
  crop?: (frame: { width: number; height: number }) => Box | null | undefined;
  /** Count the page's long tasks (only meaningful on the page's thread). */
  watchLongTasks?: boolean;
  onFailure?: (error: unknown) => void;
}

export class Pipeline {
  private readonly clock = new MediaClock();
  private config: VideoConfigMessage | undefined;
  private stopped = false;
  private readonly cleanups: (() => void)[] = [];
  private readonly stats: CaptureStats = {
    frames: 0,
    droppedByEncoder: 0,
    sendAvgMs: 0,
    sendMaxMs: 0,
    longTasks: 0,
    audio: "off",
  };
  private sends = 0;
  private sendTotalMs = 0;

  constructor(private readonly options: PipelineOptions) {}

  start(): void {
    const { options } = this;
    if (options.watchLongTasks === true) this.watchLongTasks();
    const timer = setInterval(() => {
      this.post({ kind: "stats", stats: { ...this.stats } });
    }, STATS_INTERVAL_MS);
    this.cleanups.push(() => {
      clearInterval(timer);
    });
    void this.runVideo(options.video, options.choice).catch((e: unknown) => {
      console.warn("drift: video capture failed", e);
      this.stop();
      options.onFailure?.(e);
    });
    if (options.audio !== undefined) {
      void this.runAudio(options.audio).catch((e: unknown) => {
        console.warn("drift: audio capture failed", e);
        this.stats.audio = "unavailable";
      });
    }
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    for (const cleanup of this.cleanups.splice(0)) {
      try {
        cleanup();
      } catch {
        // already closed
      }
    }
  }

  private async runVideo(track: MediaStreamTrack, initial: Choice): Promise<void> {
    let choice = initial;
    const encoder = new VideoEncoder({
      output: (chunk, metadata) => {
        this.onChunk(chunk, metadata, choice);
      },
      error: (e) => {
        console.warn("drift: encoder error", e);
        this.stop();
        this.options.onFailure?.(e);
      },
    });
    encoder.configure(choice.config);
    const reader = new MediaStreamTrackProcessor<VideoFrame>({ track, maxBufferSize: 2 }).readable.getReader();
    this.cleanups.push(() => {
      void reader.cancel();
      if (encoder.state !== "closed") encoder.close();
    });
    let lastKeyframe = -Infinity;
    let sizer: FrameSizer | undefined; // created from the first frame: the size the configuration came from
    while (!this.stopped) {
      const { value: captured, done } = await reader.read();
      if (done) break;
      let frame = this.cropped(captured);
      if (frame === undefined) continue;
      const size = { width: frame.displayWidth, height: frame.displayHeight };
      sizer ??= new FrameSizer(size);
      const decision = sizer.next(size);
      if (decision === "skip") {
        frame.close();
        continue;
      }
      if (decision !== "encode") {
        const fps = choice.config.framerate ?? undefined;
        choice = { rung: choice.rung, config: encoderConfig({ ...decision.reconfigure, fps }, choice.rung) };
        encoder.configure(choice.config);
        lastKeyframe = -Infinity; // a new configuration starts with a keyframe
      }
      if (size.width !== choice.config.width || size.height !== choice.config.height) {
        frame = await scaled(frame, choice.config); // bigger than the rung allows
      }
      if (encoder.encodeQueueSize > MAX_ENCODE_QUEUE) {
        frame.close();
        this.stats.droppedByEncoder++;
        continue;
      }
      const keyFrame = frame.timestamp - lastKeyframe >= KEYFRAME_INTERVAL_US;
      if (keyFrame) lastKeyframe = frame.timestamp;
      encoder.encode(frame, { keyFrame });
      frame.close();
      this.stats.frames++;
    }
  }

  private onChunk(chunk: EncodedVideoChunk, metadata: EncodedVideoChunkMetadata | undefined, choice: Choice): void {
    const started = performance.now();
    const description = metadata?.decoderConfig?.description;
    if (description !== undefined) {
      this.config = {
        codec: choice.rung.codec,
        record: base64(bytesOf(description)),
        width: choice.config.width,
        height: choice.config.height,
      };
    }
    const data = new Uint8Array(chunk.byteLength);
    chunk.copyTo(data);
    const key = chunk.type === "key";
    const message: Notification = {
      type: "video",
      session: this.options.session,
      ts: this.clock.map("video", chunk.timestamp),
      key,
      data: base64(data),
      ...(key && this.config !== undefined ? { config: this.config } : {}),
    };
    this.post(message);
    this.measure(performance.now() - started);
  }

  /** The frame to encode (cropped when there's a box), or undefined to skip it; closes what it doesn't return. */
  private cropped(frame: VideoFrame): VideoFrame | undefined {
    const box = this.options.crop?.({ width: frame.displayWidth, height: frame.displayHeight });
    if (box === undefined) return frame;
    if (box === null) {
      frame.close();
      return undefined;
    }
    const cropped = new VideoFrame(frame, { visibleRect: box });
    frame.close();
    return cropped;
  }

  private async runAudio(track: MediaStreamTrack): Promise<void> {
    // The browser resamples to 44.1 kHz stereo for us: the only audio format the host takes.
    const context = new AudioContext({ sampleRate: AUDIO_SAMPLE_RATE });
    const source = context.createMediaStreamSource(new MediaStream([track]));
    const destination = context.createMediaStreamDestination();
    destination.channelCount = 2;
    destination.channelCountMode = "explicit";
    source.connect(destination); // never to context.destination: while mirroring, sound plays on the receiver only
    this.cleanups.push(() => void context.close());
    await context.resume().catch(() => undefined);
    const output = destination.stream.getAudioTracks()[0];
    if (context.state !== "running" || output === undefined) {
      this.stats.audio = "unavailable"; // e.g. the page never had a user gesture
      return;
    }
    this.stats.audio = "on";
    const reader = new MediaStreamTrackProcessor<AudioData>({ track: output }).readable.getReader();
    this.cleanups.push(() => void reader.cancel());
    let batch: Uint8Array[] = [];
    let frames = 0;
    let batchTs = 0;
    while (!this.stopped) {
      const { value: data, done } = await reader.read();
      if (done) break;
      if (data.sampleRate !== AUDIO_SAMPLE_RATE) {
        data.close();
        this.stats.audio = "unavailable";
        return;
      }
      const planes = Array.from({ length: Math.min(2, data.numberOfChannels) }, (_, plane) => {
        const samples = new Float32Array(data.numberOfFrames);
        data.copyTo(samples, { planeIndex: plane, format: "f32-planar" });
        return samples;
      });
      if (frames === 0) batchTs = this.clock.map("audio", data.timestamp);
      batch.push(toS16Stereo(planes));
      frames += data.numberOfFrames;
      data.close();
      if (frames >= AUDIO_BATCH_FRAMES) {
        const started = performance.now();
        this.post({ type: "audio", session: this.options.session, ts: batchTs, data: base64(concat(batch)) });
        this.measure(performance.now() - started);
        batch = [];
        frames = 0;
      }
    }
  }

  private watchLongTasks(): void {
    try {
      const observer = new PerformanceObserver((list) => {
        this.stats.longTasks += list.getEntries().length;
      });
      observer.observe({ type: "longtask" });
      this.cleanups.push(() => {
        observer.disconnect();
      });
    } catch {
      // longtask timing unsupported: stats just stay at 0
    }
  }

  private measure(ms: number): void {
    this.sends++;
    this.sendTotalMs += ms;
    this.stats.sendAvgMs = Math.round((this.sendTotalMs / this.sends) * 100) / 100;
    this.stats.sendMaxMs = Math.max(this.stats.sendMaxMs, Math.round(ms * 100) / 100);
  }

  private post(message: Notification | StatsMessage): void {
    if (!this.stopped) this.options.send(message);
  }
}

function bytesOf(source: AllowSharedBufferSource): Uint8Array {
  return ArrayBuffer.isView(source)
    ? new Uint8Array(source.buffer, source.byteOffset, source.byteLength).slice()
    : new Uint8Array(source).slice();
}

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, part) => n + part.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

/** `frame` resized to the encoder's size (same aspect ratio: the ladder only scales uniformly); closes `frame`. */
async function scaled(frame: VideoFrame, size: { width: number; height: number }): Promise<VideoFrame> {
  const timestamp = frame.timestamp;
  try {
    const bitmap = await createImageBitmap(frame, {
      resizeWidth: size.width,
      resizeHeight: size.height,
      resizeQuality: "medium",
    });
    return new VideoFrame(bitmap, { timestamp });
  } finally {
    frame.close();
  }
}
