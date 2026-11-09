/** Compiled MuJoCo models (MJB), kept by the exact bytes they were compiled from.
 *
 * Compiling a map scene costs seconds of CPU on every load; loading the same model's MJB costs
 * a fraction of a second. An entry is found only by the SHA-256 of every compile input: the
 * MuJoCo version, the wasm binary's own digest, the scene path and each mounted file's path and
 * bytes. The body carries its own digest, so a damaged entry is a miss and is removed. Storage is
 * optional: every store failure (no IndexedDB, private mode, quota) is a miss or a skipped write. */

/** Bumped when the key or entry layout changes; older entries then never match. */
const FORMAT = 'm0clip-mjb-1';
/** Total MJB bytes kept. One map scene is about 100 MB. */
export const MODEL_CACHE_MAX_BYTES = 512 * 1024 * 1024;

export interface StoredModel { key: string; bytes: number; sha256: string; used: number }
export interface StoredModelBody { entry: StoredModel; body: Uint8Array }

export interface ModelStore {
  /** The entry and its body, if both are present. */
  read(key: string): Promise<StoredModelBody | undefined>;
  /** In one transaction: remove the keys `evict` picks from the current entries, then add this one. */
  write(entry: StoredModel, body: Uint8Array, evict: (entries: StoredModel[]) => string[]): Promise<void>;
  touch(key: string, used: number): Promise<void>;
  remove(key: string): Promise<void>;
}

async function sha256(bytes: Uint8Array | string): Promise<string> {
  const data = typeof bytes === 'string' ? new TextEncoder().encode(bytes) : bytes;
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', data as Uint8Array<ArrayBuffer>));
  let hex = '';
  for (const byte of digest) hex += byte.toString(16).padStart(2, '0');
  return hex;
}

/** Cache key of one compile: `runtime` names the MuJoCo build, `files` are every MEMFS input
 * (absolute path and bytes), including the scene. */
export async function modelCacheKey(runtime: string, scene: string,
    files: ReadonlyArray<readonly [string, Uint8Array]>): Promise<string> {
  const rows = await Promise.all(files.map(async ([path, bytes]) => [path, bytes.byteLength, await sha256(bytes)] as const));
  rows.sort((a, b) => a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0);
  return sha256(JSON.stringify([FORMAT, runtime, scene, rows]));
}

/** Least recently used entries to remove so the others plus `incoming` bytes fit `maxBytes`. */
export function lruEvictions(entries: readonly StoredModel[], key: string, incoming: number, maxBytes: number): string[] {
  const others = entries.filter(entry => entry.key !== key).sort((a, b) => a.used - b.used);
  let total = incoming + others.reduce((sum, entry) => sum + entry.bytes, 0);
  const evicted: string[] = [];
  for (const entry of others) {
    if (total <= maxBytes) break;
    evicted.push(entry.key);
    total -= entry.bytes;
  }
  return evicted;
}

export class ModelCache {
  private writes = new Set<Promise<boolean>>();
  constructor(private readonly store: ModelStore, readonly maxBytes = MODEL_CACHE_MAX_BYTES,
              private readonly now: () => number = Date.now) {}

  /** The verified MJB for `key`, or null. A body that fails its size or digest is removed. */
  async get(key: string): Promise<Uint8Array | null> {
    let found: StoredModelBody | undefined;
    try { found = await this.store.read(key); } catch { return null; }
    if (!found) return null;
    const { entry, body } = found;
    if (entry.key !== key || body.byteLength !== entry.bytes || await sha256(body) !== entry.sha256) {
      await this.remove(key);
      return null;
    }
    try { await this.store.touch(key, this.now()); } catch { /* Recency is advisory. */ }
    return body;
  }

  /** Store `body` under `key`, evicting least recently used entries to stay within `maxBytes`.
   * Runs in the background; false when the body is too large or storage refused it. */
  put(key: string, body: Uint8Array): Promise<boolean> {
    const write = (async () => {
      if (body.byteLength > this.maxBytes) return false;
      try {
        const entry: StoredModel = { key, bytes: body.byteLength, sha256: await sha256(body), used: this.now() };
        await this.store.write(entry, body, entries => lruEvictions(entries, key, body.byteLength, this.maxBytes));
        return true;
      } catch { return false; }
    })();
    this.writes.add(write);
    void write.finally(() => this.writes.delete(write));
    return write;
  }

  async remove(key: string): Promise<void> {
    try { await this.store.remove(key); } catch { /* A missing or unreachable entry is already a miss. */ }
  }

  /** Resolves once every write started so far has finished. */
  async idle(): Promise<void> { await Promise.all([...this.writes]); }
}

const DB = 'm0clip-physics-models', ENTRIES = 'entries', BODIES = 'bodies';

function done(request: IDBRequest): Promise<unknown> {
  const { promise, resolve, reject } = Promise.withResolvers<unknown>();
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => reject(request.error);
  return promise;
}
/** Settles when `tx` commits. Handled up front: a request failure that aborts it rejects its own await. */
function finished(tx: IDBTransaction): Promise<void> {
  const { promise, resolve, reject } = Promise.withResolvers<void>();
  tx.oncomplete = () => resolve();
  tx.onerror = tx.onabort = () => reject(tx.error ?? new DOMException('Physics cache write aborted.', 'AbortError'));
  promise.catch(() => {});
  return promise;
}

/** Browser IndexedDB: entry rows in one store, MJB bodies in another so listing never reads bodies. */
export class IndexedDbModelStore implements ModelStore {
  private db?: Promise<IDBDatabase>;

  private open(): Promise<IDBDatabase> {
    if (this.db) return this.db;
    const { promise, resolve, reject } = Promise.withResolvers<IDBDatabase>();
    const request = indexedDB.open(DB, 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore(ENTRIES, { keyPath: 'key' });
      request.result.createObjectStore(BODIES);
    };
    request.onsuccess = () => {
      const db = request.result;
      db.onversionchange = () => { db.close(); this.db = undefined; };
      resolve(db);
    };
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new DOMException('Physics cache is blocked by another tab.', 'InvalidStateError'));
    return this.db = promise;
  }

  async read(key: string): Promise<StoredModelBody | undefined> {
    const tx = (await this.open()).transaction([ENTRIES, BODIES], 'readonly');
    const [entry, body] = await Promise.all([done(tx.objectStore(ENTRIES).get(key)), done(tx.objectStore(BODIES).get(key))]);
    return entry && body instanceof ArrayBuffer ? { entry: entry as StoredModel, body: new Uint8Array(body) } : undefined;
  }

  async write(entry: StoredModel, body: Uint8Array, evict: (entries: StoredModel[]) => string[]) {
    const tx = (await this.open()).transaction([ENTRIES, BODIES], 'readwrite'), complete = finished(tx);
    const entries = tx.objectStore(ENTRIES), bodies = tx.objectStore(BODIES);
    try {
      const evicted = evict(await done(entries.getAll()) as StoredModel[]);
      for (const key of evicted) { entries.delete(key); bodies.delete(key); }
      const exact = body.byteOffset === 0 && body.byteLength === body.buffer.byteLength ? body.buffer : body.slice().buffer;
      bodies.put(exact, entry.key);
      entries.put(entry);
    } catch (error) {
      try { tx.abort(); } catch { /* Already finished by the failed request. */ }
      throw error;
    }
    await complete;
  }

  async touch(key: string, used: number) {
    const tx = (await this.open()).transaction(ENTRIES, 'readwrite'), complete = finished(tx), entries = tx.objectStore(ENTRIES);
    const entry = await done(entries.get(key)) as StoredModel | undefined;
    if (entry) entries.put({ ...entry, used });
    await complete;
  }

  async remove(key: string) {
    const tx = (await this.open()).transaction([ENTRIES, BODIES], 'readwrite'), complete = finished(tx);
    tx.objectStore(ENTRIES).delete(key);
    tx.objectStore(BODIES).delete(key);
    await complete;
  }
}
