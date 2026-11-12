import { describe, expect, it } from "vitest";
import { NativeClient, type PortLike } from "../src/background/native";
import type { StatusEvent } from "../src/protocol";

class FakePort implements PortLike {
  sent: unknown[] = [];
  disconnected = false;
  private messageListeners: ((message: unknown) => void)[] = [];
  private disconnectListeners: (() => void)[] = [];
  onMessage = { addListener: (l: (message: unknown) => void) => this.messageListeners.push(l) };
  onDisconnect = { addListener: (l: () => void) => this.disconnectListeners.push(l) };

  postMessage(message: unknown): void {
    this.sent.push(message);
  }
  disconnect(): void {
    this.disconnected = true;
  }
  receive(message: unknown): void {
    for (const l of this.messageListeners) l(message);
  }
  drop(): void {
    for (const l of this.disconnectListeners) l();
  }
}

describe("NativeClient", () => {
  it("adds the envelope and matches the response by id", async () => {
    const port = new FakePort();
    const client = new NativeClient(() => port);
    const answer = client.request({ type: "hello" });
    expect(port.sent).toEqual([{ v: 1, id: "1", type: "hello" }]);
    port.receive({ v: 1, id: "1", type: "hello", host: "0.1.0" });
    await expect(answer).resolves.toEqual({ v: 1, id: "1", type: "hello", host: "0.1.0" });
  });

  it("opens the port once for many requests", () => {
    let opened = 0;
    const port = new FakePort();
    const client = new NativeClient(() => (opened++, port));
    void client.request({ type: "hello" });
    void client.request({ type: "scan" });
    expect(opened).toBe(1);
  });

  it("forwards status events", () => {
    const port = new FakePort();
    const events: StatusEvent[] = [];
    const client = new NativeClient(
      () => port,
      (e) => events.push(e),
    );
    void client.request({ type: "hello" });
    port.receive({ v: 1, type: "status", device: "d", state: "playing" });
    expect(events).toEqual([{ v: 1, type: "status", device: "d", state: "playing" }]);
  });

  it("ignores invalid messages from the host", async () => {
    const port = new FakePort();
    const client = new NativeClient(() => port);
    const answer = client.request({ type: "hello" });
    port.receive({ v: 1, id: "1", type: "hello", host: "0.1.0", extra: "<img onerror>" });
    port.receive({ v: 1, id: "1", type: "ok" });
    await expect(answer).resolves.toEqual({ v: 1, id: "1", type: "ok" });
  });

  it("fails pending requests and reconnects after the host exits", async () => {
    const opened: FakePort[] = [];
    const client = new NativeClient(() => {
      const port = new FakePort();
      opened.push(port);
      return port;
    });
    const answer = client.request({ type: "hello" });
    opened[0]?.drop();
    await expect(answer).rejects.toThrow("not running");
    void client.request({ type: "hello" });
    expect(opened).toHaveLength(2);
  });
});
