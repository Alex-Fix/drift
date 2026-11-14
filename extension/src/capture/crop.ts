// Tab-capture fallback: where the video is in the captured tab frame.

export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** The video's box and the top-level viewport, in CSS pixels, as the page reports them. */
export interface Placement {
  rect: Box;
  viewport: { width: number; height: number };
}

const MIN_SIZE = 16;
const INSET = 1; // CSS px trimmed off each side: keeps anti-aliased page edges and outlines out

/**
 * The video's box in a captured frame of `frame` size. Tab capture keeps the tab's aspect ratio and fits it into the
 * frame (black bars when they differ), so CSS pixels map with one uniform scale plus a centring offset. The box is
 * inset by a pixel and rounded inward to even values (4:2:0 frames crop on even boundaries), so the page's edges and
 * outlines stay out. `null` when the video isn't entirely on screen — the encoder needs a stable size, so the
 * receiver holds the last full frame until it's back — or is too small to show.
 */
export function cropRect(placement: Placement, frame: { width: number; height: number }): Box | null {
  const { rect, viewport } = placement;
  if (viewport.width <= 0 || viewport.height <= 0) return null;
  if (rect.x < 0 || rect.y < 0 || rect.x + rect.width > viewport.width || rect.y + rect.height > viewport.height) {
    return null; // partly off screen
  }
  const scale = Math.min(frame.width / viewport.width, frame.height / viewport.height);
  const offsetX = (frame.width - viewport.width * scale) / 2;
  const offsetY = (frame.height - viewport.height * scale) / 2;
  const left = Math.ceil(offsetX + (rect.x + INSET) * scale);
  const top = Math.ceil(offsetY + (rect.y + INSET) * scale);
  const right = Math.floor(offsetX + (rect.x + rect.width - INSET) * scale);
  const bottom = Math.floor(offsetY + (rect.y + rect.height - INSET) * scale);
  const x = (left + 1) & ~1;
  const y = (top + 1) & ~1;
  const width = (right - x) & ~1;
  const height = (bottom - y) & ~1;
  if (width < MIN_SIZE || height < MIN_SIZE) return null;
  return { x, y, width, height };
}
