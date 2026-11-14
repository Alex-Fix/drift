/**
 * Puts video and audio on one timeline: each track's first frame is placed at its arrival time since the session
 * started, and later frames follow that track's own timestamps. Output is microseconds from the session start, which
 * the host anchors to NTP — so both tracks share one origin even when the browser timestamps them on different
 * clocks.
 */
export class MediaClock {
  private readonly origin: number;
  private readonly offsets = new Map<string, number>();

  constructor(private readonly now: () => number = () => performance.now()) {
    this.origin = now();
  }

  /** `timestamp`: the frame's own timestamp in µs. */
  map(track: "video" | "audio", timestamp: number): number {
    let offset = this.offsets.get(track);
    if (offset === undefined) {
      offset = (this.now() - this.origin) * 1000 - timestamp;
      this.offsets.set(track, offset);
    }
    return Math.max(0, Math.round(timestamp + offset));
  }
}
