import { describe, expect, it } from "vitest";
import { parseOverlayAction } from "../src/background/overlay";

describe("parseOverlayAction", () => {
  it("accepts the remote's fixed actions", () => {
    for (const action of ["toggle", "back", "forward", "bring_back"]) {
      expect(parseOverlayAction({ kind: "drift-overlay-action", action })).toEqual({ action });
    }
  });

  it("accepts a jump to a moment, in seconds", () => {
    expect(parseOverlayAction({ kind: "drift-overlay-action", action: "seek", position: 61.5 })).toEqual({
      action: "seek",
      position: 61.5,
    });
  });

  it("refuses a jump without a sane position", () => {
    for (const position of [-1, Number.NaN, Number.POSITIVE_INFINITY, 1e9, "60", undefined]) {
      expect(parseOverlayAction({ kind: "drift-overlay-action", action: "seek", position })).toBeUndefined();
    }
    expect(parseOverlayAction({ kind: "drift-overlay-action", action: "seek" })).toBeUndefined();
    expect(parseOverlayAction({ kind: "drift-overlay-action", action: "toggle", position: 5 })).toBeUndefined();
  });

  it("refuses anything else", () => {
    expect(parseOverlayAction({ kind: "drift-overlay-action", action: "send" })).toBeUndefined();
    expect(parseOverlayAction({ kind: "drift-overlay-action", action: "toggle", url: "https://x" })).toBeUndefined();
    expect(parseOverlayAction({ kind: "host", action: "toggle" })).toBeUndefined();
    expect(parseOverlayAction("toggle")).toBeUndefined();
    expect(parseOverlayAction(null)).toBeUndefined();
  });
});
