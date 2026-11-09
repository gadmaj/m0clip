/** CPU-only binary/resource boundaries. No game data is embedded and no rendering is claimed. */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';


import { build } from 'esbuild';
import { zipSync, strToU8 } from 'fflate';
import { Worker } from 'node:worker_threads';
import { once } from 'node:events';
import { constants as zlibConstants, deflateRawSync } from 'node:zlib';
import { spawnSync } from 'node:child_process';

const compiled = await build({ entryPoints: ['src/maps/raw-source-files.ts'], bundle: true, platform: 'node', format: 'cjs', write: false });
const module = { exports: {} };
new Function('module', 'require', compiled.outputFiles[0].text)(module, createRequire(import.meta.url));
const { SourceFileSystem, SourceMissingChunkError, canonicalSourcePath } = module.exports;
const indexCompiled = await build({ entryPoints: ['src/maps/source-import-index.ts'], bundle: true, platform: 'node', format: 'cjs', write: false });
const indexModule = { exports: {} };
new Function('module', 'require', indexCompiled.outputFiles[0].text)(indexModule, createRequire(import.meta.url));
const { selectedSourceBsp } = indexModule.exports;

{
  const crcTable = Uint32Array.from({ length: 256 }, (_, n) => {
    for (let i = 0; i < 8; i++) n = n & 1 ? 0xedb88320 ^ (n >>> 1) : n >>> 1;
    return n >>> 0;
  });
  function crc(bytes) {
    let value = 0xffffffff;
    for (const byte of bytes) value = crcTable[(value ^ byte) & 255] ^ (value >>> 8);
    return (value ^ 0xffffffff) >>> 0;
  }
  function u32(value) { const out = Buffer.alloc(4); out.writeUInt32LE(value); return out; }
  function u64(value) { const out = Buffer.alloc(8); out.writeBigUInt64LE(BigInt(value)); return out; }
  function z(value) { return Buffer.from(value + '\0'); }
  function vpk({ version = 1, archive = 0x7fff, offset = 7, payload = Buffer.from('body'), preload = Buffer.from('pre'), paths = ['materials/nested/sample.vmt'], crcOverride, terminator = 0xffff } = {}) {
    const records = [];
    for (const path of paths) {
      const slash = path.lastIndexOf('/'), dot = path.lastIndexOf('.');
      const record = Buffer.alloc(18);
      record.writeUInt32LE(crcOverride ?? crc(Buffer.concat([preload, payload])), 0);
      record.writeUInt16LE(preload.length, 4); record.writeUInt16LE(archive, 6);
      record.writeUInt32LE(offset, 8); record.writeUInt32LE(payload.length, 12); record.writeUInt16LE(terminator, 16);
      records.push(z(dot < 0 ? ' ' : path.slice(dot + 1)), z(slash < 0 ? ' ' : path.slice(0, slash)), z(path.slice(slash + 1, dot < 0 ? undefined : dot)), record, preload, z(''), z(''));
    }
    const tree = Buffer.concat([...records, z('')]), header = Buffer.alloc(version === 1 ? 12 : 28);
    header.writeUInt32LE(0x55aa1234, 0); header.writeUInt32LE(version, 4); header.writeUInt32LE(tree.length, 8);
    const body = Buffer.concat([Buffer.alloc(offset, 0xa5), payload, Buffer.from('not part of the resource')]);
    const embedded = archive === 0x7fff ? body : Buffer.alloc(0);
    if (version === 2) header.writeUInt32LE(embedded.length, 12);
    return { directory: new Blob([header, tree, embedded]), chunk: new Blob([body]), raw: Buffer.concat([header, tree, embedded]) };
  }
  function gma(entries, options = {}) {
    const header = Buffer.alloc(21); header.write('GMAD'); header[4] = 3;
    const table = entries.flatMap(([path, body], index) => [u32(index + 1), z(path), u64(body.length), u32(options.zeroCrc ? 0 : crc(body))]);
    return new Blob([header, z('required-content-id'), z(''), z(options.name ?? 'Fixture'), z('{"description":"fixture"}'), z('Author'), u32(1), ...table, u32(0), ...entries.map(([, body]) => body), ...(options.footer ? [u32(0)] : [])]);
  }
  const text = async (fs, path) => (await fs.readFile(path))?.text();
  const loose = (path, body) => ({ kind: 'loose', files: [{ path, blob: new Blob([body]) }] });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = () => { throw new Error('Unexpected network access'); };
  try {
    const pak = { kind: 'zip', file: new Blob([zipSync({ 'Materials/Nested/Sample.vmt': strToU8('pak'), 'maps/a.bsp': strToU8('a'), 'maps/other/a.bsp': strToU8('b') })]) };
    const ordered = await SourceFileSystem.create([pak, loose('materials/nested/sample.vmt', 'loose')]);
    assert.equal(await text(ordered, 'MATERIALS\\NESTED\\SAMPLE.VMT'), 'pak');
    assert.deepEqual(ordered.mapCandidates.map(file => file.path), ['maps/a.bsp', 'maps/other/a.bsp']);
    assert.equal(await ordered.readFile('sample.vmt'), undefined, 'Never choose a duplicate basename');
    assert.equal(await text(await SourceFileSystem.create([loose('materials/nested/sample.vmt', 'isolated')]), 'materials/nested/sample.vmt'), 'isolated');
    assert.equal(await text(await SourceFileSystem.create([loose('literal%2f.vmt', 'literal')]), 'literal%2f.vmt'), 'literal');
    const unicode = await SourceFileSystem.create([loose('J\u030c.vmt', 'normalized')]);
    assert.equal(await text(unicode, unicode.files[0].path), 'normalized', 'Canonical lowercase paths remain NFC and readable');
    await assert.rejects(SourceFileSystem.create([{ kind: 'loose', files: [
      { path: 'J\u030c.vmt', blob: new Blob() }, { path: '\u01f0.vmt', blob: new Blob() },
    ] }]));
    // Opt-in large paths still avoid retaining a quadratic set of ancestor strings.
    const deep = new Worker(`
      const { parentPort, workerData } = require('node:worker_threads');
      const load = require('node:module').createRequire(workerData.importer);
      const module = { exports: {} };
      new Function('module', 'require', workerData.compiled)(module, load);
      const { zipSync, strToU8 } = load('fflate');
      (async () => {
        const path = 'a/'.repeat(32000) + 'x.vmt';
        const fs = await module.exports.SourceFileSystem.create([{ kind: 'zip', file: new Blob([zipSync({ [path]: strToU8('bounded') })]) }], undefined, { maxPathLength: 65535, maxPathDepth: 32001 });
        parentPort.postMessage(await (await fs.readFile(fs.files[0].path)).text());
      })().catch(error => { throw error; });
    `, { eval: true, resourceLimits: { maxOldGenerationSizeMb: 128 },
      workerData: { compiled: compiled.outputFiles[0].text, importer: import.meta.url } });
    const [[deepBody], [deepExit]] = await Promise.all([once(deep, 'message'), once(deep, 'exit')]);
    assert.equal(deepBody, 'bounded'); assert.equal(deepExit, 0);
    for (const path of ['../escape', '/absolute', 'a/../b', 'a//b', 'C:\\file', '\\\\server\\file', 'https://example/a']) await assert.rejects(SourceFileSystem.create([loose(path, '')]));
    for (const files of [
      [{ path: 'A.vmt', blob: new Blob() }, { path: 'a.VMT', blob: new Blob() }],
      [{ path: 'a', blob: new Blob() }, { path: 'a/b', blob: new Blob() }],
      [{ path: 'a/b', blob: new Blob() }, { path: 'a', blob: new Blob() }],
    ]) await assert.rejects(SourceFileSystem.create([{ kind: 'loose', files }]));
    // Small limits exercise aggregate metadata/index ownership without large attack allocations.
    const create = (mounts, limits) => SourceFileSystem.create(mounts, undefined, limits);
    await assert.rejects(create([loose('a', ''), loose('b', '')], { maxMounts: 1 }));
    await assert.rejects(create([loose('a', ''), loose('b', '')], { maxEntries: 1 }));
    await assert.rejects(create([loose('a/b', ''), loose('c/d', '')], { maxTrieNodes: 5 }));
    await assert.rejects(create([loose('abc', ''), loose('def', '')], { maxExpandedPathChars: 5 }));
    await assert.rejects(create([loose('a/b/c', '')], { maxPathDepth: 2 }));
    await assert.rejects(create([loose('abcd', '')], { maxPathLength: 3 }));
    await assert.rejects(create([loose('abcd', '')], { maxNameLength: 3 }));
    await assert.rejects(create([loose('a/'.repeat(129) + 'x', '')], {}));
    const metadataZip = zipSync({ a: new Uint8Array() });
    const metadataSize = Buffer.from(metadataZip).readUInt32LE(metadataZip.length - 22 + 12);
    await assert.rejects(create([{ kind: 'zip', file: new Blob([metadataZip]) }, { kind: 'zip', file: new Blob([metadataZip]) }], { maxMetadataBytes: metadataSize * 2 - 1 }));
    await assert.rejects(create([{ kind: 'gma', file: gma([['a/b/c', Buffer.alloc(0)]]) }], { maxPathDepth: 2 }));
    const sharedRecord = Buffer.alloc(18); sharedRecord.writeUInt16LE(0x7fff, 6); sharedRecord.writeUInt16LE(0xffff, 16);
    const sharedTree = Buffer.concat([z('vmt'), z('a/b/c'), ...[0, 1, 2].flatMap(index => [z(`asset${index}`), sharedRecord]), z(''), z(''), z('')]);
    const sharedHeader = Buffer.alloc(12); sharedHeader.writeUInt32LE(0x55aa1234); sharedHeader.writeUInt32LE(1, 4); sharedHeader.writeUInt32LE(sharedTree.length, 8);
    const sharedFolderVpk = { kind: 'vpk', directory: new Blob([sharedHeader, sharedTree]) };
    await assert.rejects(create([sharedFolderVpk], { maxExpandedPathChars: 30 }));
    const sharedFolderFs = await create([sharedFolderVpk], { maxExpandedPathChars: 48 });
    assert.equal((await sharedFolderFs.readFile('a/b/c/asset2.vmt')).size, 0);
    for (const limits of [{ maxEntries: -1 }, { maxResources: NaN }, { maxPathLength: 1.5 }]) await assert.rejects(create([], limits));
    for (const version of [1, 2]) {
      const fixture = vpk({ version });
      const fs = await SourceFileSystem.create([{ kind: 'vpk', directory: fixture.directory }]);
      assert.equal(await text(fs, 'materials/nested/sample.vmt'), 'prebody', 'Preload plus exact nonzero embedded offset/length');
      const external = vpk({ version, archive: 4 });
      const complete = await SourceFileSystem.create([{ kind: 'vpk', directory: external.directory, chunks: [{ index: 4, blob: external.chunk }] }]);
      assert.equal(await text(complete, 'materials/nested/sample.vmt'), 'prebody', 'Numbered external chunk has the same exact range');
      const missing = await SourceFileSystem.create([{ kind: 'vpk', label: 'Companion', directory: external.directory }, loose('materials/nested/sample.vmt', 'must not fall through')]);
      assert.deepEqual(missing.mounts[0].missingChunks, [4]);
      await assert.rejects(missing.readFile('materials/nested/sample.vmt'), error => error instanceof SourceMissingChunkError && error.chunkIndex === 4);
      await assert.rejects(SourceFileSystem.create([{ kind: 'vpk', directory: external.directory, chunks: [{ index: 4, blob: external.chunk.slice(0, 8) }] }]));
      const corrupt = vpk({ version, crcOverride: 0 });
      const bad = await SourceFileSystem.create([{ kind: 'vpk', directory: corrupt.directory }]);
      await assert.rejects(bad.readFile('materials/nested/sample.vmt'));
    }
    const noExtension = vpk({ paths: ['README'], payload: Buffer.from('x'), preload: Buffer.alloc(0) });
    assert.equal(await text(await SourceFileSystem.create([{ kind: 'vpk', directory: noExtension.directory }]), 'readme'), 'x');
    const preloadOnly = vpk({ archive: 5, payload: Buffer.alloc(0) });
    const preloadFs = await SourceFileSystem.create([{ kind: 'vpk', directory: preloadOnly.directory }]);
    assert.equal(await text(preloadFs, 'materials/nested/sample.vmt'), 'pre');
    assert.deepEqual(preloadFs.mounts[0].missingChunks, []);
    const duplicates = vpk({ paths: ['materials/a.vmt', 'MATERIALS/A.VMT'] });
    await assert.rejects(SourceFileSystem.create([{ kind: 'vpk', directory: duplicates.directory }]));
    await assert.rejects(SourceFileSystem.create([{ kind: 'vpk', directory: vpk({ terminator: 0 }).directory }]));
    const truncatedTree = vpk().raw; truncatedTree.writeUInt32LE(truncatedTree.length, 8);
    await assert.rejects(SourceFileSystem.create([{ kind: 'vpk', directory: new Blob([truncatedTree]) }]));
    const fixture = vpk({ archive: 4 });
    await assert.rejects(SourceFileSystem.create([{ kind: 'vpk', directory: fixture.directory, chunks: [{ index: 4, blob: fixture.chunk }, { index: 4, blob: fixture.chunk }] }]));

    // The long metadata string crosses the reader page boundary; the second body has a nonzero offset.
    const addon = gma([['maps/one.bsp', Buffer.from('first')], ['maps/two.bsp', Buffer.from('second')]], { name: 'n'.repeat(65540), footer: true });
    const addonFs = await SourceFileSystem.create([{ kind: 'gma', file: addon }]);
    assert.equal(await text(addonFs, 'maps/two.bsp'), 'second');
    assert.deepEqual(addonFs.mounts[0].requiredContents, ['required-content-id']);
    assert.equal(addonFs.mounts[0].addon.name.length, 65540);
    const addonBytes = Buffer.from(await addon.arrayBuffer()); addonBytes[addonBytes.length - 5] ^= 1;
    const corruptAddon = await SourceFileSystem.create([{ kind: 'gma', file: new Blob([addonBytes]) }]);
    await assert.rejects(corruptAddon.readFile('maps/two.bsp'));
    await assert.rejects(SourceFileSystem.create([{ kind: 'gma', file: addon.slice(0, addon.size - 5) }]));
    await assert.rejects(SourceFileSystem.create([{ kind: 'gma', file: gma([['maps/a.bsp', Buffer.from('a')], ['Maps/A.BSP', Buffer.from('b')]]) }]));
    await assert.rejects(SourceFileSystem.create([{ kind: 'gma', file: gma([['../a', Buffer.alloc(0)]]) }]));
    const huge = Buffer.from(await gma([['a', Buffer.alloc(0)]]).arrayBuffer());
    const sizeAt = huge.indexOf(Buffer.from('a\0'), 21) + 2;
    huge.writeBigUInt64LE(1n << 63n, sizeAt);
    await assert.rejects(SourceFileSystem.create([{ kind: 'gma', file: new Blob([huge]) }]));
    // fastgmad records CRC 0 for every entry: that is no checksum, not a mismatch.
    const fastgmad = await SourceFileSystem.create([{ kind: 'gma', file: gma([['maps/fast.bsp', Buffer.from('fastgmad body')]], { zeroCrc: true }) }]);
    assert.equal(await text(fastgmad, 'maps/fast.bsp'), 'fastgmad body');
    // A GMA-contained BSP over the 128 MiB decompression limit is a slice of the
    // selected file, so choosing it allocates nothing beyond small metadata pages.
    class SparseBlob {
      static largest = 0;
      constructor(size, parts, offset = 0) { this.size = size; this.parts = parts; this.offset = offset; }
      slice(start = 0, end = this.size) {
        start = Math.max(0, Math.min(start, this.size)); end = Math.max(start, Math.min(end, this.size));
        return new SparseBlob(end - start, this.parts, this.offset + start);
      }
      async arrayBuffer() {
        SparseBlob.largest = Math.max(SparseBlob.largest, this.size);
        if (this.size > 1024 * 1024) throw new Error('test fixture: unexpected large materialization');
        const out = new Uint8Array(this.size);
        for (const { at, bytes } of this.parts) {
          const from = Math.max(at, this.offset), to = Math.min(at + bytes.length, this.offset + this.size);
          if (from < to) out.set(bytes.subarray(from - at, to - at), from - this.offset);
        }
        return out.buffer;
      }
    }
    const bigBytes = 129 * 1024 * 1024, gmaHeader = Buffer.alloc(21); gmaHeader.write('GMAD'); gmaHeader[4] = 3;
    const bigMeta = Buffer.concat([gmaHeader, z(''), z('Big'), z('{}'), z('Author'), u32(1), u32(1), z('maps/big.bsp'), u64(bigBytes), u32(0), u32(0)]);
    const vbsp = Buffer.alloc(1036); vbsp.write('VBSP'); vbsp.writeInt32LE(20, 4);
    const bigGma = Object.assign(new SparseBlob(bigMeta.length + bigBytes, [{ at: 0, bytes: bigMeta }, { at: bigMeta.length, bytes: vbsp }]), { name: 'big.gma' });
    const bigSelection = await selectedSourceBsp({ kind: 'source', format: 'gma', file: bigGma, mapPath: 'maps/big.bsp', name: 'Big', game: 'Garry’s Mod', mounts: [] });
    assert.equal(bigSelection.file.size, bigBytes);
    assert.equal(bigSelection.mapName, 'big');
    assert(SparseBlob.largest <= 64 * 1024, `Selecting the slice materialized ${SparseBlob.largest} bytes`);
    await assert.rejects((await SourceFileSystem.create([{ kind: 'gma', file: bigGma }])).readFile('maps/big.bsp'), /allowance/, 'Callers without an explicit allowance keep the default cap');

    for (const level of [0, 6]) {
      const bytes = zipSync({ 'materials/ok.vmt': strToU8('selected'), 'materials/unused.vmt': strToU8('not selected') }, { level });
      const fs = await SourceFileSystem.create([{ kind: 'zip', file: new Blob([bytes]) }]);
      assert.equal(await text(fs, 'materials/ok.vmt'), 'selected');
      const damaged = Buffer.from(bytes), local = damaged.indexOf(Buffer.from('selected'));
      if (level === 0) {
        assert(local >= 0); damaged[local] ^= 1;
        const bad = await SourceFileSystem.create([{ kind: 'zip', file: new Blob([damaged]) }]);
        await assert.rejects(bad.readFile('materials/ok.vmt'));
        assert.equal(await text(bad, 'materials/unused.vmt'), 'not selected');
      }
    }
    // LZMA (method 14) members, as bspzip -repack -compress writes, from an
    // independent encoder: Python's zipfile (APPNOTE header, end-marker flag set).
    const lzmaBody = Buffer.from(Array.from({ length: 300 }, (_, i) => `brush ${i % 17} face ${i * 7919 % 1000};`).join('\n'));
    const pythonZip = spawnSync('python3', ['-c', `
import io, sys, zipfile
body = sys.stdin.buffer.read()
out = io.BytesIO()
with zipfile.ZipFile(out, 'w') as archive:
    archive.writestr(zipfile.ZipInfo('materials/lzma.vmt'), body, compress_type=zipfile.ZIP_LZMA)
    archive.writestr(zipfile.ZipInfo('materials/empty.vmt'), b'', compress_type=zipfile.ZIP_LZMA)
    archive.writestr(zipfile.ZipInfo('materials/bzip2.vmt'), body, compress_type=zipfile.ZIP_BZIP2)
    archive.writestr(zipfile.ZipInfo('materials/stored.vmt'), b'stored', compress_type=zipfile.ZIP_STORED)
sys.stdout.buffer.write(out.getvalue())`], { input: lzmaBody });
    assert.equal(pythonZip.status, 0, `Independent ZIP fixture encoding failed: ${pythonZip.stderr}`);
    const lzmaZip = pythonZip.stdout, lzmaFs = await create([{ kind: 'zip', file: new Blob([lzmaZip]) }], {});
    assert.equal(lzmaZip.readUInt16LE(8), 14, 'The fixture member really uses method 14');
    assert.deepEqual(Buffer.from(await (await lzmaFs.readFile('materials/lzma.vmt')).arrayBuffer()), lzmaBody);
    assert.equal((await lzmaFs.readFile('materials/empty.vmt')).size, 0);
    assert.equal(await text(lzmaFs, 'materials/stored.vmt'), 'stored', 'An unsupported member does not block its siblings');
    await assert.rejects(lzmaFs.readFile('materials/bzip2.vmt'), /compression method 12/);
    const damagedLzma = Buffer.from(lzmaZip), lzmaData = 30 + 'materials/lzma.vmt'.length + 9 + 40;
    damagedLzma[lzmaData] ^= 0x55;
    await assert.rejects((await create([{ kind: 'zip', file: new Blob([damagedLzma]) }], {})).readFile('materials/lzma.vmt'));
    // A chosen BSP that is itself an LZMA member keeps the default decompression
    // working-memory bound: only stored slices lift the selection's total cap.
    const lzmaMap = spawnSync('python3', ['-c', `
import io, sys, zipfile
body = b'VBSP' + (20).to_bytes(4, 'little') + bytes(32 * 1024 * 1024 - 8)
out = io.BytesIO()
with zipfile.ZipFile(out, 'w') as archive:
    archive.writestr(zipfile.ZipInfo('maps/packed.bsp'), body, compress_type=zipfile.ZIP_LZMA)
sys.stdout.buffer.write(out.getvalue())`]);
    assert.equal(lzmaMap.status, 0, `Independent LZMA map fixture encoding failed: ${lzmaMap.stderr}`);
    assert(lzmaMap.stdout.length < 1024 * 1024, 'The packed map fixture is small on disk');
    await assert.rejects(selectedSourceBsp({ kind: 'source', format: 'zip', file: Object.assign(new Blob([lzmaMap.stdout]), { name: 'packed.zip' }), mapPath: 'maps/packed.bsp', name: 'Packed', game: 'Team Fortress 2', mounts: [] }),
      /ownership byte limit/, 'A 32 MiB LZMA BSP is refused before decoder state is allocated');
    // Independently wrap raw zlib Deflate: fixed/dynamic and a stored block crossing
    // multiple bounded codec feeds must preserve exact output and native ZIP CRC.
    function deflateZip(body, compressed = deflateRawSync(body), declared = body.length, checksum = crc(body)) {
      const local = Buffer.alloc(30), central = Buffer.alloc(46), end = Buffer.alloc(22), name = Buffer.from('a');
      local.writeUInt32LE(0x04034b50); local.writeUInt16LE(20, 4); local.writeUInt16LE(8, 8);
      local.writeUInt32LE(checksum, 14); local.writeUInt32LE(compressed.length, 18); local.writeUInt32LE(declared, 22); local.writeUInt16LE(1, 26);
      central.writeUInt32LE(0x02014b50); central.writeUInt16LE(20, 6); central.writeUInt16LE(8, 10);
      central.writeUInt32LE(checksum, 16); central.writeUInt32LE(compressed.length, 20); central.writeUInt32LE(declared, 24); central.writeUInt16LE(1, 28);
      end.writeUInt32LE(0x06054b50); end.writeUInt16LE(1, 8); end.writeUInt16LE(1, 10);
      end.writeUInt32LE(central.length + name.length, 12); end.writeUInt32LE(local.length + name.length + compressed.length, 16);
      return Buffer.concat([local, name, compressed, central, name, end]);
    }
    const body = Buffer.from('native binary payload '.repeat(400));
    for (const compressed of [deflateRawSync(body), deflateRawSync(body, { strategy: zlibConstants.Z_FIXED }), deflateRawSync(body, { level: 0 })]) {
      const fs = await create([{ kind: 'zip', file: new Blob([deflateZip(body, compressed)]) }], {});
      assert.deepEqual(Buffer.from(await (await fs.readFile('a')).arrayBuffer()), body);
    }
    const storedBody = Buffer.from(Uint8Array.from({ length: 70000 }, (_, index) => (index * 73 ^ index >>> 5) & 255));
    const storedFs = await create([{ kind: 'zip', file: new Blob([deflateZip(storedBody, deflateRawSync(storedBody, { level: 0 }))]) }], {});
    assert.deepEqual(Buffer.from(await (await storedFs.readFile('a')).arrayBuffer()), storedBody);
    // A nonfinal stored block aligns each native final block's header with the LAST
    // byte of a 4096-byte feed. A final header/block awaiting more input is not EOF.
    const boundaryPrefix = Buffer.alloc(4090, 0x5a), prefixHeader = Buffer.alloc(5);
    prefixHeader.writeUInt16LE(boundaryPrefix.length, 1); prefixHeader.writeUInt16LE(boundaryPrefix.length ^ 0xffff, 3);
    const dynamicBody = Buffer.from('a'.repeat(2000) + 'b'.repeat(1000) + 'c'.repeat(500) + 'defghijklmnop'.repeat(80));
    const dynamicCompressed = deflateRawSync(dynamicBody);
    assert.equal((dynamicCompressed[0] >>> 1) & 3, 2, 'Independent zlib fixture supplies a dynamic final Huffman block');
    for (const [tail, compressed] of [
      [storedBody.subarray(0, 5000), deflateRawSync(storedBody.subarray(0, 5000), { level: 0 })],
      [body, deflateRawSync(body, { strategy: zlibConstants.Z_FIXED })],
      [dynamicBody, dynamicCompressed],
    ]) {
      const expected = Buffer.concat([boundaryPrefix, tail]), stream = Buffer.concat([prefixHeader, boundaryPrefix, compressed]);
      const fs = await create([{ kind: 'zip', file: new Blob([deflateZip(expected, stream)]) }], {});
      assert.deepEqual(Buffer.from(await (await fs.readFile('a')).arrayBuffer()), expected);
    }
    const partialByteFs = await create([{ kind: 'zip', file: new Blob([deflateZip(Buffer.alloc(0), Buffer.from([3, 0xfc]))]) }], {});
    assert.equal((await partialByteFs.readFile('a')).size, 0, 'The final partial byte may contain unused padding bits');
    const alignedEmptyFs = await create([{ kind: 'zip', file: new Blob([deflateZip(Buffer.alloc(0), Buffer.from([1, 0, 0, 255, 255]))]) }], {});
    assert.equal((await alignedEmptyFs.readFile('a')).size, 0, 'A byte-aligned final stored block has no retained partial byte');
    for (const compressed of [
      Buffer.from([3, 0, 0]), // One whole trailing byte after a partial-byte final block.
      Buffer.from([1, 0, 0, 255, 255, 0]), // One byte after a byte-aligned final block.
      Buffer.from([0, 0, 0, 255, 255]), // Complete nonfinal empty block, with no final block.
      Buffer.from([1, 1, 0, 254, 255]), // Incomplete final stored body.
      deflateRawSync(body).subarray(0, 1), // Incomplete final compressed header/code.
    ]) {
      const fs = await create([{ kind: 'zip', file: new Blob([deflateZip(Buffer.alloc(0), compressed)]) }], {});
      await assert.rejects(fs.readFile('a'));
    }
    class TrackingBlob extends Blob {
      tracking = false;
      bytesRead = 0;
      hold;
      slice(...args) {
        const part = super.slice(...args), arrayBuffer = part.arrayBuffer.bind(part), hold = this.hold;
        if (this.tracking) part.arrayBuffer = async () => {
          if (hold) await hold;
          const bytes = await arrayBuffer();
          this.bytesRead += bytes.byteLength;
          return bytes;
        };
        return part;
      }
    }
    const expansionFile = new TrackingBlob([deflateZip(body, undefined, 0x10000000)]);
    const declaredFs = await create([{ kind: 'zip', file: expansionFile }], {});
    expansionFile.tracking = true;
    await assert.rejects(declaredFs.readFile('a', undefined, 32));
    await assert.rejects(declaredFs.readFile('a', undefined, Number.MAX_SAFE_INTEGER), /decompresses to 268435456 bytes/, 'A generous caller allowance never lifts the decompression limit');
    assert.equal(expansionFile.bytesRead, 0, 'Reject declared expansion before reading local headers or output');
    const overflowFs = await create([{ kind: 'zip', file: new Blob([deflateZip(body, undefined, 1)]) }, loose('a', 'never fallback')], {});
    await assert.rejects(overflowFs.readFile('a'));
    const corruptCrcFs = await create([{ kind: 'zip', file: new Blob([deflateZip(body, undefined, body.length, 0)]) }], {});
    await assert.rejects(corruptCrcFs.readFile('a'));
    const malformedFs = await create([{ kind: 'zip', file: new Blob([deflateZip(body, Buffer.from([7]))]) }], {});
    await assert.rejects(malformedFs.readFile('a'));
    const paddedDeflateFile = new TrackingBlob([deflateZip(Buffer.alloc(0), Buffer.concat([deflateRawSync(Buffer.alloc(0)), Buffer.alloc(5 * 4096)]))]);
    const paddedDeflateFs = await create([{ kind: 'zip', file: paddedDeflateFile }], {});
    paddedDeflateFile.tracking = true;
    await assert.rejects(paddedDeflateFs.readFile('a'), 'A final empty Deflate block cannot hide compressed padding inside the declared member');
    assert(paddedDeflateFile.bytesRead <= 4096 + 31, 'Reject after at most one bounded body feed and local metadata, without reading the trailing padding');
    const cacheFile = new TrackingBlob([deflateZip(body)]);
    const cachedFs = await create([{ kind: 'zip', file: cacheFile }], { maxResources: 1 });
    cacheFile.tracking = true;
    const cancelled = new AbortController();
    const abandoned = cachedFs.readFile('A', cancelled.signal), survivor = cachedFs.readFile('a');
    cancelled.abort();
    await assert.rejects(abandoned, { name: 'AbortError' });
    const retained = await survivor, extractedBytes = cacheFile.bytesRead;
    assert.deepEqual(Buffer.from(await retained.arrayBuffer()), body);
    assert.strictEqual(await cachedFs.readFile('A'), retained, 'Canonical concurrent ANI-like reads retain one Blob identity');
    assert.equal(cacheFile.bytesRead, extractedBytes, 'A repeated canonical read consumes no additional archive bytes');
    await assert.rejects(cachedFs.readFile('a', undefined, body.length - 1));
    for (const allowance of [-1, NaN, 1.5]) await assert.rejects(cachedFs.readFile('a', undefined, allowance));
    const concurrentFs = await create([loose('a', '1234'), loose('b', '5678')], { maxTotalResourceBytes: 7 });
    const first = concurrentFs.readFile('a');
    await assert.rejects(concurrentFs.readFile('b'));
    await first;
    await assert.rejects(concurrentFs.readFile('b'));
    const countFs = await create([loose('a', ''), loose('b', '')], { maxResources: 1 });
    await countFs.readFile('a');
    await assert.rejects(countFs.readFile('b'));
    const workspaceFile = new TrackingBlob([deflateZip(body)]);
    const workspaceFs = await create([{ kind: 'zip', file: workspaceFile }], { maxTotalResourceBytes: body.length * 2 });
    workspaceFile.tracking = true;
    const pendingFile = new TrackingBlob([zipSync({ a: body, b: body })]);
    const pendingFs = await create([{ kind: 'zip', file: pendingFile }], { maxTotalResourceBytes: 16 * 1024 * 1024 + 3 * body.length });
    pendingFile.tracking = true;
    let releasePending;
    pendingFile.hold = new Promise(resolve => { releasePending = resolve; });
    const pendingA = pendingFs.readFile('a');
    await assert.rejects(pendingFs.readFile('b'), 'Concurrent ZIP output and codec ownership is reserved before extraction');
    releasePending();
    pendingFile.hold = undefined;
    assert.deepEqual(Buffer.from(await (await pendingA).arrayBuffer()), body);
    assert.deepEqual(Buffer.from(await (await pendingFs.readFile('b')).arrayBuffer()), body, 'Released temporary workspace may be reused without evicting retained output');
    await assert.rejects(workspaceFs.readFile('a'));
    assert.equal(workspaceFile.bytesRead, 0, 'Reserve codec workspace before extraction, not in its callback');
    const retryFile = new TrackingBlob([deflateZip(body)]);
    const retryFs = await create([{ kind: 'zip', file: retryFile }], { maxResources: 1 });
    retryFile.tracking = true;
    let release;
    retryFile.hold = new Promise(resolve => { release = resolve; });
    const abortAll = new AbortController(), interrupted = retryFs.readFile('a', abortAll.signal);
    await Promise.resolve(); // Start the held local-header read before cancellation.
    abortAll.abort();
    await assert.rejects(interrupted, { name: 'AbortError' });
    await assert.rejects(retryFs.readFile('a'), 'Cancelled in-flight work still owns its reservation');
    release();
    retryFile.hold = undefined;
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(Buffer.from(await (await retryFs.readFile('a')).arrayBuffer()), body, 'All-cancelled extraction releases ownership and permits retry');
    const failedFs = await create([{ kind: 'zip', file: new Blob([deflateZip(body, undefined, body.length, 0)]) }, loose('b', 'valid')], { maxResources: 1 });
    await assert.rejects(failedFs.readFile('a'));
    assert.equal(await text(failedFs, 'b'), 'valid', 'Failed resource promises release the cache slot and byte reservation');
    for (const entries of [
      { 'A.vmt': strToU8('a'), 'a.VMT': strToU8('b') },
      { '../a': strToU8('a') },
      { 'a': strToU8('a'), 'a/b': strToU8('b') },
    ]) await assert.rejects(SourceFileSystem.create([{ kind: 'zip', file: new Blob([zipSync(entries)]) }]));
    const overlap = Buffer.from(zipSync({ a: strToU8('a'), b: strToU8('b') }, { level: 0 }));
    const cd = overlap.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
    overlap.writeUInt32LE(40, cd + 20); overlap.writeUInt32LE(40, cd + 24);
    await assert.rejects(SourceFileSystem.create([{ kind: 'zip', file: new Blob([overlap]) }]));
    await assert.rejects(SourceFileSystem.create([pak], AbortSignal.abort()), { name: 'AbortError' });
    await assert.rejects(ordered.readFile('maps/a.bsp', AbortSignal.abort()), { name: 'AbortError' });
    const controller = new AbortController();
    class CancellingBlob extends Blob {
      slice(...args) {
        const part = super.slice(...args), arrayBuffer = part.arrayBuffer.bind(part);
        part.arrayBuffer = async () => { const bytes = await arrayBuffer(); controller.abort(); return bytes; };
        return part;
      }
    }
    await assert.rejects(SourceFileSystem.create([{ kind: 'vpk', directory: new CancellingBlob([fixture.raw]) }], controller.signal), { name: 'AbortError' });
  } finally { globalThis.fetch = originalFetch; }
  console.log('PASS: local Source mount precedence/isolation, full paths, VPK preload/ranges, GMA boundaries, ZIP CRC/decompression, collisions and cancellation');
}
