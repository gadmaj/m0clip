// Byte-only MIT LZMA decoder; see the complete notice in the vendored module.
import codec from './raw-source-lzma-codec.js';

export function sourceAbort(signal?: AbortSignal): void {
  if (signal?.aborted) throw signal.reason ?? new DOMException('Source import aborted', 'AbortError');
}

/** Conservative JS numeric-array slot costs, not engine heap metrics: read input,
 * Valve->alone adapter copy, codec output, dictionary and probabilities. */
export function sourceLzmaWorkingBytes(readBytes: number, storedBytes: number, size: number, property: number, dictionary: number): number {
  const lc = property % 9, lp = Math.floor(property / 9) % 5;
  return readBytes + storedBytes + size * 16 + Math.max(dictionary, 4096) * 16
    + (1 << (lc + lp)) * (0x300 * 16 + 128) + 256 * 1024;
}

/** Decode one raw LZMA1 stream of known positive length through the codec's
 * standard .lzma-alone header: 5 property bytes + uint64 size. */
function decodeLzmaStream(properties: Uint8Array, stream: Uint8Array, size: number, signal?: AbortSignal): Promise<Uint8Array<ArrayBuffer>> {
  const alone = new Uint8Array(13 + stream.length);
  alone.set(properties.subarray(0, 5));
  new DataView(alone.buffer).setUint32(5, size, true);
  alone.set(stream, 13);
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
  return decodeLzmaStream(bytes.subarray(12, 17), bytes.subarray(17), size, signal);
}

/** Largest lc+lp accepted in ZIP LZMA members; the archive reserves probability
 * tables for this bound before extraction. 7-Zip and Valve's encoders use 3. */
export const SOURCE_ZIP_LZMA_MAX_LITERAL_BITS = 8;

/** PKWARE APPNOTE 5.8.8 (ZIP method 14), as written by bspzip -repack -compress:
 * two LZMA SDK version bytes, a uint16 property size (5), the properties, then a
 * raw LZMA1 stream whose optional end marker follows the known output. A match
 * can never reach further back than the bytes already written, so the decoder
 * window is clamped to the declared size instead of the authored dictionary. */
export async function decodeZipLzma(bytes: Uint8Array, expected: number, signal?: AbortSignal): Promise<Uint8Array<ArrayBuffer>> {
  sourceAbort(signal);
  if (!Number.isSafeInteger(expected) || expected < 0 || expected > 0xffffffff) throw new Error('Invalid ZIP LZMA declared size');
  if (bytes.length < 9) throw new Error('Truncated ZIP LZMA header');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint16(2, true) !== 5) throw new Error(`Unsupported ZIP LZMA property size ${view.getUint16(2, true)}`);
  const property = bytes[4];
  if (property >= 225) throw new Error('Invalid ZIP LZMA properties');
  if (property % 9 + Math.floor(property / 9) % 5 > SOURCE_ZIP_LZMA_MAX_LITERAL_BITS) throw new Error(`ZIP LZMA literal context lc+lp exceeds ${SOURCE_ZIP_LZMA_MAX_LITERAL_BITS}`);
  if (expected === 0) return new Uint8Array(0);
  const properties = bytes.slice(4, 9);
  new DataView(properties.buffer).setUint32(1, Math.min(view.getUint32(5, true), expected), true);
  return decodeLzmaStream(properties, bytes.subarray(9), expected, signal);
}
