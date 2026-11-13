import { describe, expect, it } from "vitest";
import { StepDownMonitor } from "../src/capture/stepdown";

function feed(monitor: StepDownMonitor, frames: number, droppedEvery: number, start = 0): number {
  let now = start;
  for (let i = 0; i < frames; i++) {
    monitor.record(droppedEvery > 0 && i % droppedEvery === 0, now);
    now += 16;
  }
  return now;
}

describe("StepDownMonitor", () => {
  it("stays put while few frames are lost", () => {
    const monitor = new StepDownMonitor();
    const now = feed(monitor, 120, 20); // 5% lost
    expect(monitor.due(now)).toBe(false);
  });

  it("steps down when too many frames are lost in the window", () => {
    const monitor = new StepDownMonitor();
    const now = feed(monitor, 120, 4); // 25% lost
    expect(monitor.due(now)).toBe(true);
  });

  it("waits out the cooldown before judging the new rung", () => {
    const monitor = new StepDownMonitor(3000, 0.15, 10_000);
    let now = feed(monitor, 120, 2);
    expect(monitor.due(now)).toBe(true);
    now = feed(monitor, 120, 2, now);
    expect(monitor.due(now)).toBe(false); // still cooling down
    now = feed(monitor, 120, 2, now + 10_000);
    expect(monitor.due(now)).toBe(true);
  });

  it("only judges the recent window and needs enough frames", () => {
    const monitor = new StepDownMonitor(1000);
    let now = feed(monitor, 60, 1); // all lost, long ago
    now = feed(monitor, 100, 0, now + 5000); // then healthy
    expect(monitor.due(now)).toBe(false);
    expect(new StepDownMonitor().due(0)).toBe(false);
  });

  it("an external step-down starts the cooldown too", () => {
    const monitor = new StepDownMonitor();
    monitor.stepped(0);
    const now = feed(monitor, 120, 2, 100);
    expect(monitor.due(now)).toBe(false);
  });
});
