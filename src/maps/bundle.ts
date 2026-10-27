/** Browser-local converted maps. ZIP metadata is read separately from resource bodies. */
import { BoundedInflate, deflateFeedBytes } from './deflate';
import { mapXmlReferences, parseMapXml } from './xml.mjs';

export interface MapBundleResource {
  path: string;
  bytes: number;
  sha256: string;
}
export interface MapBundleIndex {
  format: 'm0clip-map';
  version: 1;
  name: string;
  game: string;
  entry: 'manifest.json';
  resources: readonly MapBundleResource[];
}
export interface DecodedMapBundle {
  id: string;
  fingerprint: string;
  index: MapBundleIndex;
  files: ReadonlyMap<string, Blob>;
}

const wrapper = 'm0clip-map.json';
const maxMetadata = 16 * 1024 * 1024;
const utf8 = new TextDecoder('utf-8', { fatal: true });
const encoder = new TextEncoder();
interface ZipEntry {
  path: string; flags: number; method: number; crc: number;
  compressed: number; bytes: number; offset: number;
}
function aborted(signal?: AbortSignal) { signal?.throwIfAborted(); }
function fail(message: string): never { throw new Error(`Map bundle: ${message}`); }
function pathName(value: unknown): string {
  if (typeof value !== 'string' || !value || value !== value.normalize('NFC') ||
      /[\\:%?#\u0000-\u001f\u007f]/.test(value) || value.startsWith('/') ||
      value.split('/').some(part => !part || part === '.' || part === '..')) fail(`unsafe resource path ${JSON.stringify(value)}`);
  return value;
}
function dependency(value: unknown, base: string): string | null {
  if (typeof value !== 'string' || !value) fail(`invalid dependency in ${base}`);
  if (value.startsWith('data:')) return null; // glTF embeds some images/buffers directly.
  if (/[\\:%?#\u0000-\u001f\u007f]/.test(value) || value.startsWith('/')) fail(`unsafe dependency ${value} in ${base}`);
  const parts = base.split('/').slice(0, -1);
  for (const part of value.split('/')) {
    if (part === '..') { if (!parts.length) fail(`dependency escapes map root: ${value} in ${base}`); parts.pop(); }
    else if (part !== '.') { if (!part) fail(`invalid dependency ${value} in ${base}`); parts.push(part); }
  }
  return pathName(parts.join('/'));
}
interface BundlePathNode { file: boolean; children?: Map<string, BundlePathNode> }
/** Visit each component once, without rebuilding complete ancestor prefixes. */
function validateAncestors(paths: Iterable<string>, signal?: AbortSignal) {
  const maxNodes = 262144;
  let nodes = 1;
  const root: BundlePathNode = { file: false };
  for (const path of paths) {
    aborted(signal);
    let node = root, start = 0;
    while (start < path.length) {
      aborted(signal);
      if (node.file) fail(`file/directory path conflict: ${path}`);
      const slash = path.indexOf('/', start), end = slash < 0 ? path.length : slash;
      const component = path.slice(start, end).toLowerCase();
      let child = node.children?.get(component);
      if (!child) {
        if (nodes >= maxNodes) fail('resource path component limit exceeded');
        nodes++; child = { file: false };
        node.children ??= new Map(); node.children.set(component, child);
      }
      node = child; start = end + 1;
    }
    if (node.children?.size) fail(`file/directory path conflict: ${path}`);
    node.file = true;
  }
}
function view(bytes: Uint8Array) { return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength); }
async function read(file: Blob, start: number, length: number, signal?: AbortSignal) {
  aborted(signal);
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(length) || start < 0 || length < 0 || start + length > file.size) fail('truncated ZIP');
  const result = new Uint8Array(await file.slice(start, start + length).arrayBuffer());
  aborted(signal);
  if (result.length !== length) fail('truncated ZIP read');
  return result;
}
function extraFields(bytes: Uint8Array, path: string) {
  const data = view(bytes);
  for (let pos = 0; pos < bytes.length;) {
    if (pos + 4 > bytes.length) fail(`invalid ZIP extra field: ${path}`);
    const id = data.getUint16(pos, true), size = data.getUint16(pos + 2, true);
    if (id === 1) fail(`ZIP64 is unsupported (${path}); create an ordinary ZIP under 4 GiB`);
    if (id === 0x7075) fail(`alternate ZIP path metadata is unsupported (${path}); use UTF-8 ZIP names`);
    pos += size + 4;
    if (pos > bytes.length) fail(`truncated ZIP extra field: ${path}`);
  }
}
async function directory(file: Blob, signal?: AbortSignal) {
  if (file.size < 22) fail('not an ordinary ZIP');
  const tail = await read(file, Math.max(0, file.size - 65557), Math.min(file.size, 65557), signal);
  const data = view(tail);
  let end = -1;
  for (let pos = tail.length - 22; pos >= 0; pos--) {
    if (data.getUint32(pos, true) === 0x06054b50 && pos + 22 + data.getUint16(pos + 20, true) === tail.length) { end = pos; break; }
  }
  if (end < 0) fail('ZIP end directory is missing or truncated');
  const count = data.getUint16(end + 10, true), size = data.getUint32(end + 12, true), offset = data.getUint32(end + 16, true);
  if (count === 65535 || size === 0xffffffff || offset === 0xffffffff) fail('ZIP64 is unsupported; create an ordinary ZIP under 4 GiB');
  if (data.getUint16(end + 4, true) || data.getUint16(end + 6, true) || data.getUint16(end + 8, true) !== count) fail('multi-disk ZIP is unsupported');
  const endOffset = file.size - tail.length + end;
  if (size > maxMetadata || offset + size !== endOffset) fail('invalid or oversized ZIP central directory');
  const central = await read(file, offset, size, signal), cd = view(central);
  const entries = new Map<string, ZipEntry>(), names = new Set<string>();
  let pos = 0;
  for (let i = 0; i < count; i++) {
    aborted(signal);
    if (pos + 46 > size || cd.getUint32(pos, true) !== 0x02014b50) fail('invalid ZIP central directory entry');
    const flags = cd.getUint16(pos + 8, true), method = cd.getUint16(pos + 10, true);
    const nameSize = cd.getUint16(pos + 28, true), extraSize = cd.getUint16(pos + 30, true), commentSize = cd.getUint16(pos + 32, true);
    const next = pos + 46 + nameSize + extraSize + commentSize;
    if (next > size) fail('truncated ZIP central directory entry');
    const nameBytes = central.subarray(pos + 46, pos + 46 + nameSize);
    if (!(flags & 0x800) && nameBytes.some(byte => byte > 127)) fail('non-UTF-8 ZIP names are unsupported; repack with UTF-8 names');
    const name = utf8.decode(nameBytes), isDirectory = name.endsWith('/');
    const path = pathName(isDirectory ? name.slice(0, -1) : name), key = path.toLowerCase();
    if (names.has(key)) fail(`duplicate or ambiguous ZIP path: ${path}`);
    names.add(key);
    if (flags & ~0x80e || (method !== 0 && method !== 8)) fail(`unsupported ZIP compression/encryption for ${path}; use stored or Deflate entries`);
    const mode = cd.getUint32(pos + 38, true) >>> 16, kind = mode & 0xf000;
    if (kind && kind !== 0x8000 && kind !== 0x4000) fail(`non-regular ZIP entry (including symlink): ${path}`);
    if (Boolean(cd.getUint32(pos + 38, true) & 0x10) && !isDirectory || kind === 0x4000 && !isDirectory) fail(`directory masquerades as a file: ${path}`);
    const entry: ZipEntry = { path, flags, method, crc: cd.getUint32(pos + 16, true), compressed: cd.getUint32(pos + 20, true), bytes: cd.getUint32(pos + 24, true), offset: cd.getUint32(pos + 42, true) };
    if (cd.getUint16(pos + 34, true) || entry.bytes === 0xffffffff || entry.compressed === 0xffffffff || entry.offset === 0xffffffff) fail(`unsupported split/ZIP64 entry: ${path}`);
    if (entry.offset + 30 + entry.compressed > offset || method === 0 && entry.bytes !== entry.compressed) fail(`invalid ZIP size/offset: ${path}`);
    extraFields(central.subarray(pos + 46 + nameSize, pos + 46 + nameSize + extraSize), path);
    if (!isDirectory) entries.set(path, entry);
    else if (entry.bytes || entry.compressed) fail(`nonempty ZIP directory: ${path}`);
    pos = next;
  }
  if (pos !== size) fail('unexpected data in ZIP central directory');
  // A file cannot also be an ancestor directory of another file.
  validateAncestors(entries.keys(), signal);
  return { entries, offset };
}
const crcTable = Uint32Array.from({ length: 256 }, (_, n) => {
  for (let i = 0; i < 8; i++) n = n & 1 ? 0xedb88320 ^ (n >>> 1) : n >>> 1;
  return n >>> 0;
});
const contentTypes: Readonly<Record<string, string>> = {
  json: 'application/json', xml: 'application/xml', gltf: 'model/gltf+json', glb: 'model/gltf-binary',
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', avif: 'image/avif',
  gif: 'image/gif', ktx2: 'image/ktx2', gz: 'application/gzip',
};
function contentType(path: string) {
  const extension = path.slice(path.lastIndexOf('.') + 1).toLowerCase();
  return contentTypes[extension] ?? 'application/octet-stream';
}
async function extract(file: Blob, entry: ZipEntry, centralOffset: number, signal?: AbortSignal) {
  const header = await read(file, entry.offset, 30, signal), data = view(header);
  const nameSize = data.getUint16(26, true), extraSize = data.getUint16(28, true);
  if (data.getUint32(0, true) !== 0x04034b50 || data.getUint16(6, true) !== entry.flags || data.getUint16(8, true) !== entry.method) fail(`inconsistent ZIP local header: ${entry.path}`);
  const metadata = await read(file, entry.offset + 30, nameSize + extraSize, signal);
  if (utf8.decode(metadata.subarray(0, nameSize)) !== entry.path) fail(`inconsistent ZIP local path: ${entry.path}`);
  extraFields(metadata.subarray(nameSize), entry.path);
  if (!(entry.flags & 8) && (data.getUint32(14, true) !== entry.crc || data.getUint32(18, true) !== entry.compressed || data.getUint32(22, true) !== entry.bytes)) fail(`inconsistent ZIP local sizes/CRC: ${entry.path}`);
  const start = entry.offset + 30 + nameSize + extraSize;
  if (start + entry.compressed > centralOffset) fail(`truncated ZIP body: ${entry.path}`);
  if (entry.flags & 8) {
    const end = start + entry.compressed;
    if (end + 12 > centralOffset) fail(`truncated ZIP data descriptor: ${entry.path}`);
    const marker = view(await read(file, end, 4, signal)).getUint32(0, true);
    const skip = marker === 0x08074b50 ? 4 : 0;
    if (end + skip + 12 > centralOffset) fail(`truncated ZIP data descriptor: ${entry.path}`);
    const descriptor = view(await read(file, end + skip, 12, signal));
    if (descriptor.getUint32(0, true) !== entry.crc || descriptor.getUint32(4, true) !== entry.compressed || descriptor.getUint32(8, true) !== entry.bytes) fail(`inconsistent ZIP data descriptor: ${entry.path}`);
  }
  let size = 0, crc = 0xffffffff;
  const chunks: BlobPart[] = [];
  const consume = (chunk: Uint8Array) => {
    aborted(signal);
    if (chunk.length > entry.bytes - size) fail(`inflated size exceeds declared bytes: ${entry.path}`);
    size += chunk.length;
    for (const byte of chunk) crc = crcTable[(crc ^ byte) & 255] ^ (crc >>> 8);
    if (entry.method !== 0 && chunk.length) chunks.push(chunk as BlobPart);
  };
  const inflate = entry.method === 8 ? new BoundedInflate(entry.compressed, entry.bytes, consume, signal) : null;
  const feedBytes = inflate ? deflateFeedBytes : 16384;
  try {
    for (let pos = 0; pos < entry.compressed; pos += feedBytes) {
      const body = await read(file, start + pos, Math.min(feedBytes, entry.compressed - pos), signal);
      if (inflate) inflate.push(body); else consume(body);
    }
    inflate?.finish();
  } catch (error) {
    aborted(signal);
    fail(`cannot inflate ${entry.path}: ${error instanceof Error ? error.message : String(error)}`);
  }
  aborted(signal);
  if (size !== entry.bytes || ((crc ^ 0xffffffff) >>> 0) !== entry.crc) fail(`wrong bytes/CRC or truncated body: ${entry.path}`);
  return entry.method === 0 ? file.slice(start, start + entry.bytes, contentType(entry.path)) : new Blob(chunks, { type: contentType(entry.path) });
}
function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`invalid ${label}`);
  return value as Record<string, unknown>;
}
async function json(blob: Blob, path: string, signal?: AbortSignal): Promise<Record<string, unknown>> {
  aborted(signal);
  try {
    const text = await blob.text();
    aborted(signal);
    return record(JSON.parse(text), path);
  } catch (error) { aborted(signal); fail(`invalid JSON in ${path}: ${error instanceof Error ? error.message : String(error)}`); }
}
function indexOf(value: Record<string, unknown>, signal?: AbortSignal): MapBundleIndex {
  if (value.format !== 'm0clip-map' || value.version !== 1 || value.entry !== 'manifest.json') fail('unsupported m0clip-map.json format/version/entry (expected m0clip-map version 1)');
  for (const field of ['name', 'game']) if (typeof value[field] !== 'string' || !(value[field] as string).trim() || (value[field] as string).length > 256 || /[\u0000-\u001f\u007f]/.test(value[field] as string)) fail(`invalid bundle ${field}`);
  if (!Array.isArray(value.resources) || !value.resources.length || value.resources.length > 65534) fail('invalid resource list');
  const names = new Set<string>();
  const resources = value.resources.map(item => {
    const resource = record(item, 'resource'), path = pathName(resource.path), key = path.toLowerCase();
    if (path === wrapper || names.has(key)) fail(`duplicate/reserved resource path: ${path}`);
    if (/\.(?:zip|7z|rar|tar|tgz|tbz2?|txz|bz2|xz)(?:\.gz)?$/i.test(path)) fail(`archive cannot be a map dependency: ${path}`);
    names.add(key);
    if (!Number.isSafeInteger(resource.bytes) || (resource.bytes as number) < 0 || (resource.bytes as number) >= 0xffffffff) fail(`invalid byte count: ${path}`);
    if (typeof resource.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(resource.sha256)) fail(`invalid SHA256: ${path}`);
    return Object.freeze({ path, bytes: resource.bytes as number, sha256: resource.sha256 });
  });
  for (const required of ['manifest.json', 'map.xml']) if (!resources.some(resource => resource.path === required)) fail(`required resource is missing: ${required}`);
  validateAncestors(names, signal);
  return Object.freeze({ format: 'm0clip-map', version: 1, name: value.name as string, game: value.game as string, entry: 'manifest.json', resources: Object.freeze(resources) });
}
async function inspect(file: Blob, signal?: AbortSignal) {
  aborted(signal);
  const zip = await directory(file, signal), entry = zip.entries.get(wrapper);
  if (!entry) fail(`${wrapper} is missing; choose a converted-map bundle`);
  if (entry.bytes > maxMetadata) fail(`${wrapper} is too large`);
  const index = indexOf(await json(await extract(file, entry, zip.offset, signal), wrapper, signal), signal);
  for (const resource of index.resources) {
    const actual = zip.entries.get(resource.path);
    if (!actual) fail(`declared resource is missing: ${resource.path}`);
    if (actual.bytes !== resource.bytes) fail(`wrong declared byte count: ${resource.path}`);
  }
  aborted(signal);
  return { ...zip, index };
}
/** Reads the directory and wrapper only, never inflating the models or textures. */
export async function inspectMapBundle(file: Blob, signal?: AbortSignal): Promise<MapBundleIndex> {
  return (await inspect(file, signal)).index;
}
async function hash(blob: Blob, signal?: AbortSignal) {
  aborted(signal);
  const bytes = await blob.arrayBuffer();
  aborted(signal);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  aborted(signal);
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}
async function gltf(blob: Blob, path: string, signal?: AbortSignal) {
  if (path.endsWith('.gltf')) return json(blob, path, signal);
  const bytes = await read(blob, 0, 20, signal), data = view(bytes);
  if (data.getUint32(0, true) !== 0x46546c67 || data.getUint32(4, true) !== 2 || data.getUint32(8, true) !== blob.size || data.getUint32(16, true) !== 0x4e4f534a || data.getUint32(12, true) > blob.size - 20) fail(`invalid GLB: ${path}`);
  return json(blob.slice(20, 20 + data.getUint32(12, true)), path, signal);
}
/** Mirrors build_startup_catalogue's selected mapVisuals and GLTF URI edges,
 * adding manifest.files (the independent physics closure). No directory scans. */
async function validateDependencies(files: ReadonlyMap<string, Blob>, signal?: AbortSignal) {
  const manifest = await json(files.get('manifest.json')!, 'manifest.json', signal);
  let xmlCharacters = 0;
  let xmlAllocation = 0;
  const xmlAllocationLimit = 64 * 1024 * 1024;
  const reserveXml = (bytes: number) => {
    aborted(signal);
    if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > xmlAllocationLimit - xmlAllocation)
      throw new RangeError('Map XML metadata allocation limit exceeded');
    xmlAllocation += bytes;
  };
  const xmlOptions = { signal, maxAllocationBytes: xmlAllocationLimit, reserve: reserveXml };
  const xml = async (blob: Blob) => {
    aborted(signal);
    reserveXml(blob.size * 3 + 1024);
    const text = await blob.text();
    aborted(signal);
    return text;
  };
  const required = new Set<string>(['manifest.json', 'map.xml']);
  function add(value: unknown, base = 'manifest.json', embedded = false) {
    const path = dependency(value, base);
    if (path === null) { if (!embedded) fail(`embedded URI is not valid in ${base}`); return; }
    if (!files.has(path)) fail(`missing dependency ${path} (from ${base})`);
    required.add(path);
  }
  if (!Array.isArray(manifest.files) || !manifest.files.includes('map.xml')) fail('manifest.json files must include map.xml');
  const physics = new Set(manifest.files.map(pathName));
  for (const path of physics) add(path);
  const rootXml = await xml(files.get('map.xml')!);
  aborted(signal);
  const rootElements = parseMapXml(rootXml, 'map.xml', xmlOptions);
  const compiler = rootElements.find(element => element.name === 'compiler')?.attributes ?? {};
  const native = manifest.native_textures === undefined ? {} : record(manifest.native_textures, 'native_textures');
  add(native.visual ?? manifest.visual ?? 'visual.glb');
  if (manifest.props !== undefined) {
    const props = record(manifest.props, 'props');
    if (props.visual === 'props.glb') add(native.props ?? props.visual);
  }
  for (const path of ['lighting.json', 'lightstyles.json']) if (files.has(path)) add(path);
  if (manifest.visibility !== undefined) add(manifest.visibility);
  if (manifest.color_corrections !== undefined) {
    if (!Array.isArray(manifest.color_corrections)) fail('invalid color_corrections');
    for (const layer of manifest.color_corrections) add(record(layer, 'color correction').file);
  }
  for (const path of required) {
    aborted(signal);
    const blob = files.get(path)!;
    if (/\.(?:glb|gltf)$/.test(path)) {
      const document = await gltf(blob, path, signal);
      for (const field of ['buffers', 'images']) {
        if (document[field] === undefined) continue;
        if (!Array.isArray(document[field])) fail(`invalid ${field} in ${path}`);
        for (const item of document[field] as unknown[]) {
          const uri = record(item, `${field} in ${path}`).uri;
          if (uri !== undefined) add(uri, path, true);
        }
      }
    } else if (path === 'lightstyles.json') {
      const styles = await json(blob, path, signal);
      for (const page of Object.values(record(styles.pages, 'lightstyle pages'))) add(page, path);
    } else if (path.endsWith('.xml')) {
      const text = path === 'map.xml' ? rootXml : await xml(blob);
      aborted(signal);
      const elements = path === 'map.xml' ? rootElements : parseMapXml(text, path, xmlOptions);
      for (const reference of mapXmlReferences(elements, path, compiler, {
        signal, maxExpandedCharacters: maxMetadata - xmlCharacters,
        reserve(characters) { reserveXml(characters * 64 + 256); xmlCharacters += characters; },
      })) {
        const file = dependency(reference.value, reference.base);
        if (file === null) fail(`embedded URI is not valid in ${path}`);
        if (!physics.has(file)) fail(`physics dependency ${file} (from ${path}) is absent from manifest.json files`);
        add(file);
      }
    }
  }
}
/** Verifies each declared body before exposing any map resources or identity. */
export async function decodeMapBundle(file: Blob, signal?: AbortSignal): Promise<DecodedMapBundle> {
  const { index, entries, offset } = await inspect(file, signal);
  const files = new Map<string, Blob>();
  for (const resource of index.resources) {
    aborted(signal);
    const blob = await extract(file, entries.get(resource.path)!, offset, signal);
    if (blob.size !== resource.bytes || await hash(blob, signal) !== resource.sha256) fail(`wrong bytes or SHA256: ${resource.path}`);
    files.set(resource.path, blob);
  }
  await validateDependencies(files, signal);
  const canonical = { ...index, resources: [...index.resources].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0) };
  const fingerprint = await hash(new Blob([encoder.encode(JSON.stringify(canonical))]), signal);
  aborted(signal);
  return { id: `local-${fingerprint}`, fingerprint, index, files };
}
