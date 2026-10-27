#!/usr/bin/env node
/** Package only a converted map's selected visual + physics dependency graph.
 * Usage: node scripts/package_map.mjs MAP_DIRECTORY --output MAP.zip [--name NAME] [--game GAME]
 * Existing outputs are never overwritten. No directory scan or source-data copy.
 * @typedef {import('../src/maps/bundle').MapBundleIndex} MapBundleIndex
 */
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { open, unlink } from 'node:fs/promises';
import { resolve, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Zip, ZipPassThrough } from 'fflate';
import { assetKey } from './build_startup_catalogue.mjs';
import { mapXmlReferences, parseMapXml } from '../src/maps/xml.mjs';

const wrapper = 'm0clip-map.json';
const maxMetadata = 16 * 1024 * 1024;
const allowedTypes = /\.(?:json|xml|glb|gltf|bin|png|jpe?g|webp|gif|avif|ktx2?|vtf|rgb|rgba|stl|obj|msh|skn|hfield|exr|hdr|dds|tga|bmp|tiff?)(?:\.gz)?$/i;
function pathName(value) {
  if (typeof value !== 'string' || !value || value !== value.normalize('NFC') || /[\\:%?#\u0000-\u001f\u007f]/.test(value) || value.startsWith('/') || value.split('/').some(part => !part || part === '.' || part === '..')) throw Error(`Unsafe map resource path: ${JSON.stringify(value)}`);
  if (value === wrapper || !allowedTypes.test(value)) throw Error(`Not a converted-map resource: ${value}`);
  return value;
}
function reference(value, base, embedded = false) {
  if (typeof value !== 'string' || !value) throw Error(`Invalid dependency in ${base}`);
  if (value.startsWith('data:') && embedded) return null;
  if (/[\\:%?#\u0000-\u001f\u007f]/.test(value) || value.startsWith('/')) throw Error(`Unsafe dependency ${value} in ${base}`);
  // Use the startup catalogue's URL convention, with a selected virtual root.
  // Containment is checked before URL normalization can erase parent traversal.
  let depth = base.split('/').length - 1;
  for (const part of value.split('/')) {
    if (part === '..') { if (!depth--) throw Error(`Dependency escapes map root: ${value} in ${base}`); }
    else if (part !== '.') { if (!part) throw Error(`Invalid dependency ${value} in ${base}`); depth++; }
  }
  return pathName(assetKey(value, '/' + base).slice(1));
}
function object(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error(`Invalid ${label}`);
  return value;
}
/** Node lacks openat. On Linux, proc-fd child lookup provides its anchored
 * semantics: only the known descriptor link is followed; each child is no-follow. */
async function openRoot(directory) {
  if (process.platform !== 'linux' || !constants.O_DIRECTORY || !constants.O_NOFOLLOW) throw Error('Map packaging requires Linux with /proc/self/fd and no-follow directory opens');
  const flags = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;
  let parent;
  try {
    parent = await open('/', flags);
    const probe = await open(`/proc/self/fd/${parent.fd}/.`, flags);
    try {
      const expected = await parent.stat(), actual = await probe.stat();
      if (expected.dev !== actual.dev || expected.ino !== actual.ino) throw Error('/proc/self/fd does not resolve the owned directory descriptor');
    } finally { await probe.close(); }
    for (const part of resolve(directory).split('/').filter(Boolean)) {
      const previous = parent;
      parent = await open(`/proc/self/fd/${previous.fd}/${part}`, flags);
      await previous.close();
    }
    return parent;
  } catch (cause) {
    await parent?.close();
    throw Error(`Cannot anchor map directory without following symlinks; Linux with accessible /proc/self/fd is required: ${cause.message}`, { cause });
  }
}
async function openResource(root, name) {
  pathName(name);
  let parent = root;
  try {
    const parts = name.split('/');
    for (const part of parts.slice(0, -1)) {
      const previous = parent;
      parent = await open(`/proc/self/fd/${previous.fd}/${part}`, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      if (previous !== root) await previous.close();
    }
    // Nonblocking prevents a concurrently substituted FIFO from hanging before
    // the regular-file check. It does not change ordinary file streaming.
    const handle = await open(`/proc/self/fd/${parent.fd}/${parts.at(-1)}`, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const info = await handle.stat();
      if (!info.isFile() || info.size >= 0xffffffff) throw Error(`Resource is not a ZIP32 regular file: ${name}`);
      return handle;
    } catch (error) { await handle.close(); throw error; }
  } catch (cause) {
    const error = Error(`Not an owned regular map resource (symlinks are not followed): ${name}: ${cause.message}`, { cause });
    error.code = cause.code;
    throw error;
  } finally { if (parent !== root) await parent.close(); }
}
async function document(root, name, signal, metadata) {
  signal?.throwIfAborted();
  const handle = await openResource(root, name);
  try {
    const info = await handle.stat();
    let offset = 0, size = info.size;
    if (extname(name) === '.glb') {
      const header = Buffer.alloc(20);
      if ((await handle.read(header, 0, 20, 0)).bytesRead !== 20 || header.readUInt32LE(0) !== 0x46546c67 || header.readUInt32LE(4) !== 2 || header.readUInt32LE(8) !== info.size || header.readUInt32LE(16) !== 0x4e4f534a) throw Error(`Invalid GLB: ${name}`);
      offset = 20; size = header.readUInt32LE(12);
    }
    if (size > maxMetadata || offset + size > info.size) throw Error(`Oversized/truncated metadata: ${name}`);
    const bytes = Buffer.alloc(size);
    let count = 0;
    while (count < size) {
      signal?.throwIfAborted();
      const read = await handle.read(bytes, count, size - count, offset + count);
      if (!read.bytesRead) throw Error(`Truncated metadata: ${name}`);
      count += read.bytesRead;
    }
    signal?.throwIfAborted();
    metadata?.set(name, { offset, bytes: size, sha256: createHash('sha256').update(bytes).digest('hex') });
    const text = bytes.toString('utf8');
    return name.endsWith('.xml') ? text : object(JSON.parse(text), name);
  } finally { await handle.close(); }
}
/** Same selected native visuals/props, sidecars and glTF URI edges as
 * buildStartupCatalogue mapVisuals; manifest.files adds the actual physics input set. */
async function closure(root, signal) {
  const metadata = new Map();
  const manifest = await document(root, 'manifest.json', signal, metadata);
  const resources = new Set(['manifest.json', 'map.xml']), names = new Map();
  const add = (value, base = 'manifest.json', embedded = false) => {
    const path = reference(value, base, embedded);
    if (path !== null) resources.add(path);
  };
  if (!Array.isArray(manifest.files) || !manifest.files.includes('map.xml')) throw Error('manifest.json files must include map.xml');
  const physics = new Set(manifest.files.map(path => pathName(path)));
  for (const path of physics) resources.add(path);
  const rootXml = await document(root, 'map.xml', signal, metadata);
  const rootElements = parseMapXml(rootXml, 'map.xml');
  const compiler = rootElements.find(element => element.name === 'compiler')?.attributes ?? {};
  const native = manifest.native_textures === undefined ? {} : object(manifest.native_textures, 'native_textures');
  add(native.visual ?? manifest.visual ?? 'visual.glb');
  if (manifest.props !== undefined && object(manifest.props, 'props').visual === 'props.glb') add(native.props ?? manifest.props.visual);
  for (const name of ['lighting.json', 'lightstyles.json']) {
    try { const handle = await openResource(root, name); await handle.close(); resources.add(name); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  if (manifest.visibility !== undefined) add(manifest.visibility);
  if (manifest.color_corrections !== undefined) {
    if (!Array.isArray(manifest.color_corrections)) throw Error('Invalid color_corrections');
    for (const layer of manifest.color_corrections) add(object(layer, 'color correction').file);
  }
  for (const path of resources) {
    signal?.throwIfAborted();
    const key = path.toLowerCase();
    if (names.has(key) && names.get(key) !== path) throw Error(`Ambiguous resource names: ${path}, ${names.get(key)}`);
    names.set(key, path);
    if (/\.(?:glb|gltf)$/.test(path)) {
      const gltf = await document(root, path, signal, metadata);
      for (const field of ['buffers', 'images']) {
        if (gltf[field] === undefined) continue;
        if (!Array.isArray(gltf[field])) throw Error(`Invalid ${field} in ${path}`);
        for (const item of gltf[field]) if (object(item, field).uri !== undefined) add(item.uri, path, true);
      }
    } else if (path === 'lightstyles.json') {
      const styles = await document(root, path, signal, metadata);
      for (const page of Object.values(object(styles.pages, 'lightstyle pages'))) add(page, path);
    } else if (path.endsWith('.xml')) {
      const elements = path === 'map.xml' ? rootElements : parseMapXml(await document(root, path, signal, metadata), path);
      for (const edge of mapXmlReferences(elements, path, compiler)) {
        const file = reference(edge.value, edge.base);
        if (!physics.has(file)) throw Error(`Physics dependency ${file} (from ${path}) is absent from manifest.json files; regenerate the converted map's physics index`);
        resources.add(file);
      }
    }
  }
  return { manifest, resources: [...resources].sort(), metadata };
}
async function streamResource(root, path, consume, signal, metadata) {
  const handle = await openResource(root, path);
  const hash = createHash('sha256');
  const graphHash = metadata ? createHash('sha256') : null;
  let bytes = 0;
  try {
    // Each yielded chunk is owned until its ZIP write has completed.
    for await (const chunk of handle.createReadStream({ autoClose: false, highWaterMark: 256 * 1024 })) {
      signal?.throwIfAborted();
      if (metadata) {
        const start = Math.max(0, metadata.offset - bytes);
        const end = Math.min(chunk.length, metadata.offset + metadata.bytes - bytes);
        if (end > start) graphHash.update(chunk.subarray(start, end));
      }
      bytes += chunk.length;
      if (bytes >= 0xffffffff) throw Error(`Resource exceeds ZIP32: ${path}`);
      hash.update(chunk);
      if (consume) await consume(chunk);
    }
    signal?.throwIfAborted();
    if (metadata && graphHash.digest('hex') !== metadata.sha256) throw Error(`Dependency metadata changed while packaging: ${path}; retry from an unchanged converted map`);
    return { path, bytes, sha256: hash.digest('hex') };
  } finally { await handle.close(); }
}
/** Two streaming passes: identity first, then ZIP output, checking for changes.
 * Binary textures/meshes are never collected into a multi-GB in-memory archive. */
async function packageFromRoot(root, target, options) {
  const signal = options.signal;
  signal?.throwIfAborted();
  const { manifest, resources, metadata } = await closure(root, signal);
  const name = options.name ?? manifest.name ?? manifest.id, game = options.game ?? manifest.game;
  for (const [field, value] of Object.entries({ name, game })) {
    if (typeof value !== 'string' || !value.trim() || value.length > 256 || /[\u0000-\u001f\u007f]/.test(value)) throw Error(`Provide a valid --${field} (or manifest.${field})`);
  }
  /** @type {MapBundleIndex} */
  const index = { format: 'm0clip-map', version: 1, name, game, entry: 'manifest.json', resources: [] };
  const entries = [];
  for (const path of resources) {
    try { entries.push(await streamResource(root, path, null, signal, metadata.get(path))); }
    catch (error) { throw Error(`Cannot package ${path}: ${error.message}`, { cause: error }); }
  }
  index.resources = entries;
  if (entries.length > 65533) throw Error('Too many resources for ordinary ZIP32');
  const wrapperBytes = Buffer.from(JSON.stringify(index, null, 2) + '\n');
  if (wrapperBytes.length > maxMetadata) throw Error('Bundle resource index exceeds 16 MiB');
  if (entries.reduce((sum, entry) => sum + entry.bytes + 200 + Buffer.byteLength(entry.path) * 2, wrapperBytes.length + 256) >= 0xffffffff) throw Error('Selected map exceeds ordinary ZIP32 (4 GiB); split/reconvert the map before packaging');
  // Exclusive creation is intentional: a failed run never overwrites user data.
  const destination = await open(target, 'wx');
  let success = false, written = 0, zipError;
  const pending = [];
  const zip = new Zip((error, data) => { if (error) zipError = error; else pending.push(data); });
  async function flush() {
    if (zipError) throw zipError;
    for (const chunk of pending.splice(0)) {
      signal?.throwIfAborted();
      written += chunk.length;
      if (written >= 0xffffffff) throw Error('ZIP32 archive exceeds 4 GiB');
      for (let offset = 0; offset < chunk.length;) {
        const result = await destination.write(chunk, offset, chunk.length - offset);
        if (!result.bytesWritten) throw Error('Cannot write ZIP output');
        offset += result.bytesWritten;
      }
    }
  }
  try {
    const head = new ZipPassThrough(wrapper);
    zip.add(head); head.push(wrapperBytes, true); await flush();
    for (const entry of entries) {
      signal?.throwIfAborted();
      const member = new ZipPassThrough(entry.path);
      zip.add(member); await flush();
      const actual = await streamResource(root, entry.path, async chunk => { member.push(chunk, false); await flush(); }, signal);
      if (actual.bytes !== entry.bytes || actual.sha256 !== entry.sha256) throw Error(`Resource changed while packaging: ${entry.path}; retry from an unchanged converted map`);
      member.push(new Uint8Array(), true); await flush();
    }
    zip.end(); await flush();
    signal?.throwIfAborted();
    await destination.sync();
    success = true;
    return index;
  } finally {
    zip.terminate();
    await destination.close();
    if (!success) await unlink(target);
  }
}

/** Keep the selected directory descriptor alive for graph discovery and both
 * streaming passes, even if its original pathname is renamed or replaced. */
export async function packageMap(directory, output, options = {}) {
  options.signal?.throwIfAborted();
  const root = await openRoot(directory);
  try {
    return await packageFromRoot(root, resolve(output), options);
  } finally { await root.close(); }
}

async function main() {
  const args = process.argv.slice(2), options = {};
  let directory, output;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--help' || arg === '-h') {
      console.log('Usage: node scripts/package_map.mjs MAP_DIRECTORY --output MAP.zip [--name NAME] [--game GAME]\nPackages a converted manifest.json/map.xml map, selected visuals, textures and physics.\nRequires Linux with accessible /proc/self/fd; every input directory/resource is opened without following symlinks.\nStored ZIP32 output is streamed; existing outputs are rejected.');
      return;
    }
    if (['--output', '--name', '--game'].includes(arg)) {
      const value = args[++i];
      if (!value || value.startsWith('--')) throw Error(`Missing value for ${arg}`);
      if (arg === '--output') output = value; else options[arg.slice(2)] = value;
    } else if (arg.startsWith('-') || directory) throw Error(`Unexpected argument: ${arg}`);
    else directory = arg;
  }
  if (!directory || !output) throw Error('Usage: node scripts/package_map.mjs MAP_DIRECTORY --output MAP.zip [--name NAME] [--game GAME]');
  const controller = new AbortController();
  const cancel = () => controller.abort(new Error('Packaging cancelled'));
  process.once('SIGINT', cancel); process.once('SIGTERM', cancel);
  try {
    const index = await packageMap(directory, output, { ...options, signal: controller.signal });
    console.log(`Packaged ${index.name}: ${index.resources.length} verified resources, ${index.resources.reduce((sum, resource) => sum + resource.bytes, 0)} bytes.\n${resolve(output)}`);
  } finally { process.off('SIGINT', cancel); process.off('SIGTERM', cancel); }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(`Map packaging failed: ${error.message}`); process.exitCode = 1; });
}
