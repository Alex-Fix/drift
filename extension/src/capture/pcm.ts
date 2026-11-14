/** Planar float channels → interleaved signed 16-bit little-endian stereo (the host's only audio format). Mono is
 * duplicated to both sides; channels past the second are dropped. */
export function toS16Stereo(planes: readonly Float32Array[]): Uint8Array {
  const left = planes[0];
  if (left === undefined) return new Uint8Array(0);
  const right = planes[1] ?? left;
  const out = new DataView(new ArrayBuffer(left.length * 4));
  for (let i = 0; i < left.length; i++) {
    out.setInt16(i * 4, toS16(left[i] ?? 0), true);
    out.setInt16(i * 4 + 2, toS16(right[i] ?? 0), true);
  }
  return new Uint8Array(out.buffer);
}

function toS16(sample: number): number {
  const clamped = Math.max(-1, Math.min(1, sample));
  return Math.round(clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff);
}

export function base64(bytes: Uint8Array): string {
  if (bytes.toBase64) return bytes.toBase64();
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}
