/** Converted-map worker messages carry local Blobs and their own HTTP root, never live map state. */
import type { DecodedMapBundle } from './bundle';
import type { TransferUpdate } from '../loading/transfers';

export type BundleVerificationRequest = { type: 'verify'; file: Blob };
export type BundleVerificationResponse =
  | { type: 'ready'; url: string }
  | { type: 'bundle'; bundle: DecodedMapBundle }
  | { type: 'transfers'; updates: TransferUpdate[] }
  | { type: 'error'; name: string; message: string };

export function verificationRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
const bytes = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;
export function verificationTransfers(value: unknown): value is TransferUpdate[] {
  return Array.isArray(value) && value.every(item => verificationRecord(item)
    && typeof item.id === 'string' && item.id.length > 0
    && typeof item.url === 'string' && /^https?:\/\//i.test(item.url)
    && bytes(item.loaded) && (item.total === null || bytes(item.total))
    && ['loading', 'done', 'failed', 'cancelled'].includes(item.state as string)
    && item.realm === undefined);
}
/** Transport validation only. CRC, SHA, dependencies and identity run in the decoder. */
export function verifiedBundle(value: unknown): value is DecodedMapBundle {
  if (!verificationRecord(value) || typeof value.fingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(value.fingerprint)
    || value.id !== `local-${value.fingerprint}` || !(value.files instanceof Map)
    || !verificationRecord(value.index) || value.index.format !== 'm0clip-map' || value.index.version !== 1
    || value.index.entry !== 'manifest.json' || typeof value.index.name !== 'string' || typeof value.index.game !== 'string'
    || !Array.isArray(value.index.resources) || !value.index.resources.length || value.index.resources.length > 65534
    || value.files.size !== value.index.resources.length) return false;
  const seen = new Set<string>();
  for (const item of value.index.resources) {
    if (!verificationRecord(item) || typeof item.path !== 'string' || !item.path || seen.has(item.path)
      || !bytes(item.bytes) || typeof item.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(item.sha256)) return false;
    const blob: unknown = value.files.get(item.path);
    if (!(blob instanceof Blob) || blob.size !== item.bytes) return false;
    seen.add(item.path);
  }
  return seen.has('manifest.json');
}
