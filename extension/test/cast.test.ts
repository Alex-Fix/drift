import { describe, expect, it } from "vitest";
import { chooseMode, fallsBack, fallsBackOnError } from "../src/background/cast";

const stream = (mediaType: string): unknown => expect.objectContaining({ mode: "stream", mediaType });
const mirror = { mode: "mirror" };

describe("chooseMode", () => {
  it("streams the video's own address", () => {
    const url = "https://cdn.example/a.mp4";
    expect(chooseMode({ url })).toEqual({ mode: "stream", url, mediaType: "file" });
  });

  it("streams HLS and MP4/MOV addresses by their path", () => {
    expect(chooseMode({ url: "https://cdn.example/master.m3u8" })).toEqual(stream("streaming"));
    expect(chooseMode({ url: "https://cdn.example/a/MOVIE.MP4?token=1#t=5" })).toEqual(stream("file"));
    expect(chooseMode({ url: "http://cdn.example/clip.m4v" })).toEqual(stream("file"));
    expect(chooseMode({ url: "http://cdn.example/clip.mov" })).toEqual(stream("file"));
  });

  it("streams by the source type when the path says nothing", () => {
    expect(chooseMode({ url: "https://cdn.example/play?id=7", mime: "application/x-mpegURL" })).toEqual(
      stream("streaming"),
    );
    expect(chooseMode({ url: "https://cdn.example/v/7", mime: 'video/mp4; codecs="avc1.64001f"' })).toEqual(
      stream("file"),
    );
  });

  it("mirrors everything else", () => {
    expect(chooseMode({ url: undefined })).toEqual(mirror); // blob/MSE player
    expect(chooseMode({ url: "https://cdn.example/manifest.mpd" })).toEqual(mirror); // DASH
    expect(chooseMode({ url: "https://cdn.example/clip.webm", mime: "video/webm" })).toEqual(mirror);
    expect(chooseMode({ url: "https://cdn.example/watch?v=1" })).toEqual(mirror);
    expect(chooseMode({ url: "https://cdn.example/m3u8/page.html" })).toEqual(mirror);
  });

  it("never streams a non-http address", () => {
    expect(chooseMode({ url: "file:///movies/a.mp4" })).toEqual(mirror);
    expect(chooseMode({ url: "data:video/mp4;base64,AAAA", mime: "video/mp4" })).toEqual(mirror);
    expect(chooseMode({ url: "not a url.mp4" })).toEqual(mirror);
  });
});

describe("fallback", () => {
  it("falls back when the receiver refuses the URL, not for other errors", () => {
    expect(fallsBackOnError("stream_failed")).toBe(true);
    expect(fallsBackOnError("device_unreachable")).toBe(false);
    expect(fallsBackOnError("pairing_required")).toBe(false);
  });

  it("mirrors a stream that failed or was dropped before it played", () => {
    expect(fallsBack({ state: "failed", reason: "stream_failed" }, false)).toBe(true);
    expect(fallsBack({ state: "stopped", reason: "stream_failed" }, false)).toBe(true);
  });

  it("doesn't fall back once the stream has played, or when it was stopped on purpose", () => {
    expect(fallsBack({ state: "failed", reason: "stream_failed" }, true)).toBe(false);
    expect(fallsBack({ state: "stopped" }, false)).toBe(false);
    expect(fallsBack({ state: "loading" }, false)).toBe(false);
  });
});
