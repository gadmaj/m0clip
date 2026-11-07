/** One request per dedicated worker. The facade terminates it on any outcome. */
import { inspectSourceFile } from './source-import-index';
import { sourceImportFailure, sourceRecord, type SourceImportResponse } from './source-import-protocol';
import { observeTransfers } from '../loading/transfers';

const scope = self as unknown as {
  onmessage: ((event: MessageEvent<unknown>) => void) | null;
  postMessage(message: SourceImportResponse): void;
};
scope.onmessage = event => {
  scope.onmessage = null;
  void (async () => {
    try {
      if (!sourceRecord(event.data) || event.data.type !== 'inspect' || !(event.data.file instanceof File))
        throw new Error('Invalid Source inspection request.');
      const inspection = await inspectSourceFile(event.data.file);
      stopTransfers({ drain: true });
      scope.postMessage({ type: 'inspection', inspection });
    } catch (error) {
      stopTransfers({ drain: true });
      scope.postMessage({ type: 'error', error: sourceImportFailure(error) });
    }
  })();
};
// Root ownership must arrive before buffered static-import transfer updates.
scope.postMessage({ type: 'ready', url: import.meta.url });
const stopTransfers = observeTransfers(`source-metadata:${crypto.randomUUID()}`, updates => {
  for (let offset = 0; offset < updates.length; offset += 4096)
    scope.postMessage({ type: 'transfers', updates: updates.slice(offset, offset + 4096) });
});
