/**
 * Source VTF CPU pixel codecs. BC palette/channel conventions follow m0clip's
 * scripts/source_assets.py and src/render/source-vtf.ts. VTF format references:
 * noclip.website, Copyright (c) 2018 Jasper St. Pierre, MIT (LICENSE.noclip).
 * Only the selected encoded 2D slice is consumed. No per-pixel/block allocations.
 */
const rawOrders: Readonly<Record<number, string>> = Object.freeze({
  0: 'RGBA', 1: 'ABGR', 2: 'RGB', 3: 'BGR', 5: 'I', 6: 'IA', 8: 'A',
  11: 'ARGB', 12: 'BGRA', 16: 'BGRX',
});
const blockBytes: Readonly<Record<number, number>> = Object.freeze({ 13: 8, 14: 16, 15: 16, 20: 8 });
function fail(message: string): never { throw new Error(`Source VTF: ${message}`); }

export function sourceVtfPixelKind(format: number): 'byte' | 'hdr' | 'uv' {
  if (rawOrders[format] || blockBytes[format] || format === 21) return 'byte';
  if (format === 22) return 'uv';
  if (format === 24) return 'hdr';
  return fail(`unsupported image format ${format}`);
}
export function sourceVtfSliceBytes(format: number, width: number, height: number): number {
  sourceVtfPixelKind(format);
  const block = blockBytes[format];
  const size = block ? Math.ceil(width / 4) * Math.ceil(height / 4) * block
    : width * height * (rawOrders[format]?.length ?? (format === 24 ? 8 : 2));
  if (!Number.isSafeInteger(size) || size < 1) fail('invalid encoded slice size');
  return size;
}
function halfToFloat(value: number): number {
  const sign = value & 0x8000 ? -1 : 1, exponent = value >>> 10 & 31, fraction = value & 1023;
  if (exponent === 0) return sign * fraction * 2 ** -24;
  if (exponent === 31) return fraction ? NaN : sign * Infinity;
  return sign * (1024 + fraction) * 2 ** (exponent - 25);
}

/** Bytes retain their authored transfer encoding; float HDR is linear, UV88 is SNORM. */
export function decodeSourceVtfPixels(bytes: Uint8Array, format: number, width: number, height: number, signal?: AbortSignal): Uint8Array | Float32Array {
  signal?.throwIfAborted();
  const kind = sourceVtfPixelKind(format), count = width * height;
  if (bytes.byteLength !== sourceVtfSliceBytes(format, width, height)) fail('encoded slice length mismatch');
  const outputBytes = count * 4 * (kind === 'byte' ? 1 : 4);
  if (!Number.isSafeInteger(outputBytes) || outputBytes > 0xffffffff) fail('selected decoded slice exceeds typed-array capacity');
  if (format === 0) return bytes; // Already RGBA; preserve the selected range's ownership.
  if (kind !== 'byte') {
    const out = new Float32Array(count * 4);
    if (kind === 'hdr') {
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      for (let i = 0; i < out.length; i++) {
        if ((i & 0xffff) === 0) signal?.throwIfAborted();
        out[i] = halfToFloat(view.getUint16(i * 2, true));
      }
    } else {
      // IMAGE_FORMAT_UV88 is two signed, normalized channels, not biased RGB normal data.
      for (let i = 0; i < count; i++) {
        if ((i & 0xffff) === 0) signal?.throwIfAborted();
        const u = bytes[i * 2], v = bytes[i * 2 + 1];
        out[i * 4] = Math.max(-1, (u > 127 ? u - 256 : u) / 127);
        out[i * 4 + 1] = Math.max(-1, (v > 127 ? v - 256 : v) / 127);
        out[i * 4 + 3] = 1;
      }
    }
    return out;
  }
  const out = new Uint8Array(count * 4), order = rawOrders[format];
  if (order) {
    out.fill(255);
    // Resolve channel destinations once, outside the pixel loop; I expands into RGB.
    for (let channel = 0; channel < order.length; channel++) {
      const symbol = order[channel], target = 'RGBA'.indexOf(symbol);
      if (symbol === 'X') continue;
      for (let i = 0, from = channel; i < count; i++, from += order.length) {
        if ((i & 0xffff) === 0) signal?.throwIfAborted();
        const value = bytes[from], at = i * 4;
        if (symbol === 'I') out[at] = out[at + 1] = out[at + 2] = value;
        else out[at + target] = value;
      }
    }
  } else if (format === 21) {
    // BGRA5551: little-endian B0..4, G5..9, R10..14, A15.
    for (let i = 0; i < count; i++) {
      if ((i & 0xffff) === 0) signal?.throwIfAborted();
      const packed = bytes[i * 2] | bytes[i * 2 + 1] << 8;
      const r = packed >>> 10 & 31, g = packed >>> 5 & 31, b = packed & 31, at = i * 4;
      out[at] = r << 3 | r >>> 2; out[at + 1] = g << 3 | g >>> 2; out[at + 2] = b << 3 | b >>> 2;
      out[at + 3] = packed & 0x8000 ? 255 : 0;
    }
  } else {
    const block = blockBytes[format], palette = new Uint8Array(16), alpha = new Uint8Array(8);
    const blocksWide = Math.ceil(width / 4), blocksHigh = Math.ceil(height / 4);
    for (let by = 0, at = 0; by < blocksHigh; by++) {
      signal?.throwIfAborted();
      for (let bx = 0; bx < blocksWide; bx++, at += block) {
        const colorAt = at + (block === 8 ? 0 : 8);
        const c0 = bytes[colorAt] | bytes[colorAt + 1] << 8, c1 = bytes[colorAt + 2] | bytes[colorAt + 3] << 8;
        const four = block !== 8 || c0 > c1;
        for (let endpoint = 0; endpoint < 2; endpoint++) {
          const packed = endpoint ? c1 : c0, p = endpoint * 4;
          const r = packed >>> 11 & 31, g = packed >>> 5 & 63, b = packed & 31;
          palette[p] = r << 3 | r >>> 2; palette[p + 1] = g << 2 | g >>> 4; palette[p + 2] = b << 3 | b >>> 2;
          palette[p + 3] = 255;
        }
        for (let c = 0; c < 3; c++) {
          const a = palette[c], b = palette[4 + c];
          palette[8 + c] = four ? Math.floor((2 * a + b) / 3) : Math.floor((a + b) / 2);
          palette[12 + c] = four ? Math.floor((a + 2 * b) / 3) : 0;
        }
        palette[11] = 255; palette[15] = four ? 255 : 0;
        let colorBits = (bytes[colorAt + 4] | bytes[colorAt + 5] << 8 | bytes[colorAt + 6] << 16 | bytes[colorAt + 7] << 24) >>> 0;
        let alphaBits = 0;
        if (format === 15) {
          alpha[0] = bytes[at]; alpha[1] = bytes[at + 1];
          if (alpha[0] > alpha[1]) for (let i = 1; i <= 6; i++) alpha[i + 1] = Math.floor(((7 - i) * alpha[0] + i * alpha[1]) / 7);
          else {
            for (let i = 1; i <= 4; i++) alpha[i + 1] = Math.floor(((5 - i) * alpha[0] + i * alpha[1]) / 5);
            alpha[6] = 0; alpha[7] = 255;
          }
          // A JS Number exactly represents all six alpha-index bytes (48 bits).
          for (let i = 0; i < 6; i++) alphaBits += bytes[at + 2 + i] * 2 ** (8 * i);
        }
        for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++) {
          const p = (colorBits & 3) * 4, a = alpha[alphaBits % 8];
          colorBits >>>= 2;
          if (format === 15) alphaBits = Math.floor(alphaBits / 8);
          const px = bx * 4 + x, py = by * 4 + y;
          if (px >= width || py >= height) continue;
          const to = (py * width + px) * 4;
          out[to] = palette[p]; out[to + 1] = palette[p + 1]; out[to + 2] = palette[p + 2];
          out[to + 3] = format === 14 ? (bytes[at + (y * 4 + x >>> 1)] >>> ((x & 1) * 4) & 15) * 17
            : format === 15 ? a : palette[p + 3];
        }
      }
    }
  }
  return out;
}
