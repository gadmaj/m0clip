/** Lazy local Source intake. Each operation owns and disposes one CPU worker. */
import type { DecodedMapBundle } from './bundle';
import type { WorkerTransferObserver } from '../loading/transfers';
import {
  sourceBundle, sourceFailure, sourceInspection, sourceRecord, sourceStage, sourceTransfers,
  type SourceImportChoice, type SourceImportFailure, type SourceImportRequest,
  type SourceImportRequirement, type SourceImportStage, type SourceInspection,
} from './source-import-protocol';
export type { SourceImportChoice, SourceInspection, SourceImportRequirement } from './source-import-protocol';

export class SourceImportError extends Error {
  readonly requirements: readonly SourceImportRequirement[];
  readonly omittedRequirements: number;
  constructor(failure: SourceImportFailure) {
    super(failure.message);
    this.name = 'SourceImportError';
    this.requirements = Object.freeze(failure.requirements.map(item => Object.freeze({ ...item })));
    this.omittedRequirements = failure.omittedRequirements;
  }
}

function workerFailure(message: string): SourceImportError {
  return new SourceImportError({ message, requirements: [], omittedRequirements: 0 });
}

function requestSourceWorker(request: SourceImportRequest, signal?: AbortSignal,
  onStage?: (stage: SourceImportStage) => void,
  observer?: WorkerTransferObserver): Promise<SourceInspection | DecodedMapBundle> {
  const { promise, resolve, reject } = Promise.withResolvers<SourceInspection | DecodedMapBundle>();
  if (signal?.aborted) {
    reject(signal.reason ?? new DOMException('Source import cancelled', 'AbortError'));
    return promise;
  }
  let worker: Worker | undefined, settled = false;
  const realm = request.type === 'inspect' ? 'source-metadata' : 'source-assembly';
  let resources: PerformanceObserver | undefined, rootUrl: string | undefined, rootReported = false;
  let requestedAt = Infinity;
  const rootId = observer ? `${realm}-root:${crypto.randomUUID()}` : '';
  const accountRoot = (entries: readonly PerformanceEntry[]) => {
    if (!observer || !rootUrl || rootReported) return;
    for (const candidate of entries) {
      if (candidate.entryType !== 'resource' || candidate.name !== rootUrl
        || candidate.startTime < requestedAt) continue;
      const entry = candidate as PerformanceResourceTiming;
      if (!['worker', 'script', 'other'].includes(entry.initiatorType) || entry.responseEnd <= 0
        || !Number.isSafeInteger(entry.decodedBodySize) || entry.decodedBodySize < 0) continue;
      rootReported = true;
      // The constructor's real decoded HTTP body is independent of page imports.
      // The worker's root URL identifies ownership; it is not byte credit.
      try { observer.transfers([{ id: rootId, url: entry.name, realm,
        loaded: entry.decodedBodySize, total: entry.decodedBodySize, state: 'done' }]); }
      catch { /* Observation cannot break local conversion or cancellation. */ }
      return;
    }
  };
  const finish = (error: unknown, value?: SourceInspection | DecodedMapBundle) => {
    if (settled) return;
    settled = true;
    signal?.removeEventListener('abort', cancel);
    if (observer) {
      accountRoot(resources?.takeRecords() ?? []);
      accountRoot(performance.getEntriesByType('resource'));
    }
    resources?.disconnect();
    resources = undefined;
    if (worker) {
      worker.onmessage = worker.onerror = worker.onmessageerror = null;
      worker.terminate();
      worker = undefined;
    }
    if (error !== undefined) reject(error);
    else resolve(value!);
  };
  const cancel = () => finish(signal?.reason ?? new DOMException('Source import cancelled', 'AbortError'));
  signal?.addEventListener('abort', cancel, { once: true });
  try {
    if (observer) {
      try {
        resources = new PerformanceObserver(list => { if (!settled) accountRoot(list.getEntries()); });
        resources.observe({ type: 'resource', buffered: true });
      } catch { resources?.disconnect(); resources = undefined; }
    }
    requestedAt = performance.now();
    worker = request.type === 'inspect'
      ? new Worker(new URL('./source-inspect.worker.ts', import.meta.url), { type: 'module', name: 'source-inspection' })
      : new Worker(new URL('./source-assemble.worker.ts', import.meta.url), { type: 'module', name: 'source-assembly' });
    worker.onerror = event => {
      event.preventDefault();
      finish(workerFailure('The local Source worker failed. Check the selected map and companion files.'));
    };
    worker.onmessageerror = () => finish(workerFailure('The local Source worker returned an unreadable message.'));
    worker.onmessage = event => {
      if (settled) return;
      const message: unknown = event.data;
      if (sourceRecord(message)) {
        if (message.type === 'ready' && !rootUrl && typeof message.url === 'string') {
          try {
            const url = new URL(message.url);
            if (!/^https?:$/.test(url.protocol) || url.origin !== location.origin || url.href !== message.url)
              throw new Error('Invalid Source worker root URL.');
            rootUrl = url.href;
            try { observer?.root(rootUrl, realm); } catch { /* Root ownership is optional observation. */ }
            accountRoot(resources?.takeRecords() ?? []);
            if (observer) accountRoot(performance.getEntriesByType('resource'));
            return;
          } catch { finish(workerFailure('The local Source worker returned an invalid root URL.')); return; }
        }
        if (rootUrl && message.type === 'transfers' && sourceTransfers(message.updates)) {
          try {
            for (const update of message.updates) update.realm = realm;
            observer?.transfers(message.updates);
          } catch { /* Observation cannot break local conversion or cancellation. */ }
          return;
        }
        if (rootUrl && message.type === 'error' && sourceFailure(message.error)) {
          finish(new SourceImportError(message.error)); return;
        }
        if (rootUrl && request.type === 'inspect' && message.type === 'inspection' && sourceInspection(message.inspection)) {
          finish(undefined, message.inspection); return;
        }
        if (rootUrl && request.type === 'convert' && message.type === 'bundle' && sourceBundle(message.bundle)) {
          finish(undefined, message.bundle); return;
        }
        if (rootUrl && request.type === 'convert' && message.type === 'stage' && sourceStage(message.stage)) {
          try { onStage?.(message.stage); }
          catch (error) { finish(error ?? new Error('Source stage callback failed.')); }
          return;
        }
      }
      finish(workerFailure('The local Source worker returned an invalid message.'));
    };
    if (signal?.aborted) cancel();
    if (!settled) worker.postMessage(request);
  } catch (error) { finish(error ?? new Error('Source worker could not start.')); }
  return promise;
}

export async function inspectSourceMap(file: File, signal?: AbortSignal,
  observer?: WorkerTransferObserver): Promise<SourceInspection> {
  return await requestSourceWorker({ type: 'inspect', file }, signal, undefined, observer) as SourceInspection;
}
export async function convertSourceMap(choice: SourceImportChoice, signal?: AbortSignal,
  onStage?: (stage: SourceImportStage) => void, observer?: WorkerTransferObserver): Promise<DecodedMapBundle> {
  return await requestSourceWorker({ type: 'convert', choice }, signal, onStage, observer) as DecodedMapBundle;
}
