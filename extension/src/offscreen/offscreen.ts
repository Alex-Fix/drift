// Tab-capture fallback (implementation step 8): captures the whole tab from a tabCapture stream id, crops each frame
// to where the page says the video is, and runs the shared pipeline. Lives in an offscreen document, so none of this
// runs on the page's thread. Tab capture mutes the tab, which is what we want: sound plays on the receiver only.
import { cropRect, type Placement } from "../capture/crop";
import { chooseVideoConfig, encoderSupports } from "../capture/ladder";
import { Pipeline } from "../capture/pipeline";
import { MEDIA_PORT, type OffscreenCommand, type OffscreenStarted } from "../messages";

interface Running {
  pipeline: Pipeline;
  stream: MediaStream;
  port: chrome.runtime.Port;
  placement: Placement | null;
}

let running: Running | undefined;

async function start(command: Extract<OffscreenCommand, { action: "start" }>): Promise<OffscreenStarted> {
  stop();
  const source = { chromeMediaSource: "tab", chromeMediaSourceId: command.streamId };
  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { mandatory: source },
      video: { mandatory: { ...source, maxWidth: 3840, maxHeight: 2160, maxFrameRate: 60 } },
    } as MediaStreamConstraints); // Chrome's tab-capture constraints aren't in the standard types
  } catch (e) {
    console.warn("drift: tab capture failed", e);
    return { ok: false, error: "capture_failed" };
  }
  const video = stream.getVideoTracks()[0];
  const settings = video?.getSettings();
  if (video === undefined || !settings?.width || !settings.height) {
    stopTracks(stream);
    return { ok: false, error: "capture_failed" };
  }
  const tab = { width: settings.width, height: settings.height };
  const box = command.placement ? cropRect(command.placement, tab) : undefined;
  const size = box ?? tab;
  const choice = await chooseVideoConfig({ ...size, fps: settings.frameRate }, encoderSupports);
  if (choice === undefined) {
    stopTracks(stream);
    return { ok: false, error: "encoder_unavailable" };
  }
  const port = chrome.runtime.connect({ name: MEDIA_PORT });
  const state: Running = {
    stream,
    port,
    placement: command.placement,
    pipeline: new Pipeline({
      session: command.session,
      choice,
      video,
      audio: stream.getAudioTracks()[0],
      send: (message) => {
        try {
          port.postMessage(message);
        } catch {
          stop();
        }
      },
      // null placement: the page couldn't say where the video is (cross-origin frame) — mirror the whole tab
      crop: (frame) => (state.placement ? cropRect(state.placement, frame) : undefined),
      onFailure: () => {
        stop();
      },
    }),
  };
  port.onMessage.addListener((message: { kind?: string }) => {
    if (message.kind === "stop") stop();
    if (message.kind === "step_down") state.pipeline.stepDown();
  });
  port.onDisconnect.addListener(() => {
    stop();
  });
  running = state;
  state.pipeline.start();
  const { config } = choice;
  return {
    ok: true,
    codec: choice.rung.codec,
    width: config.width,
    height: config.height,
    fps: config.framerate ?? 30,
  };
}

function stop(): void {
  const current = running;
  running = undefined;
  if (current === undefined) return;
  current.pipeline.stop();
  stopTracks(current.stream); // ends tab capture: the tab is audible again
  current.port.disconnect();
}

function stopTracks(stream: MediaStream): void {
  for (const track of stream.getTracks()) track.stop();
}

function isCommand(raw: unknown): raw is OffscreenCommand {
  return typeof raw === "object" && raw !== null && (raw as { target?: unknown }).target === "offscreen";
}

chrome.runtime.onMessage.addListener((raw: unknown, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id || !isCommand(raw)) return false;
  switch (raw.action) {
    case "start":
      void start(raw).then(sendResponse);
      return true;
    case "placement":
      if (running) running.placement = raw.placement;
      break;
    case "stop":
      stop();
      break;
  }
  sendResponse({ ok: true });
  return false;
});
