/** Bytes per second over the last minute: the mirroring bitrate graph in Stats for nerds. */
export class Meter {
  private readonly buckets = new Map<number, number>(); // whole second → bytes

  constructor(private readonly seconds = 60) {}

  add(bytes: number, nowMs: number): void {
    const second = Math.floor(nowMs / 1000);
    this.buckets.set(second, (this.buckets.get(second) ?? 0) + bytes);
    for (const key of this.buckets.keys()) if (key <= second - this.seconds) this.buckets.delete(key);
  }

  /** Mbit/s for each of the last `seconds` complete seconds, oldest first (0 where nothing was sent). */
  mbps(nowMs: number): number[] {
    const current = Math.floor(nowMs / 1000);
    return Array.from({ length: this.seconds }, (_, i) => {
      const bytes = this.buckets.get(current - this.seconds + i) ?? 0;
      return Math.round((bytes * 8) / 10_000) / 100; // two decimals
    });
  }
}

/** Bytes a padded base64 string decodes to. */
export function base64Bytes(data: string): number {
  const padding = data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0;
  return (data.length / 4) * 3 - padding;
}
