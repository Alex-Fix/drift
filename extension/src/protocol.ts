// Protocol v1 message types and validation. Mirrors host/src/drift_host/protocol.py; contract in docs/protocol.md.
// Messages from the host are validated too: a broken or outdated host must not drive the popup into a bad state.

export const VERSION = 1;

export type ErrorCode =
  | "invalid_message"
  | "unsupported_version"
  | "unknown_type"
  | "message_too_large"
  | "unknown_device"
  | "unsupported_url"
  | "pairing_required"
  | "device_unreachable"
  | "internal_error"
  | "mirror_unsupported"
  | "mirror_failed"
  | "session_unknown"
  | "pairing_failed";

export interface DeviceInfo {
  id: string;
  name: string;
  model?: string;
  mirror?: boolean; // drift can mirror to it (absent: unknown)
  paired?: boolean; // drift has pairing credentials for it
}

export type PlaybackState = "idle" | "loading" | "playing" | "paused";
export type VideoCodec = "h264" | "hevc";

/** Interleaved s16le stereo at 44.1 kHz: the only audio the host takes (it wraps it as uncompressed ALAC). */
export interface AudioFormat {
  format: "pcm_s16";
  rate: 44100;
  channels: 2;
}

/** Decoder setup: the avcC / hvcC record WebCodecs reports as `decoderConfig.description`, base64. */
export interface VideoConfigMessage {
  codec: VideoCodec;
  record: string;
  width: number;
  height: number;
}

/** Requests without the envelope; `NativeClient` adds `v` and `id`. */
export type Request =
  | { type: "hello" }
  | { type: "scan"; timeout_ms?: number }
  | { type: "play"; device: string; url: string; title?: string; position?: number }
  | { type: "control"; device: string; action: "pause" | "resume" | "seek"; position?: number }
  | { type: "stop"; device: string }
  | { type: "pair_begin"; device: string }
  | { type: "pair_pin"; device: string; pin: string }
  | { type: "mirror_start"; device: string; audio?: AudioFormat }
  | { type: "mirror_stop"; session: string };

/** Extension → host, no id, no response (media at frame rate). `ts`: microseconds on the capture clock. */
export type Notification =
  | { type: "video"; session: string; ts: number; key: boolean; data: string; config?: VideoConfigMessage }
  | { type: "audio"; session: string; ts: number; data: string };

export type Response =
  | { v: 1; id: string; type: "hello"; host: string }
  | { v: 1; id: string; type: "devices"; devices: DeviceInfo[] }
  | { v: 1; id: string; type: "ok" }
  | { v: 1; id?: string; type: "error"; code: ErrorCode }
  | { v: 1; id: string; type: "mirror_started"; session: string };

export interface StatusEvent {
  v: 1;
  type: "status";
  device: string;
  state: PlaybackState;
  position?: number;
  duration?: number;
}

export interface MirrorStatusEvent {
  v: 1;
  type: "mirror_status";
  session: string;
  state: "mirroring" | "stopped";
  reason?: ErrorCode;
  codec?: VideoCodec;
  width?: number;
  height?: number;
  dropped?: number;
}

export type HostEvent = StatusEvent | MirrorStatusEvent;

export type Message = (Request & { v: 1; id: string }) | Response | HostEvent | (Notification & { v: 1 });

export class ProtocolError extends Error {
  constructor(readonly code: ErrorCode) {
    super(code);
    this.name = "ProtocolError";
  }
}

type Spec =
  | { kind: "str"; max: number }
  | { kind: "num"; min: number; max?: number; integer?: boolean }
  | { kind: "oneOf"; values: readonly string[] }
  | { kind: "url" }
  | { kind: "devices" }
  | { kind: "pattern"; regex: RegExp } // anchored; at most 256 characters
  | { kind: "bool" }
  | { kind: "base64"; maxBytes: number } // decoded size
  | { kind: "obj"; fields: Fields };
type Kind = "request" | "response" | "event" | "notification";
type Fields = Record<string, [spec: Spec, required: boolean]>;

const ID: Spec = { kind: "str", max: 64 };
const DEVICE: Spec = { kind: "str", max: 128 };
const NAME: Spec = { kind: "str", max: 256 };
const POSITION: Spec = { kind: "num", min: 0 };
const URL_MAX = 8 * 1024;
const MAX_DEVICES = 64;
const ERROR_CODES: readonly ErrorCode[] = [
  "invalid_message",
  "unsupported_version",
  "unknown_type",
  "message_too_large",
  "unknown_device",
  "unsupported_url",
  "pairing_required",
  "device_unreachable",
  "internal_error",
  "mirror_unsupported",
  "mirror_failed",
  "session_unknown",
  "pairing_failed",
];
const SESSION: Spec = { kind: "pattern", regex: /^[0-9a-f]{32}$/ };
const MEDIA_TS: Spec = { kind: "num", min: 0, max: 2 ** 53, integer: true };
const DIMENSION: Spec = { kind: "num", min: 16, max: 8192, integer: true };
const VIDEO_CODECS: Spec = { kind: "oneOf", values: ["h264", "hevc"] };
export const MAX_VIDEO_CHUNK = 2 * 1024 * 1024;
export const MAX_AUDIO_CHUNK = 256 * 1024;
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

const MESSAGES: Record<string, [Kind, Fields]> = {
  hello: ["request", {}],
  scan: ["request", { timeout_ms: [{ kind: "num", min: 500, max: 10_000, integer: true }, false] }],
  play: [
    "request",
    { device: [DEVICE, true], url: [{ kind: "url" }, true], title: [NAME, false], position: [POSITION, false] },
  ],
  control: [
    "request",
    {
      device: [DEVICE, true],
      action: [{ kind: "oneOf", values: ["pause", "resume", "seek"] }, true],
      position: [POSITION, false],
    },
  ],
  stop: ["request", { device: [DEVICE, true] }],
  pair_begin: ["request", { device: [DEVICE, true] }],
  pair_pin: ["request", { device: [DEVICE, true], pin: [{ kind: "pattern", regex: /^[0-9]{4,8}$/ }, true] }],
  mirror_start: [
    "request",
    {
      device: [DEVICE, true],
      audio: [
        {
          kind: "obj",
          fields: {
            format: [{ kind: "oneOf", values: ["pcm_s16"] }, true],
            rate: [{ kind: "num", min: 44100, max: 44100, integer: true }, true],
            channels: [{ kind: "num", min: 2, max: 2, integer: true }, true],
          },
        },
        false,
      ],
    },
  ],
  mirror_stop: ["request", { session: [SESSION, true] }],
  devices: ["response", { devices: [{ kind: "devices" }, true] }],
  ok: ["response", {}],
  error: ["response", { code: [{ kind: "oneOf", values: ERROR_CODES }, true] }],
  mirror_started: ["response", { session: [SESSION, true] }],
  status: [
    "event",
    {
      device: [DEVICE, true],
      state: [{ kind: "oneOf", values: ["idle", "loading", "playing", "paused"] }, true],
      position: [POSITION, false],
      duration: [POSITION, false],
    },
  ],
  mirror_status: [
    "event",
    {
      session: [SESSION, true],
      state: [{ kind: "oneOf", values: ["mirroring", "stopped"] }, true],
      reason: [{ kind: "oneOf", values: ERROR_CODES }, false],
      codec: [VIDEO_CODECS, false],
      width: [DIMENSION, false],
      height: [DIMENSION, false],
      dropped: [{ kind: "num", min: 0, max: 2 ** 53, integer: true }, false],
    },
  ],
  video: [
    "notification",
    {
      session: [SESSION, true],
      ts: [MEDIA_TS, true],
      key: [{ kind: "bool" }, true],
      data: [{ kind: "base64", maxBytes: MAX_VIDEO_CHUNK }, true],
      config: [
        {
          kind: "obj",
          fields: {
            codec: [VIDEO_CODECS, true],
            record: [{ kind: "base64", maxBytes: 64 * 1024 }, true],
            width: [DIMENSION, true],
            height: [DIMENSION, true],
          },
        },
        false,
      ],
    },
  ],
  audio: [
    "notification",
    { session: [SESSION, true], ts: [MEDIA_TS, true], data: [{ kind: "base64", maxBytes: MAX_AUDIO_CHUNK }, true] },
  ],
};

// hello is both a request and its response; the response carries the host's version.
const HELLO_RESPONSE: Fields = { host: [{ kind: "str", max: 32 }, true] };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Validate any protocol message, or throw `ProtocolError`. */
export function parse(raw: unknown): Message {
  if (!isRecord(raw) || typeof raw.v !== "number" || !Number.isInteger(raw.v)) {
    throw new ProtocolError("invalid_message");
  }
  if (raw.v !== VERSION) throw new ProtocolError("unsupported_version");
  if (typeof raw.type !== "string") throw new ProtocolError("invalid_message");
  const entry = Object.hasOwn(MESSAGES, raw.type) ? MESSAGES[raw.type] : undefined;
  if (entry === undefined) throw new ProtocolError("unknown_type");
  let [kind, fields] = entry;
  if (raw.type === "hello" && "host" in raw) [kind, fields] = ["response", HELLO_RESPONSE];

  if ("id" in raw) {
    check(ID, raw.id);
    if (kind === "event" || kind === "notification") throw new ProtocolError("invalid_message");
  } else if (kind === "request" || (kind === "response" && raw.type !== "error")) {
    throw new ProtocolError("invalid_message");
  }

  checkFields(raw, fields, ["v", "type", "id"]);
  if (raw.type === "control" && raw.action === "seek" && !("position" in raw)) {
    throw new ProtocolError("invalid_message");
  }
  return raw as unknown as Message;
}

function checkFields(obj: Record<string, unknown>, fields: Fields, extra: readonly string[]): void {
  for (const key of Object.keys(obj)) {
    if (!extra.includes(key) && !Object.hasOwn(fields, key)) fail();
  }
  for (const [name, [spec, required]] of Object.entries(fields)) {
    if (Object.hasOwn(obj, name)) check(spec, obj[name]);
    else if (required) fail();
  }
}

function check(spec: Spec, value: unknown): void {
  switch (spec.kind) {
    case "str":
      if (typeof value !== "string" || value.length === 0 || value.length > spec.max) fail();
      return;
    case "num":
      if (typeof value !== "number" || !Number.isFinite(value) || (spec.integer === true && !Number.isInteger(value)))
        fail();
      if (value < spec.min || (spec.max !== undefined && value > spec.max)) fail();
      return;
    case "oneOf":
      if (typeof value !== "string" || !spec.values.includes(value)) fail();
      return;
    case "url":
      checkUrl(value);
      return;
    case "devices":
      if (!Array.isArray(value) || value.length > MAX_DEVICES) fail();
      for (const device of value) checkDevice(device);
      return;
    case "pattern":
      if (typeof value !== "string" || value.length > 256 || !spec.regex.test(value)) fail();
      return;
    case "bool":
      if (typeof value !== "boolean") fail();
      return;
    case "base64":
      // Shape and size only (non-empty, padded, base64 alphabet), like the host.
      if (
        typeof value !== "string" ||
        value.length === 0 ||
        value.length % 4 !== 0 ||
        value.length > Math.floor((spec.maxBytes + 2) / 3) * 4 ||
        !BASE64.test(value)
      )
        fail();
      return;
    case "obj":
      if (!isRecord(value)) fail();
      checkFields(value, spec.fields, []);
      return;
  }
}

/** Only http(s) URLs with a host ever reach a receiver; `file:`, `blob:`, `data:` and the like are refused. */
export function checkUrl(value: unknown): void {
  if (typeof value !== "string" || value.length === 0 || value.length > URL_MAX) fail();
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ProtocolError("unsupported_url");
  }
  if ((url.protocol !== "http:" && url.protocol !== "https:") || url.hostname === "") {
    throw new ProtocolError("unsupported_url");
  }
}

const DEVICE_FIELDS: Fields = {
  id: [DEVICE, true],
  name: [NAME, true],
  model: [NAME, false],
  mirror: [{ kind: "bool" }, false],
  paired: [{ kind: "bool" }, false],
};

function checkDevice(value: unknown): void {
  if (!isRecord(value)) fail();
  checkFields(value, DEVICE_FIELDS, []);
}

function fail(): never {
  throw new ProtocolError("invalid_message");
}
