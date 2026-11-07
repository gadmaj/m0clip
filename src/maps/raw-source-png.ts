// Byte-oriented PNG encoding preserves RGB beneath zero alpha. No canvas,
// premultiplication, colour conversion, metadata, or image decoder is involved.
const PNG_SIGNATURE = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
const CRC_TABLE = new Uint32Array(256);
for (let i = 0; i < CRC_TABLE.length; i++) {
  let crc = i;
  for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  CRC_TABLE[i] = crc >>> 0;
}
function pngChunk(type: string, bytes: Uint8Array): Blob {
  const header = new Uint8Array(8), view = new DataView(header.buffer);
  view.setUint32(0, bytes.byteLength, false);
  for (let i = 0; i < 4; i++) header[4 + i] = type.charCodeAt(i);
  let crc = 0xffffffff;
  for (let i = 4; i < 8; i++) crc = CRC_TABLE[(crc ^ header[i]) & 255] ^ (crc >>> 8);
  for (let i = 0; i < bytes.length; i++) crc = CRC_TABLE[(crc ^ bytes[i]) & 255] ^ (crc >>> 8);
  const footer = new DataView(new ArrayBuffer(4));
  footer.setUint32(0, (crc ^ 0xffffffff) >>> 0, false);
  return new Blob([header, new Uint8Array(bytes.buffer as ArrayBuffer, bytes.byteOffset, bytes.byteLength), footer.buffer]);
}

/** Borrows rgba until resolution: callers must not mutate/detach it meanwhile.
 * At most 1 GiB of filtered input is accepted. Input is never duplicated into a
 * full scanline buffer; only compressed chunks are snapshotted into Blob parts.
 */
export async function encodeSourcePng(width: number, height: number, rgba: Uint8Array, signal?: AbortSignal): Promise<Blob> {
  signal?.throwIfAborted();
  const rowBytes = width * 4, filteredBytes = (rowBytes + 1) * height;
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1 || width > 0x7fffffff || height > 0x7fffffff || !Number.isSafeInteger(filteredBytes) || filteredBytes > 1024 ** 3) throw new RangeError('PNG dimensions exceed byte limit');
  if (!(rgba instanceof Uint8Array) || rgba.byteLength !== rowBytes * height) throw new RangeError('PNG RGBA byte length does not match dimensions');
  const buffer=rgba.buffer;
  if (!(buffer instanceof ArrayBuffer)) throw new TypeError('Shared PNG input cannot be encoded atomically');
  const ihdr = new Uint8Array(13), dimensions = new DataView(ihdr.buffer);
  dimensions.setUint32(0, width, false); dimensions.setUint32(4, height, false);
  ihdr[8] = 8; ihdr[9] = 6; // RGBA8, standard compression/filter, no interlace.
  const parts: Blob[] = [new Blob([PNG_SIGNATURE]), pngChunk('IHDR', ihdr)];
  const compression = new CompressionStream('deflate');
  const writer = compression.writable.getWriter(), reader = compression.readable.getReader();
  const abort = () => {
    const reason = signal?.reason ?? new DOMException('PNG encoding aborted', 'AbortError');
    void reader.cancel(reason).catch(() => {});
    void writer.abort(reason).catch(() => {});
  };
  signal?.addEventListener('abort', abort, { once: true });
  const filter = new Uint8Array(1);
  // Consume concurrently: awaiting only the producer would deadlock once the
  // compressor's readable side applies backpressure.
  const produce = (async () => {
    for (let row = 0; row < height; row++) {
      signal?.throwIfAborted();
      await writer.write(filter);
      for (let offset = row * rowBytes; offset < (row + 1) * rowBytes; offset += 65536) {
        signal?.throwIfAborted();
        await writer.write(new Uint8Array(buffer, rgba.byteOffset + offset, Math.min(65536, (row + 1) * rowBytes - offset)));
      }
    }
    await writer.close();
  })();
  const consume = (async () => {
    let compressedBytes = 0;
    // A generous deflate overhead bound still prevents unbounded output retention.
    const compressedLimit = filteredBytes + Math.ceil(filteredBytes / 16384) * 16 + 65536;
    while (true) {
      signal?.throwIfAborted();
      const { value, done } = await reader.read();
      if (done) break;
      compressedBytes += value.byteLength;
      if (compressedBytes > compressedLimit) throw new RangeError('PNG compressed output exceeds byte limit');
      if (value.byteLength) parts.push(pngChunk('IDAT', value));
    }
  })();
  try {
    await Promise.all([produce, consume]);
    signal?.throwIfAborted();
    parts.push(pngChunk('IEND', new Uint8Array(0)));
    return new Blob(parts, { type: 'image/png' });
  } catch (error) {
    void reader.cancel(error).catch(() => {});
    void writer.abort(error).catch(() => {});
    await Promise.allSettled([produce, consume]);
    signal?.throwIfAborted();
    throw error;
  } finally {
    signal?.removeEventListener('abort', abort);
    writer.releaseLock(); reader.releaseLock();
  }
}
