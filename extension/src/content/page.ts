// The page's own <video> while it plays on the receiver. Injected with `chrome.scripting.executeScript({ func, args })`,
// which serialises each function's source: they must stay self-contained (no imports, no outer variables).

/** Pause the video while the receiver plays it; returns where it was (seconds), or null if it's gone. */
export function pauseVideo(index: number): number | null {
  const video = document.querySelectorAll("video")[index];
  if (video === undefined) return null;
  video.pause();
  return video.currentTime;
}

/** Play it on the page again, from `position` (where the receiver was) if given. False if the video is gone. */
export function resumeVideo(index: number, position: number | null): boolean {
  const video = document.querySelectorAll("video")[index];
  if (video === undefined) return false;
  if (position !== null && Number.isFinite(position) && position >= 0) video.currentTime = position;
  // Autoplay rules may refuse play() outside a user gesture; the page then shows its own play button.
  video.play().catch(() => undefined);
  return true;
}
