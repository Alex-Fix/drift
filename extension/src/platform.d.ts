// Chrome APIs drift uses that TypeScript's DOM types don't cover yet.

interface HTMLMediaElement {
  /** Chrome: a live MediaStream of what the element plays (fails for EME-protected media). */
  captureStream(): MediaStream;
}

declare class MediaStreamTrackProcessor<T extends VideoFrame | AudioData> {
  constructor(init: { track: MediaStreamTrack; maxBufferSize?: number });
  readonly readable: ReadableStream<T>;
}

interface Uint8Array {
  /** Chrome 140+ (TC39 Uint8Array base64). */
  toBase64?: () => string;
}
