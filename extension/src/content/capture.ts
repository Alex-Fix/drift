// Injected on demand into the frame holding the chosen <video> (chrome.scripting.executeScript with files). Captures
// it with captureStream(), encodes with WebCodecs and streams the chunks to the background over the media port.
//
// It runs on the page's thread (design decision, implementation step 6): capture and encoding happen in the
// browser's media threads; base64 + postMessage run here and are measured (CaptureStats) so the cost is visible.
import { MediaClock } from "../capture/clock";
import { chooseVideoConfig, type Choice } from "../capture/ladder";
import { base64, toS16Stereo } from "../capture/pcm";
import { MEDIA_PORT, type CaptureCommand, type CaptureStats, type PrepareResult, type StatsMessage } from "../messages";
import type { Notification, VideoConfigMessage } from "../protocol";

const KEYFRAME_INTERVAL_US = 2_000_000;
const MAX_ENCODE_QUEUE = 3; // frames waiting in the encoder before new ones are skipped
const AUDIO_SAMPLE_RATE = 44100;
const AUDIO_BATCH_FRAMES = 4410; // 100 ms per audio message
const TRACK_WAIT_MS = 3000;
const STATS_INTERVAL_MS = 1000;

class Capture {
  private stream: MediaStream | undefined;
  private choice: Choice | undefined;
  private port: chrome.runtime.Port | undefined;
  private session = "";
  private clock = new MediaClock();
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

  async prepare(index: number): Promise<PrepareResult> {
    const video = document.querySelectorAll("video")[index];
    if (video === undefined) return { ok: false, error: "no_video" };
    if (video.mediaKeys !== null) return { ok: false, error: "drm" };
    try {
      this.stream = video.captureStream();
    } catch {
      return { ok: false, error: "capture_failed" }; // e.g. protected or cross-origin media
    }
    const track = await firstVideoTrack(this.stream);
    if (track === undefined) return { ok: false, error: "capture_failed" };
    const settings = track.getSettings();
    const width = settings.width ?? video.videoWidth;
    const height = settings.height ?? video.videoHeight;
    if (!width || !height) return { ok: false, error: "capture_failed" };
    this.choice = await chooseVideoConfig({ width, height, fps: settings.frameRate }, async (config) => {
      try {
        return (await VideoEncoder.isConfigSupported(config)).supported === true;
      } catch {
        return false;
      }
    });
    if (this.choice === undefined) return { ok: false, error: "encoder_unavailable" };
    const { config } = this.choice;
    return {
      ok: true,
      audio: this.stream.getAudioTracks().length > 0,
      codec: this.choice.rung.codec,
      width: config.width,
      height: config.height,
      fps: config.framerate ?? 30,
    };
  }

  start(session: string): void {
    if (this.stream === undefined || this.choice === undefined) throw new Error("prepare first");
    this.session = session;
    this.clock = new MediaClock();
    const port = chrome.runtime.connect({ name: MEDIA_PORT });
    this.port = port;
    port.onMessage.addListener((message: { kind?: string }) => {
      if (message.kind === "stop") this.stop();
    });
    port.onDisconnect.addListener(() => {
      this.stop();
    });
    this.watchLongTasks();
    const timer = setInterval(() => {
      this.post({ kind: "stats", stats: { ...this.stats } } satisfies StatsMessage);
    }, STATS_INTERVAL_MS);
    this.cleanups.push(() => {
      clearInterval(timer);
    });
    void this.runVideo(this.stream, this.choice).catch((e: unknown) => {
      console.warn("drift: video capture failed", e);
      this.stop();
    });
    void this.runAudio(this.stream).catch((e: unknown) => {
      console.warn("drift: audio capture failed", e);
      this.stats.audio = "unavailable";
    });
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
    for (const track of this.stream?.getTracks() ?? []) track.stop();
    this.port?.disconnect();
    globalThis.__driftCapture = undefined; // a later mirror injects a fresh instance
  }

  private async runVideo(stream: MediaStream, choice: Choice): Promise<void> {
    const track = stream.getVideoTracks()[0];
    if (track === undefined) return;
    const encoder = new VideoEncoder({
      output: (chunk, metadata) => {
        this.onChunk(chunk, metadata, choice);
      },
      error: (e) => {
        console.warn("drift: encoder error", e);
        this.stop();
      },
    });
    encoder.configure(choice.config);
    const reader = new MediaStreamTrackProcessor<VideoFrame>({ track, maxBufferSize: 2 }).readable.getReader();
    this.cleanups.push(() => {
      void reader.cancel();
      if (encoder.state !== "closed") encoder.close();
    });
    let lastKeyframe = -Infinity;
    while (!this.stopped) {
      const { value: frame, done } = await reader.read();
      if (done) break;
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
      session: this.session,
      ts: this.clock.map("video", chunk.timestamp),
      key,
      data: base64(data),
      ...(key && this.config !== undefined ? { config: this.config } : {}),
    };
    this.post(message);
    this.measure(performance.now() - started);
  }

  private async runAudio(stream: MediaStream): Promise<void> {
    const track = stream.getAudioTracks()[0];
    if (track === undefined) return;
    // The browser resamples to 44.1 kHz stereo for us: the only audio format the host takes.
    const context = new AudioContext({ sampleRate: AUDIO_SAMPLE_RATE });
    const source = context.createMediaStreamSource(new MediaStream([track]));
    const destination = context.createMediaStreamDestination();
    destination.channelCount = 2;
    destination.channelCountMode = "explicit";
    source.connect(destination);
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
        this.post({ type: "audio", session: this.session, ts: batchTs, data: base64(concat(batch)) });
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
    if (this.stopped || this.port === undefined) return;
    try {
      this.port.postMessage(message);
    } catch {
      this.stop(); // the background went away
    }
  }
}

function isCommand(raw: unknown): raw is CaptureCommand {
  return typeof raw === "object" && raw !== null && (raw as { kind?: unknown }).kind === "drift-capture";
}

function firstVideoTrack(stream: MediaStream): Promise<MediaStreamTrack | undefined> {
  const now = stream.getVideoTracks()[0];
  if (now !== undefined) return Promise.resolve(now);
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      resolve(undefined);
    }, TRACK_WAIT_MS);
    stream.addEventListener("addtrack", (event) => {
      if (event.track.kind === "video") {
        clearTimeout(timer);
        resolve(event.track);
      }
    });
  });
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

declare global {
  var __driftCapture: Capture | undefined; // one per frame's isolated world
}

if (globalThis.__driftCapture === undefined) {
  const capture = new Capture();
  globalThis.__driftCapture = capture;
  chrome.runtime.onMessage.addListener((raw: unknown, sender, sendResponse) => {
    if (sender.id !== chrome.runtime.id || !isCommand(raw)) return false;
    const message = raw;
    if (globalThis.__driftCapture !== capture) return false; // a newer injection owns this frame now
    switch (message.action) {
      case "prepare":
        void capture.prepare(message.index).then(sendResponse);
        return true;
      case "start":
        capture.start(message.session);
        sendResponse({ ok: true });
        return false;
      case "stop":
        capture.stop();
        sendResponse({ ok: true });
        return false;
    }
  });
}
