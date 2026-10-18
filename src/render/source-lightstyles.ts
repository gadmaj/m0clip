/** Source's 10 Hz light styles, from noclip.website Common/IdTech2/WorldLightingState.ts.
 * Copyright (c) 2018 Jasper St. Pierre, MIT; see LICENSE.noclip. */
import * as THREE from 'three';
import { gunzipSync } from 'fflate';

const PATTERNS = [
  'm', 'mmnmmommommnonmmonqnmmo', 'abcdefghijklmnopqrstuvwxyzyxwvutsrqponmlkjihgfedcba',
  'mmmmmaaaaammmmmaaaaaabcdefgabcdefg', 'mamamamamama', 'jklmnopqrstuvwxyzyxwvutsrqponmlkj',
  'nmonqnmomnmomomno', 'mmmaaaabcdefgmmmmaaaammmaamm',
  'mmmaaammmaaammmabcdefaaaammmmabcdefmmmaaaa', 'aaaaaaaazzzzzzzz',
  'mmamammmmammamamaaamammma', 'abcdefghijklmnopqrrqponmlkjihgfedcba', 'mmnnmmnnnmmnn',
];
interface Patch {
  page: number; x: number; y: number; width: number; height: number; styles: number[]; samples: string;
}
interface StyleData {
  size: number; pages: Record<string, string>; patches: Patch[];
  patterns: Record<string, { pattern: string | null; default: number; off: boolean }>;
}

export class SourceLightStyles {
  readonly textures = new Map<number, THREE.DataTexture>();
  private patterns = Array.from({ length: 256 }, (_, i) => PATTERNS[i] ?? 'm');
  private values = new Float32Array(256).fill(1);
  private patches: (Omit<Patch, 'samples'> & { samples: Uint8Array })[];
  private lastTick = -1;
  private started = performance.now();

  private constructor(private data: StyleData) {
    for (const [style, p] of Object.entries(data.patterns)) {
      this.patterns[Number(style)] = p.off ? 'a' : p.pattern || this.patterns[p.default] || 'm';
    }
    this.patches = data.patches.map((p) => ({ ...p, samples: Uint8Array.from(atob(p.samples), (c) => c.charCodeAt(0)) }));
  }

  static async load(url: URL): Promise<SourceLightStyles | null> {
    const r = await fetch(url);
    if (!r.ok || !r.headers.get('content-type')?.includes('json')) return null;
    const result = new SourceLightStyles(await r.json() as StyleData);
    const pages=await Promise.allSettled(Object.entries(result.data.pages).map(async ([page, file]) => {
      const response = await fetch(new URL(file, url));
      if (!response.ok) throw new Error(`Source lightstyle atlas failed: ${file}`);
      const body = new Uint8Array(await response.arrayBuffer());
      // Vite serves .gz with Content-Encoding; fetch has already decompressed it in that case.
      const bytes = body[0] === 0x1f && body[1] === 0x8b ? gunzipSync(body) : body;
      if (bytes.length !== result.data.size ** 2 * 4) throw new Error(`Invalid lightstyle atlas: ${file}`);
      const texture = new THREE.DataTexture(bytes, result.data.size, result.data.size);
      texture.magFilter = texture.minFilter = THREE.LinearFilter;
      texture.needsUpdate = true;
      result.textures.set(Number(page), texture);
    }));
    const failed=pages.find((page):page is PromiseRejectedResult=>page.status==='rejected');
    if(failed){for(const texture of result.textures.values())texture.dispose();throw failed.reason;}
    result.update(0);
    return result;
  }

  value = (style: number) => this.values[style] ?? 1;

  update(seconds = (performance.now() - this.started) / 1000) {
    const tick = Math.floor(seconds * 10);
    if (tick === this.lastTick) return;
    this.lastTick = tick;
    const previous = this.values.slice();
    for (let i = 0; i < this.values.length; i++) {
      const p = this.patterns[i];
      this.values[i] = (p.charCodeAt(tick % p.length) - 97) / 12;
    }
    for (const patch of this.patches) {
      if (!patch.styles.some((s) => previous[s] !== this.values[s])) continue;
      const texture = this.textures.get(patch.page)!;
      const pixels = texture.image.data as Uint8Array;
      const size = this.data.size, count = patch.width * patch.height;
      for (let y = -1; y <= patch.height; y++) for (let x = -1; x <= patch.width; x++) {
        const sample = (Math.max(0, Math.min(y, patch.height - 1)) * patch.width
                     + Math.max(0, Math.min(x, patch.width - 1))) * 4;
        const rgb = [0, 0, 0];
        for (let i = 0; i < patch.styles.length; i++) {
          const offset = i * count * 4 + sample;
          const byte = patch.samples[offset + 3], exponent = byte > 127 ? byte - 256 : byte;
          const scale = 2 ** exponent / 255 * this.value(patch.styles[i]);
          for (let c = 0; c < 3; c++) rgb[c] += patch.samples[offset + c] * scale;
        }
        const scaled = rgb.map((v) => Math.max(0, Math.min(1, v / 6)));
        const multiplier = Math.ceil(Math.max(...scaled, 1e-6) * 255) / 255;
        const offset = ((patch.y + y) * size + patch.x + x) * 4;
        for (let c = 0; c < 3; c++) pixels[offset + c] = Math.floor(scaled[c] / multiplier * 255);
        pixels[offset + 3] = Math.floor(multiplier * 255);
      }
      texture.needsUpdate = true;
    }
  }
}
