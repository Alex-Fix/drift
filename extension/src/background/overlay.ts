import { MAX_POSITION, OVERLAY_ACTIONS, type OverlayRequest } from "../messages";

/**
 * The one kind of message the background takes from a content script besides media: the page remote's input.
 * Exactly `{ kind: "drift-overlay-action", action }` with a known action, or `{ kind, action: "seek", position }`
 * with a position in seconds; anything else is undefined. The caller also checks the sender is the frame holding
 * this tab's remote.
 */
export function parseOverlayAction(raw: unknown): OverlayRequest | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const keys = Object.keys(raw);
  const { kind, action, position } = raw as { kind?: unknown; action?: unknown; position?: unknown };
  if (kind !== "drift-overlay-action") return undefined;
  if (action === "seek") {
    const valid =
      keys.length === 3 &&
      typeof position === "number" &&
      Number.isFinite(position) &&
      position >= 0 &&
      position <= MAX_POSITION;
    return valid ? { action, position } : undefined;
  }
  if (keys.length !== 2 || !keys.includes("action")) return undefined;
  const known = OVERLAY_ACTIONS.find((name) => name === action);
  return known === undefined ? undefined : { action: known };
}
