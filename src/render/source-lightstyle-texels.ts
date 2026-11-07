/** Source directional lightmap normalization, matching the static CPU atlas.
 * RGBExp32 input is style-major within each of the four layer buffers. */
export function paintSourceDirectionalStylePatch(
  pixels: readonly [Uint8Array, Uint8Array, Uint8Array, Uint8Array], size: number,
  patch: { x: number; y: number; width: number; height: number; styles: readonly number[] },
  samples: readonly [Uint8Array, Uint8Array, Uint8Array, Uint8Array],
  values: Float32Array, sums: Float32Array, signal?: AbortSignal,
): void {
  const { x, y, width, height, styles } = patch, count = width * height;
  for (let row = 0; row < height; row++) {
    if ((row & 31) === 0) signal?.throwIfAborted();
    for (let column = 0; column < width; column++) {
      sums.fill(0);
      const sample = (row * width + column) * 4;
      for (let style = 0; style < styles.length; style++) for (let layer = 0; layer < 4; layer++) {
        const bytes = samples[layer], at = style * count * 4 + sample, byte = bytes[at + 3];
        const scale = 2 ** (byte > 127 ? byte - 256 : byte) / 255 * values[styles[style]];
        for (let channel = 0; channel < 3; channel++) sums[layer * 3 + channel] += bytes[at + channel] * scale;
      }
      const out = ((y + row) * size + x + column) * 4;
      for (let layer = 0; layer < 4; layer++) {
        let r = sums[0], g = sums[1], b = sums[2];
        if (layer > 0) {
          const ar = (sums[3] + sums[6] + sums[9]) / 3, ag = (sums[4] + sums[7] + sums[10]) / 3, ab = (sums[5] + sums[8] + sums[11]) / 3;
          r = ar ? sums[layer * 3] * (sums[0] / ar) : 0;
          g = ag ? sums[layer * 3 + 1] * (sums[1] / ag) : 0;
          b = ab ? sums[layer * 3 + 2] * (sums[2] / ab) : 0;
        }
        r = Math.max(0, Math.min(1, r / 6)); g = Math.max(0, Math.min(1, g / 6)); b = Math.max(0, Math.min(1, b / 6));
        const m = Math.ceil(Math.max(r, g, b, 1e-6) * 255) / 255, target = pixels[layer];
        target[out] = r / m * 255; target[out + 1] = g / m * 255; target[out + 2] = b / m * 255; target[out + 3] = m * 255;
      }
    }
  }
  for (const target of pixels) {
    for (let row = 0; row < height; row++) {
      const at = ((y + row) * size + x) * 4;
      target.copyWithin(at - 4, at, at + 4);
      target.copyWithin(at + width * 4, at + (width - 1) * 4, at + width * 4);
    }
    const first = (y * size + x - 1) * 4, length = (width + 2) * 4, last = first + (height - 1) * size * 4;
    target.copyWithin(first - size * 4, first, first + length);
    target.copyWithin(last + size * 4, last, last + length);
  }
}
