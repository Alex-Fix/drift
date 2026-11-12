export interface Candidate {
  /** `http(s)` URL the receiver could fetch, or undefined for blob/MSE players (not streamable without a relay). */
  url: string | undefined;
  title: string;
  duration: number | undefined;
  position: number;
  playing: boolean;
  /** Encrypted Media Extensions are active: DRM-protected, never streamed. */
  drm: boolean;
}

/**
 * Lists the page's videos. Injected with `chrome.scripting.executeScript({ func })`, which serialises the function's
 * source: it must stay self-contained (no imports, no outer variables) and return plain JSON.
 */
export function findCandidates(): Candidate[] {
  const streamable = (src: string): string | undefined => (/^https?:\/\//i.test(src) ? src : undefined);
  return Array.from(document.querySelectorAll("video")).map((video) => {
    const sources = [video.currentSrc, video.src, ...Array.from(video.querySelectorAll("source"), (s) => s.src)];
    return {
      url: sources.map(streamable).find((url) => url !== undefined),
      title: document.title.slice(0, 256) || location.hostname,
      duration: Number.isFinite(video.duration) ? video.duration : undefined,
      position: video.currentTime,
      playing: !video.paused,
      drm: video.mediaKeys !== null,
    };
  });
}
