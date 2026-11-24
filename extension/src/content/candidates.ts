export interface Candidate {
  /** `http(s)` URL the receiver could fetch, or undefined for blob/MSE players (not streamable without a relay). */
  url: string | undefined;
  /** The `type` of the `<source>` that `url` came from, e.g. `video/mp4`; helps choose streaming. */
  mime: string | undefined;
  title: string;
  duration: number | undefined;
  position: number;
  playing: boolean;
  /** The page's poster image for it (http(s) only), shown as the thumbnail in the popup. */
  poster: string | undefined;
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
    const url = sources.map(streamable).find((found) => found !== undefined);
    const source = Array.from(video.querySelectorAll("source")).find((s) => url !== undefined && s.src === url);
    const mime = source?.type.slice(0, 128);
    return {
      url,
      mime: mime === "" ? undefined : mime,
      title: document.title.slice(0, 256) || location.hostname,
      duration: Number.isFinite(video.duration) ? video.duration : undefined,
      position: video.currentTime,
      poster: /^https?:\/\//i.test(video.poster) && video.poster.length <= 2048 ? video.poster : undefined,
      playing: !video.paused,
      drm: video.mediaKeys !== null,
    };
  });
}
