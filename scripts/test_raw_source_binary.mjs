/** CPU binary consumers (not browser/native visual qualification).
 * Run from the repository root, with Node 24+, existing esbuild/three and Pillow:
 *   node scripts/test_raw_source_binary.mjs
 * PNG bytes are independently decoded by both zlib and Python Pillow; GLBs are
 * parsed by the application's installed Three.js GLTFLoader, not a stand-in.
 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { inflateSync } from 'node:zlib';
import { build } from 'esbuild';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';

const compiled = await build({ stdin: { contents: "export * from './src/maps/raw-source-gltf'; export * from './src/maps/raw-source-png';", resolveDir: process.cwd(), loader: 'ts' }, bundle: true, platform: 'node', format: 'cjs', write: false });
const module = { exports: {} };
new Function('module', 'require', compiled.outputFiles[0].text)(module, createRequire(import.meta.url));
const { SourceGlb, encodeSourcePng } = module.exports;


async function decodePng(blob, width, height, expected) {
  const bytes = Buffer.from(await blob.arrayBuffer());
  assert.equal(blob.type, 'image/png');
  assert.deepEqual([...bytes.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  let offset = 8;
  const names = [], idat = [];
  while (offset < bytes.length) {
    const length = bytes.readUInt32BE(offset), type = bytes.toString('ascii', offset + 4, offset + 8);
    assert(offset + 12 + length <= bytes.length, 'complete PNG chunk');
    // Independent bit-at-a-time CRC, not the encoder's lookup-table algorithm.
    let crc = 0xffffffff;
    for (const byte of bytes.subarray(offset + 4, offset + 8 + length)) {
      crc ^= byte;
      for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
    }
    assert.equal((crc ^ 0xffffffff) >>> 0, bytes.readUInt32BE(offset + 8 + length), `${type} CRC`);
    const payload = bytes.subarray(offset + 8, offset + 8 + length);
    if (type === 'IHDR') {
      assert.equal(length, 13); assert.equal(payload.readUInt32BE(0), width); assert.equal(payload.readUInt32BE(4), height);
      assert.deepEqual([...payload.subarray(8)], [8, 6, 0, 0, 0]);
    } else if (type === 'IDAT') idat.push(payload);
    else assert.equal(type, 'IEND');
    if (type === 'IEND') assert.equal(length, 0);
    names.push(type); offset += length + 12;
  }
  assert.equal(offset, bytes.length); assert.equal(names[0], 'IHDR'); assert.equal(names.at(-1), 'IEND');
  assert.equal(names.filter(n => n === 'IHDR').length, 1); assert.equal(names.filter(n => n === 'IEND').length, 1);
  
  const scanlines = inflateSync(Buffer.concat(idat));
  assert.equal(scanlines.length, (width * 4 + 1) * height);
  for (let row = 0; row < height; row++) {
    assert.equal(scanlines[row * (width * 4 + 1)], 0);
    assert.deepEqual(scanlines.subarray(row * (width * 4 + 1) + 1, (row + 1) * (width * 4 + 1)), Buffer.from(expected.subarray(row * width * 4, (row + 1) * width * 4)));
  }
  // Feed actual PNG bytes through the existing independently implemented decoder.
  const decoded = spawnSync('python3', ['-c', 'import io,sys\nfrom PIL import Image\nim=Image.open(io.BytesIO(sys.stdin.buffer.read()))\nim.load()\nassert im.mode=="RGBA"\nassert im.size==(int(sys.argv[1]),int(sys.argv[2]))\nsys.stdout.buffer.write(im.tobytes())', String(width), String(height)], { input: bytes, maxBuffer: expected.length + 1024 * 1024 });
  assert.equal(decoded.status, 0, `Pillow decoding failed; genuine python3/Pillow required: ${decoded.stderr}`);
  assert.deepEqual(decoded.stdout, Buffer.from(expected));
  return { bytes, idatCount: idat.length };
}

const transparent = new Uint8Array([255, 17, 99, 0, 3, 250, 4, 1, 1, 2, 3, 127, 88, 77, 66, 255, 0, 255, 201, 0, 255, 255, 255, 254]);
const png = await encodeSourcePng(3, 2, transparent);
await decodePng(png, 3, 2, transparent);
const storage = new Uint8Array(257 * 113 * 4 + 19).fill(193), rgba = storage.subarray(7, storage.length - 12);
let seed = 123456789;
for (let i = 0; i < rgba.length; i++) { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; rgba[i] = seed & 255; }
for (let i = 3; i < rgba.length; i += 16) rgba[i] = 0;
const original = storage.slice();
const random = await decodePng(await encodeSourcePng(257, 113, rgba), 257, 113, rgba);
assert(random.idatCount > 1, 'large incompressible pixels exercise multiple streamed IDAT chunks');
assert.deepEqual(storage, original, 'encoding borrows without changing nonzero-offset input');
// A wide row crosses the encoder's bounded write segments without adding filters.
const wide = new Uint8Array(20000 * 4);
for (let i = 0; i < wide.length; i++) wide[i] = i % 251;
await decodePng(await encodeSourcePng(20000, 1, wide), 20000, 1, wide);
for (const [w, h, data] of [[0, 1, new Uint8Array()], [-1, 1, transparent], [1.5, 2, transparent], [Infinity, 1, transparent], [1, NaN, transparent], [0x80000000, 1, transparent], [1, 0x80000000, transparent], [32768, 32768, transparent], [3, 2, transparent.subarray(1)], [1, 1, new Float32Array([1])], [1, 1, new Uint32Array([0xff0000ff])], [1, 1, new Uint8ClampedArray(4)]]) {
  await assert.rejects(encodeSourcePng(w, h, data));
}
if (typeof SharedArrayBuffer !== 'undefined') await assert.rejects(encodeSourcePng(1, 1, new Uint8Array(new SharedArrayBuffer(4))));
const pre = new AbortController(); pre.abort();
await assert.rejects(encodeSourcePng(3, 2, transparent, pre.signal), error => error.name === 'AbortError');
const during = new AbortController(), reason = new Error('actual deflate cancellation');
const pending = encodeSourcePng(257, 113, rgba, during.signal);
queueMicrotask(() => during.abort(reason));
let timer;
try {
  await assert.rejects(Promise.race([pending, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('compression cancellation hung')), 5000); })]), error => error === reason);
} finally { clearTimeout(timer); }
await decodePng(await encodeSourcePng(3, 2, transparent), 3, 2, transparent); // Cancellation releases the native stream.

const glb = new SourceGlb();
const backing = new Uint8Array([99, 11, 22, 33, 88]);
const rawView = glb.view(new DataView(backing.buffer, 1, 3));
backing.fill(0);
const array = new Uint8Array([4, 5, 6, 7]);
const arrayView = glb.view(array.buffer); array.fill(0);
const encodedBacking = new Uint8Array([200, 41, 42, 201]);
const immutable = new Blob([encodedBacking]).slice(1, 3);
encodedBacking.fill(0);
const blobView = glb.view(immutable);
const imageView = glb.view(png);
glb.json.images.push({ bufferView: imageView, mimeType: 'image/png' });
const pBacking = new Float32Array([999, -2, 3, 4, 5, 6, 7, 0, -1, 8, 999]);
const positions = pBacking.subarray(1, 10), expectedPositions = [...positions];
const position = glb.accessor(positions, 'VEC3', { target: 34962, bounds: true }); positions.fill(999);
const color = glb.accessor(new Uint8Array([255, 0, 8, 255, 0, 255, 17, 128, 1, 2, 255, 0]), 'VEC4', { target: 34962, normalized: true, bounds: true });
const rgbBytes=[255,0,8,0,255,17,1,2,255],rgbShorts=[65535,0,2048,0,65535,4096,1,2,65535];
const rgb8=glb.accessor(new Uint8Array(rgbBytes),'VEC3',{target:34962,normalized:true});
const rgb16=glb.accessor(new Uint16Array(rgbShorts),'VEC3',{target:34962,normalized:true});
const index = glb.accessor(new Uint16Array([0, 1, 2]), 'SCALAR', { target: 34963, bounds: true });
const uint32 = glb.accessor(new Uint32Array([0, 65536, 0xffffffff]), 'SCALAR', { bounds: true });
const uv = glb.accessor(new Float32Array([0, 0, 1, 0, 0, 1]), 'VEC2', { target: 34962 });
const joints = glb.accessor(new Uint16Array(12), 'VEC4', { target: 34962 });
const weights = glb.accessor(new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0]), 'VEC4', { target: 34962 });
const inverse = glb.accessor(new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]), 'MAT4');
const times = glb.accessor(new Float32Array([0, 1]), 'SCALAR', { bounds: true });
const motion = glb.accessor(new Float32Array([0, 0, 0, 0, 0, 2]), 'VEC3');
glb.json.materials.push({ name: 'authored', pbrMetallicRoughness: { baseColorFactor: [.2, .4, .6, 1], metallicFactor: 0, roughnessFactor: .85 }, doubleSided: false });
glb.json.meshes.push({ primitives: [{ attributes: { POSITION: position, COLOR_0: color, _RGB8:rgb8, _RGB16:rgb16, TEXCOORD_0: uv, JOINTS_0: joints, WEIGHTS_0: weights }, indices: index, material: 0 }] });
glb.json.nodes.push({ name: 'native Z up', mesh: 0, skin: 0 }, { name: 'root bone' });
glb.json.scenes[0].nodes.push(0, 1);
glb.json.skins = [{ joints: [1], inverseBindMatrices: inverse }];
glb.json.animations = [{ name: 'authored translation', samplers: [{ input: times, output: motion, interpolation: 'LINEAR' }], channels: [{ sampler: 0, target: { node: 1, path: 'translation' } }] }];
// Force nonzero final BIN padding, independently of JSON padding.
const tail = glb.view(new Uint8Array([71]));
const result = glb.finish(), buffer = await result.arrayBuffer(), bytes = Buffer.from(buffer);
assert.equal(result.type, 'model/gltf-binary');
assert.equal(bytes.readUInt32LE(0), 0x46546c67); assert.equal(bytes.readUInt32LE(4), 2); assert.equal(bytes.readUInt32LE(8), bytes.length);
const jsonLength = bytes.readUInt32LE(12); assert.equal(jsonLength % 4, 0); assert.equal(bytes.readUInt32LE(16), 0x4e4f534a);
const jsonBytes = bytes.subarray(20, 20 + jsonLength), json = JSON.parse(jsonBytes.toString('utf8'));
const canonicalJson = Buffer.from(JSON.stringify(json));
assert(jsonBytes.subarray(canonicalJson.length).every(byte => byte === 32));
const binOffset = 20 + jsonLength; assert.equal(bytes.readUInt32LE(binOffset + 4), 0x004e4942);
const binLength = bytes.readUInt32LE(binOffset), bin = bytes.subarray(binOffset + 8);
assert.equal(binLength, bin.length); assert.equal(binLength % 4, 0); assert.equal(json.buffers[0].byteLength, binLength);
let end = 0;
for (const view of json.bufferViews) {
  assert.equal(view.byteOffset % 4, 0); assert.equal(view.buffer, 0);
  assert(view.byteOffset >= end && view.byteOffset + view.byteLength <= bin.length);
  assert(bin.subarray(end, view.byteOffset).every(byte => byte === 0), 'inter-view zero padding');
  end = view.byteOffset + view.byteLength;
}
assert(bin.subarray(end).every(byte => byte === 0)); assert.equal(bin.length - end, 3);
const viewBytes = id => { const view = json.bufferViews[id]; return bin.subarray(view.byteOffset, view.byteOffset + view.byteLength); };
assert.deepEqual([...viewBytes(rawView)], [11, 22, 33]);
assert.deepEqual([...viewBytes(arrayView)], [4, 5, 6, 7]);
assert.deepEqual([...viewBytes(blobView)], [41, 42]); assert.deepEqual([...viewBytes(tail)], [71]);
assert.deepEqual(viewBytes(imageView), Buffer.from(await png.arrayBuffer()));
await decodePng(new Blob([viewBytes(imageView)], { type: 'image/png' }), 3, 2, transparent);
assert.deepEqual(json.accessors[position].min, [-2, -1, 4]); assert.deepEqual(json.accessors[position].max, [5, 6, 8]);
assert.deepEqual(json.accessors[color].min, [0, 0, 8, 0]); assert.deepEqual(json.accessors[color].max, [255, 255, 255, 255]);
assert.deepEqual(json.accessors[index].min, [0]); assert.deepEqual(json.accessors[index].max, [2]);
assert.deepEqual(json.accessors[uint32].max, [0xffffffff]);
assert.deepEqual([position, color, index, uint32, inverse].map(id => json.accessors[id].componentType), [5126, 5121, 5123, 5125, 5126]);
assert.equal(json.accessors[inverse].count, 1); assert.equal(json.accessors[inverse].type, 'MAT4');
assert.equal(json.nodes[0].matrix, undefined); assert.equal(json.nodes[0].rotation, undefined);

for(const id of [rgb8,rgb16]){
  const accessor=json.accessors[id],view=json.bufferViews[accessor.bufferView],componentBytes=accessor.componentType===5121?1:2;
  for(let i=0;i<accessor.count;i++)assert.equal((view.byteOffset+i*view.byteStride)%4,0,'every vertex starts at a four-byte boundary');
  assert(view.byteStride>=3*componentBytes);
}
// The real consumer verifies valid geometry, integer/normalized attributes, skin,
// animation and unchanged Z coordinates; no WebGL/Chrome context is involved.
const loaded = await new GLTFLoader().parseAsync(buffer, '');
const mesh = loaded.scene.getObjectByName('native_Z_up');
assert(mesh?.isSkinnedMesh, 'actual skinned GLTF mesh');
assert.deepEqual([...mesh.geometry.getAttribute('position').array], expectedPositions);
assert.deepEqual([...mesh.geometry.index.array], [0, 1, 2]);
assert(mesh.geometry.index.array instanceof Uint16Array);
assert(mesh.geometry.getAttribute('skinIndex').array instanceof Uint16Array);
assert(mesh.geometry.getAttribute('color').array instanceof Uint8Array); assert.equal(mesh.geometry.getAttribute('color').normalized, true);
assert.equal(mesh.geometry.getAttribute('color').getW(1), 128 / 255);
assert.equal(mesh.geometry.getAttribute('position').getZ(2), 8);
for(const [attribute,values,divisor] of [['_rgb8',rgbBytes,255],['_rgb16',rgbShorts,65535]]){
  const actual=mesh.geometry.getAttribute(attribute);
  for(let i=0;i<3;i++)assert.deepEqual([actual.getX(i),actual.getY(i),actual.getZ(i)],values.slice(i*3,i*3+3).map(v=>v/divisor));
}
assert.deepEqual(mesh.quaternion.toArray(), [0, 0, 0, 1]);
assert.equal(mesh.skeleton.bones.length, 1); assert.equal(mesh.skeleton.boneInverses[0].elements[15], 1);
assert.equal(mesh.material.name, 'authored'); assert.equal(mesh.material.roughness, .85);
const uint32Attribute = await loaded.parser.getDependency('accessor', uint32);
assert(uint32Attribute.array instanceof Uint32Array); assert.deepEqual([...uint32Attribute.array], [0, 65536, 0xffffffff]);
assert.equal(loaded.animations.length, 1); assert.deepEqual([...loaded.animations[0].tracks[0].values], [0, 0, 0, 0, 0, 2]);
glb.json.nodes[0].name = 'changed after finish'; glb.view(new Uint8Array([1, 2])); glb.finish();
assert.equal(JSON.parse(bytes.subarray(20, 20 + jsonLength).toString()).nodes[0].name, 'native Z up', 'finished Blob keeps its JSON snapshot');
assert.deepEqual(Buffer.from(await result.arrayBuffer()), bytes, 'later appends cannot mutate an existing GLB');

for (const limit of [0, 27, -1, 1.5, Infinity, 0x100000000]) assert.throws(() => new SourceGlb(limit));
const bounded = new SourceGlb(1024);
assert.throws(() => bounded.view(new Uint8Array(1000)));
assert.equal(bounded.json.bufferViews.length, 0);
assert.throws(() => new SourceGlb(28).finish());
const exact = new SourceGlb(bytes.length - 1);
exact.json.extras = { tooLarge: 'x'.repeat(bytes.length) };
assert.throws(() => exact.finish());
const invalid = new SourceGlb();
for (const [data, type, opts] of [[new Float32Array([1, 2]), 'VEC3'], [new Float32Array(), 'SCALAR'], [new Int16Array([1]), 'SCALAR'], [new Float64Array([1]), 'SCALAR'], [new Float32Array([NaN]), 'SCALAR'], [new Float32Array([Infinity]), 'SCALAR', { bounds: true }], [new Float32Array([1]), 'SCALAR', { normalized: true }], [new Uint32Array([1]), 'SCALAR', { normalized: true }], [new Uint16Array([1, 2]), 'VEC2', { target: 34963 }], [new Float32Array([1]), 'SCALAR', { target: 34963 }], [new Uint8Array([1]), 'SCALAR', { target: 34963, normalized: true }], [new Uint8Array([1]), 'INVALID'], [new Uint8Array([1]), 'toString'], [new Uint8Array([1]), 'SCALAR', { target: 42 }]]) {
  assert.throws(() => invalid.accessor(data, type, opts));
  assert.equal(invalid.json.accessors.length, 0); assert.equal(invalid.json.bufferViews.length, 0);
}
assert.throws(() => invalid.view(new Uint8Array()));
assert.throws(() => invalid.view(new Uint8Array([1]), 42));
if (typeof SharedArrayBuffer !== 'undefined') assert.throws(() => invalid.view(new Uint8Array(new SharedArrayBuffer(4))));
assert.throws(() => glb.finish(pre.signal), error => error.name === 'AbortError');
// Mutating an accessor buffer after intake, including an unaligned byte slice,
// must not alter its exact selected bytes in the finished BIN chunk.
const odd = new SourceGlb(), source = new Uint8Array([9, 8, 7, 6, 5, 4]);
odd.view(source.subarray(1, 5)); source.fill(0);
const oddBytes = Buffer.from(await odd.finish().arrayBuffer()), oddJsonLength = oddBytes.readUInt32LE(12);
assert.deepEqual([...oddBytes.subarray(28 + oddJsonLength)], [8, 7, 6, 5]);
console.log('Source GLB + lossless PNG: actual Three.js/Pillow consumers, ownership, types, bounds, chunks, malformed and cancellation boundaries passed.');
