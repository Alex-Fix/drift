// Where the page remote goes, kept free of the DOM so it's unit-tested.

export interface Box {
  left: number;
  top: number;
  width: number;
  height: number;
}

export type Dock = "over" | "below" | "above";

export const BAR_HEIGHT = 56;
const GAP = 8;

/**
 * The remote's box in the frame's viewport. Over the video while streaming or mirroring from the page (the TV gets
 * the stream or the element's own frames, never the screen). In tab-capture mirroring the TV gets this part of the
 * screen, so the remote docks as a bar below the video, or above it, and is hidden when neither fits.
 */
export function overlayBox(
  video: Box,
  viewport: { width: number; height: number },
  docked: boolean,
): (Box & { dock: Dock }) | undefined {
  if (video.width < 1 || video.height < 1) return undefined;
  if (!docked) return { ...video, dock: "over" };
  const width = Math.min(video.width, viewport.width);
  const left = Math.min(Math.max(video.left, 0), Math.max(0, viewport.width - width));
  const below = video.top + video.height + GAP;
  if (below + BAR_HEIGHT <= viewport.height) return { left, top: below, width, height: BAR_HEIGHT, dock: "below" };
  const above = video.top - GAP - BAR_HEIGHT;
  if (above >= 0) return { left, top: above, width, height: BAR_HEIGHT, dock: "above" };
  return undefined;
}
