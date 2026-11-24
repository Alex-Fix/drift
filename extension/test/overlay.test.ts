import { describe, expect, it } from "vitest";
import { parseOverlayAction } from "../src/background/overlay";

describe("parseOverlayAction", () => {
  it("accepts the remote's fixed actions", () => {
    for (const action of ["toggle", "back", "forward", "bring_back"]) {
      expect(parseOverlayAction({ kind: "drift-overlay-action", action })).toBe(action);
    }
  });

  it("refuses anything else", () => {
    expect(parseOverlayAction({ kind: "drift-overlay-action", action: "send" })).toBeUndefined();
    expect(parseOverlayAction({ kind: "drift-overlay-action", action: "toggle", url: "https://x" })).toBeUndefined();
    expect(parseOverlayAction({ kind: "host", action: "toggle" })).toBeUndefined();
    expect(parseOverlayAction("toggle")).toBeUndefined();
    expect(parseOverlayAction(null)).toBeUndefined();
  });
});
