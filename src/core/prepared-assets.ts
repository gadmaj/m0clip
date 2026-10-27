import type { PlannedAsset } from '../loading/asset-plan';

interface PreparedBody {
  body: ArrayBuffer;
  status: number;
  statusText: string;
  headers: Headers;
}

/** HTTP identity used for retained selected bodies, including semantic queries. */
export function httpAssetKey(url: string): string | null {
  const resolved = new URL(url, globalThis.location?.href ?? 'http://localhost/');
  if (resolved.protocol !== 'http:' && resolved.protocol !== 'https:') return null;
  resolved.hash = '';
  const origin = globalThis.location?.origin ?? 'http://localhost';
  return resolved.origin === origin ? resolved.pathname + resolved.search : resolved.href;
}

/** A planning lifetime owns only bodies it explicitly prepared, not every runtime fetch. */
export class PreparedAssets {
  private bodies = new Map<string, Promise<PreparedBody>>();
  private completed = new Map<string, PlannedAsset>();
  private active = true;

  async prepare(url: string): Promise<Response> {
    const key = httpAssetKey(url);
    if (!key || !this.active) return fetch(url);
    let pending = this.bodies.get(key);
    if (!pending) {
      pending = (async () => {
        const response = await fetch(url);
        if (!response.ok) throw new Error(`Asset download: ${url} (HTTP ${response.status})`);
        const body = await response.arrayBuffer();
        if (this.active) this.completed.set(key, { url: key, bytes: body.byteLength });
        return { body, status: response.status, statusText: response.statusText, headers: response.headers };
      })();
      this.bodies.set(key, pending);
      const request = pending;
      void pending.catch(() => { if (this.bodies.get(key) === request) this.bodies.delete(key); });
    }
    const value = await pending;
    return new Response(value.body, { status: value.status, statusText: value.statusText, headers: value.headers });
  }

  async fetch(url: string): Promise<Response> {
    const key = httpAssetKey(url);
    const pending = key && this.active ? this.bodies.get(key) : undefined;
    if (!pending) return fetch(url);
    const value = await pending;
    return new Response(value.body, { status: value.status, statusText: value.statusText, headers: value.headers });
  }

  snapshot(): PlannedAsset[] { return [...this.completed.values()]; }

  clear() {
    this.active = false;
    this.bodies.clear();
    this.completed.clear();
  }
}

let prepared: PreparedAssets | undefined;

export function usePreparedAssets(assets: PreparedAssets): () => void {
  prepared = assets;
  return () => {
    if (prepared === assets) prepared = undefined;
    assets.clear();
  };
}

/** Actual consumers use the selected preflight body, never a second HTTP download. */
export function fetchAsset(url: string): Promise<Response> {
  return prepared ? prepared.fetch(url) : fetch(url);
}
