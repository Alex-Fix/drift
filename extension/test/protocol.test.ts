import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse, ProtocolError } from "../src/protocol";

const fixtures = join(import.meta.dirname, "../../protocol/fixtures");
const load = (dir: string) =>
  readdirSync(join(fixtures, dir))
    .filter((file) => file.endsWith(".json"))
    .map((file) => ({
      name: file.slice(0, -5),
      message: JSON.parse(readFileSync(join(fixtures, dir, file), "utf8")) as unknown,
    }));

describe("shared fixtures", () => {
  it.each(load("valid"))("accepts $name unchanged", ({ message }) => {
    expect(parse(message)).toEqual(message);
  });

  it.each(load("invalid"))("rejects $name with its code", ({ name, message }) => {
    const expected = name.split("--")[0];
    expect(() => parse(message)).toThrow(expect.objectContaining({ code: expected }) as ProtocolError);
  });
});

describe("parse", () => {
  it("rejects a boolean version", () => {
    expect(() => parse({ v: true, type: "hello", id: "1" })).toThrow(ProtocolError);
  });

  it("rejects an id on an event", () => {
    expect(() => parse({ v: 1, type: "status", id: "1", device: "d", state: "idle" })).toThrow(ProtocolError);
  });

  it("does not treat inherited properties as message types", () => {
    expect(() => parse({ v: 1, type: "toString", id: "1" })).toThrow(
      expect.objectContaining({ code: "unknown_type" }) as ProtocolError,
    );
  });
});
