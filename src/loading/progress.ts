import type { PlannedAsset } from './asset-plan';
import { catalogueAssetKey } from './catalogue';
import type { TransferUpdate } from './transfers';

export interface LoadingSnapshot {
  loaded: number;
  knownTotal: number;
  active: number;
  unknown: number;
  remaining: number;
  etaSeconds: number | null;
  stalled: boolean;
  frozen: boolean;
  unexpected: number;
}

/** Unique decoded HTTP entities. Planning may be indeterminate; a frozen maximum never changes. */
export class SceneProgress {
  private generation = 0;
  private requests = new Map<string, TransferUpdate>();
  private activity = new Map<string, number>();
  private resources = new Map<string, TransferUpdate>();
  private budget: Map<string, number> | null = null;
  private maximum = 0;
  private loaded = 0;
  private mismatch = false;
  private started = 0;
  private lastByte = 0;
  private samples: Array<{ at: number; bytes: number }> = [];

  begin(now: number): number {
    this.generation++;
    this.requests.clear();
    this.activity.clear();
    this.resources.clear();
    this.budget = null;
    this.maximum = this.loaded = 0;
    this.mismatch = false;
    this.started = this.lastByte = now;
    this.samples = [{ at: now, bytes: 0 }];
    return this.generation;
  }

  get hasCatalogueMismatch() { return this.mismatch; }

  freeze(generation: number, assets: readonly PlannedAsset[], now: number) {
    if (generation !== this.generation) return;
    if (this.budget) throw new Error('The scene asset payload maximum is already fixed.');
    const budget = new Map<string, number>();
    for (const asset of assets) {
      if (!Number.isSafeInteger(asset.bytes) || asset.bytes < 0) throw new Error(`Invalid asset payload size: ${asset.url}`);
      const url = catalogueAssetKey(asset.url), previous = budget.get(url);
      if (previous !== undefined && previous !== asset.bytes) throw new Error(`Conflicting asset payload sizes: ${url}`);
      budget.set(url, asset.bytes);
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
    this.update(generation, assets.map(asset => ({ id: `prepared:${catalogueAssetKey(asset.url)}`,
      url: asset.url, loaded: asset.bytes, total: asset.bytes, state: 'done' })), now);
  }

  update(generation: number, updates: readonly TransferUpdate[], now: number) {
    if (generation !== this.generation) return;
    for (const update of updates) {
      const previous = this.requests.get(update.id);
      // A late batch must not resurrect a completed, failed or cancelled request.
      if (previous && previous.state !== 'loading') continue;
      const url = catalogueAssetKey(update.url);
      const request = { ...update, url, loaded: Math.max(previous?.loaded ?? 0, update.loaded) };
      this.requests.set(update.id, request);
      const active = (this.activity.get(url) ?? 0)
        + (!previous && request.state === 'loading' ? 1 : 0)
        - (previous?.state === 'loading' && request.state !== 'loading' ? 1 : 0);
      this.activity.set(url, active);
      const resource = this.resources.get(url);
      const loaded = Math.max(resource?.loaded ?? 0, request.loaded);
      const done = resource?.state === 'done' || request.state === 'done';
      this.resources.set(url, { id: url, url, loaded,
        total: done ? loaded : request.total ?? resource?.total ?? null,
        state: done ? 'done' : active > 0 ? 'loading' : request.state });
    }
    this.recount(now);
  }

  private recount(now: number) {
    let loaded = 0;
    for (const [url, resource] of this.resources) {
      const bytes = this.budget?.get(url);
      if (this.budget && (bytes === undefined || resource.loaded > bytes
        || resource.state === 'done' && resource.loaded !== bytes)) this.mismatch = true;
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
    const last = this.samples[this.samples.length - 1];
    if (last.at === now) last.bytes = this.loaded;
    else this.samples.push({ at: now, bytes: this.loaded });
    const cutoff = now - 5_000;
    while (this.samples.length > 1 && this.samples[1].at <= cutoff) this.samples.shift();

    let knownTotal = this.maximum, active = 0, unknown = 0, unexpected = 0;
    for (const [url, resource] of this.resources) {
      const bytes = this.budget?.get(url);
      if (this.budget && (bytes === undefined || resource.loaded > bytes
        || resource.state === 'done' && resource.loaded !== bytes)) unexpected++;
      if (resource.state === 'loading') {
        active++;
        if (resource.total === null && bytes === undefined) unknown++;
      }
      if (!this.budget) knownTotal += Math.max(resource.total ?? 0, resource.loaded);
    }
    const remaining = Math.max(0, knownTotal - this.loaded);
    const stalled = active > 0 && remaining > 0 && now - this.lastByte >= 3_500;
    const first = this.samples[0], elapsed = now - first.at;
    const bytes = this.loaded - first.bytes;
    const etaSeconds = this.budget && active > 0 && remaining > 0
      && !stalled && now - this.started >= 1_500 && elapsed >= 1_000 && bytes > 0
      ? remaining / (bytes / (elapsed / 1_000)) : null;
    return { loaded: this.loaded, knownTotal, active, unknown, remaining, etaSeconds, stalled,
      frozen: this.budget !== null, unexpected };
  }
}

export function downloadTime(seconds: number): string {
  const rounded = Math.max(1, Math.ceil(seconds));
  if (rounded < 60) return `${rounded}s`;
  if (rounded < 3_600) return `${Math.floor(rounded / 60)}m ${rounded % 60}s`;
  const minutes = Math.ceil(rounded / 60);
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}
