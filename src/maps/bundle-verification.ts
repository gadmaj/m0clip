/** Each converted-map Load owns one worker; no main-thread decoder fallback. */
import type { DecodedMapBundle } from './bundle';
import type { TransferUpdate } from '../loading/transfers';
import { verifiedBundle, verificationRecord, verificationTransfers,
  type BundleVerificationRequest } from './bundle-verification-protocol';

/** Root ownership is metadata; only transfers report actual consumed HTTP bytes. */
export interface BundleVerificationObserver {
  root(url: string): void;
  transfers(updates: TransferUpdate[]): void;
}

export function verifyMapBundle(file: Blob, signal?: AbortSignal,
  observer?: BundleVerificationObserver): Promise<DecodedMapBundle> {
  const { promise, resolve, reject } = Promise.withResolvers<DecodedMapBundle>();
  if (signal?.aborted) {
    reject(signal.reason ?? new DOMException('Map loading cancelled.', 'AbortError'));
    return promise;
  }
  let worker: Worker | undefined, settled = false;
  let resources: PerformanceObserver | undefined, rootUrl: string | undefined, rootReported = false;
  let requestedAt = Infinity;
  const rootId = `map-verification-root:${crypto.randomUUID()}`;
  const accountRoot = (entries: readonly PerformanceEntry[]) => {
    if (!rootUrl || rootReported) return;
    for (const candidate of entries) {
      if (candidate.entryType !== 'resource' || candidate.name !== rootUrl
        || candidate.startTime < requestedAt) continue;
      const entry = candidate as PerformanceResourceTiming;
      if (!['worker', 'script', 'other'].includes(entry.initiatorType) || entry.responseEnd <= 0
        || !Number.isSafeInteger(entry.decodedBodySize) || entry.decodedBodySize < 0) continue;
      rootReported = true;
      // This is the constructor's real HTTP entry, not the page's copy of a
      // shared import. Do not substitute catalogue sizes or transport bytes.
      try { observer?.transfers([{ id: rootId, url: entry.name, realm: 'map-verification',
        loaded: entry.decodedBodySize, total: entry.decodedBodySize, state: 'done' }]); }
      catch { /* Observation cannot break verification or cancellation. */ }
      return;
    }
  };
  const finish = (error: unknown, bundle?: DecodedMapBundle) => {
    if (settled) return;
    settled = true;
    signal?.removeEventListener('abort', cancel);
    accountRoot(resources?.takeRecords() ?? []);
    accountRoot(performance.getEntriesByType('resource'));
    resources?.disconnect();
    resources = undefined;
    if (worker) {
      worker.onmessage = worker.onerror = worker.onmessageerror = null;
      worker.terminate();
      worker = undefined;
    }
    if (error !== undefined) reject(error);
    else resolve(bundle!);
  };
  const cancel = () => finish(signal?.reason ?? new DOMException('Map loading cancelled.', 'AbortError'));
  signal?.addEventListener('abort', cancel, { once: true });
  try {
    try {
      resources = new PerformanceObserver(list => { if (!settled) accountRoot(list.getEntries()); });
      resources.observe({ type: 'resource', buffered: true });
    } catch { resources?.disconnect(); resources = undefined; }
    requestedAt = performance.now();
    worker = new Worker(new URL('./bundle-verification.worker.ts', import.meta.url), { type: 'module', name: 'map-verification' });
    worker.onerror = event => {
      event.preventDefault();
      finish(new Error('The map verification worker failed. Reload and try the bundle again.'));
    };
    worker.onmessageerror = () => finish(new Error('The map verification worker returned an unreadable message.'));
    worker.onmessage = event => {
      if (settled) return;
      const message: unknown = event.data;
      if (verificationRecord(message)) {
        if (message.type === 'ready' && !rootUrl && typeof message.url === 'string') {
          try {
            const url = new URL(message.url);
            if (!/^https?:$/.test(url.protocol) || url.origin !== location.origin || url.href !== message.url)
              throw new Error('Invalid worker root URL.');
            rootUrl = url.href;
            try { observer?.root(rootUrl); } catch { /* Metadata observation cannot break verification. */ }
            accountRoot(resources?.takeRecords() ?? []);
            accountRoot(performance.getEntriesByType('resource'));
            return;
          } catch { finish(new Error('The map verification worker returned an invalid root URL.')); return; }
        }
        if (rootUrl && message.type === 'transfers' && verificationTransfers(message.updates)) {
          try {
            for (const update of message.updates) {
              update.realm = 'map-verification';
            }
            observer?.transfers(message.updates);
          }
          catch { /* Optional observation cannot change verification. */ }
          return;
        }
        if (rootUrl && message.type === 'error' && typeof message.name === 'string' && typeof message.message === 'string') {
          const error = new Error(message.message); error.name = message.name;
          finish(error); return;
        }
        if (rootUrl && message.type === 'bundle' && verifiedBundle(message.bundle)) {
          finish(undefined, message.bundle); return;
        }
      }
      finish(new Error('The map verification worker returned an invalid message.'));
    };
    if (signal?.aborted) cancel();
    if (!settled) {
      const request: BundleVerificationRequest = { type: 'verify', file };
      worker!.postMessage(request);
    }
  } catch (error) { finish(error ?? new Error('The map verification worker could not start.')); }
  return promise;
}
