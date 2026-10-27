import type { GoldSrcSource } from '../render/characters/goldsrc';
import type { PlannedAsset } from '../loading/asset-plan';

export type PmodelGame = 'hl' | 'sc';
export interface PmodelRef { game: PmodelGame; name: string }
export type PmodelId = `pmodels:${PmodelGame}:${string}`;
export interface PmodelRecord extends PmodelRef {
  id: PmodelId;
  thumbnail: string;
  source: string;
}
export interface PmodelSearchOptions {
  game?: PmodelGame | 'all';
  offset?: number;
  limit?: number;
  signal?: AbortSignal;
}
export interface PmodelSearchResult {
  results: PmodelRecord[];
  total: number;
  offset: number;
  limit: number;
}

// Upstream API: https://github.com/wootguy/pmodels#api-to-download-models
// modeldb.js hashes UTF-16 code units, reducing modulo 15485863 EACH step,
// then selects one of 32 https://wootdata.github.io/{hl|sc}models_data_N/
// Preview images are generated {name}_small.png files; original BMPs are optional.
// Only the two small names indexes are cached here, never a model database.
const INDEX_ROOT = 'https://wootguy.github.io/pmodels/database/';
const LOCAL_ROOT = '/assets/characters/picardia-v1sc/';
const GAMES: readonly PmodelGame[] = ['hl', 'sc'];
const MAX_PAGE = 40;
// Observed indexes: 223176 / 147569 B; Picardia: 1745672 B. Leave room for
// larger selected models while bounding streamed bodies even without a length.
const MAX_INDEX_BYTES = 2 * 1024 * 1024;
const MAX_MODEL_BYTES = 64 * 1024 * 1024;
const MAX_METADATA_BYTES = 4 * 1024 * 1024;
const MAX_README_BYTES = 1024 * 1024;

function validRef(value: PmodelRef): boolean {
  if (!value || (value.game !== 'hl' && value.game !== 'sc') || typeof value.name !== 'string') return false;
  const name = value.name;
  if (!name || name === '.' || name === '..' || /[\/\\\u0000-\u001f\u007f-\u009f]/u.test(name)) return false;
  // encodeURIComponent rejects unpaired surrogates; keep all valid Unicode,
  // punctuation and spaces rather than guessing an ASCII filename alphabet.
  try { encodeURIComponent(name); return true; } catch { return false; }
}

export function pmodelId(ref: PmodelRef): PmodelId {
  if (!validRef(ref)) throw new Error('Invalid Source model name or game.');
  return `pmodels:${ref.game}:${encodeURIComponent(ref.name)}`;
}

/** Strict canonical IDs only: malformed, double-decoded and traversing paths fail. */
export function decodePmodelId(value: unknown): PmodelRef | null {
  if (typeof value !== 'string') return null;
  const match = /^pmodels:(hl|sc):(.+)$/u.exec(value);
  if (!match) return null;
  try {
    const ref: PmodelRef = { game: match[1] as PmodelGame, name: decodeURIComponent(match[2]) };
    return validRef(ref) && pmodelId(ref) === value ? ref : null;
  } catch { return null; }
}

function isLocal(ref: PmodelRef): boolean {
  return ref.game === 'hl' && ref.name === 'picardia_v1sc';
}

function modelRoot(ref: PmodelRef): string {
  if (isLocal(ref)) return LOCAL_ROOT;
  let hash = 0;
  for (let i = 0; i < ref.name.length; i++) {
    hash = (((hash << 5) - hash) + ref.name.charCodeAt(i)) % 15485863;
  }
  return `https://wootdata.github.io/${ref.game}models_data_${hash % 32}/models/player/${encodeURIComponent(ref.name)}/`;
}

/** Metadata for a saved selection, without any index or asset request. */
export function pmodelRecord(ref: PmodelRef): PmodelRecord {
  const id = pmodelId(ref);
  const base = `${modelRoot(ref)}${encodeURIComponent(ref.name)}`;
  return { id, game: ref.game, name: ref.name, thumbnail: isLocal(ref) ? `${LOCAL_ROOT}preview.min.png` : `${base}_small.png`, source: `${base}${isLocal(ref) ? '.txt' : '.json'}` };
}

function abortError(signal?: AbortSignal): unknown {
  return signal?.reason ?? new DOMException('Source model request cancelled.', 'AbortError');
}

function checkAbort(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortError(signal);
}

/** CORS fetches preserve an isolated document; do not substitute opaque no-cors. */
async function fetchBytes(url: string, maxBytes: number, signal?: AbortSignal, optional = false): Promise<ArrayBuffer | null> {
  checkAbort(signal);
  const response = await fetch(url, { signal, mode: 'cors', credentials: 'omit' });
  if (!response.ok) {
    try { await response.body?.cancel(); } catch { /* Preserve the HTTP status. */ }
    if (optional && response.status === 404) return null;
    throw new Error(`Source model request failed (${response.status}): ${url}`);
  }
  const length = Number(response.headers.get('content-length'));
  if (Number.isFinite(length) && length > maxBytes) {
    try { await response.body?.cancel(); } catch { /* Preserve the size error. */ }
    throw new Error(`Source model response exceeds ${maxBytes} bytes: ${url}`);
  }
  if (!response.body) throw new Error(`Source model response is empty: ${url}`);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      checkAbort(signal);
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) throw new Error(`Source model response exceeds ${maxBytes} bytes: ${url}`);
      chunks.push(value);
    }
    checkAbort(signal);
  } catch (error) {
    try { await reader.cancel(); } catch { /* Preserve the original fetch/abort error. */ }
    throw error;
  } finally { reader.releaseLock(); }
  if (chunks.length === 1) {
    const chunk = chunks[0];
    if (chunk.byteOffset === 0 && chunk.byteLength === chunk.buffer.byteLength && chunk.buffer instanceof ArrayBuffer) return chunk.buffer;
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return bytes.buffer;
}

interface IndexedName { name: string; match: string }
interface IndexLoad {
  controller: AbortController;
  promise: Promise<readonly IndexedName[]>;
  users: number;
  settled: boolean;
}
const indexes = new Map<PmodelGame, readonly IndexedName[]>();
const loading = new Map<PmodelGame, IndexLoad>();

async function readIndex(game: PmodelGame, signal: AbortSignal): Promise<readonly IndexedName[]> {
  const bytes = await fetchBytes(`${INDEX_ROOT}${game}/model_names.txt`, MAX_INDEX_BYTES, signal);
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes!);
  const names: IndexedName[] = [];
  const seen = new Set<string>();
  for (const name of text.split(/\r?\n/u)) {
    if (!name) continue;
    if (!validRef({ game, name })) throw new Error(`The ${game.toUpperCase()} Source model index contains an unsafe filename.`);
    if (seen.has(name)) continue;
    seen.add(name);
    names.push({ name, match: name.normalize('NFKC').toLowerCase() });
  }
  if (!names.length) throw new Error(`The ${game.toUpperCase()} Source model index is empty.`);
  return names;
}

function getIndex(game: PmodelGame, signal?: AbortSignal): Promise<readonly IndexedName[]> {
  checkAbort(signal);
  const cached = indexes.get(game);
  if (cached) return Promise.resolve(cached);
  let entry = loading.get(game);
  if (!entry) {
    const controller = new AbortController();
    entry = { controller, users: 0, settled: false, promise: undefined! };
    const current = entry;
    current.promise = readIndex(game, controller.signal).then(names => {
      if (!controller.signal.aborted) indexes.set(game, names);
      return names;
    }).finally(() => {
      current.settled = true;
      if (loading.get(game) === current) loading.delete(game);
    });
    loading.set(game, current);
  }
  const current = entry;
  current.users++;
  // A cancelled gallery request cannot poison a concurrent search. Abort the
  // shared HTTP request only when its last reader leaves, then allow a fresh one.
  return new Promise((resolve, reject) => {
    let finished = false;
    const finish = () => {
      if (finished) return false;
      finished = true;
      signal?.removeEventListener('abort', onAbort);
      current.users--;
      if (!current.users && !current.settled) {
        if (loading.get(game) === current) loading.delete(game);
        current.controller.abort();
      }
      return true;
    };
    const onAbort = () => { if (finish()) reject(abortError(signal)); };
    signal?.addEventListener('abort', onAbort, { once: true });
    current.promise.then(names => { if (finish()) resolve(names); }, error => { if (finish()) reject(error); });
    if (signal?.aborted) onAbort();
  });
}

/** Explicit search is the ONLY trigger for loading the small HL/SC names indexes. */
export async function searchPmodels(query: string, options: PmodelSearchOptions = {}): Promise<PmodelSearchResult> {
  checkAbort(options.signal);
  const game = options.game ?? 'all';
  if (game !== 'all' && game !== 'hl' && game !== 'sc') throw new Error('Unknown Source model game.');
  const offset = Number.isFinite(options.offset) ? Math.max(0, Math.floor(options.offset!)) : 0;
  const limit = Number.isFinite(options.limit) ? Math.max(1, Math.min(MAX_PAGE, Math.floor(options.limit!))) : MAX_PAGE;
  const games = game === 'all' ? GAMES : [game];
  const lists = await Promise.all(games.map(id => getIndex(id, options.signal)));
  checkAbort(options.signal);
  const words = query.normalize('NFKC').toLowerCase().trim().split(/\s+/u).filter(Boolean);
  const results: PmodelRecord[] = [];
  let total = 0;
  for (let i = 0; i < lists.length; i++) {
    for (const entry of lists[i]) {
      if (!words.every(word => entry.match.includes(word))) continue;
      if (total >= offset && results.length < limit) results.push(pmodelRecord({ game: games[i], name: entry.name }));
      total++;
    }
  }
  return { results, total, offset, limit };
}

/** Load one deliberate selection; dependencies are fetched only when the parser requests them. */
export async function loadPmodel(ref: PmodelRef, signal?: AbortSignal, onAsset?: (asset: PlannedAsset) => void): Promise<GoldSrcSource> {
  const record = pmodelRecord(ref);
  checkAbort(signal);
  const root = modelRoot(record);
  const base = `${root}${encodeURIComponent(record.name)}`;
  const read = async (url: string, maxBytes: number, optional = false) => {
    const bytes = await fetchBytes(url, maxBytes, signal, optional);
    if (bytes) onAsset?.({ url, bytes: bytes.byteLength });
    return bytes;
  };
  const modelBytes = (await read(`${base}.mdl`, MAX_MODEL_BYTES))!;
  // Keep original authorship/readmes, not a database-wide license assertion.
  // Missing JSON is allowed by the upstream API; other failed responses remain
  // visible. Never consult another model, an index, sounds or an animation pack.
  let readme: string | undefined;
  if (isLocal(record)) {
    readme = new TextDecoder().decode((await read(`${base}.txt`, MAX_README_BYTES))!);
  } else {
    const bytes = await read(`${base}.json`, MAX_METADATA_BYTES, true);
    if (bytes) {
      const metadata: unknown = JSON.parse(new TextDecoder().decode(bytes));
      if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) throw new Error(`Invalid Source model metadata: ${base}.json`);
      if ('readme' in metadata && metadata.readme === true) {
        readme = new TextDecoder().decode((await read(`${base}.txt`, MAX_README_BYTES))!);
      }
    }
  }
  checkAbort(signal);
  // Capture immutable identity: caller mutation must not redirect dependencies.
  const name = record.name;
  const dependencyPrefix = name.toLowerCase();
  const dependencies = new Map<string, Promise<ArrayBuffer>>();
  return {
    name,
    model: modelBytes,
    source: record.source,
    thumbnail: record.thumbnail,
    readme,
    loadDependency(filename: string): Promise<ArrayBuffer> {
      checkAbort(signal);
      if (typeof filename !== 'string' || !validRef({ game: record.game, name: filename })) throw new Error('Unsafe Source model dependency filename.');
      const lower = filename.toLowerCase();
      const suffix = lower.slice(dependencyPrefix.length);
      if (!lower.startsWith(dependencyPrefix) || !/^(?:t|\d{2})\.mdl$/u.test(suffix) || suffix === '00.mdl') {
        throw new Error(`Unrelated Source model dependency: ${filename}`);
      }
      // Upstream names use lower-case t/.mdl; some compiled headers use T/.MDL.
      const canonical = `${name}${suffix}`;
      let pending = dependencies.get(canonical);
      if (!pending) {
        pending = read(`${root}${encodeURIComponent(canonical)}`, MAX_MODEL_BYTES).then(bytes => bytes!)
          .catch(error => { dependencies.delete(canonical); throw error; });
        dependencies.set(canonical, pending);
      }
      return pending;
    },
  };
}
