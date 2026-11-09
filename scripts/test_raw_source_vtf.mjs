/** Consumer-visible CPU VTF boundaries. Synthetic pixels only; no native/map claim. */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';




import { build } from 'esbuild';

const compiled = await build({ entryPoints: ['src/maps/raw-source-vtf.ts'], bundle: true, platform: 'node', format: 'cjs', write: false });
const module = { exports: {} };
new Function('module', 'require', compiled.outputFiles[0].text)(module, createRequire(import.meta.url));
const { readSourceVtf } = module.exports;

{
  const blocks = { 13: 8, 14: 16, 15: 16, 20: 8 };
  const bpp = { 0: 4, 1: 4, 2: 3, 3: 3, 5: 1, 6: 2, 8: 1, 11: 4, 12: 4, 16: 4, 21: 2, 22: 2, 24: 8 };
  const size = (fmt, w, h) => blocks[fmt] ? Math.ceil(w / 4) * Math.ceil(h / 4) * blocks[fmt] : w * h * bpp[fmt];
  const u32 = value => { const b = Buffer.alloc(4); b.writeUInt32LE(value); return b; };
  function fixture({ minor = 5, width = 1, height = 1, depth = 1, frames = 1, firstFrame = 0, flags = 0, format = 0, mips = 1, directory = minor >= 3, headerPadding = 0, padding = directory ? 9 : 0, thumbnail, resources = [], pixels = () => undefined } = {}) {
    const storedFaces = flags & 0x4000 ? minor < 5 && firstFrame !== 65535 ? 7 : 6 : 1;
    const images = [];
    for (let mip = mips - 1; mip >= 0; mip--) {
      const w = Math.max(1, width >>> mip), h = Math.max(1, height >>> mip), d = Math.max(1, depth >>> mip);
      for (let frame = 0; frame < frames; frame++) for (let face = 0; face < storedFaces; face++) for (let z = 0; z < d; z++) {
        const body = pixels({ mip, frame, face, z, width: w, height: h }) ?? Buffer.alloc(size(format, w, h));
        assert.equal(body.length, size(format, w, h)); images.push(body);
      }
    }
    const image = Buffer.concat(images), count = directory ? resources.length + 1 + Number(Boolean(thumbnail)) : 0;
    const hsize = (minor >= 2 ? 80 : 64) + count * 8 + headerPadding, header = Buffer.alloc(hsize);
    header.write('VTF\0'); header.writeUInt32LE(7, 4); header.writeUInt32LE(minor, 8); header.writeUInt32LE(hsize, 12);
    header.writeUInt16LE(width, 16); header.writeUInt16LE(height, 18); header.writeUInt32LE(flags, 20);
    header.writeUInt16LE(frames, 24); header.writeUInt16LE(firstFrame, 26); header.writeFloatLE(1, 48);
    header.writeInt32LE(format, 52); header[56] = mips; header.writeInt32LE(thumbnail ? 13 : -1, 57);
    if (thumbnail) { header[61] = 4; header[62] = 4; assert.equal(thumbnail.length, 8); }
    if (minor >= 2) header.writeUInt16LE(depth, 63);
    if (minor >= 3) header.writeUInt32LE(count, 68);
    const chunks = [Buffer.alloc(padding, 0xa5)], entries = [];
    let cursor = hsize + padding;
    for (const resource of resources) {
      if (resource.inlineValue !== undefined) entries.push({ tag: resource.tag, flags: 2, value: resource.inlineValue });
      else {
        entries.push({ tag: resource.tag, flags: 0, value: cursor });
        chunks.push(u32(resource.payload.length), resource.payload); cursor += 4 + resource.payload.length;
      }
    }
    if (thumbnail) { entries.push({ tag: 1, flags: 0, value: cursor }); chunks.push(thumbnail); cursor += thumbnail.length; }
    const imageOffset = cursor;
    entries.push({ tag: 0x30, flags: 0, value: cursor }); chunks.push(image);
    if (directory) entries.forEach((entry, i) => {
      const at = 80 + i * 8;
      header[at] = entry.tag & 255; header[at + 1] = entry.tag >>> 8 & 255; header[at + 2] = entry.tag >>> 16 & 255; header[at + 3] = entry.flags;
      header.writeUInt32LE(entry.value, at + 4);
    });
    const bytes = Buffer.concat([header, ...chunks]);
    return { bytes, blob: new Blob([bytes]), imageOffset, headerSize: hsize };
  }
  async function pixels(options) { return (await (await readSourceVtf(fixture(options).blob)).decode()).data; }
  const rawCases = [
    [0, [7, 19, 33, 48], [7, 19, 33, 48]], [1, [48, 33, 19, 7], [7, 19, 33, 48]],
    [2, [7, 19, 33], [7, 19, 33, 255]], [3, [33, 19, 7], [7, 19, 33, 255]],
    [5, [17], [17, 17, 17, 255]], [6, [17, 55], [17, 17, 17, 55]],
    [8, [55], [255, 255, 255, 55]], [11, [48, 7, 19, 33], [7, 19, 33, 48]],
    [12, [33, 19, 7, 48], [7, 19, 33, 48]], [16, [33, 19, 7, 0], [7, 19, 33, 255]],
    [21, [0, 252], [255, 0, 0, 255]], [21, [31, 0], [0, 0, 255, 0]],
  ];
  for (const [format, source, expected] of rawCases) assert.deepEqual(Array.from(await pixels({ format, pixels: () => Buffer.from(source) })), expected);
  const srgb = await readSourceVtf(fixture({ flags: 0x40, pixels: () => Buffer.from([7, 19, 33, 48]) }).blob);
  assert.equal(srgb.header.colorSpace, 'srgb'); assert.equal(srgb.header.srgbFlag, true);
  assert.deepEqual(Array.from((await srgb.decode()).data), [7, 19, 33, 48], 'File flag must not apply gamma or alpha conversion');
  assert.equal((await readSourceVtf(fixture().blob)).header.colorSpace, 'unspecified');
  const memoryFixture = fixture({ pixels: () => Buffer.from([7, 19, 33, 48]) });
  const memoryStorage = new Uint8Array(memoryFixture.bytes.length + 19);
  memoryStorage.set(memoryFixture.bytes, 11);
  const memoryInput = memoryStorage.subarray(11, 11 + memoryFixture.bytes.length);
  const memoryVtf = await readSourceVtf(memoryInput), memoryEncoded = await memoryVtf.encoded();
  assert.equal(memoryEncoded.data.buffer, memoryStorage.buffer);
  assert.equal(memoryEncoded.data.byteOffset, memoryInput.byteOffset + memoryFixture.imageOffset);
  assert.equal(memoryEncoded.sourceOffset, memoryFixture.imageOffset);
  assert.deepEqual(Array.from((await memoryVtf.decode()).data), [7, 19, 33, 48]);
  assert.equal((await memoryVtf.decode()).data.buffer, memoryStorage.buffer, 'RGBA in-memory decode borrows the exact original range');
  const arrayInput = memoryFixture.bytes.buffer.slice(memoryFixture.bytes.byteOffset, memoryFixture.bytes.byteOffset + memoryFixture.bytes.byteLength);
  assert.equal((await (await readSourceVtf(arrayInput)).encoded()).data.buffer, arrayInput);
  await assert.rejects(memoryVtf.encoded({ mip: 1 }));
  const ownedEncoded = await (await readSourceVtf(memoryFixture.blob)).encoded();
  assert.deepEqual(Array.from(ownedEncoded.data), [7, 19, 33, 48]);
  const encodedAbort = new AbortController(); encodedAbort.abort();
  await assert.rejects(memoryVtf.encoded({}, encodedAbort.signal), { name: 'AbortError' });
  const hdr = await readSourceVtf(fixture({ format: 24, flags: 0x40, pixels: () => Buffer.from([0, 64, 0, 188, 1, 0, 0, 60]) }).blob);
  assert.equal(hdr.header.colorSpace, 'linear'); assert.equal((await hdr.decode()).pixelType, 'rgba32f');
  assert.deepEqual(Array.from((await hdr.decode()).data), [2, -1, 2 ** -24, 1], 'Preserve HDR, negative and half subnormal values');
  const special = await pixels({ format: 24, pixels: () => Buffer.from([0, 128, 0, 124, 0, 252, 1, 124]) });
  assert(Object.is(special[0], -0)); assert.equal(special[1], Infinity); assert.equal(special[2], -Infinity); assert(Number.isNaN(special[3]));
  const uv = await readSourceVtf(fixture({ format: 22, pixels: () => Buffer.from([128, 127]) }).blob);
  assert.equal(uv.header.colorSpace, 'signed-normalized'); assert.deepEqual(Array.from((await uv.decode()).data), [-1, 1, 0, 1]);

  function bcColor(c0, c1 = 0, indices = 0) { const b = Buffer.alloc(8); b.writeUInt16LE(c0); b.writeUInt16LE(c1, 2); b.writeUInt32LE(indices >>> 0, 4); return b; }
  for (const format of [13, 20]) {
    const edge = await pixels({ format, width: 5, height: 3, pixels: () => Buffer.concat([bcColor(0xf800), bcColor(0x001f)]) });
    assert.equal(edge.length, 5 * 3 * 4);
    for (let y = 0; y < 3; y++) for (let x = 0; x < 5; x++) assert.deepEqual(Array.from(edge.subarray((y * 5 + x) * 4, (y * 5 + x + 1) * 4)), x === 4 ? [0, 0, 255, 255] : [255, 0, 0, 255]);
    assert.deepEqual(Array.from(await pixels({ format, pixels: () => bcColor(0, 0xffff, 3) })), [0, 0, 0, 0], 'BC1 three-color transparent entry');
    assert.deepEqual(Array.from(await pixels({ format, pixels: () => bcColor(0xf800, 0x001f, 2) })), [170, 0, 85, 255], 'BC1 four-color interpolation');
  }
  const dxt3 = Buffer.concat([Buffer.from([0x21, 0x43, 0x65, 0x87, 0xa9, 0xcb, 0xed, 0x0f]), bcColor(0, 0xffff, 0xffffffff)]);
  const bc2 = await pixels({ format: 14, width: 4, height: 4, pixels: () => dxt3 });
  assert.deepEqual(Array.from(bc2.subarray(0, 8)), [170, 170, 170, 17, 170, 170, 170, 34], 'BC2 forces four-color palette and decodes alpha nibbles');
  assert.equal(bc2[15 * 4 + 3], 0);
  for (const [a0, a1, expected] of [[240, 30, 60], [10, 110, 255]]) {
    const alpha = Buffer.alloc(8); alpha[0] = a0; alpha[1] = a1;
    // Last pixel's selector occupies the upper three of 48 bits.
    let bits = 7 * 2 ** 45 + 2;
    for (let i = 0; i < 6; i++) { alpha[2 + i] = bits % 256; bits = Math.floor(bits / 256); }
    const bc3 = await pixels({ format: 15, width: 4, height: 4, pixels: () => Buffer.concat([alpha, bcColor(0xf800)]) });
    assert.equal(bc3[3], a0 > a1 ? 210 : 30, 'BC3 interpolated alpha entry');
    assert.equal(bc3[15 * 4 + 3], expected, 'BC3 full 48-bit selector and both alpha tables');
  }

  for (const minor of [0, 1, 2, 3, 4, 5]) for (const firstFrame of [0, 65535]) {
    const f = fixture({ minor, flags: 0x4000, frames: 2, firstFrame, pixels: ({ frame, face }) => Buffer.from([frame * 20 + face, 0, 0, 255]) });
    const t = await readSourceVtf(f.blob), stored = minor < 5 && firstFrame !== 65535 ? 7 : 6;
    assert.equal(t.header.storedFaces, stored); assert.equal(t.header.hasSpheremap, stored === 7);
    assert.equal((await t.decode({ frame: 1, face: stored - 1 })).data[0], 20 + stored - 1);
    await assert.rejects(t.decode({ face: stored }));
  }
  const packedDepth = await readSourceVtf(fixture({ minor: 2, depth: 257,
    pixels: ({ z }) => Buffer.from([z === 256 ? 91 : 0, 33, 65, 255]) }).blob);
  assert.equal(packedDepth.header.depth, 257, 'Packed depth includes bytes63 and64, not padding');
  assert.deepEqual(Array.from((await packedDepth.decode({ z: 256 })).data), [91, 33, 65, 255]);
  const volume = fixture({ width: 4, height: 2, depth: 4, frames: 2, mips: 3, pixels: ({ mip, frame, z, width, height }) => Buffer.alloc(width * height * 4, mip * 40 + frame * 10 + z) });
  class RangedBlob extends Blob {
    ranges = [];
    arrayBuffer() { throw new Error('Full-file copies are forbidden'); }
    slice(start, end, type) { this.ranges.push([start, end]); return super.slice(start, end, type); }
  }
  const tracked = new RangedBlob([volume.bytes]), vt = await readSourceVtf(tracked);
  assert(!tracked.ranges.some(([start]) => start >= volume.imageOffset), 'Header parse must not read texture pixels');
  tracked.ranges.length = 0;
  const selected = await vt.decode({ frame: 1, mip: 1, z: 1 });
  assert.equal(selected.width, 2); assert.equal(selected.height, 1); assert.equal(selected.data[0], 51);
  assert.deepEqual(tracked.ranges, [[selected.sourceOffset, selected.sourceOffset + 8]], 'Exactly one selected frame/mip/z range is read');
  for (const selection of [{ frame: 2 }, { frame: -1 }, { face: 1 }, { mip: 3 }, { mip: 0.5 }, { mip: 2, z: 1 }, { z: NaN }]) await assert.rejects(vt.decode(selection));

  const chunks = fixture({ thumbnail: bcColor(0xf800), resources: [{ tag: 0x00435243, inlineValue: 1234 }, { tag: 0x0044564b, payload: Buffer.from('real resource payload') }] });
  const rt = await readSourceVtf(chunks.blob);
  assert.equal(rt.resources.find(r => r.tag === 0x00435243).inlineValue, 1234);
  const chunk = rt.resources.find(r => r.tag === 0x0044564b);
  assert.equal(await chunks.blob.slice(chunk.offset, chunk.offset + chunk.byteLength).text(), 'real resource payload');
  assert.equal((await rt.decode()).sourceOffset, chunks.imageOffset);
  const padded = fixture({ minor: 1, headerPadding: 16, thumbnail: bcColor(0xf800), pixels: () => Buffer.from([1, 2, 3, 4]) });
  assert.deepEqual(Array.from((await (await readSourceVtf(padded.blob)).decode()).data), [1, 2, 3, 4], 'Legacy layout honors declared header size and thumbnail');
  const noDirectory = fixture({ minor: 3, directory: false }); await readSourceVtf(noDirectory.blob);

  const corrupt = async (base, change) => { const bytes = Buffer.from(base.bytes); change(bytes); await assert.rejects(readSourceVtf(new Blob([bytes]))); };
  const plain = fixture();
  await assert.rejects(readSourceVtf(new Blob([Buffer.alloc(12)])));
  await assert.rejects(readSourceVtf(plain.blob.slice(0, -1)));
  await corrupt(plain, b => b.writeUInt32LE(0, 0));
  await corrupt(plain, b => b.writeUInt32LE(6, 8));
  await corrupt(plain, b => b.writeUInt32LE(64, 12));
  await corrupt(plain, b => b.writeUInt16LE(0, 16));
  await corrupt(plain, b => b.writeUInt16LE(0, 63));
  await corrupt(plain, b => b.writeUInt16LE(2, 26));
  await corrupt(plain, b => { b[56] = 2; });
  await corrupt(plain, b => b.writeInt32LE(99, 52));
  await corrupt(plain, b => b.writeUInt32LE(33, 68));
  await corrupt(plain, b => { b[83] = 2; });
  await corrupt(plain, b => { b[83] = 4; });
  await corrupt(plain, b => { b[80] = 0x31; });
  await corrupt(plain, b => b.writeUInt32LE(0xffffffff, 84));
  await corrupt(plain, b => b.writeUInt32LE(8, 84));
  await corrupt(chunks, b => { b[88] = b[80]; b[89] = b[81]; b[90] = b[82]; });
  await corrupt(chunks, b => b.writeUInt32LE(0xffffffff, chunks.headerSize + 9));
  await corrupt(chunks, b => b.writeUInt32LE(chunks.headerSize + 9, 80 + 3 * 8 + 4));
  await assert.rejects(readSourceVtf(fixture({ width: 2, height: 1, flags: 0x4000 }).blob));
  await assert.rejects(readSourceVtf(fixture({ width: 2, height: 2, depth: 2, flags: 0x4000 }).blob));
  const controller = new AbortController(); controller.abort();
  await assert.rejects(readSourceVtf(plain.blob, controller.signal), { name: 'AbortError' });
  await assert.rejects(vt.decode({}, controller.signal), { name: 'AbortError' });
  class AbortingBlob extends Blob {
    slice(start, end, type) { const result = super.slice(start, end, type); return { arrayBuffer: async () => { const bytes = await result.arrayBuffer(); during.abort(); return bytes; } }; }
  }
  const during = new AbortController();
  await assert.rejects(readSourceVtf(new AbortingBlob([plain.bytes]), during.signal), { name: 'AbortError' });
  const duringDecode = new AbortController();
  class SelectedAbortingBlob extends Blob {
    slice(start, end, type) {
      const result = super.slice(start, end, type);
      return start === plain.imageOffset ? { arrayBuffer: async () => { const bytes = await result.arrayBuffer(); duringDecode.abort(); return bytes; } } : result;
    }
  }
  const selectedAbort = await readSourceVtf(new SelectedAbortingBlob([plain.bytes]));
  await assert.rejects(selectedAbort.decode({}, duringDecode.signal), { name: 'AbortError' });
  console.log('PASS VTF channels/HDR/SNORM/BC edge and alpha/layout/resources/ranges/corruption/cancellation boundaries');
}
