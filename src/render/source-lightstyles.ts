/** Source's 10 Hz light styles, from noclip.website Common/IdTech2/WorldLightingState.ts.
 * Copyright (c) 2018 Jasper St. Pierre, MIT; see LICENSE.noclip. */
import * as THREE from 'three';

import type { MapSource } from '../maps/source';
import { paintSourceDirectionalStylePatch } from './source-lightstyle-texels';

import { parseSourceJson } from '../maps/raw-source-json';

import { sourceLightstylePatterns, sourceLightstyleValue } from './source-lightstyle-values';



interface Patch {
  page: number; x: number; y: number; width: number; height: number; styles: number[]; samples: string;
  /** Actual texture IDs in this sidecar's owning GLTFParser, never CPU page IDs. */
  bumpPages?: [number, number, number];
  bumpSamples?: [string, string, string];
}
interface StyleData {
  size: number; pages: Record<string, string>; patches: Patch[];
  patterns: Record<string, { pattern: string | null; default: number; off: boolean }>;
}


type DecodedPatch = Omit<Patch, 'samples' | 'bumpSamples'> & {
  samples: Uint8Array; bumpSamples?: [Uint8Array, Uint8Array, Uint8Array];
  directional?: {
    pixels: [Uint8Array, Uint8Array, Uint8Array, Uint8Array];
    samples: [Uint8Array, Uint8Array, Uint8Array, Uint8Array];
    textures: [THREE.DataTexture, THREE.DataTexture, THREE.DataTexture];
  };
};

export interface SourceLightStyleOptions {
  signal?: AbortSignal;
  /** Conservative JSON, normalized metadata, decoded sample/workspace and page ownership. */
  maxBytes?: number;
  /** Worst-case per-tick sample/channel work, including replicated gutters. */
  maxWork?: number;
  maxPatches?: number;
  maxJsonNodes?: number;
  maxJsonMembers?: number;
  maxJsonDepth?: number;
}

function positive(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new RangeError(`Invalid Source lightstyle ${name} limit`);
  return value;
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('Invalid Source lightstyle metadata');
  return value as Record<string, unknown>;
}

function integer(value: unknown, minimum: number, maximum: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum || value > maximum)
    throw new RangeError('Invalid Source lightstyle integer or page binding');
  return value;
}

function keyIndex(key: string): number {
  const index = integer(Number(key), 0, Number.MAX_SAFE_INTEGER);
  if (String(index) !== key) throw new RangeError('Invalid Source lightstyle page/style key');
  return index;
}

/** Validate all bindings and lengths before allocating decoded sample buffers. */
function parseData(input: unknown, maxBytes: number, maxWork: number, maxPatches: number, metadataBytes: number, signal?: AbortSignal): { data: StyleData; patches: DecodedPatch[] } {
  const source = record(input), size = integer(source.size, 4, 16384), pages: Record<string, string> = Object.create(null);
  const pageBytes = size * size * 4;
  let bytes = metadataBytes, work = 0;
  const charge = (amount: number) => {
    if (!Number.isSafeInteger(amount) || amount > maxBytes - bytes) throw new RangeError('Source lightstyle decoded byte limit exceeded');
    bytes += amount;
  };
  charge(512);
  const pageFiles = record(source.pages);
  for (const key in pageFiles) {
    if (!Object.hasOwn(pageFiles, key)) continue;
    signal?.throwIfAborted(); keyIndex(key);
    const file = pageFiles[key];
    if (typeof file !== 'string' || !file.length) throw new TypeError('Invalid Source lightstyle atlas file');
    charge(pageBytes + 256 + key.length * 2); pages[key] = file;
  }
  const patterns: StyleData['patterns'] = Object.create(null);
  const patternValues = record(source.patterns);
  for (const key in patternValues) {
    if (!Object.hasOwn(patternValues, key)) continue;
    integer(keyIndex(key), 0, 255);
    charge(256 + key.length * 2);
    const p = record(patternValues[key]);
    if ((p.pattern !== null && (typeof p.pattern !== 'string' || (p.pattern !== '' && !/^[a-z]+$/.test(p.pattern)))) || typeof p.off !== 'boolean')
      throw new TypeError('Invalid Source lightstyle pattern');
    patterns[key] = { pattern: p.pattern as string | null, default: integer(p.default, -1, 255), off: p.off };
  }
  if (!Array.isArray(source.patches) || source.patches.length > maxPatches) throw new RangeError('Source lightstyle patch limit exceeded');
  const patches: Patch[] = [], bindings = new Map<number, string>(), owners = new Map<number, number>();
  const sampleString = (value: unknown, length: number): string => {
    if (typeof value !== 'string' || value.length !== Math.ceil(length / 3) * 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)
      || (length % 3 === 1 && !value.endsWith('==')) || (length % 3 === 2 && (!value.endsWith('=') || value.endsWith('==')))
      || (length % 3 === 0 && value.endsWith('=')))
      throw new RangeError('Source lightstyle sample length or base64 mismatch');
    charge(length * 3 + 128); return value;
  };
  for (const value of source.patches) {
    signal?.throwIfAborted();
    const p = record(value), page = integer(p.page, 0, Number.MAX_SAFE_INTEGER);
    const width = integer(p.width, 1, size - 2), height = integer(p.height, 1, size - 2);
    const x = integer(p.x, 1, size - width - 1), y = integer(p.y, 1, size - height - 1);
    if (!Array.isArray(p.styles) || !p.styles.length || p.styles.length > 4) throw new RangeError('Invalid Source lightstyle styles');
    // Own both normalized patch records, arrays, decoded views and binding entries.
    charge(1024 + p.styles.length * 32);
    const styles = p.styles.map(style => integer(style, 0, 254));
    if (new Set(styles).size !== styles.length) throw new RangeError('Duplicate Source lightstyle styles');
    const count = width * height * styles.length * 4, patch: Patch = { page, x, y, width, height, styles, samples: sampleString(p.samples, count) };
    if ((p.bumpPages === undefined) !== (p.bumpSamples === undefined)) throw new TypeError('Source lightstyle directional fields must be paired');
    if (p.bumpPages !== undefined) {
      if (!Array.isArray(p.bumpPages) || p.bumpPages.length !== 3 || !Array.isArray(p.bumpSamples) || p.bumpSamples.length !== 3)
        throw new TypeError('Invalid Source lightstyle directional triples');
      charge(256);
      patch.bumpPages = [integer(p.bumpPages[0], 0, Number.MAX_SAFE_INTEGER), integer(p.bumpPages[1], 0, Number.MAX_SAFE_INTEGER), integer(p.bumpPages[2], 0, Number.MAX_SAFE_INTEGER)];
      patch.bumpSamples = [sampleString(p.bumpSamples[0], count), sampleString(p.bumpSamples[1], count), sampleString(p.bumpSamples[2], count)];
    }
    const allPages = [page, ...(patch.bumpPages ?? [])], signature = allPages.join(',');
    if (new Set(allPages).size !== allPages.length) throw new RangeError('Aliased Source lightstyle page bindings');
    if (patch.bumpPages) {
      if (bindings.has(page) && bindings.get(page) !== signature) throw new RangeError('Conflicting Source lightstyle page bindings');
      bindings.set(page, signature);
    }
    for (const id of allPages) {
      if (!(String(id) in pages)) throw new RangeError('Source lightstyle patch has no page binding');
      if (owners.has(id) && owners.get(id) !== page) throw new RangeError('Conflicting Source lightstyle page ownership');
      owners.set(id, page);
    }
    const patchWork = patch.bumpPages
      ? (width * height * styles.length * 4 + (width + 2) * (height + 2)) * 4
      : (width + 2) * (height + 2) * styles.length * 4;
    if (patchWork > maxWork - work) throw new RangeError('Source lightstyle update work limit exceeded');
    work += patchWork; patches.push(patch);
  }
  const decode = (sample: string) => Uint8Array.from(atob(sample), c => c.charCodeAt(0));
  charge(96 + patches.length * 8);
  const decoded = patches.map(p => {
    signal?.throwIfAborted();
    return { ...p, samples: decode(p.samples), bumpSamples: p.bumpSamples && [decode(p.bumpSamples[0]), decode(p.bumpSamples[1]), decode(p.bumpSamples[2])] as [Uint8Array, Uint8Array, Uint8Array] | undefined };
  });
  for (const p of decoded) {
    const count = p.width * p.height * p.styles.length * 4;
    if (p.samples.length !== count || p.bumpSamples?.some(s => s.length !== count)) throw new RangeError('Source lightstyle decoded sample length mismatch');
  }
  return { data: { size, pages, patches, patterns }, patches: decoded };
}

/** MapSource has no read signal: stop awaiting headers promptly, but retain a
 * rejection handler and cancel any response body that arrives after ownership
 * ended. This does not claim to cancel the underlying request before headers. */
function readStyleResponse(source: MapSource, file: string, signal?: AbortSignal): Promise<Response> {
  signal?.throwIfAborted();
  if (!signal) return source.read(file);
  return new Promise<Response>((resolve, reject) => {
    let aborted = false;
    const abort = () => {
      aborted = true;
      signal.removeEventListener('abort', abort);
      reject(signal.reason ?? new DOMException('Source lightstyle read aborted', 'AbortError'));
    };
    signal.addEventListener('abort', abort, { once: true });
    source.read(file).then(response => {
      signal.removeEventListener('abort', abort);
      if (aborted || signal.aborted) {
        if (!aborted) abort();
        void response.body?.cancel(signal.reason).catch(() => {});
        return;
      }
      resolve(response);
    }, error => {
      signal.removeEventListener('abort', abort);
      reject(error);
    });
  });
}

async function boundedBytes(stream: ReadableStream<Uint8Array> | null, maximum: number, signal?: AbortSignal): Promise<Uint8Array<ArrayBuffer>> {
  if (!stream) throw new Error('Missing Source lightstyle response body');
  const reader = stream.getReader(), chunks: Uint8Array[] = [];
  let size = 0;
  const abort = () => { void reader.cancel(signal?.reason).catch(() => {}); };
  signal?.addEventListener('abort', abort, { once: true });
  try {
    signal?.throwIfAborted();
    for (;;) {
      const part = await reader.read(); signal?.throwIfAborted();
      if (part.done) break;
      if (part.value.byteLength > maximum - size) {
        await reader.cancel(); throw new RangeError('Source lightstyle response byte limit exceeded');
      }
      size += part.value.byteLength; chunks.push(part.value);
    }
    const bytes = new Uint8Array(size);
    let at = 0; for (const chunk of chunks) { bytes.set(chunk, at); at += chunk.length; }
    return bytes;
  } finally {
    signal?.removeEventListener('abort', abort);
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
export class SourceLightStyles {
  readonly textures = new Map<number, THREE.DataTexture>();
  /** Flat and directional pages are disjoint roles (validated in parseData). */
  private readonly roles = new Map<number, 'flat' | 'bump'>();
  private patterns: string[];
  private values = new Float32Array(256).fill(1);
  
  
private changed = new Uint8Array(256);

private sums = new Float32Array(12);
private lastTick = -1;
  private started = performance.now();

  private constructor(private data: StyleData, private patches: DecodedPatch[], private signal?: AbortSignal) {
    this.patterns = sourceLightstylePatterns(data.patterns);
    for (const patch of patches) {
      this.roles.set(patch.page, 'flat');
      for (const page of patch.bumpPages ?? []) this.roles.set(page, 'bump');
    }
  }

  /** Live atlas for a lightmap texture ID of the owning world GLTFParser, only
   * when a patch actually binds that ID in the same role. Stock atlases are the
   * world GLB's first textures (page ordinal = texture ID); generated sidecars
   * store texture IDs directly. Anything else stays the parser's own texture. */
  lightmap(index: number, role: 'flat' | 'bump'): THREE.DataTexture | undefined {
    return this.roles.get(index) === role ? this.textures.get(index) : undefined;
  }

  static async load(source: MapSource, options: SourceLightStyleOptions = {}): Promise<SourceLightStyles | null> {
    options.signal?.throwIfAborted();
    if (!source.has('lightstyles.json')) return null;
    const maxBytes = positive(options.maxBytes ?? 256 * 1024 * 1024, 'byte');
    const maxWork = positive(options.maxWork ?? 200_000_000, 'work');
    const maxPatches = positive(options.maxPatches ?? 2_000_000, 'patch');
    const r = await readStyleResponse(source, 'lightstyles.json', options.signal);
    if (!r.ok || !r.headers.get('content-type')?.includes('json')) {
      await r.body?.cancel(); options.signal?.throwIfAborted(); return null;
    }
    const metadata = await boundedBytes(r.body, maxBytes, options.signal);
    const json = parseSourceJson(metadata, { maxBytes, maxAllocationBytes: maxBytes, signal: options.signal,
      maxNodes: options.maxJsonNodes, maxMembers: options.maxJsonMembers, maxDepth: options.maxJsonDepth });
    const parsed = parseData(json.value, maxBytes, maxWork, maxPatches, json.ownershipBytes, options.signal);
    const result = new SourceLightStyles(parsed.data, parsed.patches, options.signal);
    try {
      // Sequential ownership keeps temporary compressed/inflated bodies bounded by one page.
      for (const [page, file] of Object.entries(result.data.pages)) {
        const response = await readStyleResponse(source, file, options.signal);
        if (!response.ok) {
          await response.body?.cancel(); options.signal?.throwIfAborted();
          throw new Error(`Source lightstyle atlas failed: ${file}`);
        }
        const expected = result.data.size ** 2 * 4;
        let bytes = await boundedBytes(response.body, Math.min(maxBytes, expected + 65536), options.signal);
        // Servers may already have decompressed a Content-Encoding:gzip response.
        if (bytes[0] === 0x1f && bytes[1] === 0x8b) {
          bytes = await boundedBytes(new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip')), expected, options.signal);
        }
        if (bytes.length !== expected) throw new Error(`Invalid lightstyle atlas: ${file}`);
        const texture = new THREE.DataTexture(bytes, result.data.size, result.data.size);
        texture.magFilter = texture.minFilter = THREE.LinearFilter;
        texture.needsUpdate = true;
        result.textures.set(Number(page), texture);
      }
      for (const patch of result.patches) if (patch.bumpPages && patch.bumpSamples) {
        const b = patch.bumpPages, s = patch.bumpSamples;
        const flat = result.textures.get(patch.page)!, t1 = result.textures.get(b[0])!, t2 = result.textures.get(b[1])!, t3 = result.textures.get(b[2])!;
        patch.directional = {
          pixels: [flat.image.data as Uint8Array, t1.image.data as Uint8Array, t2.image.data as Uint8Array, t3.image.data as Uint8Array],
          samples: [patch.samples, s[0], s[1], s[2]], textures: [t1, t2, t3],
        };
      }
      result.update(0);
      return result;
    } catch (error) { for (const texture of result.textures.values()) texture.dispose(); throw error; }
  }

  value = (style: number) => this.values[style] ?? 1;

  update(seconds = (performance.now() - this.started) / 1000) {
    this.signal?.throwIfAborted();
    if (!Number.isFinite(seconds) || seconds < 0 || !Number.isSafeInteger(Math.floor(seconds * 10))) throw new RangeError('Invalid Source lightstyle time');
    const tick = Math.floor(seconds * 10);
    if (tick === this.lastTick) return;
    this.lastTick = tick;
    for (let i = 0; i < this.values.length; i++) {
      const p = this.patterns[i], previous = this.values[i];
      this.values[i] = sourceLightstyleValue(p, tick);
      this.changed[i] = Number(previous !== this.values[i]);
    }
    for (const patch of this.patches) {
      this.signal?.throwIfAborted();
      let changed = false;
      for (const style of patch.styles) if (this.changed[style]) { changed = true; break; }
      if (!changed) continue;
      const texture = this.textures.get(patch.page)!, pixels = texture.image.data as Uint8Array;
      if (patch.directional) {
        paintSourceDirectionalStylePatch(patch.directional.pixels, this.data.size, patch, patch.directional.samples, this.values, this.sums, this.signal);
        texture.needsUpdate = true;
        for (const bump of patch.directional.textures) bump.needsUpdate = true;
        continue;
      }
      // Preserve legacy flat-only double accumulation and byte quantization exactly.
      const size = this.data.size, count = patch.width * patch.height;
      for (let y = -1; y <= patch.height; y++) {
        if ((y & 31) === 0) this.signal?.throwIfAborted();
        for (let x = -1; x <= patch.width; x++) {
          const sample = (Math.max(0, Math.min(y, patch.height - 1)) * patch.width + Math.max(0, Math.min(x, patch.width - 1))) * 4;
          let r = 0, g = 0, b = 0;
          for (let i = 0; i < patch.styles.length; i++) {
            const offset = i * count * 4 + sample, byte = patch.samples[offset + 3];
            const scale = 2 ** (byte > 127 ? byte - 256 : byte) / 255 * this.value(patch.styles[i]);
            r += patch.samples[offset] * scale; g += patch.samples[offset + 1] * scale; b += patch.samples[offset + 2] * scale;
          }
          r = Math.max(0, Math.min(1, r / 6)); g = Math.max(0, Math.min(1, g / 6)); b = Math.max(0, Math.min(1, b / 6));
          const multiplier = Math.ceil(Math.max(r, g, b, 1e-6) * 255) / 255, offset = ((patch.y + y) * size + patch.x + x) * 4;
          pixels[offset] = Math.floor(r / multiplier * 255); pixels[offset + 1] = Math.floor(g / multiplier * 255); pixels[offset + 2] = Math.floor(b / multiplier * 255);
          pixels[offset + 3] = Math.floor(multiplier * 255);
        }
      }
      texture.needsUpdate = true;
    }
  }
}
