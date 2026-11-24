import { describe, expect, it } from "vitest";
import { Meter, base64Bytes } from "../src/background/meter";

describe("Meter", () => {
  it("reports Mbit/s per complete second, oldest first", () => {
    const meter = new Meter(3);
    meter.add(500_000, 10_000);
    meter.add(500_000, 10_900);
    meter.add(250_000, 11_500);
    meter.add(999, 12_100); // the current second isn't complete: not shown
    expect(meter.mbps(12_200)).toEqual([0, 8, 2]);
  });

  it("forgets what's older than its window", () => {
    const meter = new Meter(2);
    meter.add(125_000, 1_000);
    meter.add(125_000, 9_000);
    expect(meter.mbps(10_000)).toEqual([0, 1]);
  });
});

describe("base64Bytes", () => {
  it("counts decoded bytes", () => {
    expect(base64Bytes("AAAA")).toBe(3);
    expect(base64Bytes("AAA=")).toBe(2);
    expect(base64Bytes("AA==")).toBe(1);
  });
});
