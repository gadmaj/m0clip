/** Raw Source BSP admission and game-lump ownership CPU boundaries.
 * node scripts/test_raw_source_admission.mjs
 * Real BSP reader, props reader and finalization gate; no native, map or fidelity qualification. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import buildFixture from './build-fixture.cjs';
const compiled = await buildFixture({ root: process.cwd(), platform: 'node', format: 'es',
  source: "export * from './src/maps/raw-source-bsp';export * from './src/maps/raw-source-props';export * from './src/maps/source-import-finalize';" });
const { readSourceBsp, readSourceProps, readSourceStaticProps, finalizeSourceAssembly } =
  await import(`data:text/javascript;base64,${Buffer.from(compiled.code).toString('base64')}`);

const frame = { origin: [0, 0, 0], yaw: 0, metresPerUnit: .0254, up: 'Z', spawnClass: 'fixture', floorFound: true };
const files = { readFile: async () => undefined };
const ENTITIES = Buffer.from('{"classname" "worldspawn"}\n{"classname" "info_player_start" "origin" "0 0 0"}\0');
const id = text => Buffer.from(text).readUInt32LE(0); // on-disk FourCC byte order
function worldModel(faces = 0) {
  const model = Buffer.alloc(48);
  [-64, -64, -64, 64, 64, 64].forEach((value, i) => model.writeFloatLE(value, i * 4));
  model.writeInt32LE(faces, 44);
  return model;
}
/** Standard descriptor order; payloads follow the header in insertion order. */
function vbsp(entries) {
  const header = Buffer.alloc(1036), bodies = [];
  header.write('VBSP'); header.writeInt32LE(20, 4); header.writeInt32LE(1, 1032);
  let offset = 1036;
  for (const [index, bytes, version = 0, decoded = 0] of entries) {
    const p = 8 + index * 16;
    header.writeUInt32LE(offset, p); header.writeUInt32LE(bytes.length, p + 4);
    header.writeUInt32LE(version, p + 8); header.writeUInt32LE(decoded, p + 12);
    bodies.push(bytes); offset += bytes.length;
  }
  return Buffer.concat([header, ...bodies]);
}
const world = (extra = []) => [[0, ENTITIES], [5, Buffer.alloc(32)], [14, worldModel()], ...extra];
/** Game-lump container placed FIRST (absolute offset 1036). `aliasOf` reuses an
 * earlier record's offset; `length` is the directory filelen (decoded size). */
function gameLumps(records, base = 1036) {
  const table = Buffer.alloc(4 + records.length * 16), bodies = [];
  let cursor = base + table.length;
  table.writeUInt32LE(records.length, 0);
  records.forEach((record, i) => {
    const p = 4 + i * 16, offset = record.aliasOf === undefined ? cursor : table.readUInt32LE(4 + record.aliasOf * 16 + 8);
    table.writeUInt32LE(record.id, p); table.writeUInt16LE(record.flags ?? 0, p + 4); table.writeUInt16LE(record.version ?? 0, p + 6);
    table.writeUInt32LE(offset, p + 8); table.writeUInt32LE(record.length ?? record.payload.length, p + 12);
    if (record.aliasOf === undefined) { bodies.push(record.payload); cursor += record.payload.length; }
  });
  return Buffer.concat([table, ...bodies]);
}
// Python stdlib is an independent real LZMA encoder, not a fake codec.
function valveCompressed(payload, dictionary) {
  const encoded = spawnSync('python3', ['-c', 'import lzma,sys;sys.stdout.buffer.write(lzma.compress(sys.stdin.buffer.read(),format=lzma.FORMAT_ALONE,filters=[{"id":lzma.FILTER_LZMA1,"dict_size":int(sys.argv[1])}]))', String(dictionary)], { input: payload });
  if (encoded.status !== 0) throw new Error(`Fixture LZMA encoding failed: ${encoded.stderr}`);
  const alone = encoded.stdout, valve = Buffer.alloc(17 + alone.length - 13);
  valve.write('LZMA'); valve.writeUInt32LE(payload.length, 4); valve.writeUInt32LE(alone.length - 13, 8);
  alone.copy(valve, 12, 0, 5); alone.copy(valve, 17, 13);
  return valve;
}
/** Records every range taken from the BSP file after the reader is open. */
class ReadLog extends Blob {
  constructor(bytes) { super([bytes]); this.slices = []; this.onSlice = undefined; }
  slice(start, end, type) { this.slices.push([start, end]); this.onSlice?.(start, end); return super.slice(start, end, type); }
}
async function open(bytes, options) {
  const file = new ReadLog(bytes), bsp = await readSourceBsp(file, options);
  file.slices.length = 0;
  return { file, world: { frame, bsp } };
}
const widest = file => Math.max(0, ...file.slices.map(([start, end]) => end - start));

// --- Auto descriptor order: mandatory evidence, never a preferred order. ---
{
  // All-version-0 standard lumps make the left4dead2 reading structurally valid
  // too (every lump empty); only entity/worldmodel/schema evidence decides.
  const bytes = vbsp(world());
  const alternate = await readSourceBsp(new Blob([bytes]), { variant: 'left4dead2' });
  assert.equal(alternate.entities.length, 0, 'The alternate descriptor order is structurally possible');
  const auto = await readSourceBsp(new Blob([bytes]));
  assert.equal(auto.variant, 'standard');
  assert.deepEqual(auto.entities.map(e => e.values.classname), ['worldspawn', 'info_player_start']);
}
for (const [label, entries] of [
  // Planes version 1 is no layout this importer decodes; left4dead2 has no entities.
  ['impossible lump version', world([[1, Buffer.alloc(1040), 1]])],
  ['worldmodel faces beyond the face table', [[0, ENTITIES], [5, Buffer.alloc(32)], [14, worldModel(5)]]],
  ['no worldmodel', [[0, ENTITIES]]],
]) {
  const bytes = vbsp(entries);
  await assert.rejects(readSourceBsp(new Blob([bytes])), label);
  assert.equal((await readSourceBsp(new Blob([bytes]), { variant: 'standard' })).entities.length, 2, `${label}: explicit selection stays usable`);
}

// --- Retained visual payloads the importer cannot emit block finalization. ---
const detailProps = (objects, models = objects ? 1 : 0) => {
  const lump = Buffer.alloc(12 + models * 128 + objects * 52);
  lump.writeUInt32LE(models, 0);
  if (models) lump.write('models/detail/fixture.mdl', 4);
  lump.writeUInt32LE(0, 4 + models * 128); lump.writeUInt32LE(objects, 8 + models * 128);
  return lump;
};
{
  const container = gameLumps([{ id: id('prpd'), version: 4, payload: detailProps(1) }]);
  assert.equal(container.length - 20, 192);
  const { world: populated } = await open(vbsp([[35, container], ...world([[45, Buffer.alloc(352)]])]));
  const props = await readSourceProps(populated, files);
  assert.equal(props.placements.length, 0); assert.equal(props.completeResources, true);
  assert.deepEqual(props.requirements.map(r => [r.code, r.blocking]).sort(), [['detail-prop-runtime', true], ['overlay-runtime', true]]);
  let verifying = false;
  await assert.rejects(finalizeSourceAssembly({ files: new Map(), requirements: props.requirements }, 'Admission', 'Source fixture', () => { verifying = true; }),
    failure => ['detail-prop-runtime', 'overlay-runtime'].every(code => failure.requirements?.some(r => r.code === code && r.blocking)));
  assert.equal(verifying, false, 'Blocked payloads never reach verification or identity');
}
{
  // Valve's empty detail lump (0 model / 0 sprite / 0 object counts) draws nothing.
  const { world: empty } = await open(vbsp([[35, gameLumps([{ id: id('prpd'), version: 4, payload: detailProps(0) }])], ...world()]));
  const props = await readSourceProps(empty, files);
  assert.deepEqual(props.requirements, []);
  assert.equal(props.gameLumps[0].length, 12, 'Empty detail metadata is retained, not dropped');
}
for (const [label, entries] of [
  ['detail counts beyond payload', [[35, gameLumps([{ id: id('prpd'), version: 4, payload: detailProps(1).subarray(0, 191) }])], ...world()]],
  ['truncated overlay record', world([[45, Buffer.alloc(351)]])],
]) await assert.rejects(readSourceProps((await open(vbsp(entries))).world, files), label);

// --- Game-lump ownership is validated and charged before any payload read. ---
const payload = Buffer.alloc(4096, 0x5a), valve = valveCompressed(payload, 4096);
const compressed = (extra = {}) => ({ id: id('aaaa'), flags: 1, payload: valve, length: payload.length, ...extra });
for (const [label, records] of [
  ['compressed alias', [compressed(), compressed({ id: id('bbbb'), aliasOf: 0 })]],
  ['uncompressed alias', [{ id: id('aaaa'), payload: Buffer.alloc(64) }, { id: id('bbbb'), payload: Buffer.alloc(64), aliasOf: 0 }]],
]) {
  const { file, world: aliased } = await open(vbsp([[35, gameLumps(records)], ...world()]));
  await assert.rejects(readSourceProps(aliased, files), label);
  assert.deepEqual(file.slices, [], `${label}: refused before any payload or header read`);
}
{
  const container = gameLumps([compressed(), compressed({ id: id('bbbb') })]);
  const bytes = vbsp([[35, container], ...world()]);
  // Aggregate logical game-lump ceiling: 2 x 4096 decoded against 4096.
  const capped = await open(bytes);
  await assert.rejects(readSourceProps(capped.world, files, { maxGameLumpBytes: 4096 }));
  assert.equal(widest(capped.file), 17, 'Only bounded LZMA headers were read');
  // Retained decoded bytes share the BSP import's aggregate ceiling exactly.
  const owned = ENTITIES.length + container.length;
  const short = await open(bytes, { maxDecodedBytes: owned + 2 * payload.length - 1 });
  await assert.rejects(readSourceProps(short.world, files));
  assert.equal(widest(short.file), 17, 'Decoded ownership is refused before payload reads');
  const exact = await open(bytes, { maxDecodedBytes: owned + 2 * payload.length + 48 });
  const props = await readSourceProps(exact.world, files);
  for (const lump of props.gameLumps) assert.deepEqual(Buffer.from(await lump.decodedBlob.arrayBuffer()), payload);
  // A pre-codec abort refunds its reservation: the same import then fits exactly once.
  const aborted = await open(bytes, { maxDecodedBytes: owned + 2 * payload.length + 48 }), controller = new AbortController();
  aborted.file.onSlice = (start, end) => { if (end - start > 17) controller.abort(); };
  await assert.rejects(readSourceProps(aborted.world, files, { signal: controller.signal }), { name: 'AbortError' });
  aborted.file.onSlice = undefined;
  assert.equal((await readSourceProps(aborted.world, files)).gameLumps.length, 2);
}
{
  // An 8 MiB dictionary's codec workspace is reserved before the payload is read.
  const bytes = vbsp([[35, gameLumps([compressed({ payload: valveCompressed(payload, 1 << 23) })])], ...world()]);
  const tight = await open(bytes, { maxWorkingBytes: 64 * 1024 * 1024 });
  await assert.rejects(readSourceProps(tight.world, files));
  assert.equal(widest(tight.file), 17);
  const roomy = await open(bytes, { maxWorkingBytes: 256 * 1024 * 1024 });
  assert.deepEqual(Buffer.from(await (await readSourceProps(roomy.world, files)).gameLumps[0].decodedBlob.arrayBuffer()), payload);
}
{
  // Padding before Valve's empty sentinel stays owned raw bytes, never codec input.
  const padded = Buffer.concat([valve, Buffer.alloc(3, 0xee)]);
  const { world: sentinel } = await open(vbsp([[35, gameLumps([compressed({ payload: padded }), { id: 0, payload: Buffer.alloc(0) }])], ...world()]));
  const [lump, end] = (await readSourceProps(sentinel, files)).gameLumps;
  assert.equal(lump.rawBlob.size, padded.length); assert.equal(end.length, 0);
  assert.deepEqual(Buffer.from(await lump.decodedBlob.arrayBuffer()), payload);
}

// --- Static props: reused authored leaf ranges are charged before expansion. ---
/** sprp v4: one model, `shared` leaf IDs (all leaf 0), every record reusing the whole range. */
function staticProps(records, shared) {
  const countAt = 136 + shared * 2, sprp = Buffer.alloc(countAt + 4 + records * 56);
  sprp.writeUInt32LE(1, 0); sprp.write('models/fixture.mdl', 4);
  sprp.writeUInt32LE(shared, 132); sprp.writeUInt32LE(records, countAt);
  for (let i = 0; i < records; i++) sprp.writeUInt16LE(shared, countAt + 4 + i * 56 + 28);
  return sprp;
}
{
  const records = 200, shared = 1000, sprp = staticProps(records, shared);
  const container = gameLumps([{ id: id('prps'), version: 4, payload: sprp }]);
  const bytes = vbsp([[35, container], ...world([[10, Buffer.alloc(56)]])]);
  // ~13 KB of input authors 200,000 leaf IDs: at least 400,000 retained bytes.
  const owned = ENTITIES.length + container.length + 56;
  const short = await open(bytes, { maxDecodedBytes: owned + 2 * records * shared - 1 });
  await assert.rejects(readSourceProps(short.world, files));
  const full = await readSourceProps((await open(bytes)).world, files);
  assert.equal(full.placements.length, records);
  const authored = new Array(shared).fill(0);
  for (const placement of full.placements) assert.deepEqual([...placement.leaves], authored, 'Every authored leaf ID is retained, never truncated');
  // The plain sprp clone shares the import's working ceiling with concurrent owners.
  const limit = container.length + 1024, concurrent = await open(bytes, { maxWorkingBytes: limit });
  const first = await readSourceProps(concurrent.world, files);
  const held = concurrent.world.bsp.reserve(0, limit - sprp.length + 1);
  await assert.rejects(readSourceStaticProps(concurrent.world, first.gameLumps));
  held.complete();
  assert.equal((await readSourceStaticProps(concurrent.world, first.gameLumps)).length, records, 'A refused clone left no capacity behind');
}
console.log('PASS: evidence-decided BSP descriptor order, blocking detail/overlay admission, pre-read game-lump alias/aggregate/codec ownership, pre-expansion static-prop leaf/working ownership. No native or fidelity qualification.');
