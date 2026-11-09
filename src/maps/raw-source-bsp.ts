// Source geometry algorithms follow noclip.website e47a8cc (Copyright 2018 Jasper
// St. Pierre, MIT; see LICENSE.noclip) and this project's Python Source converter.
import { decodeValveLzma, sourceAbort } from './raw-source-lzma';
export { buildSourceWorld as decodeSourceWorld } from './raw-source-geometry';
export type { SourceWorld, SourceSurface, SourceCollision, SourceFrame, SourceHeightfield } from './raw-source-geometry';

export interface SourceLump {
  readonly index: number;
  readonly offset: number;
  readonly length: number;
  readonly version: number;
  readonly uncompressedSize: number;
  /** Original exact bytes; game lumps retain their absolute BSP offsets. */
  readonly raw: Blob;
}
export interface SourceEntity {
  /** Duplicate keys and authored ordering remain available (e.g. entity outputs). */
  readonly pairs: readonly (readonly [string, string])[];
  readonly values: Readonly<Record<string, string>>;
}
/** One reservation against an import's aggregate decoded/working ceilings. */
export interface SourceBspReservation {
  /** Success: transient working capacity returns; decoded bytes stay owned for the import. */
  complete(): void;
  /** Failure before any codec started returns everything. After a codec started,
   * both stay charged: abandoned codec arrays may still be live. Idempotent. */
  fail(codecStarted: boolean): void;
}
export interface SourceBsp {
  readonly file: Blob;
  readonly version: number;
  readonly revision: number;
  readonly variant: 'standard' | 'left4dead2';
  readonly lumps: readonly SourceLump[];
  readonly entities: readonly SourceEntity[];
  /** All 64 raw lumps remain owned; decode only requested payloads. */
  getLump(index: number, signal?: AbortSignal): Promise<Uint8Array<ArrayBuffer>>;
  /** Charge payloads and retained records derived from this BSP (game lumps,
   * static-prop placements/leaves) to the SAME aggregate ceilings as lumps, before
   * any read, decode or allocation. Throws without charging. */
  reserve(decodedBytes: number, workingBytes: number): SourceBspReservation;
}
/** Conservative JS numeric-array slot costs, not engine heap metrics: read input,
 * Valve->alone adapter copy, codec output, dictionary and probabilities. */
export function sourceLzmaWorkingBytes(readBytes: number, storedBytes: number, size: number, property: number, dictionary: number): number {
  const lc = property % 9, lp = Math.floor(property / 9) % 5;
  return readBytes + storedBytes + size * 16 + Math.max(dictionary, 4096) * 16
    + (1 << (lc + lp)) * (0x300 * 16 + 128) + 256 * 1024;
}
export interface SourceEntityOptions {
  signal?: AbortSignal;
  /** Encoded entity lump bytes (UTF-16 bytes for the standalone text parser). */
  maxEntityBytes?: number;
  /** Cumulative authored token characters, including duplicate keys/values. */
  maxStringCharacters?: number;
  maxEntities?: number;
  maxEntityPairs?: number;
  /** Logical arrays, records and dictionary slots, not engine heap measurements. */
  maxEntityObjects?: number;
}
export interface SourceBspOptions extends SourceEntityOptions {
  variant?: 'auto' | 'standard' | 'left4dead2';
  /** Per-lump decompression and dictionary allocation ceiling. */
  maxLumpBytes?: number;
  /** Aggregate retained decoded bytes and derived retained records, including in-flight reservations. */
  maxDecodedBytes?: number;
  /** Aggregate conservative transient ownership, including encoded input,
   * LZMA adapter/codec arrays and entity text. Not a JS heap measurement. */
  maxWorkingBytes?: number;
}
function limit(value: number | undefined, fallback: number, name: string): number {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result <= 0) throw new Error(`Invalid Source ${name} limit`);
  return result;
}

/** One bounded parser drives both the synchronous public text API and the
 * cooperative BSP import. Strings are sliced once, never per-character ropes. */
function* sourceEntitySteps(text: string, options: SourceEntityOptions): Generator<void, SourceEntity[]> {
  const maxCharacters = limit(options.maxStringCharacters, 32 * 1024 * 1024, 'entity string');
  const maxEntities = limit(options.maxEntities, 262144, 'entity count');
  const maxPairs = limit(options.maxEntityPairs, 2 * 1024 * 1024, 'entity pair');
  const maxObjects = limit(options.maxEntityObjects, 5 * 1024 * 1024, 'entity object');
  let cursor = 0, characters = 0, pairsUsed = 0, objects = 1, nextYield = 0;
  const reserve = (count: number) => {
    if (count > maxObjects - objects) throw new Error('Source entity object limit exceeded');
    objects += count;
  };
  const token = function* (): Generator<void, string | { brace: '{' | '}' } | undefined> {
    for (;;) {
      while (cursor < text.length && /\s/.test(text[cursor])) {
        cursor++;
        if (cursor >= nextYield) { nextYield = cursor + 4096; sourceAbort(options.signal); yield; }
      }
      if (!text.startsWith('//', cursor)) break;
      while (cursor < text.length && text[cursor] !== '\n') {
        cursor++;
        if (cursor >= nextYield) { nextYield = cursor + 4096; sourceAbort(options.signal); yield; }
      }
    }
    if (cursor === text.length || text[cursor] === '\0') return undefined;
    const c = text[cursor++];
    if (c === '{' || c === '}') return { brace: c };
    const start = c === '"' ? cursor : cursor - 1;
    let escaped = false;
    if (c === '"') {
      while (cursor < text.length && text[cursor] !== '"') {
        if (text[cursor] === '\\' && (text[cursor + 1] === '"' || text[cursor + 1] === '\\')) { escaped = true; cursor++; }
        cursor++;
        if (cursor >= nextYield) { nextYield = cursor + 4096; sourceAbort(options.signal); yield; }
      }
      if (cursor === text.length) throw new Error('Unterminated Source entity string');
    } else while (cursor < text.length && !/[\s{}\0]/.test(text[cursor])) {
      cursor++;
      if (cursor >= nextYield) { nextYield = cursor + 4096; sourceAbort(options.signal); yield; }
    }
    const length = cursor - start;
    if (length > maxCharacters - characters) throw new Error('Source entity string limit exceeded');
    characters += length;
    const value = text.slice(start, cursor);
    if (c === '"') cursor++;
    return escaped ? value.replace(/\\(["\\])/g, '$1') : value;
  };
  sourceAbort(options.signal);
  const entities: SourceEntity[] = [];
  for (;;) {
    if (cursor >= nextYield) { nextYield = cursor + 4096; sourceAbort(options.signal); yield; }
    const open = yield* token();
    if (open === undefined) return entities;
    if (typeof open !== 'object' || open.brace !== '{') throw new Error('Expected Source entity opening brace');
    if (entities.length >= maxEntities) throw new Error('Source entity count limit exceeded');
    reserve(3);
    const pairs: [string, string][] = [], values: Record<string, string> = Object.create(null);
    for (;;) {
      const key = yield* token();
      if (typeof key === 'object' && key.brace === '}') break;
      if (typeof key !== 'string') throw new Error('Malformed Source entity key');
      if (pairsUsed >= maxPairs) throw new Error('Source entity pair limit exceeded');
      pairsUsed++; reserve(2);
      const value = yield* token();
      if (typeof value !== 'string') throw new Error('Malformed Source entity value');
      pairs.push([key, value]); values[key] = value;
    }
    entities.push({ pairs, values });
  }
}
/** Valve entity KeyValues, preserving quoted escapes, comments and duplicates. */
export function parseSourceEntities(text: string, options: SourceEntityOptions = {}): SourceEntity[] {
  sourceAbort(options.signal);
  if (text.length * 2 > limit(options.maxEntityBytes, 64 * 1024 * 1024, 'entity byte')) throw new Error('Source entity byte limit exceeded');
  const steps = sourceEntitySteps(text, options);
  for (;;) { const step = steps.next(); if (step.done) return step.value; }
}

/** Record strides and accepted lump versions this importer's own decoders
 * require (raw-source-geometry/lighting/visibility). A descriptor order that
 * violates them is impossible, not an ambiguous alternative. */
const LUMP_SCHEMA: readonly (readonly [index: number, stride: number, versions: readonly number[]])[] = [
  [1, 20, [0]], [2, 32, [0]], [3, 12, [0]], [5, 32, [0]], [6, 72, [0]], [7, 56, [1]], [8, 4, [1]],
  [12, 4, [0]], [13, 4, [0]], [14, 48, [0]], [17, 2, [0]], [18, 12, [0]], [19, 8, [0]], [26, 176, [0]],
  [30, 12, [0]], [31, 2, [0]], [33, 20, [0]], [39, 2, [0]], [44, 4, [0]], [48, 2, [0]], [53, 4, [1]], [58, 56, [1]],
];
/** Mandatory bounded evidence for one structurally valid descriptor order:
 * entity descriptor, worldmodel 0, record schemas/versions and Valve LZMA
 * headers. The full bounded entity parser, not a prefix guess, validates text. */
async function variantEvidence(version: number, lumps: readonly SourceLump[], maxEntityBytes: number, signal?: AbortSignal): Promise<boolean> {
  const size = (lump: SourceLump) => lump.uncompressedSize || lump.length;
  const read = async (lump: SourceLump, bytes: number) => {
    const view = new DataView(await lump.raw.slice(0, bytes).arrayBuffer());
    sourceAbort(signal);
    return view;
  };
  const entities = lumps[0], models = lumps[14], nodes = lumps[5], leaves = lumps[10], primitives = lumps[37];
  if (!entities.length || entities.version !== 0 || size(entities) > maxEntityBytes || !models.length || !nodes.length) return false;
  for (const [index, stride, versions] of LUMP_SCHEMA) {
    const lump = lumps[index];
    if (lump.length && (!versions.includes(lump.version) || size(lump) % stride)) return false;
  }
  if (leaves.length && (leaves.version > 1 || size(leaves) % (leaves.version === 0 ? 56 : 32))) return false;
  if (primitives.length && (primitives.version !== 0 || size(primitives) % (version === 22 ? 16 : 10))) return false;
  for (const lump of lumps) if (lump.uncompressedSize) {
    const header = await read(lump, 17);
    if (header.byteLength !== 17 || header.getUint32(0, true) !== 0x414d5a4c || header.getUint32(4, true) !== lump.uncompressedSize
      || header.getUint32(8, true) !== lump.length - 17 || header.getUint8(12) >= 225) return false;
  }
  if (!models.uncompressedSize) {
    const model = await read(models, 48), faces = lumps[7].length ? lumps[7] : lumps[58];
    const bounds = Array.from({ length: 6 }, (_, i) => model.getFloat32(i * 4, true));
    const headnode = model.getInt32(36, true), firstFace = model.getInt32(40, true), faceCount = model.getInt32(44, true);
    const totalFaces = faces.length ? size(faces) / 56 : 0;
    if (bounds.some(value => !Number.isFinite(value)) || bounds[0] > bounds[3] || bounds[1] > bounds[4] || bounds[2] > bounds[5]
      || headnode < 0 || headnode >= size(nodes) / 32 || firstFace < 0 || faceCount < 0 || faceCount > totalFaces - firstFace) return false;
  }
  return true;
}

export async function readSourceBsp(file: Blob, options: SourceBspOptions = {}): Promise<SourceBsp> {
  sourceAbort(options.signal);
  if (file.size < 1036) throw new Error('Truncated VBSP header');
  const header = new DataView(await file.slice(0, 1036).arrayBuffer());
  sourceAbort(options.signal);
  if (header.getUint32(0, true) !== 0x50534256) throw new Error('Not a Source VBSP file');
  const version = header.getInt32(4, true), revision = header.getInt32(1032, true);
  if (version < 19 || version > 22) throw new Error(`Unsupported VBSP version ${version}`);
  const maximum = limit(options.maxLumpBytes, 512 * 1024 * 1024, 'lump allocation');
  const maxDecoded = limit(options.maxDecodedBytes, 512 * 1024 * 1024, 'aggregate decoded');
  const maxWorking = limit(options.maxWorkingBytes, 1024 * 1024 * 1024, 'aggregate working');
  const maxEntityBytes = limit(options.maxEntityBytes, 64 * 1024 * 1024, 'entity byte');
  const directory = (variant: 'standard' | 'left4dead2'): SourceLump[] | undefined => {
    const lumps: SourceLump[] = [];
    for (let index = 0; index < 64; index++) {
      const p = 8 + index * 16;
      const offset = header.getUint32(p + (variant === 'standard' ? 0 : 4), true);
      const length = header.getUint32(p + (variant === 'standard' ? 4 : 8), true);
      const lumpVersion = header.getUint32(p + (variant === 'standard' ? 8 : 0), true);
      const uncompressedSize = header.getUint32(p + 12, true);
      if ((length > 0 && offset < 1036) || offset > file.size || length > file.size - offset || uncompressedSize > maximum || (uncompressedSize > 0 && length < 17)) return undefined;
      lumps.push({ index, offset, length, version: lumpVersion, uncompressedSize, raw: file.slice(offset, offset + length) });
    }
    const ranges = lumps.filter(l => l.length > 0).sort((a, b) => a.offset - b.offset);
    for (let i = 1; i < ranges.length; i++) if (ranges[i].offset < ranges[i - 1].offset + ranges[i - 1].length) return undefined;
    return lumps;
  };
  const requested = options.variant ?? 'auto';
  if (requested !== 'auto' && requested !== 'standard' && requested !== 'left4dead2') throw new Error('Invalid BSP variant');
  let standard = requested !== 'left4dead2' ? directory('standard') : undefined;
  let l4d = requested !== 'standard' ? directory('left4dead2') : undefined;
  if (requested === 'auto' && standard && l4d) {
    // Both descriptor orders fit the file: only mandatory schema evidence may
    // decide, never a preferred order. Explicit selection remains available.
    const standardEvidence = await variantEvidence(version, standard, maxEntityBytes, options.signal);
    const l4dEvidence = await variantEvidence(version, l4d, maxEntityBytes, options.signal);
    if (standardEvidence === l4dEvidence) throw new Error('Unsupported BSP descriptor layout or required lump schema');
    if (standardEvidence) l4d = undefined; else standard = undefined;
  }
  const lumps = standard ?? l4d;
  if (!lumps) throw new Error('Invalid BSP lump directory bounds, overlap, or descriptor order');
  const cache = new Map<number, Uint8Array<ArrayBuffer>>();
  const pending = new Map<number, Promise<Uint8Array<ArrayBuffer>>>();
  let decodedBytes = 0, workingBytes = 0;
  const reserveWorking = (bytes: number) => {
    if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > maxWorking - workingBytes) throw new Error('Source aggregate working limit exceeded');
    workingBytes += bytes;
  };
  const reserveDerived = (decoded: number, working: number): SourceBspReservation => {
    if (!Number.isSafeInteger(decoded) || decoded < 0 || decoded > maxDecoded - decodedBytes) throw new Error('Source aggregate decoded limit exceeded');
    reserveWorking(working);
    decodedBytes += decoded;
    let settled = false;
    return {
      complete() { if (!settled) { settled = true; workingBytes -= working; } },
      fail(codecStarted) {
        if (settled) return;
        settled = true;
        if (!codecStarted) { workingBytes -= working; decodedBytes -= decoded; }
      },
    };
  };
  // Decode lifetime belongs to this import. A requester may abandon only its
  // own wait; late decode settlement remains handled and may populate cache.
  const waitForLump = (request: Promise<Uint8Array<ArrayBuffer>>, signal?: AbortSignal): Promise<Uint8Array<ArrayBuffer>> => {
    const localSignal = signal === options.signal ? undefined : signal;
    const { promise, resolve, reject } = Promise.withResolvers<Uint8Array<ArrayBuffer>>();
    const cleanup = () => {
      options.signal?.removeEventListener('abort', abort);
      localSignal?.removeEventListener('abort', abort);
    };
    const abort = () => {
      cleanup();
      const aborted = options.signal?.aborted ? options.signal : localSignal;
      reject(aborted?.reason ?? new DOMException('Source import aborted', 'AbortError'));
    };
    options.signal?.addEventListener('abort', abort, { once: true });
    localSignal?.addEventListener('abort', abort, { once: true });
    request.then(result => {
      if (options.signal?.aborted || localSignal?.aborted) abort();
      else { cleanup(); resolve(result); }
    }, error => { cleanup(); reject(error); });
    if (options.signal?.aborted || localSignal?.aborted) abort();
    return promise;
  };
  const getLump = async (index: number, signal?: AbortSignal): Promise<Uint8Array<ArrayBuffer>> => {
    sourceAbort(options.signal); sourceAbort(signal);
    if (!Number.isInteger(index) || index < 0 || index >= 64) throw new Error('Invalid BSP lump index');
    const prior = cache.get(index);
    if (prior) return prior;
    const inFlight = pending.get(index);
    if (inFlight) return waitForLump(inFlight, signal);
    const lump = lumps[index], size = lump.uncompressedSize || lump.length;
    if (lump.length > maximum || size > maximum) throw new Error(`BSP lump ${index} exceeds allocation limit`);
    if (size > maxDecoded - decodedBytes) throw new Error('Source aggregate decoded limit exceeded');
    decodedBytes += size;
    const decode = async () => {
      let working = 0, codecStarted = false, completed = false;
      const reserve = (bytes: number) => { reserveWorking(bytes); working += bytes; };
      try {
        const decodeSignal = options.signal;
        if (lump.uncompressedSize) {
          reserve(17);
          const header = new DataView(await lump.raw.slice(0, 17).arrayBuffer());
          sourceAbort(decodeSignal);
          if (header.byteLength !== 17 || header.getUint32(0, true) !== 0x414d5a4c) throw new Error('Invalid Valve LZMA header');
          if (header.getUint32(4, true) !== size || header.getUint32(8, true) !== lump.length - 17) throw new Error('Valve LZMA size mismatch or limit exceeded');
          const property = header.getUint8(12), dictionary = header.getUint32(13, true);
          if (property >= 225 || dictionary > maximum) throw new Error('Unsupported or excessive LZMA properties');
          reserve(sourceLzmaWorkingBytes(lump.length, lump.length, size, property, dictionary));
        } else reserve(lump.length);
        const bytes = new Uint8Array(await lump.raw.arrayBuffer());
        sourceAbort(decodeSignal);
        let decoded = bytes;
        if (lump.uncompressedSize) {
          codecStarted = true;
          decoded = await decodeValveLzma(bytes, size, maximum, decodeSignal);
        }
        sourceAbort(decodeSignal);
        cache.set(index, decoded); completed = true;
        return decoded;
      } finally {
        // Abort may reject before the codec's scheduled chunk exits. Failed
        // started decodes retain capacity for this import, never lending it to
        // another decoder while abandoned arrays may still be owned.
        if (completed || !codecStarted) workingBytes -= working;
        if (!completed && !codecStarted) decodedBytes -= size;
      }
    };
    const request = decode().finally(() => pending.delete(index));
    pending.set(index, request);
    return waitForLump(request, signal);
  };
  const entitySize = lumps[0].uncompressedSize || lumps[0].length;
  if (entitySize > maxEntityBytes) throw new Error('Source entity byte limit exceeded');
  const entityBytes = await getLump(0, options.signal);
  reserveWorking(entityBytes.length * 2);
  let entities: SourceEntity[];
  try {
    const steps = sourceEntitySteps(new TextDecoder().decode(entityBytes), options);
    for (;;) {
      const step = steps.next();
      if (step.done) { entities = step.value; break; }
      await new Promise<void>(resolve => setTimeout(resolve, 0));
      sourceAbort(options.signal);
    }
  } finally { workingBytes -= entityBytes.length * 2; }
  return { file, version, revision, variant: standard ? 'standard' : 'left4dead2', lumps, entities, getLump, reserve: reserveDerived };
}

export interface SourceWorldOptions {
  signal?: AbortSignal;
  /** Cumulative decoded geometry ownership, shared with later brush-model decoding. */
  maxGeometryBytes?: number;
  /** Cumulative decoded surface vertices, including later brush models. */
  maxVertices?: number;
  /** Import-wide brush-collision hull work (plane triples plus half-space tests), shared with later brush-model decoding. */
  maxBrushHullWork?: number;
  /** Default uses the existing spawn-floor probe; a map-centre fallback adds a blocking spawn-unresolved requirement. */
  spawn?: { origin: readonly [number, number, number]; yaw: number };
}
