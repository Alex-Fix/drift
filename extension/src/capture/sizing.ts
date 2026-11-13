// When the captured picture changes size (a resolution switch in an adaptive stream, fullscreen, a window resize in
// tab capture), the encoder must be reconfigured: feeding it frames of another size is undefined. Sizes that change
// every frame (a resize animation) aren't worth a reconfigure each, so a new size has to hold for a few frames first;
// frames in between are skipped (the receiver holds the last picture).

export interface Size {
  width: number;
  height: number;
}

export type Decision = "encode" | "skip" | { reconfigure: Size };

const same = (a: Size, b: Size) => a.width === b.width && a.height === b.height;

export class FrameSizer {
  private pending: { size: Size; count: number } | undefined;

  constructor(
    private source: Size, // the size the current encoder configuration was derived from
    private readonly stableFrames = 10,
  ) {}

  next(size: Size): Decision {
    if (same(size, this.source)) {
      this.pending = undefined;
      return "encode";
    }
    if (this.pending !== undefined && same(this.pending.size, size)) this.pending.count++;
    else this.pending = { size, count: 1 };
    if (this.pending.count < this.stableFrames) return "skip";
    this.pending = undefined;
    this.source = size;
    return { reconfigure: size };
  }
}
