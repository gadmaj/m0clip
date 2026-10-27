/** Install the hosted R1 catalog once per browser. Existing imports win; an
 * explicit deletion stays deleted on subsequent visits. Manual import remains available. */
import { storePack, type PackMetadata, type StoredPack } from './index';

function settings(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('ume-default-packs', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('settings');
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export async function installDefaultPacks(existing: PackMetadata[], progress: (message: string) => void,
    fetchMetadata: (url: string) => Promise<Response> = fetch): Promise<PackMetadata[]> {
  const db = await settings();
  const key = 'r1-default-v1';
  try {
    const installed = await new Promise<boolean>((resolve, reject) => {
      const request = db.transaction('settings').objectStore('settings').get(key);
      request.onsuccess = () => resolve(!!request.result);
      request.onerror = () => reject(request.error);
    });
    if (installed) return existing;
    progress('Preparing the default R1 policy catalog…');
    const response = await fetchMetadata('/assets/packs/r1-default-v1.json');
    if (!response.ok) throw new Error(`Default catalog: HTTP ${response.status}`);
    const catalog = await response.json() as StoredPack[];
    if (!Array.isArray(catalog) || !catalog.length) throw new Error('Default catalog contains no policy packs');
    const ids = new Set(existing.map(pack => pack.id));
    const result = [...existing];
    for (const pack of catalog) {
      if (typeof pack.id !== 'string' || pack.id !== pack.manifest?.baseName ||
          !pack.manifest.checkpoints?.length || !pack.config?.policy ||
          !pack.downloadUrl?.startsWith('/assets/packs/r1/')) throw new Error('Invalid default policy entry');
      if (ids.has(pack.id)) continue;
      pack.files = {};
      const metadata = await storePack(pack);
      result.push(metadata);
      ids.add(pack.id);
    }
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction('settings', 'readwrite');
      transaction.objectStore('settings').put(true, key);
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error);
    });
    return result;
  } finally { db.close(); }
}
