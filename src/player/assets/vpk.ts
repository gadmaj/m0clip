/**
 * Valve VPK v1/v2 directory reader over selected browser Blobs. Independent implementation of the
 * public format, following the layout of the MIT noclip.website SourceEngine/VPK.ts reader:
 * a header, an extension → folder → name string tree and, per file, an 18-byte record (CRC32,
 * preload size, archive index, offset, length, 0xffff terminator) followed by its preload bytes.
 * Archive index 0x7fff keeps the body in the directory file's embedded section after the tree.
 * Only the header and tree are read; archive bodies stay in their Blobs until a caller reads one.
 */
export const VPK_EMBEDDED_ARCHIVE = 0x7fff;
const SIGNATURE = 0x55aa1234;
const utf8 = new TextDecoder('utf-8', { fatal: true });

export interface VpkDirectory {
  readonly version: 1 | 2;
  readonly headerSize: number;
  readonly treeSize: number;
  /** Absolute start of the embedded (archive 0x7fff) section in the directory file. */
  readonly dataStart: number;
  /** Byte length of the embedded section. */
  readonly dataSize: number;
  /** Header plus tree, exactly as read. The owner digests and walks it, then drops it. */
  readonly index: Uint8Array<ArrayBuffer>;
}

/** One reused visitor record per walk: copy the fields you keep. */
export interface VpkRecord {
  path: string;
  crc: number;
  /** Absolute offset of the preload bytes in the directory file. */
  preloadStart: number;
  preloadSize: number;
  archive: number;
  offset: number;
  length: number;
}

function fail(label: string, message: string): never { throw new Error(`VPK ${label}: ${message}`); }

export async function readBlobBytes(file: Blob, start: number, length: number, signal?: AbortSignal): Promise<Uint8Array<ArrayBuffer>> {
  signal?.throwIfAborted();
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(length) || start < 0 || length < 0 || start + length > file.size)
    throw new Error(`out-of-range read ${start}+${length} of ${file.size} bytes`);
  const bytes = new Uint8Array(await file.slice(start, start + length).arrayBuffer());
  signal?.throwIfAborted();
  if (bytes.length !== length) throw new Error(`short read ${bytes.length} of ${length} bytes`);
  return bytes;
}

/** Reads and validates the header, v2 section table and tree; never the archive bodies. */
export async function readVpkDirectory(file: Blob, label: string, maxTreeBytes: number, signal?: AbortSignal): Promise<VpkDirectory> {
  if (file.size < 12) fail(label, 'file is too short for a VPK header');
  const head = new DataView((await readBlobBytes(file, 0, Math.min(28, file.size), signal)).buffer);
  const version = head.getUint32(4, true), treeSize = head.getUint32(8, true);
  if (head.getUint32(0, true) !== SIGNATURE) fail(label, 'not a VPK directory (bad signature)');
  if (version !== 1 && version !== 2) fail(label, `unsupported VPK version ${version}`);
  const headerSize = version === 1 ? 12 : 28;
  if (file.size < headerSize) fail(label, 'truncated VPK v2 header');
  if (!treeSize || treeSize > maxTreeBytes) fail(label, `tree size ${treeSize} is empty or above the ${maxTreeBytes}-byte limit`);
  const dataStart = headerSize + treeSize;
  if (dataStart > file.size) fail(label, 'tree runs past the end of the file');
  let dataSize = file.size - dataStart;
  if (version === 2) {
    dataSize = head.getUint32(12, true);
    const archiveHashes = head.getUint32(16, true), otherHashes = head.getUint32(20, true), signature = head.getUint32(24, true);
    if (dataStart + dataSize + archiveHashes + otherHashes + signature !== file.size || archiveHashes % 28 || otherHashes !== 0 && otherHashes !== 48)
      fail(label, 'v2 section sizes do not add up to the file size');
    if (signature) {
      // Length-prefixed public key then signature. Parsed for bounds only, not as an authenticity check.
      const start = dataStart + dataSize + archiveHashes + otherHashes;
      if (signature < 8) fail(label, 'truncated v2 signature section');
      const keySize = new DataView((await readBlobBytes(file, start, 4, signal)).buffer).getUint32(0, true);
      if (keySize > signature - 8) fail(label, 'invalid v2 signature key size');
      const signatureSize = new DataView((await readBlobBytes(file, start + 4 + keySize, 4, signal)).buffer).getUint32(0, true);
      if (keySize + signatureSize + 8 !== signature) fail(label, 'invalid v2 signature size');
    }
  }
  const index = await readBlobBytes(file, 0, dataStart, signal);
  const check = new DataView(index.buffer);
  for (let pos = 0; pos < 12; pos += 4)
    if (check.getUint32(pos, true) !== head.getUint32(pos, true)) fail(label, 'header changed while it was being read');
  return Object.freeze({ version, headerSize, treeSize, dataStart, dataSize, index });
}

/** Walks every record in tree order. Path text is joined as Source stores it; callers canonicalize. */
export function walkVpkTree(directory: VpkDirectory, label: string, visit: (record: Readonly<VpkRecord>) => void, maxStringBytes = 4096): void {
  const { index, headerSize, dataStart, dataSize } = directory;
  const data = new DataView(index.buffer, index.byteOffset, index.byteLength);
  const end = dataStart;
  let pos = headerSize;
  const string = () => {
    const start = pos;
    while (pos < end && index[pos]) pos++;
    if (pos === end) fail(label, 'unterminated tree string');
    if (pos - start > maxStringBytes) fail(label, 'tree string is too long');
    try { return utf8.decode(index.subarray(start, pos++)); } catch { fail(label, 'tree string is not UTF-8'); }
  };
  const record: VpkRecord = { path: '', crc: 0, preloadStart: 0, preloadSize: 0, archive: 0, offset: 0, length: 0 };
  for (;;) {
    const extension = string();
    if (!extension) break;
    if (/[\\/]/.test(extension)) fail(label, `invalid extension ${JSON.stringify(extension)}`);
    for (;;) {
      const folder = string();
      if (!folder) break;
      const prefix = folder === ' ' ? '' : `${folder}/`, suffix = extension === ' ' ? '' : `.${extension}`;
      for (;;) {
        const name = string();
        if (!name) break;
        if (/[\\/]/.test(name)) fail(label, `invalid file name ${JSON.stringify(name)}`);
        const path = prefix + name + suffix;
        if (pos + 18 > end) fail(label, `truncated record for ${path}`);
        record.path = path;
        record.crc = data.getUint32(pos, true);
        record.preloadSize = data.getUint16(pos + 4, true);
        record.archive = data.getUint16(pos + 6, true);
        record.offset = data.getUint32(pos + 8, true);
        record.length = data.getUint32(pos + 12, true);
        if (data.getUint16(pos + 16, true) !== 0xffff) fail(label, `record for ${path} lacks its 0xffff terminator`);
        if (record.archive > VPK_EMBEDDED_ARCHIVE) fail(label, `record for ${path} has archive index ${record.archive}`);
        pos += 18;
        if (pos + record.preloadSize > end) fail(label, `preload bytes for ${path} run past the tree`);
        record.preloadStart = pos;
        pos += record.preloadSize;
        if (record.archive === VPK_EMBEDDED_ARCHIVE && record.offset + record.length > dataSize)
          fail(label, `embedded bytes for ${path} run past the embedded section`);
        visit(record);
      }
    }
  }
  if (pos !== end) fail(label, 'unexpected bytes after the tree');
}

const crcTable = Uint32Array.from({ length: 256 }, (_, n) => {
  for (let i = 0; i < 8; i++) n = n & 1 ? 0xedb88320 ^ (n >>> 1) : n >>> 1;
  return n >>> 0;
});
export function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) crc = crcTable[(crc ^ bytes[i]) & 255] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}
