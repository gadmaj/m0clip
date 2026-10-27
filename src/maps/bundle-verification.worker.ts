/** Full converted ZIP verification and identity stay in this request-owned CPU realm. */
import { decodeMapBundle } from './bundle';
import { observeTransfers } from '../loading/transfers';
import { verificationRecord, type BundleVerificationResponse } from './bundle-verification-protocol';

const scope = self as unknown as {
  onmessage: ((event: MessageEvent<unknown>) => void) | null;
  postMessage(message: BundleVerificationResponse): void;
  location: { href: string };
};
scope.postMessage({ type: 'ready', url: scope.location.href });
// Buffered timings contain actual static imports, including those before this body.
// The initiating window may own the worker root's HTTP timing.
// Local archive reads are CPU work, not HTTP payload receipts.
const stopTransfers = observeTransfers(`map-verification:${crypto.randomUUID()}`, updates => {
  scope.postMessage({ type: 'transfers', updates });
});
scope.onmessage = event => {
  scope.onmessage = null;
  void (async () => {
    try {
      if (!verificationRecord(event.data) || event.data.type !== 'verify' || !(event.data.file instanceof Blob))
        throw new Error('Invalid map verification request.');
      const bundle = await decodeMapBundle(event.data.file);
      stopTransfers({ drain: true });
      scope.postMessage({ type: 'bundle', bundle });
    } catch (error) {
      stopTransfers({ drain: true });
      scope.postMessage({ type: 'error', name: error instanceof Error ? error.name : 'Error',
        message: error instanceof Error ? error.message : 'Map verification failed.' });
    }
  })();
};
