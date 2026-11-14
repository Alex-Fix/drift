import { describe, expect, it } from "vitest";
import { MirrorSessions } from "../src/background/mirror";

const S = "0123456789abcdef0123456789abcdef";
const video = { type: "video", session: S, ts: 0, key: true, data: "AAAA" };

describe("MirrorSessions.accept", () => {
  const sessions = new MirrorSessions();
  sessions.bind(7, S);

  it("forwards valid media for the tab's own session", () => {
    expect(sessions.accept(7, video)).toMatchObject({ type: "video", session: S });
    expect(sessions.accept(7, { type: "audio", session: S, ts: 5, data: "AAAA" })).toMatchObject({ type: "audio" });
  });

  it("drops media from another tab, for another session, or without a tab", () => {
    expect(sessions.accept(8, video)).toBeUndefined();
    expect(sessions.accept(7, { ...video, session: "f".repeat(32) })).toBeUndefined();
    expect(sessions.accept(undefined, video)).toBeUndefined();
  });

  it("drops anything that isn't valid media: requests, bad shapes, junk", () => {
    expect(sessions.accept(7, { type: "mirror_stop", id: "1", session: S })).toBeUndefined();
    expect(sessions.accept(7, { ...video, data: "not base64!" })).toBeUndefined();
    expect(sessions.accept(7, { ...video, extra: 1 })).toBeUndefined();
    expect(sessions.accept(7, "video")).toBeUndefined();
  });

  it("forgets a tab once unbound", () => {
    const local = new MirrorSessions();
    local.bind(3, S);
    expect(local.tabOf(S)).toBe(3);
    expect(local.unbind(3)).toBe(S);
    expect(local.accept(3, video)).toBeUndefined();
  });
});
