// Byte-only MIT LZMA decoder; see the complete notice in the vendored module.
import codec from './raw-source-lzma-codec.js';

export function sourceAbort(signal?: AbortSignal): void {
  if (signal?.aborted) throw signal.reason ?? new DOMException('Source import aborted', 'AbortError');
}

/** Valve's 17-byte header contains raw LZMA1 properties, not an .xz stream. */
export async function decodeValveLzma(bytes: Uint8Array, expected: number, maximum: number, signal?: AbortSignal): Promise<Uint8Array<ArrayBuffer>> {
  sourceAbort(signal);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.length < 17 || view.getUint32(0, true) !== 0x414d5a4c) throw new Error('Invalid Valve LZMA header');
  const size = view.getUint32(4, true), compressed = view.getUint32(8, true);
  if (size !== expected || size > maximum || compressed !== bytes.length - 17) throw new Error('Valve LZMA size mismatch or limit exceeded');
  if (size === 0) throw new Error('Zero-sized compressed Source lumps are unsupported');
  const property = bytes[12], dictionary = view.getUint32(13, true);
  if (property >= 225 || dictionary > maximum) throw new Error('Unsupported or excessive LZMA properties');
  // The codec consumes the standard .lzma-alone header: properties + uint64 size.
  const alone = new Uint8Array(13 + compressed);
  alone.set(bytes.subarray(12, 17));
  new DataView(alone.buffer).setUint32(5, size, true);
  alone.set(bytes.subarray(17), 13);
  const { promise, resolve, reject } = Promise.withResolvers<Uint8Array<ArrayBuffer>>();
  const abort = () => reject(signal?.reason ?? new DOMException('Source import aborted', 'AbortError'));
  signal?.addEventListener('abort', abort, { once: true });
  codec.decompress(alone, (result, error) => {
    signal?.removeEventListener('abort', abort);
    if (signal?.aborted) { abort(); return; }
    if (error || result === null) { reject(error ?? new Error('LZMA decompression failed')); return; }
    const output = Uint8Array.from(result);
    if (output.length !== size) { reject(new Error('LZMA decoded length mismatch')); return; }
    resolve(output);
  }, () => sourceAbort(signal)); // Throwing here terminates the scheduled chunk loop.
  return promise;
}
