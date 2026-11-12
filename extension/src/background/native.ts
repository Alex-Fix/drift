import {
  parse,
  ProtocolError,
  VERSION,
  type HostEvent,
  type Message,
  type Notification,
  type Request,
  type Response,
} from "../protocol";

export const HOST_NAME = "io.github.alex_fix.drift";
const REQUEST_TIMEOUT_MS = 15_000;

/** The subset of `chrome.runtime.Port` we use, so tests can pass a fake. */
export interface PortLike {
  postMessage(message: unknown): void;
  disconnect(): void;
  onMessage: { addListener(listener: (message: unknown) => void): void };
  onDisconnect: { addListener(listener: () => void): void };
}

interface Pending {
  resolve(response: Response): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * The native port to drift-host, opened lazily and reopened after the host exits. Requests are matched to responses
 * by `id`; events (`status`, `mirror_status`) go to `onEvent`; notifications (media) go out without an `id`.
 */
export class NativeClient {
  private port: PortLike | undefined;
  private nextId = 1;
  private readonly pending = new Map<string, Pending>();

  constructor(
    private readonly connect: () => PortLike,
    private readonly onEvent: (event: HostEvent) => void = () => undefined,
  ) {}

  request(request: Request): Promise<Response> {
    const id = String(this.nextId++);
    const port = this.open();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error("drift-host did not answer"));
      }, REQUEST_TIMEOUT_MS);
      this.pending.set(id, { resolve, reject, timer });
      port.postMessage({ v: VERSION, id, ...request });
    });
  }

  /** Fire-and-forget (media at frame rate): no id, no response; problems come back as events or id-less errors. */
  notify(notification: Notification): void {
    this.open().postMessage({ v: VERSION, ...notification });
  }

  private open(): PortLike {
    if (this.port) return this.port;
    const port = this.connect();
    port.onMessage.addListener((raw) => {
      this.receive(raw);
    });
    port.onDisconnect.addListener(() => {
      this.port = undefined;
      for (const [id, pending] of this.pending) {
        clearTimeout(pending.timer);
        pending.reject(new Error("drift-host is not running or not installed"));
        this.pending.delete(id);
      }
    });
    this.port = port;
    return port;
  }

  private receive(raw: unknown): void {
    let message;
    try {
      message = parse(raw);
    } catch (e) {
      if (!(e instanceof ProtocolError)) throw e;
      console.warn("drift: dropped an invalid message from drift-host:", e.code);
      return;
    }
    if (message.type === "status" || message.type === "mirror_status") {
      this.onEvent(message);
    } else if (isResponse(message)) {
      this.resolve(message);
    } else {
      console.warn("drift: dropped a message drift-host shouldn't send:", message.type);
    }
  }

  private resolve(response: Response): void {
    if (response.id === undefined) {
      if (response.type === "error") console.warn("drift: drift-host reported:", response.code);
      return;
    }
    const pending = this.pending.get(response.id);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pending.delete(response.id);
    pending.resolve(response);
  }
}

const RESPONSES: ReadonlySet<string> = new Set(["devices", "ok", "error", "mirror_started"]);

/** A response to one of our requests (`hello` only with the host's version; without it, it's a request). */
function isResponse(message: Message): message is Response {
  return RESPONSES.has(message.type) || (message.type === "hello" && "host" in message);
}
