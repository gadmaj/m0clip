/** Startup-only decoded payload accounting. No observer branch consumes a body. */
export interface TransferUpdate {
  id: string;
  url: string;
  loaded: number;
  total: number | null;
  state: 'loading' | 'done' | 'failed' | 'cancelled';
}

interface Collector {
  prefix: string;
  sequence: number;
  active: boolean;
  pending: (update: TransferUpdate) => void;
  abortCleanups: Set<() => void>;
  requests: Map<string, { start: number; end: number; matched: boolean }[]>;
}
interface Transfer {
  collector: Collector;
  update: TransferUpdate;
  cleanup?: () => void;
}
type ResponseReader = NonNullable<Response['body']> extends ReadableStream<infer Bytes>
  ? ReadableStreamDefaultReader<Bytes> : never;
interface FetchObservation {
  original: typeof fetch;
  wrapped: typeof fetch;
  collectors: Set<Collector>;
}
let fetchObservation: FetchObservation | undefined;

function assetUrl(input: RequestInfo | URL): string | null {
  try {
    const value = typeof input === 'string' ? input
      : input instanceof URL ? input.href : input instanceof Request ? input.url : null;
    if (value === null) return null;
    const url = new URL(value, globalThis.location.href);
    url.hash = '';
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    if (/\/assets\/previews\//i.test(url.pathname)
      || /\.(?:css|woff2?|ttf|otf|ico)$/i.test(url.pathname)
      || /\/(?:favicon[^/]*|apple-touch-icon[^/]*)$/i.test(url.pathname)) return null;
    return url.href;
  } catch {
    // An exotic fetch input must not gain a second coercion or a new error.
    return null;
  }
}

function finishTransfer(transfer: Transfer, state: Exclude<TransferUpdate['state'], 'loading'>) {
  const { collector, update } = transfer;
  if (!collector.active || update.state !== 'loading') return;
  transfer.cleanup?.();
  update.state = state;
  if (state === 'done') update.total = update.loaded;
  collector.pending(update);
}

function startTransfer(collector: Collector, url: string, signal?: AbortSignal | null): Transfer {
  const transfer: Transfer = {
    collector,
    update: { id: `${collector.prefix}:${++collector.sequence}`, url, loaded: 0, total: null, state: 'loading' },
  };
  collector.pending(transfer.update);
  if (signal) {
    const abort = () => finishTransfer(transfer, 'cancelled');
    transfer.cleanup = () => {
      signal.removeEventListener('abort', abort);
      collector.abortCleanups.delete(transfer.cleanup!);
    };
    collector.abortCleanups.add(transfer.cleanup);
    if (signal.aborted) abort();
    else signal.addEventListener('abort', abort, { once: true });
  }
  return transfer;
}

function payloadTotal(response: Response): number | null {
  const encoding = response.headers.get('content-encoding');
  if (encoding && encoding.trim().toLowerCase() !== 'identity') return null;
  // CORS can expose Content-Length while hiding Content-Encoding. An absent
  // encoding there cannot prove that the advertised bytes are decoded bytes.
  if (response.type === 'cors' && !encoding) return null;
  const length = response.headers.get('content-length');
  if (length === null || !/^\d+$/.test(length.trim())) return null;
  const total = Number(length);
  return Number.isSafeInteger(total) ? total : null;
}

function preserveMetadata(target: Response, source: Response): Response {
  const nativeClone = Response.prototype.clone;
  // A real Response is required by instantiateStreaming. Its internal headers,
  // status and body are native; only metadata unavailable to the constructor is
  // forwarded. Exposing the fetched Headers also retains its immutable guard.
  Object.defineProperties(target, {
    url: { configurable: true, value: source.url },
    redirected: { configurable: true, value: source.redirected },
    type: { configurable: true, value: source.type },
    headers: { configurable: true, value: source.headers },
    clone: {
      configurable: true,
      value: function (this: Response): Response {
        // Native teeing gives both consumers their usual independent bodies and
        // errors. Accounting is upstream of the tee, so bytes count only once.
        const clone = nativeClone.call(this);
        return this === target ? preserveMetadata(clone, source) : clone;
      },
    },
  });
  return target;
}

function observeResponse(response: Response, transfers: Transfer[], signal?: AbortSignal | null): Response {
  if (!transfers.some(({ collector, update }) => collector.active && update.state === 'loading')) return response;
  if (!response.ok) {
    // Loaders may reject an HTTP error without reading its body. It is not an
    // indefinitely pending download, even when the application ignores it.
    for (const transfer of transfers) finishTransfer(transfer, 'failed');
    return response;
  }
  const source = response.body;
  if (!source) {
    for (const transfer of transfers) finishTransfer(transfer, 'done');
    return response;
  }
  // Native fetch responses have a constructible status and an unused body.
  // Do not interfere with a response altered by instrumentation we do not own.
  if (response.status < 200 || response.status > 599 || source.locked || response.bodyUsed) return response;
  let loaded = 0;
  let total = payloadTotal(response);
  let reader: ResponseReader | undefined;
  for (const { collector, update } of transfers) {
    if (!collector.active || update.state !== 'loading') continue;
    update.total = total;
    collector.pending(update);
  }
  const body = new ReadableStream({
    type: 'bytes',
    async pull(controller) {
      try {
        // highWaterMark 0: do not lock/read the real body until a consumer asks.
        reader ??= source.getReader();
        const chunk = await reader.read();
        if (chunk.done) {
          controller.close();
          controller.byobRequest?.respond(0);
          reader.releaseLock();
          for (const transfer of transfers) finishTransfer(transfer, 'done');
          return;
        }
        loaded += chunk.value.byteLength;
        if (total !== null && loaded > total) total = null;
        // Byte streams retain BYOB support; enqueue transfers a chunk rather
        // than collecting/copying complete bodies. No extra tee is introduced.
        if (chunk.value.byteLength) controller.enqueue(chunk.value);
        for (const { collector, update } of transfers) {
          if (!collector.active || update.state !== 'loading') continue;
          update.loaded = loaded;
          update.total = total;
          collector.pending(update);
        }
      } catch (error) {
        controller.error(error);
        reader?.releaseLock();
        const state = signal?.aborted || (error instanceof DOMException && error.name === 'AbortError')
          ? 'cancelled' : 'failed';
        for (const transfer of transfers) finishTransfer(transfer, state);
      }
    },
    cancel(reason) {
      for (const transfer of transfers) finishTransfer(transfer, 'cancelled');
      const cancellation = reader ? reader.cancel(reason) : source.cancel(reason);
      return cancellation.finally(() => reader?.releaseLock());
    },
  }, { highWaterMark: 0 });
  return preserveMetadata(new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  }), response);
}

function attachFetch(collector: Collector) {
  if (fetchObservation) {
    fetchObservation.collectors.add(collector);
    return;
  }
  const original = globalThis.fetch;
  const observation: FetchObservation = { original, wrapped, collectors: new Set([collector]) };
  function wrapped(this: unknown, ...args: Parameters<typeof fetch>): ReturnType<typeof fetch> {
    // Call first, with the exact receiver/arguments. Observation cannot change
    // request conversion, caching, network order or synchronous fetch failures.
    const start = performance.now();
    const result = Reflect.apply(original, this, args) as ReturnType<typeof fetch>;
    const end = performance.now();
    let transfers: Transfer[];
    let signal: AbortSignal | null | undefined;
    try {
      const url = assetUrl(args[0]);
      if (!url) return result;
      signal = args[1]?.signal ?? (args[0] instanceof Request ? args[0].signal : undefined);
      transfers = [...observation.collectors].filter(item => item.active).map(item => {
        const requests = item.requests.get(url) ?? [];
        if (!item.requests.has(url)) item.requests.set(url, requests);
        requests.push({ start, end, matched: false });
        return startTransfer(item, url, signal);
      });
    } catch {
      return result;
    }
    return result.then(response => {
      try { return observeResponse(response, transfers, signal); }
      catch { return response; } // Optional instrumentation must never fail a loader.
    }, error => {
      const state = signal?.aborted || (error instanceof DOMException && error.name === 'AbortError')
        ? 'cancelled' : 'failed';
      for (const transfer of transfers) finishTransfer(transfer, state);
      throw error;
    });
  }
  try {
    globalThis.fetch = wrapped;
    fetchObservation = observation;
  } catch {
    // ResourceTiming can still account for native assets in a locked-down realm.
  }
}

/** Observe until explicit scene entry; stopping never cancels application work. */
export function observeTransfers(prefix: string, report: (updates: TransferUpdate[]) => void): () => void {
  const pending = new Map<string, TransferUpdate>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let notify: typeof report | undefined = report;
  const flush = () => {
    clearTimeout(timer);
    timer = undefined;
    if (!collector.active || !pending.size) return;
    const updates = [...pending.values()].map(update => ({ ...update }));
    pending.clear();
    try { notify?.(updates); } catch { /* Reporting cannot break a consumer. */ }
  };
  const collector: Collector = {
    prefix, sequence: 0, active: true, abortCleanups: new Set(), requests: new Map(),
    pending(update) {
      if (!collector.active) return;
      pending.set(update.id, update);
      if (update.state !== 'loading') flush();
      else timer ??= setTimeout(flush, 100);
    },
  };
  attachFetch(collector);
  // A worker's module graph may load before init arrives. Its whole lifetime is
  // startup, unlike the page's pre-Load UI, so include buffered worker entries.
  const since = typeof document === 'undefined' ? 0 : performance.now();
  let resources: PerformanceObserver | undefined;
  const accountResources = (entries: PerformanceEntry[]) => {
    for (const candidate of entries) {
      if (!collector.active || candidate.entryType !== 'resource' || candidate.startTime < since) continue;
      const entry = candidate as PerformanceResourceTiming;
      if (!['fetch', 'xmlhttprequest', 'script', 'link', 'img', 'image', 'worker', 'other'].includes(entry.initiatorType)) continue;
      const url = assetUrl(entry.name);
      if (!url || !Number.isSafeInteger(entry.decodedBodySize) || entry.decodedBodySize <= 0) continue;
      if (entry.initiatorType === 'fetch') {
        const match = collector.requests.get(url)?.find(request => !request.matched
          && entry.startTime >= request.start - 1 && entry.startTime <= request.end + 1);
        if (match) {
          match.matched = true;
          continue;
        }
      }
      if ((entry.initiatorType === 'link' || entry.initiatorType === 'other')
        && !/\.(?:[cm]?js|ts|wasm)(?:[?#]|$)/i.test(url)) continue;
      // Buffered timing is also a completion-only fallback for libraries that
      // captured fetch before init, and XHR. Pair observed fetches by URL/start
      // interval, not URL alone: concurrent/repeated requests are distinct.
      // Never substitute transferSize/encodedBodySize for decoded payload bytes.
      const transfer = startTransfer(collector, url);
      transfer.update.loaded = entry.decodedBodySize;
      finishTransfer(transfer, 'done');
    }
  };
  try {
    resources = new PerformanceObserver(list => accountResources(list.getEntries()));
    resources.observe({ type: 'resource', buffered: true });
  } catch {
    resources?.disconnect();
    resources = undefined;
    accountResources(performance.getEntriesByType('resource'));
  }
  return () => {
    if (!collector.active) return;
    collector.active = false;
    notify = undefined;
    clearTimeout(timer);
    pending.clear();
    resources?.disconnect();
    for (const cleanup of collector.abortCleanups) cleanup();
    collector.abortCleanups.clear();
    collector.requests.clear();
    const observation = fetchObservation;
    observation?.collectors.delete(collector);
    if (observation && !observation.collectors.size) {
      try {
        if (globalThis.fetch === observation.wrapped) globalThis.fetch = observation.original;
      } catch {
        // Do not break scene entry if another owner made the global read-only.
      }
      fetchObservation = undefined;
    }
  };
}
