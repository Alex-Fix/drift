// Mid-stream step-down (design: "Quality ladder"): when too many frames are lost, move to the next rung. Frames are
// lost either here (the encoder queue is full) or downstream (the host drops them when the receiver or network falls
// behind; the background relays that). A cooldown gives the new rung time to settle before judging it.

export class StepDownMonitor {
  private events: { at: number; dropped: boolean }[] = [];
  private quietUntil = 0;

  constructor(
    private readonly windowMs = 3000,
    private readonly threshold = 0.15, // share of frames lost in the window
    private readonly cooldownMs = 10_000,
    private readonly minFrames = 30, // don't judge on a handful of frames
  ) {}

  record(dropped: boolean, now: number): void {
    this.events.push({ at: now, dropped });
    const since = now - this.windowMs;
    while (this.events.length > 0 && (this.events[0]?.at ?? now) < since) this.events.shift();
  }

  /** True when it's time to step down; starts the cooldown. */
  due(now: number): boolean {
    if (now < this.quietUntil || this.events.length < this.minFrames) return false;
    const dropped = this.events.filter((e) => e.dropped).length;
    if (dropped / this.events.length < this.threshold) return false;
    this.stepped(now);
    return true;
  }

  /** A step-down happened (here or on request): reset and wait before judging again. */
  stepped(now: number): void {
    this.events = [];
    this.quietUntil = now + this.cooldownMs;
  }
}
