/** Real ZIP/Blob consumer boundaries; these protocol fixtures are not rendering QA. */
import assert from 'node:assert/strict';
import { createHash, webcrypto } from 'node:crypto';
import { mkdtemp, mkdir, readFile, writeFile, rm, symlink } from 'node:fs/promises';
import fsPromises from 'node:fs/promises';
import { renameSync, symlinkSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { resolve, dirname } from 'node:path';
import { build } from 'esbuild';
import { zipSync, strToU8 } from 'fflate';
import { packageMap } from './package_map.mjs';

if (!globalThis.crypto) globalThis.crypto = webcrypto;
const compiled = await build({ entryPoints: ['src/maps/bundle.ts'], bundle: true, platform: 'node', format: 'cjs', write: false });
const module = { exports: {} };
new Function('module', 'require', compiled.outputFiles[0].text)(module, createRequire(import.meta.url));
const { inspectMapBundle, decodeMapBundle } = module.exports;
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6pAAAAABJRU5ErkJggg==', 'base64');
function glb(document) {
  const json = Buffer.from(JSON.stringify(document)), chunk = Buffer.alloc(Math.ceil(json.length / 4) * 4, 0x20);
  json.copy(chunk);
  const header = Buffer.alloc(20);
  header.writeUInt32LE(0x46546c67, 0); header.writeUInt32LE(2, 4); header.writeUInt32LE(chunk.length + 20, 8);
  header.writeUInt32LE(chunk.length, 12); header.writeUInt32LE(0x4e4f534a, 16);
  return Buffer.concat([header, chunk]);
}
const bodies = {
  'manifest.json': Buffer.from(JSON.stringify({ name: 'Archive boundary', game: 'Fixture', files: ['map.xml', 'physics/triangle.obj'], visual: 'unselected.glb', native_textures: { visual: 'visual.glb' } })),
  'map.xml': Buffer.from('<mujoco><compiler meshdir="MAPDIR/physics"/><asset><mesh name="triangle" file="triangle.obj"/></asset></mujoco>'),
  'physics/triangle.obj': Buffer.from('v 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 3\n'),
  'visual.glb': glb({ asset: { version: '2.0' }, images: [{ uri: 'textures/pixel.png' }] }),
  'textures/pixel.png': png,
};
function indexFor(files = bodies) {
  return { format: 'm0clip-map', version: 1, name: 'Archive boundary', game: 'Fixture', entry: 'manifest.json',
    resources: Object.entries(files).map(([path, bytes]) => ({ path, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') })) };
}
function archive(files = bodies, index = indexFor(files), extras = {}, level = 0) {
  return new Blob([zipSync({ ...files, ...extras, 'm0clip-map.json': strToU8(JSON.stringify(index)) }, { level })]);
}
const good = archive();
const inspected = await inspectMapBundle(good);
assert.equal(inspected.name, 'Archive boundary');
const stored = await decodeMapBundle(good);
const deflated = await decodeMapBundle(archive(bodies, indexFor(), {}, 6));
assert.equal(deflated.fingerprint, stored.fingerprint, 'ZIP compression does not change verified content identity');
assert.match(stored.id, /^local-[a-f0-9]{64}$/);
assert.equal(stored.files.get('textures/pixel.png').type, 'image/png');
assert.deepEqual(Buffer.from(await stored.files.get('textures/pixel.png').arrayBuffer()), png);
const reversed = indexFor(); reversed.resources.reverse();
const repacked = await decodeMapBundle(archive(bodies, reversed, { 'unlisted.json': strToU8('{"private":"not a dependency"}') }, 6));
assert.equal(repacked.id, stored.id, 'Resource ordering and unlisted ZIP payload cannot alter identity');
assert(!repacked.files.has('unlisted.json'), 'Only declared verified resources become owned map blobs');
// Preserve valid compressed content/CRC/hash while inserting declared compressed
// bytes AFTER its final Deflate block. Neither metadata nor body validation may
// silently accept padding and feed/copy it until the declared extent is exhausted.
async function paddedArchive(target) {
  const bytes = Buffer.from(await archive(bodies, indexFor(), {}, 6).arrayBuffer());
  const end = bytes.length - 22, central = bytes.readUInt32LE(end + 16), records = [];
  for (let position = central; position < end;) {
    const nameBytes = bytes.readUInt16LE(position + 28), extra = bytes.readUInt16LE(position + 30), comment = bytes.readUInt16LE(position + 32);
    records.push({ position, name: bytes.toString('utf8', position + 46, position + 46 + nameBytes), offset: bytes.readUInt32LE(position + 42) });
    position += 46 + nameBytes + extra + comment;
  }
  const entry = records.find(record => record.name === target);
  assert(entry);
  assert.equal(bytes.readUInt16LE(entry.offset + 6) & 8, 0, 'Independent zipSync fixture has fixed local sizes, not a descriptor');
  const compressed = bytes.readUInt32LE(entry.offset + 18), start = entry.offset + 30 + bytes.readUInt16LE(entry.offset + 26) + bytes.readUInt16LE(entry.offset + 28);
  const insertion = start + compressed, padding = Buffer.alloc(5 * 4096);
  bytes.writeUInt32LE(compressed + padding.length, entry.offset + 18);
  bytes.writeUInt32LE(compressed + padding.length, entry.position + 20);
  for (const record of records) if (record.offset >= insertion) bytes.writeUInt32LE(record.offset + padding.length, record.position + 42);
  bytes.writeUInt32LE(central + padding.length, end + 16);
  class BodyReadBlob extends Blob {
    bodyBytesRead = 0;
    slice(from = 0, to = this.size, type) {
      const part = super.slice(from, to, type), arrayBuffer = part.arrayBuffer.bind(part);
      // ZIP tail/central metadata reads are distinct from selected body feeds.
      if (from >= start && to <= insertion + padding.length) part.arrayBuffer = async () => {
        const body = await arrayBuffer();
        this.bodyBytesRead += body.byteLength;
        return body;
      };
      return part;
    }
  }
  return new BodyReadBlob([bytes.subarray(0, insertion), padding, bytes.subarray(insertion)]);
}
for (const target of ['m0clip-map.json', 'manifest.json']) {
  const padded = await paddedArchive(target);
  await assert.rejects(target === 'm0clip-map.json' ? inspectMapBundle(padded) : decodeMapBundle(padded), /trailing|Deflate.*end|inflate/, `Reject trailing compressed padding in ${target}`);
  assert(padded.bodyBytesRead <= 4096, 'Reject after one bounded selected-body feed, without reading the remaining compressed padding');
}

const wrongHash = indexFor(); wrongHash.resources.find(item => item.path === 'textures/pixel.png').sha256 = '0'.repeat(64);
await assert.rejects(decodeMapBundle(archive(bodies, wrongHash)), /SHA256.*textures\/pixel\.png/);
const wrongSize = indexFor(); wrongSize.resources[0].bytes++;
await assert.rejects(inspectMapBundle(archive(bodies, wrongSize)), /byte count.*manifest\.json/);
const absent = { ...bodies }; delete absent['textures/pixel.png'];
await assert.rejects(inspectMapBundle(archive(absent, indexFor())), /missing.*textures\/pixel\.png/);
await assert.rejects(decodeMapBundle(archive(absent)), /missing dependency textures\/pixel\.png/);
const missingPhysics = { ...bodies, 'manifest.json': Buffer.from(JSON.stringify({ files: ['map.xml'], visual: 'visual.glb' })) };
await assert.rejects(decodeMapBundle(archive(missingPhysics)), /physics dependency physics\/triangle\.obj.*manifest\.json/);

const quotedXml = {
  ...bodies,
  'map.xml': Buffer.from('<mujoco><!-- <mesh file="ignored.obj"/> --><compiler meshdir="MAPDIR/physics"/><asset><mesh name="a>b file=&quot;not-a-reference.obj&quot;" file="triangle.obj"/></asset></mujoco>'),
};
await decodeMapBundle(archive(quotedXml)); // Valid quoted > is not an unsupported XML feature.
const hiddenXmlCases = [
  { file: 'missing.obj', error: /physics dependency missing\.obj/ },
  { file: '../outside.obj', error: /dependency escapes map root/ },
  { file: '/outside.obj', error: /unsafe dependency/ },
];
for (const { file, error } of hiddenXmlCases) {
  const files = { ...missingPhysics, 'map.xml': Buffer.from(`<mujoco><asset><mesh name="a>b" file="${file}"/></asset></mujoco>`) };
  await assert.rejects(decodeMapBundle(archive(files)), error);
}
for (const path of ['../escape.bin', '/absolute.bin', 'https://outside.invalid/file.bin', 'textures\\outside.png', 'textures/%2e%2e/file.bin']) {
  await assert.rejects(inspectMapBundle(archive(bodies, indexFor(), { [path]: strToU8('no') })), /unsafe resource path/);
}
await assert.rejects(inspectMapBundle(archive(bodies, indexFor(), { 'MANIFEST.JSON': strToU8('{}') })), /duplicate or ambiguous/);
await assert.rejects(inspectMapBundle(archive(bodies, indexFor(), { 'link.bin': [strToU8('target'), { os: 3, attrs: 0xa1ff << 16 }] })), /non-regular ZIP entry/);
const external = { ...bodies, 'visual.glb': glb({ asset: { version: '2.0' }, images: [{ uri: 'https://outside.invalid/pixel.png' }] }) };
await assert.rejects(decodeMapBundle(archive(external)), /unsafe dependency.*visual\.glb/);

// Repeated references under one deep compiler directory must not materialize
// a directory-by-reference cross-product, or rebuild every ancestor prefix.
const deepDirectory = 'd/'.repeat(16000).slice(0, -1), deepMesh = `${deepDirectory}/triangle.obj`;
const repeatedXml = Buffer.from(`<mujoco><compiler meshdir="MAPDIR/${deepDirectory}"/><asset>${'<mesh file="triangle.obj"/>'.repeat(8000)}</asset></mujoco>`);
const deepBodies = {
  ...bodies,
  'manifest.json': Buffer.from(JSON.stringify({ name: 'Deep references', game: 'Fixture',
    files: ['map.xml', deepMesh], visual: 'visual.glb' })),
  'map.xml': repeatedXml, [deepMesh]: bodies['physics/triangle.obj'],
};
delete deepBodies['physics/triangle.obj'];
const deepDecoded = await decodeMapBundle(archive(deepBodies));
assert.deepEqual(Buffer.from(await deepDecoded.files.get(deepMesh).arrayBuffer()), bodies['physics/triangle.obj'],
  'Repeated selected physics dependencies resolve to the original verified mesh');
const inlineXml = Buffer.from(`<mujoco><asset><mesh vertex="${'0 0 0 '.repeat(220000)}" face="0 0 0"/></asset></mujoco>`);
const inlineDecoded = await decodeMapBundle(archive({ ...bodies, 'map.xml': inlineXml }));
assert.deepEqual(Buffer.from(await inlineDecoded.files.get('map.xml').arrayBuffer()), inlineXml,
  'Large inline physics arrays survive dependency validation without being copied into retained metadata');
await assert.rejects(decodeMapBundle(archive({ ...bodies,
  'map.xml': Buffer.from(`<mujoco><compiler meshdir="MAPDIR/physics"/><asset>${'<mesh file="triangle.obj"/>'.repeat(110000)}</asset></mujoco>`),
})), RangeError, 'Dense retained dependency records stop at the import allocation boundary');

// Damage a stored texture body without touching the wrapper or central directory.
// Metadata inspection must still succeed: only Load verifies body hashes/CRC.
const damaged = new Uint8Array(await good.arrayBuffer());
const local = new DataView(damaged.buffer);
let offset = 0, damagedTexture = false;
while (local.getUint32(offset, true) === 0x04034b50) {
  const nameSize = local.getUint16(offset + 26, true), extra = local.getUint16(offset + 28, true), size = local.getUint32(offset + 18, true);
  const name = new TextDecoder().decode(damaged.subarray(offset + 30, offset + 30 + nameSize));
  const start = offset + 30 + nameSize + extra;
  if (name === 'textures/pixel.png') { damaged[start] ^= 1; damagedTexture = true; break; }
  offset = start + size;
}
assert(damagedTexture);
await inspectMapBundle(new Blob([damaged]));
await assert.rejects(decodeMapBundle(new Blob([damaged])), /CRC.*textures\/pixel\.png/);
await assert.rejects(inspectMapBundle(good.slice(0, good.size - 10)), /directory.*missing|truncated/);
await assert.rejects(decodeMapBundle(good, AbortSignal.abort()), { name: 'AbortError' });
await assert.rejects(inspectMapBundle(good, AbortSignal.abort()), { name: 'AbortError' });

// Trigger cancellation from an actual asynchronous archive read, not a fake decoder.
const controller = new AbortController();
let reads = 0;
class CancellingBlob extends Blob {
  slice(...args) {
    const part = super.slice(...args), arrayBuffer = part.arrayBuffer.bind(part);
    part.arrayBuffer = async () => {
      const result = await arrayBuffer();
      if (++reads === 5) controller.abort();
      return result;
    };
    return part;
  }
}
await assert.rejects(decodeMapBundle(new CancellingBlob([await good.arrayBuffer()]), controller.signal), { name: 'AbortError' });

// A real digest that completes after cancellation must never resolve to a map.
const hashController = new AbortController(), originalDigest = crypto.subtle.digest;
crypto.subtle.digest = async function (...args) {
  const result = await originalDigest.apply(this, args);
  hashController.abort();
  return result;
};
try {
  await assert.rejects(decodeMapBundle(good, hashController.signal), { name: 'AbortError' });
} finally { crypto.subtle.digest = originalDigest; }

async function writeFixture(directory, files) {
  for (const [path, body] of Object.entries(files)) {
    await mkdir(dirname(resolve(directory, path)), { recursive: true });
    await writeFile(resolve(directory, path), body);
  }
}

const root = await mkdtemp(resolve(tmpdir(), 'm0clip-map-bundle-'));
try {
  const source = resolve(root, 'converted'), output = resolve(root, 'selected.zip');
  await writeFixture(source, { ...bodies, 'unselected.glb': glb({ asset: { version: '2.0' } }), 'private-notes.md': strToU8('must never enter the archive') });
  const packagedIndex = await packageMap(source, output);
  assert.deepEqual(packagedIndex.resources.map(item => item.path), Object.keys(bodies).sort());
  const outputBody = await readFile(output);
  const decoded = await decodeMapBundle(new Blob([outputBody]));
  assert.equal(decoded.id, stored.id, 'The streaming producer output is consumed by the browser decoder');
  await assert.rejects(packageMap(source, output), { code: 'EEXIST' });
  assert.deepEqual(await readFile(output), outputBody, 'Existing user output remains unchanged');

  const visualCases = [
    { name: 'nested-props', files: { ...bodies,
      'manifest.json': Buffer.from(JSON.stringify({ ...JSON.parse(bodies['manifest.json']), props: { visual: 'models/props.glb' } })),
      'models/props.glb': glb({ asset: { version: '2.0' }, images: [{ uri: 'props.png' }] }), 'models/props.png': png },
      model: 'models/props.glb', dependency: 'models/props.png', bytes: png },
    { name: 'uppercase-glb', files: { 'map.xml': bodies['map.xml'], 'physics/triangle.obj': bodies['physics/triangle.obj'],
      'manifest.json': Buffer.from(JSON.stringify({ files: ['map.xml', 'physics/triangle.obj'], visual: 'VISUAL.GLB' })),
      'VISUAL.GLB': glb({ asset: { version: '2.0' }, images: [{ uri: 'UPPER.png' }] }), 'UPPER.png': png },
      model: 'VISUAL.GLB', dependency: 'UPPER.png', bytes: png },
    { name: 'uppercase-gltf', files: { ...bodies,
      'manifest.json': Buffer.from(JSON.stringify({ files: ['map.xml', 'physics/triangle.obj'], visual: 'VISUAL.GLTF' })),
      'VISUAL.GLTF': Buffer.from(JSON.stringify({ asset: { version: '2.0' }, buffers: [{ uri: 'mesh.bin', byteLength: 4 }] })), 'mesh.bin': Buffer.from('MESH') },
      model: 'VISUAL.GLTF', dependency: 'mesh.bin', bytes: Buffer.from('MESH') },
    { name: 'native-props', files: { ...bodies,
      'manifest.json': Buffer.from(JSON.stringify({ ...JSON.parse(bodies['manifest.json']), props: { visual: 'unselected-props.glb' },
        native_textures: { visual: 'visual.glb', props: 'models/PROPS.GLTF' } })),
      'models/PROPS.GLTF': Buffer.from(JSON.stringify({ asset: { version: '2.0' }, images: [{ uri: 'native.png' }] })), 'models/native.png': png },
      model: 'models/PROPS.GLTF', dependency: 'models/native.png', bytes: png },
  ];
  for (const entry of visualCases) {
    const directory = resolve(root, entry.name), selected = resolve(root, entry.name + '.zip');
    const files = { ...entry.files, 'manifest.json': Buffer.from(JSON.stringify({ name: entry.name, game: 'Fixture', ...JSON.parse(entry.files['manifest.json']) })) };
    await writeFixture(directory, files);
    await packageMap(directory, selected);
    const map = await decodeMapBundle(new Blob([await readFile(selected)]));
    assert.deepEqual(Buffer.from(await map.files.get(entry.model).arrayBuffer()), files[entry.model]);
    assert.deepEqual(Buffer.from(await map.files.get(entry.dependency).arrayBuffer()), entry.bytes);
    const incomplete = { ...files }; delete incomplete[entry.dependency];
    await assert.rejects(decodeMapBundle(archive(incomplete)), /missing dependency/);
    if (entry.name === 'nested-props') {
      const noProps = { ...files }; delete noProps[entry.model];
      await assert.rejects(decodeMapBundle(archive(noProps)), /missing dependency/);
    }
  }
  const upperXml = { ...bodies,
    'manifest.json': Buffer.from(JSON.stringify({ name: 'Upper XML', game: 'Fixture', files: ['map.xml', 'ASSET.XML'], visual: 'visual.glb' })),
    'map.xml': Buffer.from('<mujoco><include file="ASSET.XML"/></mujoco>'),
    'ASSET.XML': Buffer.from('<mujocoinclude><asset><mesh file="unindexed.obj"/></asset></mujocoinclude>') };
  await assert.rejects(decodeMapBundle(archive(upperXml)), /physics dependency unindexed\.obj/);
  const upperXmlSource = resolve(root, 'upper-xml'), upperXmlOutput = resolve(root, 'upper-xml.zip');
  await writeFixture(upperXmlSource, upperXml);
  await assert.rejects(packageMap(upperXmlSource, upperXmlOutput), /Physics dependency unindexed\.obj/);
  await assert.rejects(fsPromises.stat(upperXmlOutput), { code: 'ENOENT' });

  await rm(resolve(source, 'textures/pixel.png'));
  await symlink(resolve(source, 'private-notes.md'), resolve(source, 'textures/pixel.png'));
  await assert.rejects(packageMap(source, resolve(root, 'symlink.zip')), /symlinks are not followed/);

  const quotedSource = resolve(root, 'quoted-xml');
  await writeFixture(quotedSource, quotedXml);
  const quotedOutput = resolve(root, 'quoted.zip');
  await packageMap(quotedSource, quotedOutput);
  await decodeMapBundle(new Blob([await readFile(quotedOutput)]));
  for (const [index, { file, error }] of hiddenXmlCases.entries()) {
    const invalidSource = resolve(root, `hidden-xml-${index}`), invalidOutput = resolve(root, `hidden-${index}.zip`);
    await writeFixture(invalidSource, { ...missingPhysics, 'map.xml': Buffer.from(`<mujoco><asset><mesh name="a>b" file="${file}"/></asset></mujoco>`) });
    await assert.rejects(packageMap(invalidSource, invalidOutput), new RegExp(error.source, 'i'));
    await assert.rejects(fsPromises.stat(invalidOutput), { code: 'ENOENT' });
  }

  // Replace the selected root after it has been acquired, before metadata reads.
  // Both passes must remain on its original inode, not the replacement symlink.
  const raceFiles = {
    'manifest.json': JSON.stringify({ name: 'Race boundary', game: 'Fixture', files: ['map.xml'], visual: 'visual.gltf' }),
    'map.xml': '<mujoco/>',
    'visual.gltf': JSON.stringify({ asset: { version: '2.0' }, buffers: [{ uri: 'payload.bin', byteLength: 4 }] }),
    'payload.bin': 'SAFE',
  };
  const selected = resolve(root, 'root-race'), outside = resolve(root, 'outside-root');
  await writeFixture(selected, raceFiles);
  await writeFixture(outside, { ...raceFiles, 'payload.bin': 'LEAK' });
  const raceController = new AbortController(), checkAbort = raceController.signal.throwIfAborted.bind(raceController.signal);
  let checks = 0, rootReplaced = false;
  raceController.signal.throwIfAborted = () => {
    checkAbort();
    if (++checks === 2) {
      renameSync(selected, selected + '-owned'); symlinkSync(outside, selected); rootReplaced = true;
    }
  };
  const raceOutput = resolve(root, 'root-race.zip');
  await packageMap(selected, raceOutput, { signal: raceController.signal });
  assert(rootReplaced, 'Actual selected-root replacement occurred');
  const rootRaceMap = await decodeMapBundle(new Blob([await readFile(raceOutput)]));
  assert.equal(await rootRaceMap.files.get('payload.bin').text(), 'SAFE');

  // Synchronize actual I/O with a directory replacement. The old pathname-lstat
  // implementation leaks consistently if the actor repeats this at both passes.
  // Descriptor-relative opens instead keep the acquired directory, then reject
  // the substituted symlink on the next pass without retaining an output.
  const ancestor = resolve(root, 'ancestor-race'), assets = resolve(ancestor, 'assets'), outsideAssets = resolve(root, 'outside-assets');
  await writeFixture(ancestor, { ...raceFiles, 'visual.gltf': JSON.stringify({ asset: { version: '2.0' }, buffers: [{ uri: 'assets/payload.bin', byteLength: 4 }] }), 'assets/payload.bin': 'SAFE' });
  await writeFixture(outsideAssets, { 'payload.bin': 'LEAK' });
  const originalLstat = fsPromises.lstat, originalOpen = fsPromises.open;
  let ancestorReplaced = false;
  function replaceAncestor() {
    renameSync(assets, assets + '-owned'); symlinkSync(outsideAssets, assets); ancestorReplaced = true;
  }
  try {
    fsPromises.lstat = async function (...args) {
      if (ancestorReplaced && String(args[0]) === assets) {
        unlinkSync(assets); renameSync(assets + '-owned', assets); ancestorReplaced = false;
      }
      const info = await originalLstat.apply(this, args);
      if (!ancestorReplaced && String(args[0]) === assets) replaceAncestor();
      return info;
    };
    fsPromises.open = async function (...args) {
      const handle = await originalOpen.apply(this, args);
      if (!ancestorReplaced && String(args[0]).startsWith('/proc/self/fd/') && String(args[0]).endsWith('/assets')) replaceAncestor();
      return handle;
    };
    syncBuiltinESMExports();
    const ancestorOutput = resolve(root, 'ancestor-race.zip');
    await assert.rejects(packageMap(ancestor, ancestorOutput), /symlinks are not followed/);
    assert(ancestorReplaced, 'Actual ancestor-directory replacement occurred');
    await assert.rejects(fsPromises.stat(ancestorOutput), { code: 'ENOENT' });
  } finally {
    fsPromises.lstat = originalLstat; fsPromises.open = originalOpen; syncBuiltinESMExports();
  }

  // Missing proc-fd support is an explicit producer-environment error, never a
  // fallback to pathname checks. No resources or output may be read/written.
  try {
    fsPromises.open = async function (...args) {
      if (String(args[0]).startsWith('/proc/self/fd/')) throw Object.assign(Error('proc-fd unavailable'), { code: 'ENOENT' });
      return originalOpen.apply(this, args);
    };
    syncBuiltinESMExports();
    await assert.rejects(packageMap(quotedSource, resolve(root, 'no-proc.zip')), /Linux with accessible \/proc\/self\/fd is required/);
    await assert.rejects(fsPromises.stat(resolve(root, 'no-proc.zip')), { code: 'ENOENT' });
  } finally { fsPromises.open = originalOpen; syncBuiltinESMExports(); }
} finally { await rm(root, { recursive: true, force: true }); }
console.log('Map bundle ZIP/path/body/hash/cancellation and streaming-producer boundaries passed.');
