import type { PlannedAsset } from './asset-plan';
import { catalogueAssetKey } from './catalogue';
import type { TransferUpdate } from './transfers';

export interface LoadingSnapshot {
  loaded: number;
  knownTotal: number;
  active: number;
  unknown: number;
  remaining: number;
  /** Exact partition of `remaining`: bytes of entities with an open request. */
  activeBytes: number;
  /** Planned entities with no request yet (waiting on planning, cache reads or compilation). */
  queuedBytes: number;
  /** Entities whose requests ended (failed, cancelled or short) without their full payload. */
  stoppedBytes: number;
  /** Time for the open requests, from their own measured rate; null unless they hold every remaining byte. */
  etaSeconds: number | null;
  stalled: boolean;
  frozen: boolean;
  unexpected: number;
}

/** Only explicitly independent module realms split an otherwise identical HTTP entity. */
function progressEntityKey(asset: { url: string; realm?: 'map-verification' }): string {
  const url = catalogueAssetKey(asset.url);
  return asset.realm ? `${asset.realm}\u0000${url}` : url;
}

/** Unique decoded HTTP entities. Planning may be indeterminate; a frozen maximum never changes. */
export class SceneProgress {
  private generation = 0;
  private requests = new Map<string, TransferUpdate>();
  private activity = new Map<string, number>();
  private resources = new Map<string, TransferUpdate>();
  private workerRoots = new Set<string>();
  private budget: Map<string, number> | null = null;
  private maximum = 0;
  private loaded = 0;
  private mismatch = false;
  private started = 0;
  private lastByte = 0;
  /** When and at what byte count each entity's current open request was first seen; its rate is measured from there. */
  private opened = new Map<string, { at: number; loaded: number }>();

  begin(now: number): number {
    this.generation++;
    this.requests.clear();
    this.activity.clear();
    this.resources.clear();
    this.workerRoots.clear();
    this.budget = null;
    this.maximum = this.loaded = 0;
    this.mismatch = false;
    this.started = this.lastByte = now;
    this.opened.clear();
    return this.generation;
  }

  get hasCatalogueMismatch() { return this.mismatch; }

  /** Assign an owned worker's root before freeze, without inventing an HTTP read. */
  ownWorkerRoot(generation: number, value: string, now: number) {
    if (generation !== this.generation) return;
    const url = catalogueAssetKey(value);
    if (this.workerRoots.has(url)) return;
    this.workerRoots.add(url);
    const realm = 'map-verification', key = progressEntityKey({ url, realm });
    const page = this.resources.get(url);
    if (page) {
      const resource = this.resources.get(key);
      const active = (this.activity.get(key) ?? 0) + (this.activity.get(url) ?? 0);
      this.activity.set(key, active);
      this.activity.delete(url);
      this.resources.delete(url);
      const opened = this.opened.get(url);
      if (opened) { this.opened.delete(url); if (!this.opened.has(key)) this.opened.set(key, opened); }
      if (resource) {
        const loaded = Math.max(resource.loaded, page.loaded);
        const done = resource.state === 'done' || page.state === 'done';
        this.resources.set(key, { id: key, url, realm, loaded,
          total: done ? loaded : page.total ?? resource.total,
          state: done ? 'done' : active > 0 ? 'loading' : page.state });
      } else this.resources.set(key, { ...page, id: key, realm });
    }
    this.recount(now);
  }

  freeze(generation: number, assets: readonly PlannedAsset[], now: number) {
    if (generation !== this.generation) return;
    if (this.budget) throw new Error('The scene asset payload maximum is already fixed.');
    const budget = new Map<string, number>();
    for (const asset of assets) {
      if (!Number.isSafeInteger(asset.bytes) || asset.bytes < 0) throw new Error(`Invalid asset payload size: ${asset.url}`);
      const key = progressEntityKey(asset), previous = budget.get(key);
      if (previous !== undefined && previous !== asset.bytes) throw new Error(`Conflicting asset payload sizes: ${asset.url}`);
      budget.set(key, asset.bytes);
    }
    // The launch shell observes actual completed planning/module metadata. Include
    // those unique bodies, not a second read, and never guess an unfinished size.
    for (const [url, resource] of this.resources) {
      if (budget.has(url)) continue;
      if (resource.state !== 'loading') budget.set(url, resource.loaded);
      else if (resource.total !== null) budget.set(url, resource.total);
      else throw new Error(`The selected asset is still missing an exact payload size: ${url}`);
    }
    this.maximum = 0;
    for (const bytes of budget.values()) this.maximum += bytes;
    this.budget = budget;
    this.recount(now);
  }

  /** Retained planner bodies have already completed their real HTTP read. */
  prepared(generation: number, assets: readonly PlannedAsset[], now: number) {
    this.update(generation, assets.map(asset => ({ id: `prepared:${progressEntityKey(asset)}`,
      url: asset.url, realm: asset.realm, loaded: asset.bytes, total: asset.bytes, state: 'done' })), now);
  }

  update(generation: number, updates: readonly TransferUpdate[], now: number) {
    if (generation !== this.generation) return;
    for (const update of updates) {
      const url = catalogueAssetKey(update.url);
      const realm = update.realm ?? (this.workerRoots.has(url) ? 'map-verification' : undefined);
      const key = progressEntityKey({ url, realm });
      const previous = this.requests.get(update.id);
      // A late batch must not resurrect a completed, failed or cancelled request.
      if (previous && previous.state !== 'loading') continue;
      const request = { ...update, url, realm, loaded: Math.max(previous?.loaded ?? 0, update.loaded) };
      this.requests.set(update.id, request);
      const active = (this.activity.get(key) ?? 0)
        + (!previous && request.state === 'loading' ? 1 : 0)
        - (previous?.state === 'loading' && request.state !== 'loading' ? 1 : 0);
      this.activity.set(key, active);
      const resource = this.resources.get(key);
      const loaded = Math.max(resource?.loaded ?? 0, request.loaded);
      const done = resource?.state === 'done' || request.state === 'done';
      const state = done ? 'done' : active > 0 ? 'loading' : request.state;
      this.resources.set(key, { id: key, url, realm, loaded,
        total: done ? loaded : request.total ?? resource?.total ?? null, state });
      if (state !== 'loading') this.opened.delete(key);
      else if (!this.opened.has(key)) this.opened.set(key, { at: now, loaded });
    }
    this.recount(now);
  }

  private recount(now: number) {
    let loaded = 0;
    for (const [url, resource] of this.resources) {
      const bytes = this.budget?.get(url);
      // A zero-byte probe is not an asset payload. Once bytes arrive, every
      // unplanned body and every completed planned size must still match.
      if (this.budget && (bytes === undefined ? resource.loaded > 0
        : resource.loaded > bytes || resource.state === 'done' && resource.loaded !== bytes)) this.mismatch = true;
      if (this.budget && bytes === undefined) continue;
      loaded += bytes === undefined ? resource.loaded : Math.min(bytes, resource.loaded);
    }
    if (loaded > this.loaded) this.lastByte = now;
    this.loaded = loaded;
  }

  /** Live records for the optional disclosure; never iterate for collapsed detail DOM. */
  transfers(): IterableIterator<Readonly<TransferUpdate>> {
    return this.resources.values();
  }

  snapshot(now: number): LoadingSnapshot {
    let knownTotal = this.maximum, active = 0, unknown = 0, unexpected = 0;
    let activeBytes = 0, queuedBytes = 0, stoppedBytes = 0;
    const consumed = new Map<string, number>();
    for (const [url, resource] of this.resources) {
      const bytes = this.budget?.get(url);
      if (this.budget && (bytes === undefined ? resource.loaded > 0
        : resource.loaded > bytes || resource.state === 'done' && resource.loaded !== bytes)) unexpected++;
      if (resource.state === 'loading') {
        active++;
        if (resource.total === null && bytes === undefined) unknown++;
      }
      // Fixed plan: only planned entities, clamped exactly as recount() counts them.
      if (this.budget && bytes === undefined) continue;
      const size = bytes ?? Math.max(resource.total ?? 0, resource.loaded);
      const loaded = Math.min(size, resource.loaded);
      consumed.set(url, loaded);
      if (!this.budget) knownTotal += size;
      if (resource.state === 'loading') activeBytes += size - loaded;
      else stoppedBytes += size - loaded;
    }
    if (this.budget) for (const [url, bytes] of this.budget) if (!this.resources.has(url)) queuedBytes += bytes;

    const remaining = Math.max(0, knownTotal - this.loaded);
    const stalled = activeBytes > 0 && now - this.lastByte >= 3_500;
    // Rate of the requests open now, each over its own lifetime: a finished cache read,
    // a completed file or a request that started later cannot skew the estimate.
    let rate = 0, measured = true;
    for (const [url, loaded] of consumed) {
      if (this.resources.get(url)!.state !== 'loading') continue;
      const start = this.opened.get(url);
      if (!start || now - start.at < 1_000) { measured = false; break; }
      rate += Math.max(0, loaded - start.loaded) / ((now - start.at) / 1_000);
    }
    // Queued or stopped bytes have no transfer whose completion can be estimated.
    const etaSeconds = this.budget && activeBytes > 0 && activeBytes === remaining
      && !stalled && now - this.started >= 1_500 && measured && rate > 0
      ? activeBytes / rate : null;
    return { loaded: this.loaded, knownTotal, active, unknown, remaining, activeBytes, queuedBytes, stoppedBytes,
      etaSeconds, stalled, frozen: this.budget !== null, unexpected };
  }
}

/** ETA row for an unfinished, unfailed load. Only bytes in open requests are ever timed. */
export function downloadEstimate(snapshot: LoadingSnapshot): string {
  if (!snapshot.frozen) return 'Planning downloads…';
  if (snapshot.remaining === 0) return 'Download complete';
  if (snapshot.etaSeconds !== null) return `Download ETA ~${downloadTime(snapshot.etaSeconds)}`;
  if (snapshot.activeBytes > 0) {
    if (snapshot.stalled) return 'Waiting for data…';
    if (snapshot.queuedBytes > 0) return 'Downloading · more queued';
    if (snapshot.stoppedBytes > 0) return 'Downloading · some stopped';
    return 'Measuring speed…';
  }
  return snapshot.queuedBytes > 0 ? 'Download queued' : 'Download stopped';
}

/** Short primary label for a detailed loading message; the full message belongs in Details. */
const PHASES: ReadonlyArray<readonly [RegExp, string]> = [
  // The worker's lowercase "loading <policy name>…" may contain any word, so it goes first.
  [/^loading |polic/, 'Loading policy…'],
  [/verif/i, 'Verifying map…'],
  [/^starting/i, 'Starting scene…'],
  [/compil/i, 'Compiling physics…'],
  [/plan/i, 'Planning scene…'],
  [/visual/i, 'Preparing visuals…'],
  [/physics/i, 'Preparing physics…'],
];
export function loadingPhase(message: string): string {
  for (const [pattern, label] of PHASES) if (pattern.test(message)) return label;
  return 'Loading scene…';
}

export function downloadTime(seconds: number): string {
  const rounded = Math.max(1, Math.ceil(seconds));
  if (rounded < 60) return `${rounded}s`;
  if (rounded < 3_600) return `${Math.floor(rounded / 60)}m ${rounded % 60}s`;
  const minutes = Math.ceil(rounded / 60);
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}
