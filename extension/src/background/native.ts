import { parse, ProtocolError, VERSION, type Request, type Response, type StatusEvent } from "../protocol";

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
 * by `id`; `status` events go to `onStatus`.
 */
export class NativeClient {
  private port: PortLike | undefined;
  private nextId = 1;
  private readonly pending = new Map<string, Pending>();

  constructor(
    private readonly connect: () => PortLike,
    private readonly onStatus: (event: StatusEvent) => void = () => undefined,
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
    if (message.type === "status") {
      this.onStatus(message);
      return;
    }
    const pending = message.id === undefined ? undefined : this.pending.get(message.id);
    if (!pending || message.id === undefined) return;
    clearTimeout(pending.timer);
    this.pending.delete(message.id);
    pending.resolve(message as Response);
  }
}
