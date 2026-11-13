// Injected on demand into the frame holding the chosen <video> (chrome.scripting.executeScript with files).
//
// Page path: captureStream() → the shared pipeline (capture/pipeline.ts) → media port. Runs on the page's thread by
// design decision (implementation step 6); the pipeline measures the cost.
// Fallback (implementation step 8): when captureStream() refuses (cross-origin media), the background captures the
// whole tab in an offscreen document, and this script only reports where the video is on screen.
import type { Placement } from "../capture/crop";
import { chooseVideoConfig, type Choice } from "../capture/ladder";
import { Pipeline } from "../capture/pipeline";
import { MEDIA_PORT, type CaptureCommand, type PlacementMessage, type PrepareResult } from "../messages";

const TRACK_WAIT_MS = 3000;

class Capture {
  private video: HTMLVideoElement | undefined;
  private stream: MediaStream | undefined;
  private choice: Choice | undefined;
  private port: chrome.runtime.Port | undefined;
  private pipeline: Pipeline | undefined;
  private stopped = false;
  private readonly cleanups: (() => void)[] = [];

  async prepare(index: number): Promise<PrepareResult> {
    const video = document.querySelectorAll("video")[index];
    if (video === undefined) return { ok: false, error: "no_video" };
    if (video.mediaKeys !== null) return { ok: false, error: "drm" }; // never captured, not even by the fallback
    this.video = video;
    try {
      this.stream = video.captureStream();
    } catch {
      return { ok: false, error: "capture_failed", placement: placementOf(video) }; // e.g. cross-origin media
    }
    const track = await firstVideoTrack(this.stream);
    if (track === undefined) return { ok: false, error: "capture_failed", placement: placementOf(video) };
    const settings = track.getSettings();
    const width = settings.width ?? video.videoWidth;
    const height = settings.height ?? video.videoHeight;
    if (!width || !height) return { ok: false, error: "capture_failed", placement: placementOf(video) };
    this.choice = await chooseVideoConfig({ width, height, fps: settings.frameRate }, isSupported);
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
    const video = this.stream?.getVideoTracks()[0];
    if (this.stream === undefined || this.choice === undefined || video === undefined) throw new Error("prepare");
    const port = this.connect();
    // Sound on the receiver only, like AirPlay; restored when mirroring stops. captureStream() keeps capturing a
    // muted element's sound (verified live on the Samsung, implementation step 8).
    const element = this.video;
    if (element !== undefined && !element.muted) {
      element.muted = true;
      this.cleanups.push(() => {
        element.muted = false;
      });
    }
    this.pipeline = new Pipeline({
      session,
      choice: this.choice,
      video,
      audio: this.stream.getAudioTracks()[0],
      send: (message) => {
        this.post(port, message);
      },
      watchLongTasks: true,
      onFailure: () => {
        this.stop();
      },
    });
    this.pipeline.start();
  }

  /** Fallback mode: report the video's placement now and whenever it moves, resizes or goes fullscreen. */
  track(): void {
    const video = this.video;
    if (video === undefined) throw new Error("prepare");
    const port = this.connect();
    let last = "";
    let scheduled = false;
    const report = () => {
      scheduled = false;
      const placement = placementOf(video);
      const key = JSON.stringify(placement);
      if (key === last) return;
      last = key;
      this.post(port, { kind: "placement", placement } satisfies PlacementMessage);
    };
    const schedule = () => {
      if (!scheduled) {
        scheduled = true;
        requestAnimationFrame(report);
      }
    };
    report();
    const observer = new ResizeObserver(schedule);
    observer.observe(video);
    const events = ["scroll", "resize", "fullscreenchange"] as const;
    for (const event of events) window.addEventListener(event, schedule, { capture: true, passive: true });
    const poll = setInterval(schedule, 1000); // layout changes no event reports (e.g. a sticky player)
    this.cleanups.push(() => {
      observer.disconnect();
      for (const event of events) window.removeEventListener(event, schedule, { capture: true });
      clearInterval(poll);
    });
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.pipeline?.stop();
    for (const cleanup of this.cleanups.splice(0)) cleanup();
    for (const track of this.stream?.getTracks() ?? []) track.stop();
    this.port?.disconnect();
    globalThis.__driftCapture = undefined; // a later mirror injects a fresh instance
  }

  private connect(): chrome.runtime.Port {
    const port = chrome.runtime.connect({ name: MEDIA_PORT });
    this.port = port;
    port.onMessage.addListener((message: { kind?: string }) => {
      if (message.kind === "stop") this.stop();
    });
    port.onDisconnect.addListener(() => {
      this.stop();
    });
    return port;
  }

  private post(port: chrome.runtime.Port, message: unknown): void {
    if (this.stopped) return;
    try {
      port.postMessage(message);
    } catch {
      this.stop(); // the background went away
    }
  }
}

async function isSupported(config: VideoEncoderConfig): Promise<boolean> {
  try {
    return (await VideoEncoder.isConfigSupported(config)).supported === true;
  } catch {
    return false;
  }
}

/** The video's box in the top-level viewport (CSS px), or null when a cross-origin frame hides where it is. */
function placementOf(video: HTMLVideoElement): Placement | null {
  const box = video.getBoundingClientRect();
  let x = box.x;
  let y = box.y;
  try {
    let frame: Window = window;
    while (frame !== frame.top) {
      const element = frame.frameElement; // null when the parent is cross-origin
      if (element === null) return null;
      const outer = element.getBoundingClientRect();
      x += outer.x + element.clientLeft;
      y += outer.y + element.clientTop;
      frame = frame.parent;
    }
    return {
      rect: { x, y, width: box.width, height: box.height },
      viewport: { width: frame.innerWidth, height: frame.innerHeight },
    };
  } catch {
    return null;
  }
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

function isCommand(raw: unknown): raw is CaptureCommand {
  return typeof raw === "object" && raw !== null && (raw as { kind?: unknown }).kind === "drift-capture";
}

declare global {
  var __driftCapture: Capture | undefined; // one per frame's isolated world
}

if (globalThis.__driftCapture === undefined) {
  const capture = new Capture();
  globalThis.__driftCapture = capture;
  chrome.runtime.onMessage.addListener((raw: unknown, sender, sendResponse) => {
    if (sender.id !== chrome.runtime.id || !isCommand(raw)) return false;
    if (globalThis.__driftCapture !== capture) return false; // a newer injection owns this frame now
    switch (raw.action) {
      case "prepare":
        void capture.prepare(raw.index).then(sendResponse);
        return true;
      case "start":
        capture.start(raw.session);
        break;
      case "track":
        capture.track();
        break;
      case "stop":
        capture.stop();
        break;
    }
    sendResponse({ ok: true });
    return false;
  });
}
