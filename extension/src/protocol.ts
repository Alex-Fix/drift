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
  | "internal_error";

export interface DeviceInfo {
  id: string;
  name: string;
  model?: string;
}

export type PlaybackState = "idle" | "loading" | "playing" | "paused";

/** Requests without the envelope; `NativeClient` adds `v` and `id`. */
export type Request =
  | { type: "hello" }
  | { type: "scan"; timeout_ms?: number }
  | { type: "play"; device: string; url: string; title?: string; position?: number }
  | { type: "control"; device: string; action: "pause" | "resume" | "seek"; position?: number }
  | { type: "stop"; device: string };

export type Response =
  | { v: 1; id: string; type: "hello"; host: string }
  | { v: 1; id: string; type: "devices"; devices: DeviceInfo[] }
  | { v: 1; id: string; type: "ok" }
  | { v: 1; id?: string; type: "error"; code: ErrorCode };

export interface StatusEvent {
  v: 1;
  type: "status";
  device: string;
  state: PlaybackState;
  position?: number;
  duration?: number;
}

export type Message = (Request & { v: 1; id: string }) | Response | StatusEvent;

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
  | { kind: "devices" };
type Kind = "request" | "response" | "event";
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
];

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
  devices: ["response", { devices: [{ kind: "devices" }, true] }],
  ok: ["response", {}],
  error: ["response", { code: [{ kind: "oneOf", values: ERROR_CODES }, true] }],
  status: [
    "event",
    {
      device: [DEVICE, true],
      state: [{ kind: "oneOf", values: ["idle", "loading", "playing", "paused"] }, true],
      position: [POSITION, false],
      duration: [POSITION, false],
    },
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
    if (kind === "event") throw new ProtocolError("invalid_message");
  } else if (kind === "request" || (kind === "response" && raw.type !== "error")) {
    throw new ProtocolError("invalid_message");
  }

  for (const key of Object.keys(raw)) {
    if (key !== "v" && key !== "type" && key !== "id" && !Object.hasOwn(fields, key)) {
      throw new ProtocolError("invalid_message");
    }
  }
  for (const [name, [spec, required]] of Object.entries(fields)) {
    if (name in raw) check(spec, raw[name]);
    else if (required) throw new ProtocolError("invalid_message");
  }
  if (raw.type === "control" && raw.action === "seek" && !("position" in raw)) {
    throw new ProtocolError("invalid_message");
  }
  return raw as unknown as Message;
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

function checkDevice(value: unknown): void {
  if (!isRecord(value) || Object.keys(value).some((key) => key !== "id" && key !== "name" && key !== "model")) fail();
  check(DEVICE, value.id);
  check(NAME, value.name);
  if ("model" in value) check(NAME, value.model);
}

function fail(): never {
  throw new ProtocolError("invalid_message");
}
