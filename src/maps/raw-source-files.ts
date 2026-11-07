/**
 * Explicit, import-scoped Source mounts. No discovery, network access, URLs or script execution.
 * Supports VPK 1/2, uncompressed GMAD 3, ordinary stored/Deflate ZIP and loose Blobs.
 * Import-owned metadata, path-index, retained-resource and extraction-workspace budgets.
 * CRC is verified only for selected resources; archive MD5/signatures and the optional GMA
 * whole-archive footer are not authenticity checks. No archive payload is executed.
 */
import { BoundedInflate, deflateFeedBytes, deflateWorkspaceBytes } from './deflate';

export interface SourceLooseFile { readonly path: string; readonly blob: Blob }
export interface SourceVpkChunk { readonly index: number; readonly blob: Blob }
/** Mount order is authoritative: current-map pak, loose root, then explicitly ordered companions. */
export type SourceMount =
  | { readonly kind: 'loose'; readonly label?: string; readonly files: readonly SourceLooseFile[] }
  | { readonly kind: 'zip' | 'gma'; readonly label?: string; readonly file: Blob }
  | { readonly kind: 'vpk'; readonly label?: string; readonly directory: Blob; readonly chunks?: readonly SourceVpkChunk[] };
export interface SourceFileInfo {
  /** Full, lower-case Source path; never URL-decoded or reduced to a basename. */
  readonly path: string;
  readonly bytes: number;
  readonly mountIndex: number;
  readonly mountLabel: string;
  readonly kind: SourceMount['kind'];
  readonly archiveIndex?: number;
  readonly missingChunk?: number;
}
export interface SourceMountInfo {
  readonly kind: SourceMount['kind'];
  readonly label: string;
  readonly fileCount: number;
  readonly requiredChunks: readonly number[];
  readonly missingChunks: readonly number[];
  /** GMA content identifiers are descriptive only: no automatic mounting/downloading. */
  readonly requiredContents: readonly string[];
  readonly addon?: Readonly<{ name: string; description: string; author: string; version: number }>;
}
export class SourceMissingChunkError extends Error {
  constructor(readonly path: string, readonly mountLabel: string, readonly chunkIndex: number) {
    super(`Source files: ${path} in ${mountLabel} needs explicitly selected VPK chunk _${String(chunkIndex).padStart(3, '0')}.vpk (archive index ${chunkIndex})`);
    this.name = 'SourceMissingChunkError';
  }
}

/** All limits belong to one explicit import; no global resource or path cache is used. */
export interface SourceFileSystemLimits {
  maxMounts: number;
  maxEntries: number;
  maxTrieNodes: number;
  maxPathDepth: number;
  maxPathLength: number;
  maxNameLength: number;
  maxExpandedPathChars: number;
  maxMetadataBytes: number;
  maxResourceBytes: number;
  /** Retained unique bodies plus concurrent extraction workspace, reserved before reads. */
  maxTotalResourceBytes: number;
  maxResources: number;
}
const defaultLimits: Readonly<SourceFileSystemLimits> = Object.freeze({
  maxMounts: 128, maxEntries: 262144, maxTrieNodes: 524288,
  maxPathDepth: 128, maxPathLength: 4096, maxNameLength: 255,
  maxExpandedPathChars: 16 * 1024 * 1024, maxMetadataBytes: 64 * 1024 * 1024,
  maxResourceBytes: 128 * 1024 * 1024, maxTotalResourceBytes: 512 * 1024 * 1024, maxResources: 16384,
});
class ImportBudget {
  readonly limits: Readonly<SourceFileSystemLimits>;
  private entries = 0;
  private nodes = 0;
  private chars = 0;
  private metadata = 0;
  constructor(options: Partial<SourceFileSystemLimits>) {
    this.limits = Object.freeze({ ...defaultLimits, ...options });
    for (const [key, value] of Object.entries(this.limits)) if (!Number.isSafeInteger(value) || value < 0) fail(`invalid ${key} limit`);
  }
  metadataBytes(bytes: number) {
    if (bytes > this.limits.maxMetadataBytes - this.metadata) fail('import metadata byte limit exceeded');
    this.metadata += bytes;
  }
  entry() {
    if (++this.entries > this.limits.maxEntries) fail('import entry limit exceeded');
  }
  node() {
    if (++this.nodes > this.limits.maxTrieNodes) fail('import trie node limit exceeded');
  }
  /** Scan components before join/normalization/split amplifies their storage. */
  path(parts: readonly string[]): string {
    this.entry();
    if (this.limits.maxPathDepth < 1) fail('path depth limit exceeded');
    let length = 0, depth = 1, nameLength = 0;
    for (const part of parts) {
      if (part.length > this.limits.maxPathLength - length) fail('path length limit exceeded');
      length += part.length;
      for (let index = 0; index < part.length; index++) {
        const code = part.charCodeAt(index);
        if (code === 47 || code === 92) {
          if (++depth > this.limits.maxPathDepth) fail('path depth limit exceeded');
          nameLength = 0;
        } else if (++nameLength > this.limits.maxNameLength) fail('path name length limit exceeded');
      }
    }
    if (length > this.limits.maxExpandedPathChars - this.chars) fail('expanded path character limit exceeded');
    this.chars += length;
    const path = canonicalSourcePath(parts.length === 1 ? parts[0] : parts.join(''));
    // Unicode lowercase can expand; charge the expansion before retaining/indexing it.
    if (path.length > length) {
      const extra = path.length - length;
      if (path.length > this.limits.maxPathLength || extra > this.limits.maxExpandedPathChars - this.chars) fail('canonical path character limit exceeded');
      this.chars += extra;
      nameLength = 0;
      for (let index = 0; index < path.length; index++) {
        if (path.charCodeAt(index) === 47) nameLength = 0;
        else if (++nameLength > this.limits.maxNameLength) fail('canonical path name length limit exceeded');
      }
    }
    return path;
  }
}
const maxMetadata = 64 * 1024 * 1024;
const blockSize = 64 * 1024;
const utf8 = new TextDecoder('utf-8', { fatal: true });
function fail(message: string): never { throw new Error(`Source files: ${message}`); }
function aborted(signal?: AbortSignal) { signal?.throwIfAborted(); }
/** Backslashes are Source separators, not escapes; percent signs remain literal filename bytes. */
export function canonicalSourcePath(value: string): string {
  if (typeof value !== 'string' || !value || value !== value.normalize('NFC') || /[:\u0000-\u001f\u007f]/.test(value)) fail(`unsafe path ${JSON.stringify(value)}`);
  const path = value.replace(/\\/g, '/');
  if (path.startsWith('/') || path.split('/').some(part => !part || part === '.' || part === '..')) fail(`unsafe path ${JSON.stringify(value)}`);
  return path.toLowerCase().normalize('NFC');
}
function bounds(file: Blob, start: number, length: number, label: string) {
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(length) || start < 0 || length < 0 || !Number.isSafeInteger(start + length) || start + length > file.size) fail(`truncated/out-of-range ${label} (${start}+${length}, file ${file.size})`);
}
async function read(file: Blob, start: number, length: number, label: string, signal?: AbortSignal) {
  aborted(signal);
  bounds(file, start, length, label);
  const bytes = new Uint8Array(await file.slice(start, start + length).arrayBuffer());
  aborted(signal);
  if (bytes.length !== length) fail(`truncated read: ${label}`);
  return bytes;
}
function view(bytes: Uint8Array) { return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength); }
function text(bytes: Uint8Array, label: string) {
  try { return utf8.decode(bytes); } catch { fail(`invalid UTF-8 ${label}`); }
}
const crcTable = Uint32Array.from({ length: 256 }, (_, n) => {
  for (let bit = 0; bit < 8; bit++) n = n & 1 ? 0xedb88320 ^ (n >>> 1) : n >>> 1;
  return n >>> 0;
});
function updateCrc(crc: number, bytes: Uint8Array) {
  for (const byte of bytes) crc = crcTable[(crc ^ byte) & 255] ^ (crc >>> 8);
  return crc;
}
async function verify(blob: Blob, crc: number, path: string, signal?: AbortSignal) {
  let actual = 0xffffffff;
  for (let pos = 0; pos < blob.size; pos += blockSize) actual = updateCrc(actual, await read(blob, pos, Math.min(blockSize, blob.size - pos), path, signal));
  aborted(signal);
  if (((actual ^ 0xffffffff) >>> 0) !== crc) fail(`CRC mismatch: ${path}`);
  return blob;
}
interface Entry {
  path: string;
  bytes: number;
  archiveIndex?: number;
  missingChunk?: number;
  /** Temporary input/output ownership beyond the retained Blob. */
  workingBytes?: number;
  load: (signal?: AbortSignal) => Promise<Blob>;
}
interface ParsedMount {
  entries: Map<string, Entry>;
  requiredChunks?: number[];
  missingChunks?: number[];
  requiredContents?: string[];
  addon?: SourceMountInfo['addon'];
}
interface PathNode {
  explicit: boolean;
  file: boolean;
  children?: Map<string, PathNode>;
}
/** Track directories as well as files, so file/ancestor and case aliases cannot hide each other. */
class Paths {
  readonly entries = new Map<string, Entry>();
  private readonly root: PathNode;
  constructor(private readonly budget: ImportBudget) {
    budget.node();
    this.root = { explicit: false, file: false };
  }
  /** Reserve expanded spelling before archive components are combined. */
  prepare(parts: readonly string[]) { return this.budget.path(parts); }
  add(name: string, entry?: Omit<Entry, 'path'>, prepared = false) {
    const path = prepared ? name : this.prepare([name]);
    let node = this.root;
    for (const part of path.split('/')) {
      if (node.file) fail(`file/directory path conflict: ${name}`);
      let children = node.children;
      let child = children?.get(part);
      if (!child) {
        this.budget.node();
        children ??= node.children = new Map<string, PathNode>();
        child = { explicit: false, file: false };
        children.set(part, child);
      }
      node = child;
    }
    if (node.explicit || entry && node.children?.size) fail(`duplicate/case-colliding or file/directory path: ${name}`);
    node.explicit = true;
    node.file = !!entry;
    if (entry) this.entries.set(path, { ...entry, path });
  }
}

/** VPK v1/v2: fixed 18-byte records, preload followed by one embedded/external range. */
async function vpk(mount: Extract<SourceMount, { kind: 'vpk' }>, label: string, budget: ImportBudget, signal?: AbortSignal): Promise<ParsedMount> {
  const file = mount.directory;
  const first = view(await read(file, 0, 12, `${label} VPK header`, signal));
  const version = first.getUint32(4, true), treeSize = first.getUint32(8, true);
  if (first.getUint32(0, true) !== 0x55aa1234 || version !== 1 && version !== 2) fail(`unsupported VPK signature/version in ${label}`);
  const headerSize = version === 1 ? 12 : 28;
  if (!treeSize || treeSize > maxMetadata) fail(`invalid/oversized VPK tree in ${label}`);
  bounds(file, headerSize, treeSize, `${label} VPK tree`);
  budget.metadataBytes(treeSize);
  const dataStart = headerSize + treeSize;
  let dataSize = file.size - dataStart;
  let archiveHashSize = 0;
  if (version === 2) {
    const header = view(await read(file, 12, 16, `${label} VPK v2 sections`, signal));
    dataSize = header.getUint32(0, true);
    const archiveMd5 = header.getUint32(4, true), otherMd5 = header.getUint32(8, true), signature = header.getUint32(12, true);
    if (dataStart + dataSize + archiveMd5 + otherMd5 + signature !== file.size || archiveMd5 % 28 || otherMd5 !== 0 && otherMd5 !== 48) fail(`invalid VPK v2 section boundaries in ${label}`);
    if (archiveMd5 > maxMetadata) fail(`oversized VPK archive-hash table in ${label}`);
    archiveHashSize = archiveMd5;
    budget.metadataBytes(archiveHashSize);
    if (signature) {
      // Length-prefixed public key and signature; signatures are not authenticity checks here.
      if (signature < 8) fail(`truncated VPK signature section in ${label}`);
      const start = dataStart + dataSize + archiveMd5 + otherMd5;
      const keySize = view(await read(file, start, 4, `${label} VPK signature key`, signal)).getUint32(0, true);
      if (keySize > signature - 8) fail(`invalid VPK signature key in ${label}`);
      const signatureSize = view(await read(file, start + 4 + keySize, 4, `${label} VPK signature size`, signal)).getUint32(0, true);
      if (keySize + signatureSize + 8 !== signature) fail(`invalid VPK signature size in ${label}`);
    }
  }
  const chunks = new Map<number, Blob>();
  for (const chunk of mount.chunks ?? []) {
    budget.entry();
    if (!Number.isInteger(chunk.index) || chunk.index < 0 || chunk.index >= 0x7fff || chunks.has(chunk.index)) fail(`invalid/duplicate selected VPK chunk index ${chunk.index} in ${label}`);
    chunks.set(chunk.index, chunk.blob);
  }
  if (archiveHashSize) {
    const hashes = view(await read(file, dataStart + dataSize, archiveHashSize, `${label} VPK archive-hash table`, signal));
    for (let pos = 0; pos < archiveHashSize; pos += 28) {
      const archive = hashes.getUint32(pos, true), start = hashes.getUint32(pos + 4, true), length = hashes.getUint32(pos + 8, true);
      if (archive > 0x7fff) fail(`invalid VPK archive-hash index in ${label}`);
      if (archive === 0x7fff) {
        if (start + length > dataSize) fail(`VPK archive-hash range exceeds embedded section in ${label}`);
      } else {
        const chunk = chunks.get(archive);
        if (chunk) bounds(chunk, start, length, `${label} VPK archive-hash range`);
      }
    }
  }
  const tree = await read(file, headerSize, treeSize, `${label} VPK tree`, signal), data = view(tree);
  let pos = 0;
  function string() {
    const start = pos;
    while (pos < tree.length && tree[pos]) pos++;
    if (pos === tree.length) fail(`unterminated VPK tree string in ${label}`);
    if (pos - start > budget.limits.maxPathLength * 4) fail(`VPK path string length limit exceeded in ${label}`);
    return text(tree.subarray(start, pos++), `${label} VPK path`);
  }
  function component(value: string, role: string) {
    if (/[\\/]/.test(value) || value === '.' || value === '..') fail(`invalid VPK ${role} in ${label}`);
    // Components cannot introduce another tree level; canonicalSourcePath validates the joined name.
  }
  const paths = new Paths(budget), required = new Set<number>();
  for (;;) {
    aborted(signal);
    const extension = string();
    if (!extension) break;
    component(extension, 'extension');
    for (;;) {
      const folder = string();
      if (!folder) break;
      if (folder !== ' ' && folder.length > budget.limits.maxPathLength) fail(`VPK folder length limit exceeded in ${label}`);
      for (;;) {
        const name = string();
        if (!name) break;
        component(name, 'filename');
        const path = paths.prepare([folder === ' ' ? '' : folder, folder === ' ' ? '' : '/', name, extension === ' ' ? '' : '.', extension === ' ' ? '' : extension]);
        if (pos + 18 > tree.length) fail(`truncated VPK record: ${path}`);
        const crc = data.getUint32(pos, true), preloadSize = data.getUint16(pos + 4, true), archive = data.getUint16(pos + 6, true);
        const offset = data.getUint32(pos + 8, true), length = data.getUint32(pos + 12, true), terminator = data.getUint16(pos + 16, true);
        pos += 18;
        if (terminator !== 0xffff || archive > 0x7fff || pos + preloadSize > tree.length) fail(`invalid VPK record/preload: ${path}`);
        const preload = file.slice(headerSize + pos, headerSize + pos + preloadSize);
        pos += preloadSize;
        const payload = archive === 0x7fff ? file : chunks.get(archive);
        const start = archive === 0x7fff ? dataStart + offset : offset;
        if (archive === 0x7fff && offset + length > dataSize) fail(`VPK embedded data exceeds its section: ${path}`);
        if (length && archive !== 0x7fff) required.add(archive);
        if (length && payload) bounds(payload, start, length, `VPK payload ${path}`);
        paths.add(path, {
          bytes: preloadSize + length, archiveIndex: archive,
          missingChunk: length && !payload ? archive : undefined,
          load: async readSignal => {
            aborted(readSignal);
            if (length && !payload) throw new SourceMissingChunkError(path, label, archive);
            const body = length ? payload!.slice(start, start + length) : new Blob();
            const result = preloadSize ? new Blob([preload, body]) : body;
            return verify(result, crc, path, readSignal);
          },
        }, true);
      }
    }
  }
  if (pos !== tree.length) fail(`unexpected trailing VPK tree bytes in ${label}`);
  const requiredChunks = [...required].sort((a, b) => a - b);
  return { entries: paths.entries, requiredChunks, missingChunks: requiredChunks.filter(index => !chunks.has(index)) };
}

/** Sequential metadata-only reader: GMA has no separate table-size header. */
class GmaCursor {
  pos = 0;
  private page = new Uint8Array();
  private pageStart = 0;
  constructor(private readonly file: Blob, private readonly label: string, private readonly budget: ImportBudget, private readonly signal?: AbortSignal) {}
  async bytes(length: number): Promise<Uint8Array> {
    if (this.pos + length > maxMetadata) fail(`oversized GMA metadata in ${this.label}`);
    bounds(this.file, this.pos, length, `${this.label} GMA metadata`);
    this.budget.metadataBytes(length);
    if (this.pos < this.pageStart || this.pos + length > this.pageStart + this.page.length) {
      this.pageStart = this.pos;
      this.page = await read(this.file, this.pos, Math.min(Math.max(blockSize, length), this.file.size - this.pos), `${this.label} GMA metadata`, this.signal);
    }
    aborted(this.signal);
    const result = this.page.subarray(this.pos - this.pageStart, this.pos - this.pageStart + length);
    this.pos += length;
    return result;
  }
  async u32() { return view(await this.bytes(4)).getUint32(0, true); }
  async u64() {
    const value = view(await this.bytes(8)).getBigUint64(0, true);
    if (value > BigInt(Number.MAX_SAFE_INTEGER)) fail(`unsafe GMA 64-bit size in ${this.label}`);
    return Number(value);
  }
  async string(path = false) {
    const parts: Uint8Array[] = [];
    let length = 0;
    for (;;) {
      if (this.pos === this.pageStart + this.page.length) {
        bounds(this.file, this.pos, 1, `${this.label} GMA string`);
        this.pageStart = this.pos;
        this.page = await read(this.file, this.pos, Math.min(blockSize, this.file.size - this.pos), `${this.label} GMA metadata`, this.signal);
      }
      const start = this.pos - this.pageStart, end = this.page.indexOf(0, start);
      const part = this.page.subarray(start, end < 0 ? this.page.length : end);
      length += part.length;
      if (length > maxMetadata || this.pos + part.length + (end < 0 ? 0 : 1) > maxMetadata) fail(`oversized GMA string in ${this.label}`);
      if (path && length > this.budget.limits.maxPathLength * 4) fail(`GMA path string length limit exceeded in ${this.label}`);
      this.budget.metadataBytes(part.length + (end < 0 ? 0 : 1));
      parts.push(part);
      this.pos += part.length;
      if (end >= 0) { this.pos++; break; }
      if (this.pos >= this.file.size) fail(`unterminated GMA string in ${this.label}`);
    }
    const result = new Uint8Array(length);
    let offset = 0;
    for (const part of parts) { result.set(part, offset); offset += part.length; }
    return text(result, `${this.label} GMA string`);
  }
}
async function gma(file: Blob, label: string, budget: ImportBudget, signal?: AbortSignal): Promise<ParsedMount> {
  const cursor = new GmaCursor(file, label, budget, signal);
  const header = await cursor.bytes(21);
  if (text(header.subarray(0, 4), `${label} GMA magic`) !== 'GMAD' || header[4] !== 3) fail(`unsupported GMA signature/version in ${label}; expected GMAD v3`);
  const requiredContents: string[] = [];
  for (;;) { const item = await cursor.string(); if (!item) break; budget.entry(); requiredContents.push(item); }
  const name = await cursor.string(), description = await cursor.string(), author = await cursor.string(), version = await cursor.u32();
  const records: { path: string; bytes: number; crc: number; offset: number }[] = [];
  let total = 0;
  for (;;) {
    const id = await cursor.u32();
    if (!id) break;
    if (id !== records.length + 1) fail(`invalid/nonsequential GMA entry id in ${label}`);
    const path = budget.path([await cursor.string(true)]), bytes = await cursor.u64(), crc = await cursor.u32();
    if (!Number.isSafeInteger(total + bytes)) fail(`unsafe GMA data size in ${label}`);
    records.push({ path, bytes, crc, offset: total });
    total += bytes;
  }
  const dataStart = cursor.pos, dataEnd = dataStart + total;
  // GMAD writers may append the whole-archive CRC; selected files always use their own CRC.
  if (!Number.isSafeInteger(dataEnd) || dataEnd !== file.size && dataEnd + 4 !== file.size) fail(`invalid GMA data boundaries in ${label}`);
  const paths = new Paths(budget);
  for (const entry of records) {
    aborted(signal);
    const path = entry.path, start = dataStart + entry.offset;
    bounds(file, start, entry.bytes, `GMA entry ${path}`);
    paths.add(path, { bytes: entry.bytes, load: async readSignal => verify(file.slice(start, start + entry.bytes), entry.crc, path, readSignal) }, true);
  }
  return { entries: paths.entries, requiredContents, addon: Object.freeze({ name, description, author, version }) };
}

interface ZipEntry { path: string; name: string; flags: number; method: number; crc: number; compressed: number; bytes: number; offset: number; limit: number; minimumEnd: number }
function zipExtras(bytes: Uint8Array, path: string) {
  const data = view(bytes);
  for (let pos = 0; pos < bytes.length;) {
    if (pos + 4 > bytes.length) fail(`invalid ZIP extra field: ${path}`);
    const id = data.getUint16(pos, true), size = data.getUint16(pos + 2, true);
    if (id === 1 || id === 0x7075) fail(`ZIP64/alternate ZIP path metadata unsupported: ${path}`);
    pos += 4 + size;
    if (pos > bytes.length) fail(`truncated ZIP extra field: ${path}`);
  }
}
async function zip(file: Blob, label: string, budget: ImportBudget, signal?: AbortSignal): Promise<ParsedMount> {
  if (file.size < 22) fail(`truncated ZIP in ${label}`);
  const tail = await read(file, Math.max(0, file.size - 65557), Math.min(file.size, 65557), `${label} ZIP end`, signal), data = view(tail);
  let end = -1;
  for (let pos = tail.length - 22; pos >= 0; pos--) {
    if (data.getUint32(pos, true) === 0x06054b50 && pos + 22 + data.getUint16(pos + 20, true) === tail.length) { end = pos; break; }
  }
  if (end < 0) fail(`missing/truncated ZIP end directory in ${label}`);
  const count = data.getUint16(end + 10, true), size = data.getUint32(end + 12, true), offset = data.getUint32(end + 16, true);
  if (count === 0xffff || size === 0xffffffff || offset === 0xffffffff) fail(`ZIP64 unsupported in ${label}`);
  if (data.getUint16(end + 4, true) || data.getUint16(end + 6, true) || data.getUint16(end + 8, true) !== count) fail(`split ZIP unsupported in ${label}`);
  if (size > maxMetadata || offset + size !== file.size - tail.length + end) fail(`invalid ZIP central directory bounds in ${label}`);
  budget.metadataBytes(size);
  if (count > budget.limits.maxEntries) fail(`ZIP entry limit exceeded in ${label}`);
  const central = await read(file, offset, size, `${label} ZIP central directory`, signal), cd = view(central);
  const paths = new Paths(budget), offsets = new Set<number>(), records: ZipEntry[] = [];
  let pos = 0;
  for (let index = 0; index < count; index++) {
    aborted(signal);
    if (pos + 46 > size || cd.getUint32(pos, true) !== 0x02014b50) fail(`invalid ZIP central entry in ${label}`);
    const flags = cd.getUint16(pos + 8, true), method = cd.getUint16(pos + 10, true);
    const nameSize = cd.getUint16(pos + 28, true), extraSize = cd.getUint16(pos + 30, true), commentSize = cd.getUint16(pos + 32, true);
    const next = pos + 46 + nameSize + extraSize + commentSize;
    if (next > size) fail(`truncated ZIP central entry in ${label}`);
    if (nameSize > budget.limits.maxPathLength * 4 + 1) fail(`ZIP path string length limit exceeded in ${label}`);
    const nameBytes = central.subarray(pos + 46, pos + 46 + nameSize);
    if (!(flags & 0x800) && nameBytes.some(byte => byte > 127)) fail(`non-UTF-8 ZIP name unsupported in ${label}`);
    const name = text(nameBytes, `${label} ZIP name`), isDirectory = /[\\/]$/.test(name);
    const path = paths.prepare([isDirectory ? name.slice(0, -1) : name]);
    if (flags & ~0x80e || method !== 0 && method !== 8) fail(`unsupported ZIP encryption/compression: ${path}`);
    const attrs = cd.getUint32(pos + 38, true), kind = (attrs >>> 16) & 0xf000;
    if (kind && kind !== 0x8000 && kind !== 0x4000 || (kind === 0x4000 || Boolean(attrs & 0x10)) && !isDirectory || kind === 0x8000 && isDirectory) fail(`non-regular/inconsistent ZIP entry: ${path}`);
    const entry: ZipEntry = { path, name, flags, method, crc: cd.getUint32(pos + 16, true), compressed: cd.getUint32(pos + 20, true), bytes: cd.getUint32(pos + 24, true), offset: cd.getUint32(pos + 42, true), limit: offset, minimumEnd: 0 };
    if (cd.getUint16(pos + 34, true) || entry.offset === 0xffffffff || entry.bytes === 0xffffffff || entry.compressed === 0xffffffff || entry.offset + 30 + entry.compressed > offset || method === 0 && entry.bytes !== entry.compressed || offsets.has(entry.offset)) fail(`invalid/split/overlapping ZIP entry: ${path}`);
    offsets.add(entry.offset);
    entry.minimumEnd = entry.offset + 30 + nameSize + entry.compressed + (flags & 8 ? 12 : 0);
    records.push(entry);
    zipExtras(central.subarray(pos + 46 + nameSize, pos + 46 + nameSize + extraSize), path);
    if (isDirectory) {
      if (entry.bytes || entry.compressed) fail(`nonempty ZIP directory: ${path}`);
      paths.add(path, undefined, true);
    } else paths.add(path, { bytes: entry.bytes, workingBytes: entry.method === 8 ? entry.bytes + deflateWorkspaceBytes : 2 * 65535 + 46 + Math.min(blockSize, entry.bytes), load: readSignal => extractZip(file, entry, readSignal) }, true);
    pos = next;
  }
  if (pos !== size) fail(`trailing ZIP central directory data in ${label}`);
  records.sort((a, b) => a.offset - b.offset);
  for (let index = 0; index < records.length; index++) {
    const entry = records[index];
    entry.limit = records[index + 1]?.offset ?? offset;
    if (entry.minimumEnd > entry.limit) fail(`overlapping ZIP local records: ${entry.path}`);
  }
  return { entries: paths.entries };
}

async function extractZip(file: Blob, entry: ZipEntry, signal?: AbortSignal) {
  const header = view(await read(file, entry.offset, 30, `ZIP local header ${entry.path}`, signal));
  if (header.getUint32(0, true) !== 0x04034b50 || header.getUint16(6, true) !== entry.flags || header.getUint16(8, true) !== entry.method) fail(`inconsistent ZIP local header: ${entry.path}`);
  const nameSize = header.getUint16(26, true), extraSize = header.getUint16(28, true);
  const start = entry.offset + 30 + nameSize + extraSize;
  if (start + entry.compressed > entry.limit) fail(`truncated/overlapping ZIP body: ${entry.path}`);
  const metadata = await read(file, entry.offset + 30, nameSize + extraSize, `ZIP local metadata ${entry.path}`, signal);
  if (text(metadata.subarray(0, nameSize), entry.path) !== entry.name) fail(`inconsistent ZIP local path: ${entry.path}`);
  zipExtras(metadata.subarray(nameSize), entry.path);
  if (!(entry.flags & 8) && (header.getUint32(14, true) !== entry.crc || header.getUint32(18, true) !== entry.compressed || header.getUint32(22, true) !== entry.bytes)) fail(`inconsistent ZIP local sizes/CRC: ${entry.path}`);
  if (entry.flags & 8) {
    const end = start + entry.compressed;
    if (end + 12 > entry.limit) fail(`truncated ZIP descriptor: ${entry.path}`);
    const marker = view(await read(file, end, 4, `ZIP descriptor ${entry.path}`, signal)).getUint32(0, true), skip = marker === 0x08074b50 ? 4 : 0;
    if (end + skip + 12 > entry.limit) fail(`truncated ZIP descriptor: ${entry.path}`);
    const descriptor = view(await read(file, end + skip, 12, `ZIP descriptor ${entry.path}`, signal));
    if (descriptor.getUint32(0, true) !== entry.crc || descriptor.getUint32(4, true) !== entry.compressed || descriptor.getUint32(8, true) !== entry.bytes) fail(`inconsistent ZIP descriptor: ${entry.path}`);
  }
  if (entry.method === 0) return verify(file.slice(start, start + entry.bytes), entry.crc, entry.path, signal);
  const output = new Uint8Array(entry.bytes);
  let size = 0, crc = 0xffffffff;
  const inflate = new BoundedInflate(entry.compressed, entry.bytes, chunk => {
    output.set(chunk, size);
    size += chunk.length;
    crc = updateCrc(crc, chunk);
  }, signal);
  try {
    for (let pos = 0; pos < entry.compressed; pos += deflateFeedBytes) {
      const bytes = await read(file, start + pos, Math.min(deflateFeedBytes, entry.compressed - pos), `ZIP body ${entry.path}`, signal);
      inflate.push(bytes);
    }
    inflate.finish();
  } catch (error) {
    aborted(signal);
    fail(`cannot inflate ${entry.path}: ${error instanceof Error ? error.message : String(error)}`);
  }
  aborted(signal);
  if (size !== entry.bytes || ((crc ^ 0xffffffff) >>> 0) !== entry.crc) fail(`wrong ZIP size/CRC: ${entry.path}`);
  return new Blob([output as BlobPart]);
}

interface ResourceRead {
  readonly controller: AbortController;
  readonly promise: Promise<Blob>;
  waiters: number;
  settled: boolean;
  reserved: number;
}
export class SourceFileSystem {
  /** Effective BSP entries, with full paths and missing-chunk information; caller chooses explicitly. */
  readonly mapCandidates: readonly SourceFileInfo[];
  private readonly reads = new Map<string, ResourceRead>();
  private ownedBytes = 0;
  private ownedResources = 0;
  private constructor(
    private readonly selected: ReadonlyMap<string, Entry>,
    readonly files: readonly SourceFileInfo[],
    readonly mounts: readonly SourceMountInfo[],
    private readonly limits: Readonly<SourceFileSystemLimits>,
  ) { this.mapCandidates = Object.freeze(files.filter(file => file.path.endsWith('.bsp'))); }
  static async create(mounts: readonly SourceMount[], signal?: AbortSignal, options: Partial<SourceFileSystemLimits> = {}): Promise<SourceFileSystem> {
    aborted(signal);
    const budget = new ImportBudget(options);
    if (mounts.length > budget.limits.maxMounts) fail('import mount limit exceeded');
    const selected = new Map<string, Entry>(), files: SourceFileInfo[] = [], summaries: SourceMountInfo[] = [];
    for (let index = 0; index < mounts.length; index++) {
      aborted(signal);
      const mount = mounts[index], label = mount.label ?? `${mount.kind} mount ${index + 1}`;
      let parsed: ParsedMount;
      if (mount.kind === 'loose') {
        const paths = new Paths(budget);
        for (const { path, blob } of mount.files) {
          aborted(signal);
          paths.add(path, { bytes: blob.size, workingBytes: 0, load: async readSignal => { aborted(readSignal); return blob; } });
        }
        parsed = { entries: paths.entries };
      } else if (mount.kind === 'vpk') parsed = await vpk(mount, label, budget, signal);
      else if (mount.kind === 'gma') parsed = await gma(mount.file, label, budget, signal);
      else if (mount.kind === 'zip') parsed = await zip(mount.file, label, budget, signal);
      else fail('unsupported mount kind');
      summaries.push(Object.freeze({ kind: mount.kind, label, fileCount: parsed.entries.size,
        requiredChunks: Object.freeze(parsed.requiredChunks ?? []), missingChunks: Object.freeze(parsed.missingChunks ?? []),
        requiredContents: Object.freeze(parsed.requiredContents ?? []), addon: parsed.addon }));
      for (const entry of parsed.entries.values()) if (!selected.has(entry.path)) {
        selected.set(entry.path, entry);
        files.push(Object.freeze({ path: entry.path, bytes: entry.bytes, mountIndex: index, mountLabel: label, kind: mount.kind,
          archiveIndex: entry.archiveIndex, missingChunk: entry.missingChunk }));
      }
    }
    aborted(signal);
    return new SourceFileSystem(selected, Object.freeze(files), Object.freeze(summaries), budget.limits);
  }
  /** Absence is undefined; selected corruption never falls through. Successful unique bodies
   * remain import-owned. Failed/all-cancelled reads release reservations and may be retried.
   * A caller's cancellation never aborts another waiter or invalidates a retained body. */
  async readFile(path: string, signal?: AbortSignal, maxBytes = this.limits.maxResourceBytes): Promise<Blob | undefined> {
    aborted(signal);
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) fail('invalid resource read byte allowance');
    // Bound caller-controlled normalization work as well as indexed archive paths.
    if (path.length > this.limits.maxPathLength) fail('path length limit exceeded');
    const canonical = canonicalSourcePath(path), entry = this.selected.get(canonical);
    if (!entry) return undefined;
    if (entry.bytes > maxBytes || entry.bytes > this.limits.maxResourceBytes) fail(`resource byte allowance exceeded: ${canonical}`);
    let resource = this.reads.get(canonical);
    if (!resource) {
      if (this.ownedResources >= this.limits.maxResources) fail('import retained resource count limit exceeded');
      const reserved = entry.bytes + (entry.workingBytes ?? Math.min(blockSize, entry.bytes));
      if (!Number.isSafeInteger(reserved) || reserved > this.limits.maxTotalResourceBytes - this.ownedBytes) fail('import resource ownership byte limit exceeded');
      this.ownedBytes += reserved;
      this.ownedResources++;
      const controller = new AbortController();
      const pending: ResourceRead = {
        controller, waiters: 0, settled: false, reserved,
        promise: Promise.resolve().then(() => entry.load(controller.signal)).then(blob => {
          aborted(controller.signal);
          if (blob.size !== entry.bytes) fail(`resource size changed: ${canonical}`);
          pending.settled = true;
          this.ownedBytes -= pending.reserved - entry.bytes;
          pending.reserved = entry.bytes;
          return blob;
        }).catch(error => {
          pending.settled = true;
          this.ownedBytes -= pending.reserved;
          this.ownedResources--;
          pending.reserved = 0;
          if (this.reads.get(canonical) === pending) this.reads.delete(canonical);
          throw error;
        }),
      };
      resource = pending;
      this.reads.set(canonical, pending);
    }
    const current = resource;
    current.waiters++;
    return new Promise<Blob>((resolve, reject) => {
      let finished = false;
      const finish = (error?: unknown, blob?: Blob) => {
        if (finished) return;
        finished = true;
        signal?.removeEventListener('abort', cancel);
        current.waiters--;
        if (!current.waiters && !current.settled) {
          current.controller.abort();
          // Retain the reservation until the old extraction actually stops.
          if (this.reads.get(canonical) === current) this.reads.delete(canonical);
        }
        if (error !== undefined) reject(error);
        else resolve(blob!);
      };
      const cancel = () => finish(signal!.reason);
      signal?.addEventListener('abort', cancel, { once: true });
      current.promise.then(blob => finish(undefined, blob), error => finish(error));
      if (signal?.aborted) cancel();
    });
  }
}
