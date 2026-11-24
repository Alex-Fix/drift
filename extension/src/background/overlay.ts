import { OVERLAY_ACTIONS, type OverlayAction } from "../messages";

/**
 * The one kind of message the background takes from a content script besides media: a click on the page remote.
 * Exactly `{ kind: "drift-overlay-action", action }` with a known action, or undefined. The caller also checks the
 * sender is the frame holding this tab's remote.
 */
export function parseOverlayAction(raw: unknown): OverlayAction | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const keys = Object.keys(raw);
  const { kind, action } = raw as { kind?: unknown; action?: unknown };
  if (kind !== "drift-overlay-action" || keys.length !== 2 || !keys.includes("action")) return undefined;
  return OVERLAY_ACTIONS.find((known) => known === action);
}
