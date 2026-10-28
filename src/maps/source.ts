import { fetchAsset } from '../core/prepared-assets';
import { mapId, MAPS_DIR, type TerrainName } from '../sim/terrain';
import type { DecodedMapBundle } from './bundle';

export interface LocalMapIdentity { id: string; fingerprint: string; name: string; game: string }
export interface LocalMapPayload extends LocalMapIdentity { files: ReadonlyMap<string, Blob> }
const localSources = new Map<string, WeakRef<MapSource>>();

/** One map root, shared by rendering, physics and sidecars. Local roots never fetch HTTP. */
export class MapSource {
  readonly identity: LocalMapIdentity | undefined;
  readonly base: string;
  private urls = new Map<string, string>();
  private users = 0;
  constructor(readonly id: string, private local?: LocalMapPayload) {
    this.identity = local && { id, fingerprint: local.fingerprint, name: local.name, game: local.game };
    this.base = local ? `m0clip-map://${local.fingerprint}/` : `${MAPS_DIR}/${id}/`;
  }
  get isLocal() { return !!this.local; }
  get payload() { return this.local; }
  retain(): () => void {
    this.users++;
    let released = false;
    return () => { if (released) return; released = true; if (--this.users === 0) { for (const url of this.urls.values()) URL.revokeObjectURL(url); this.urls.clear(); } };
  }
  path(value: string): string {
    if (value.startsWith(this.base)) value = value.slice(this.base.length);
    if (!value || value.startsWith('/') || /[\\?#\x00-\x1f]/.test(value) || /^[a-z][a-z\d+.-]*:/i.test(value)) throw new Error(`Invalid map resource: ${value}`);
    const segments = value.split('/');
    if (segments.some(segment => !segment || segment === '.' || segment === '..' || /%/.test(segment))) throw new Error(`Invalid map resource: ${value}`);
    return value;
  }
  has(path: string): boolean { return !this.local || this.local.files.has(this.path(path)); }
  httpUrl(path: string): string { if (this.local) throw new Error('Local map resources are not HTTP assets.'); return `${this.base}${this.path(path)}`; }
  async read(path: string, metadataFetch: (url: string) => Promise<Response> = fetchAsset): Promise<Response> {
    path = this.path(path);
    if (!this.local) return metadataFetch(this.httpUrl(path));
    const file = this.local.files.get(path);
    if (!file) throw new Error(`Map resource missing: ${path}. Choose a complete map bundle.`);
    return new Response(file, { headers: { 'content-type': file.type || 'application/octet-stream' } });
  }
  async json<T = Record<string,unknown>>(path: string): Promise<T> {
    const response = await this.read(path);
    if (!response.ok) throw new Error(`Map resource failed: ${path} (${response.status})`);
    return response.json() as Promise<T>;
  }
  /** Used only by this map's LoadingManager; the virtual root is never sent to a server. */
  resolveUrl = (value: string): string => {
    if (!this.local) return value;
    if(!this.users)throw new DOMException('The map resource lease has ended.','AbortError');
    // Embedded GLTF images create Blob leaves after all declared URI dependencies are validated.
    if (value.startsWith('data:') || value.startsWith('blob:')) return value;
    const relative=value.startsWith(this.base)?value.slice(this.base.length):value,segments:string[]=[];
    for(const segment of relative.split('/')){
      if(segment==='.')continue;
      if(segment==='..'){if(!segments.length)throw new Error(`Map resource escapes its root: ${relative}`);segments.pop();}
      else segments.push(segment);
    }
    const path = this.path(segments.join('/'));
    let url = this.urls.get(path);
    if (!url) {
      const file = this.local.files.get(path);
      if (!file) throw new Error(`Map resource missing: ${path}. Choose a complete map bundle.`);
      url = URL.createObjectURL(file); this.urls.set(path, url);
    }
    return url;
  };
}
export function registerLocalMap(bundle: DecodedMapBundle | LocalMapPayload): MapSource {
  const payload: LocalMapPayload = 'index' in bundle
    ? { id: bundle.id, fingerprint: bundle.fingerprint, name: bundle.index.name, game: bundle.index.game, files: bundle.files }
    : bundle;
  if (payload.id !== `local-${payload.fingerprint}` || !/^[a-f0-9]{64}$/.test(payload.fingerprint)) throw new Error('Invalid local map identity.');
  const previous = localSources.get(payload.id)?.deref();
  if (previous) return previous;
  const source = new MapSource(payload.id, payload);
  localSources.set(payload.id, new WeakRef(source)); return source;
}
export function mapSource(terrain: TerrainName | string): MapSource | null {
  const id = mapId(terrain); if (!id) return null;
  if (!id.startsWith('local-')) return new MapSource(id);
  const source = localSources.get(id)?.deref();
  if (!source) throw new Error('This map is session-local. Choose the same map bundle to reattach it.');
  return source;
}
export function validLocalMap(value: unknown, terrain: string): value is LocalMapIdentity {
  if (!value || typeof value !== 'object') return false;
  const m = value as LocalMapIdentity;
  return typeof m.fingerprint === 'string' && /^[a-f0-9]{64}$/.test(m.fingerprint) && m.id === `local-${m.fingerprint}`
    && terrain === `map:${m.id}` && typeof m.name === 'string' && typeof m.game === 'string';
}
