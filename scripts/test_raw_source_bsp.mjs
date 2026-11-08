import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { build } from 'esbuild';
import sourceLzmaCodec from '../src/maps/raw-source-lzma-codec.js';
import { fixture, record } from './source_raw_map_fixture.cjs';
const built = await build({ stdin: { contents: "export * from './src/maps/raw-source-bsp';export * from './src/maps/raw-source-lzma';export * from './src/maps/raw-source-physics';export * from './src/maps/raw-source-collision';", resolveDir: process.cwd() }, bundle: true, platform: 'node', format: 'cjs', write: false });
const module = { exports: {} };
new Function('module', 'exports', 'require', built.outputFiles[0].text)(module, module.exports, createRequire(import.meta.url));
const { readSourceBsp, decodeSourceWorld, parseSourceEntities, decodeValveLzma, sourceWorldPhysicsXml, assembleSourceEntityCollision } = module.exports;
const entities = parseSourceEntities('// comment\n{ "k" "first" "k" "second" path "a\\b" "quote" "a\\\"b" }\0');
assert.deepEqual(entities[0].pairs.slice(0, 2), [['k', 'first'], ['k', 'second']]);
assert.equal(entities[0].values.path, 'a\\b'); assert.equal(entities[0].values.quote, 'a"b');
assert.equal(parseSourceEntities('{ "literal" "}" }')[0].values.literal, '}', 'Quoted braces are data, not entity delimiters');
assert.throws(() => parseSourceEntities('{"a"}'));
assert.throws(() => parseSourceEntities('{"a" "unfinished'));
for (const version of [19, 20, 21, 22]) for (const variant of ['standard', 'left4dead2']) {
  const f = fixture({ version, variant, primitive: true }), bsp = await readSourceBsp(f.blob()), world = await decodeSourceWorld(bsp);
  assert.equal(bsp.variant, variant); assert.equal(bsp.revision, 17);
  assert.deepEqual([...world.reachableBrushes], [0], 'Unreachable brush 1 is not physical world geometry');
  assert.equal(world.collision.length, 1); assert.equal(world.collision[0].kind, 'box');
  assert.deepEqual(world.collision[0].halfExtents, [64 * 0.0254, 64 * 0.0254, 32 * 0.0254]);
  assert.deepEqual([...world.surfaces[0].indices], [0, 3, 1, 1, 3, 2], 'Authored diagonal and reversed front winding');
  assert.deepEqual(world.frame.origin, [16, 16, 0]); assert.equal(world.frame.yaw, 90); assert.equal(world.frame.floorFound, true);
  assert.deepEqual(world.requirements, [], 'A floored authored spawn admits the world');
  assert.ok(Math.abs(world.surfaces[0].positions[0] + 16 * 0.0254) < 1e-6);
  assert.deepEqual([...world.surfaces[0].lightmapLuxels.slice(0, 2)], [0.5, 0.5]);
  assert.equal(world.surfaces[0].lightmap.samples.length, 100);
}
{
  const world=await decodeSourceWorld(await readSourceBsp(fixture().blob()));
  for(const options of [{maxBytes:64},{maxValues:4},{maxChunks:4}])
    assert.throws(()=>sourceWorldPhysicsXml(world,options));
  const abort=new AbortController();abort.abort();
  assert.throws(()=>sourceWorldPhysicsXml(world,{signal:abort.signal}),{name:'AbortError'});
}
{
  const f = fixture({ displacement: true }), world = await decodeSourceWorld(await readSourceBsp(f.blob()));
  const surface = world.surfaces[0], p = surface.positions, ids = surface.indices;
  const a = ids[0] * 3, b = ids[1] * 3, c = ids[2] * 3;
  assert.ok((p[b] - p[a]) * (p[c + 1] - p[a + 1]) - (p[b + 1] - p[a + 1]) * (p[c] - p[a]) > 0, 'Displacement faces point out of the floor');
  assert.equal(surface.gridSide, 5); assert.equal(surface.indices.length, 96); assert.equal(surface.displacementTriangleTags.length, 32);
  // CCoreDispInfo alternates the cell diagonal by vertex-index parity (cell 1 is odd).
  assert.deepEqual([...ids.slice(6, 12)], [1, 2, 6, 2, 7, 6]);
  assert.ok(Math.abs(surface.alpha[24] - 240 / 255) < 1e-7);
  const field = world.collision.find(c => c.kind === 'heightfield');
  assert.ok(field); assert.ok(field.approximation.maxLateralErrorMetres < 1e-5);
  assert.equal(field.elevations.length, 25); assert.ok(field.elevations.every(v => v >= 0 && v <= 1));
}
{
  const f = fixture(), p = f.entries.get(1).bytes;
  p.writeFloatLE(Math.SQRT1_2, 0); p.writeFloatLE(Math.SQRT1_2, 4);
  const world = await decodeSourceWorld(await readSourceBsp(f.blob())), hull = world.collision[0];
  assert.equal(hull.kind, 'convex'); assert.equal(hull.vertices.length, 24);
  for (let i = 0; i < hull.vertices.length; i += 3) {
    const sourceX = 16 - hull.vertices[i + 1] / 0.0254, sourceY = 16 + hull.vertices[i] / 0.0254;
    assert.ok((sourceX + sourceY) * Math.SQRT1_2 <= 64.01, 'Real slanted half-space is not replaced by its bounds');
  }
}
// Non-heightfield displacements are decomposed into convex prisms that cover
// every authored triangle exactly; concavity is never bridged.
const prismTriangles = world => world.collision.filter(c => c.kind === 'displacement-prism').reduce((sum, prism) => sum + prism.triangles, 0);
{
  const f = fixture({ displacement: true });
  f.entries.get(3).bytes.writeFloatLE(80, 24);
  const world = await decodeSourceWorld(await readSourceBsp(f.blob()));
  assert.equal(world.collision.filter(c => c.kind === 'heightfield').length, 0);
  assert.equal(prismTriangles(world), 32, 'Trapezoid prisms represent all 32 authored triangles');
}
{
  const f = fixture({ displacement: true }), bytes = f.entries.get(33).bytes;
  for (let i = 0; i < 25; i++) { bytes.writeFloatLE(1, i * 20); bytes.writeFloatLE(0, i * 20 + 8); }
  const world = await decodeSourceWorld(await readSourceBsp(f.blob()));
  assert.equal(world.collision.filter(c => c.kind === 'heightfield').length, 0, 'Lateral offsets cannot be dropped by a regular heightfield');
  assert.equal(prismTriangles(world), 32);
}
{
  // A trapezoid with a concave crease along grid column 1, inside the first 2x2 patch.
  const f = fixture({ displacement: true }), bytes = f.entries.get(33).bytes;
  f.entries.get(3).bytes.writeFloatLE(80, 24);
  for (let i = 0; i < 25; i++) bytes.writeFloatLE(Math.abs(i % 5 - 1) * 8, i * 20 + 12);
  const world = await decodeSourceWorld(await readSourceBsp(f.blob())), surface = world.surfaces[0];
  const points = [];
  for (let i = 0; i < 25; i++) points.push([0, 1, 2].map(k => surface.positions[i * 3 + k]));
  assert.equal(prismTriangles(world), 32);
  for (const prism of world.collision.filter(c => c.kind === 'displacement-prism')) {
    const columns = new Set();
    for (let v = 0; v < prism.vertices.length / 2; v += 3) {
      const index = points.findIndex(p => Math.hypot(p[0] - prism.vertices[v], p[1] - prism.vertices[v + 1], p[2] - prism.vertices[v + 2]) < 1e-5);
      assert.ok(index >= 0, 'Prism front vertices are authored points');
      columns.add(index % 5);
    }
    assert.ok(!(columns.has(0) && columns.has(2)), 'No convex hull bridges the valley between its rims');
  }
}
for (const [flags, collides, requirement] of [[0x80000000 | 0xe, false, false], [0x80000000 | 0x4, false, true], [0x80000000 | 0x1, true, false]]) {
  const f = fixture({ displacement: true }); f.entries.get(26).bytes.writeUInt32LE(flags >>> 0, 24);
  const world = await decodeSourceWorld(await readSourceBsp(f.blob()));
  assert.equal(world.collision.some(c => c.kind === 'heightfield'), collides, `SURF_* flags ${flags & 0xf} decide displacement collision`);
  assert.equal(world.requirements.some(r => r.code === 'displacement-collision-mode' && r.face === 0 && r.blocking), requirement,
    'Partial physics/player/ray collision is refused, not merged into one surface');
}
{
  const f = fixture({ displacement: true }); f.entries.get(26).bytes.writeInt32LE(0, 32);
  const world = await decodeSourceWorld(await readSourceBsp(f.blob()));
  assert.equal(world.collision.filter(c => c.kind !== 'box' && c.kind !== 'convex').length, 0, 'Non-solid displacement contents do not collide');
}
{
  const f = fixture({ displacement: true }); f.put(43, Buffer.from('tools/toolsnodraw\0'));
  const world = await decodeSourceWorld(await readSourceBsp(f.blob()));
  assert.equal(world.surfaces[0].visible, false);
  assert.ok(world.collision.some(c => c.kind === 'heightfield'), 'Invisible displacements still collide');
}
{
  const f = fixture(); f.put(0, Buffer.from('{"classname" "worldspawn"}\0'));
  const world = await decodeSourceWorld(await readSourceBsp(f.blob()));
  assert.equal(world.frame.spawnClass, 'map centre');
  assert.deepEqual(world.requirements.map(r => [r.code, r.blocking]), [['spawn-unresolved', true]], 'An unfloored map-centre spawn is never admitted');
}
{
  // func_wall collision from its own brush model; filtered/simulated brush classes are refused.
  const f = fixture();
  f.put(14, record(96, b => {
    for (let i = 0; i < 3; i++) { b.writeFloatLE(-64, i * 4); b.writeFloatLE(i === 2 ? 0 : 64, 12 + i * 4); }
    b.writeInt32LE(1, 44); b.writeInt32LE(-2, 48 + 36);
  }));
  const world = await decodeSourceWorld(await readSourceBsp(f.blob()));
  const matrix = new Float64Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 1, 2, 3, 1]);
  const brush = (classname, capability = 'authored-brush-placement-only') => ({ classname, model: 1, entityIndex: 7, matrix, capability });
  const result = await assembleSourceEntityCollision(world, { brushes: [brush('func_wall'), brush('func_illusionary'), brush('func_door'), brush('func_clip_vphysics', 'nonvisual-brush'), brush('trigger_once', 'nonvisual-brush')], placements: [], models: new Map() });
  assert.equal(result.collision.length, 1); assert.equal(result.collision[0].kind, 'entity-brush');
  const xs = [], zs = [];
  for (let i = 0; i < result.collision[0].vertices.length; i += 3) { xs.push(result.collision[0].vertices[i]); zs.push(result.collision[0].vertices[i + 2]); }
  assert.ok(Math.abs(Math.min(...xs) - (1 - 64 * 0.0254)) < 1e-9 && Math.abs(Math.max(...zs) - 3) < 1e-9 && Math.abs(Math.min(...zs) - (3 - 64 * 0.0254)) < 1e-9,
    'Model-local brush hull is placed once by the entity matrix');
  assert.deepEqual(result.requirements.map(r => r.code).sort(), ['brush-clip-collision-runtime', 'brush-entity-collision-runtime']);
  assert.match(sourceWorldPhysicsXml({ collision: [...world.collision, ...result.collision] }), /<mesh name="source_collision_1" vertex="/);
}
{
  // Studio-prop collision is emitted nowhere yet: documented non-solid placements are
  // recorded, every other authored solid is refused, and nothing becomes silently non-solid.
  const matrix = new Float64Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 10, 20, 30, 1]);
  const place = (kind, classname, solid, extra = {}) => ({ kind, classname, solid, modelPath: 'models/a.mdl', index: 0, entityIndex: 3, matrix, scale: 1, ...extra });
  const placements = [
    place('static-prop', 'prop_static', 0), place('static-prop', 'prop_static', 6), place('static-prop', 'prop_static', 2),
    place('static-prop', 'prop_static', 3),
    place('entity-model', 'prop_dynamic', 6, { entity: { values: { spawnflags: '256' } } }),
    place('entity-model', 'prop_dynamic_override', 0), place('entity-model', 'prop_dynamic_ornament', 6),
    place('entity-model', 'prop_dynamic', 6), place('entity-model', 'prop_physics', 6),
    place('static-prop', 'prop_static', 6, { modelPath: 'models/missing.mdl' }),
  ];
  const result = await assembleSourceEntityCollision({ decodeModelCollision: async () => assert.fail('No brush entities'), reserveGeometry() {} },
    { brushes: [], placements, models: new Map([['models/a.mdl', { path: 'models/a.mdl' }]]) });
  assert.deepEqual(placements.map(p => result.props.get(p)), [
    { mode: 'none', reason: 'solid-none' }, undefined, undefined, undefined,
    { mode: 'none', reason: 'collision-disabled' }, { mode: 'none', reason: 'solid-none' }, { mode: 'none', reason: 'ornament' },
    undefined, undefined, undefined,
  ]);
  assert.equal(result.collision.length, 0, 'No guessed hull or box is emitted for a prop');
  assert.deepEqual(result.requirements.map(r => [r.code, r.path, r.blocking]), [
    ['prop-vphysics-collision-unsupported', 'models/a.mdl', true], ['prop-vphysics-collision-unsupported', 'models/a.mdl', true],
    ['prop-vphysics-collision-unsupported', 'models/a.mdl', true], ['prop-vphysics-collision-unsupported', 'models/a.mdl', true],
    ['entity-model-collision-runtime', 'models/a.mdl', true],
  ], 'Every nonzero solid without documented non-solid state is refused; missing models block elsewhere');
}
{
  const f = fixture(); f.entries.get(6).bytes.writeInt32LE(0x800, 64);
  f.entries.get(7).bytes[17] = 32; f.put(8, Buffer.alloc(800, 31), 1);
  const surface = (await decodeSourceWorld(await readSourceBsp(f.blob()))).surfaces[0];
  assert.equal(surface.lightmap.layersPerStyle, 4); assert.equal(surface.lightmap.samples.length, 800);
  assert.deepEqual([...surface.lightmap.styles], [0, 32, 255, 255], 'Animated styles retain all directional RGBExp32 samples');
}
{
  const f = fixture({ primitive: true }); f.entries.get(37).bytes.writeUInt16LE(1, 8);
  await assert.rejects(async () => decodeSourceWorld(await readSourceBsp(f.blob())));
}
for (const count of [129, 65536]) {
  const f = fixture();
  f.entries.get(18).bytes.writeInt32LE(count, 4);
  f.put(19, record(count * 8, b => { for (let i = 0; i < count; i++) b.writeUInt16LE(i % 6, i * 8); }));
  const load = async () => decodeSourceWorld(await readSourceBsp(f.blob()));
  await assert.rejects(load());
}
for (const [mutate] of [
  [f => f.entries.get(5).bytes.writeInt32LE(0, 4)],
  [f => f.entries.get(14).bytes.writeInt32LE(-3, 36)],
  [f => f.entries.get(17).bytes.writeUInt16LE(99)],
  [f => f.entries.get(13).bytes.writeInt32LE(999)],
  [f => f.entries.get(7).bytes.writeInt32LE(1000, 20)],
  [f => f.entries.get(7).version = 9],
  [f => f.put(3, Buffer.alloc(13))],
  [f => f.entries.get(3).bytes.writeFloatLE(NaN)],
]) {
  const f = fixture(); mutate(f);
  await assert.rejects(async () => decodeSourceWorld(await readSourceBsp(f.blob())));
}
{
  const f = fixture({ displacement: true }); f.entries.get(26).bytes.writeInt32LE(31, 20);
  await assert.rejects(async () => decodeSourceWorld(await readSourceBsp(f.blob())));
}
{
  const f = fixture(), data = Buffer.from(await f.blob().arrayBuffer()); data.writeUInt32LE(0xfffffff0, 8);
  await assert.rejects(readSourceBsp(new Blob([data])));
  data.writeUInt32LE(18, 4); await assert.rejects(readSourceBsp(new Blob([data])));
  await assert.rejects(readSourceBsp(new Blob([data.subarray(0, 20)])));
  const overlap = Buffer.from(await f.blob().arrayBuffer());
  overlap.writeUInt32LE(overlap.readUInt32LE(8 + 3 * 16), 8 + 12 * 16);
  await assert.rejects(readSourceBsp(new Blob([overlap])));
  const abort = new AbortController(); abort.abort(); await assert.rejects(readSourceBsp(f.blob(), { signal: abort.signal }), { name: 'AbortError' });
  const parsed = await readSourceBsp(f.blob()), pending = decodeSourceWorld(parsed, { signal: abort.signal });
  await assert.rejects(pending, { name: 'AbortError' });
}
// Thin authored brushes: plane 5 becomes z >= -dist under plane 4's z <= 0, both brushes
// are CONTENTS_PLAYERCLIP, and brush model *1 (func_wall) reaches brush 1 through leaf 1.
function thinFixture(dist) {
  const f = fixture();
  f.entries.get(1).bytes.writeFloatLE(dist, 5 * 20 + 12);
  for (let i = 0; i < 2; i++) f.entries.get(18).bytes.writeInt32LE(0x10000, i * 12 + 8);
  f.put(14, record(96, b => {
    for (let i = 0; i < 3; i++) { b.writeFloatLE(-64, i * 4); b.writeFloatLE(i === 2 ? 0 : 64, 12 + i * 4); }
    b.writeInt32LE(1, 44); b.writeInt32LE(-2, 48 + 36);
  }));
  return f;
}
const funcWall = { classname: 'func_wall', model: 1, entityIndex: 7, capability: 'authored-brush-placement-only',
  matrix: new Float64Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]) };
const entityCollision = world => assembleSourceEntityCollision(world, { brushes: [funcWall], placements: [], models: new Map() });
const zExtent = vertices => { const zs = []; for (let i = 2; i < vertices.length; i += 3) zs.push(vertices[i]); return [Math.min(...zs), Math.max(...zs)]; };
{
  const world = await decodeSourceWorld(await readSourceBsp(thinFixture(0.25).blob())), entity = await entityCollision(world);
  assert.deepEqual(world.skippedDegenerateBrushes, []); assert.deepEqual(world.requirements, []);
  assert.equal(world.collision.length, 1); assert.equal(world.collision[0].kind, 'box');
  assert.ok(Math.abs(world.collision[0].halfExtents[2] - 0.125 * 0.0254) < 1e-12 && Math.abs(world.collision[0].position[2] + 0.125 * 0.0254) < 1e-12,
    'A real quarter-unit Playerclip keeps its authored thickness and placement in world collision');
  assert.equal(entity.collision.length, 1); assert.deepEqual(entity.requirements, []);
  const [low, high] = zExtent(entity.collision[0].vertices);
  assert.ok(Math.abs(high) < 1e-12 && Math.abs(low + 0.25 * 0.0254) < 1e-12, 'The same thin brush in a func_wall model is entity collision');
  const xml = sourceWorldPhysicsXml({ collision: [...world.collision, ...entity.collision] });
  assert.match(xml, /<geom type="box"/); assert.match(xml, /<mesh name="source_collision_1" vertex="/);
}
{
  const f = thinFixture(0.25), p = f.entries.get(1).bytes;
  p.writeFloatLE(Math.SQRT1_2, 0); p.writeFloatLE(Math.SQRT1_2, 4);
  const world = await decodeSourceWorld(await readSourceBsp(f.blob()));
  assert.equal(world.collision.length, 1); assert.equal(world.collision[0].kind, 'convex');
  const [low, high] = zExtent(world.collision[0].vertices);
  assert.ok(Math.abs(high) < 1e-12 && Math.abs(low + 0.25 * 0.0254) < 1e-12, 'A slanted thin brush is a convex hull, not skipped');
}
for (const dist of [0.0004, 4e-7, 1e-45]) {
  // Real positive volumes too thin for the emitted hull's rounding, down to the smallest
  // float32 separation, block world and entity admission; none is flattened or skipped.
  const world = await decodeSourceWorld(await readSourceBsp(thinFixture(dist).blob())), entity = await entityCollision(world);
  assert.deepEqual(world.collision, []); assert.deepEqual(world.skippedDegenerateBrushes, [], `${dist}-unit volume is not degenerate`);
  assert.deepEqual(world.requirements.map(r => [r.code, r.blocking]), [['brush-collision-unrepresentable', true]]);
  assert.match(world.requirements[0].detail, /\bbrush 0\b/);
  assert.deepEqual(entity.collision, []);
  assert.deepEqual(entity.requirements.map(r => [r.code, r.blocking]), [['brush-collision-unrepresentable', true]]);
  assert.match(entity.requirements[0].detail, /\bEntity 7\b.*\bbrush 1\b/);
}
for (const dist of [0, -0, -1]) {
  // Exactly coincident or crossing opposed half-spaces provably enclose no volume.
  const world = await decodeSourceWorld(await readSourceBsp(thinFixture(dist).blob())), entity = await entityCollision(world);
  assert.deepEqual(world.collision, []); assert.deepEqual(world.skippedDegenerateBrushes, [0]); assert.deepEqual(world.requirements, []);
  assert.deepEqual(entity.collision, []); assert.deepEqual(entity.requirements, []);
}
// Decoded geometry is charged before allocation, cumulatively for the world and every later
// brush-model decode, including faces that repeat the same surfedges.
function repeatedFaces(worldFaces, modelFaces = 0) {
  const f = fixture(), total = worldFaces + modelFaces, face = f.entries.get(7).bytes;
  f.put(7, Buffer.concat(Array.from({ length: total }, () => face)), 1);
  f.put(31, Buffer.alloc(total * 8));
  f.put(14, record(96, b => {
    for (let i = 0; i < 3; i++) { b.writeFloatLE(-64, i * 4); b.writeFloatLE(i === 2 ? 0 : 64, 12 + i * 4); }
    b.writeInt32LE(worldFaces, 44);
    b.writeInt32LE(-2, 48 + 36); b.writeInt32LE(worldFaces, 48 + 40); b.writeInt32LE(modelFaces, 48 + 44);
  }));
  return f;
}
const admitted = async attempt => { try { await attempt(); return true; } catch (error) { if (!(error instanceof RangeError)) throw error; return false; } };
/** Smallest limit in (fails, passes] that admits the attempt. */
async function smallestAdmitted(fails, passes, attempt) {
  while (passes - fails > 1) { const middle = Math.floor((fails + passes) / 2); if (await attempt(middle)) passes = middle; else fails = middle; }
  return passes;
}
{
  const bsp = await readSourceBsp(repeatedFaces(128).blob());
  assert.equal((await decodeSourceWorld(bsp)).surfaces.length, 128, 'Repeated surfedge references are 128 real faces');
  const RealFloat32Array = globalThis.Float32Array;
  let float32Bytes = 0;
  globalThis.Float32Array = class extends RealFloat32Array {
    constructor(...args) { super(...args); float32Bytes += this.byteLength; if (float32Bytes > 20000) throw new Error(`Float32 tripwire at ${float32Bytes} bytes`); }
  };
  try {
    await assert.rejects(decodeSourceWorld(bsp, { maxGeometryBytes: 20000 }), RangeError);
  } finally { globalThis.Float32Array = RealFloat32Array; }
  assert.ok(float32Bytes <= 20000, 'The configured ceiling refuses before attribute arrays exceed it');
  for (const options of [{ maxGeometryBytes: 0 }, { maxVertices: 1.5 }]) await assert.rejects(decodeSourceWorld(bsp, options));
}
{
  const bsp = await readSourceBsp(repeatedFaces(16, 16).blob());
  const count = surfaces => surfaces.reduce((sum, surface) => sum + surface.positions.length / 3, 0);
  const worldVertices = count((await decodeSourceWorld(bsp)).surfaces);
  const modelVertices = count(await (await decodeSourceWorld(bsp)).decodeModelSurfaces(1));
  assert.ok(modelVertices > 0 && modelVertices <= worldVertices, 'A per-call allowance would admit the late model');
  await assert.rejects((await decodeSourceWorld(bsp, { maxVertices: worldVertices })).decodeModelSurfaces(1), RangeError,
    'A late brush model shares the world vertex lifetime');
  const both = await decodeSourceWorld(bsp, { maxVertices: worldVertices + modelVertices });
  assert.equal(count(await both.decodeModelSurfaces(1)), modelVertices);
  await assert.rejects(both.decodeModelSurfaces(1), RangeError, 'Decoding a model again allocates, and is charged, again');
}
{
  const bsp = await readSourceBsp(thinFixture(0.25).blob());
  const worldBytes = await smallestAdmitted(0, 1 << 24, limit => admitted(() => decodeSourceWorld(bsp, { maxGeometryBytes: limit })));
  const bothBytes = await smallestAdmitted(worldBytes, 1 << 24, limit => admitted(async () => entityCollision(await decodeSourceWorld(bsp, { maxGeometryBytes: limit }))));
  assert.ok(bothBytes > worldBytes, 'Late entity hulls are charged to the same geometry lifetime');
  await assert.rejects(entityCollision(await decodeSourceWorld(bsp, { maxGeometryBytes: worldBytes })), RangeError);
  assert.equal((await entityCollision(await decodeSourceWorld(bsp, { maxGeometryBytes: bothBytes }))).collision.length, 1);
}
{
  // Every func_wall placement, a repeated alias of one entity included, owns its own placed
  // hull: distinct transforms survive and each copy pays the shared geometry lifetime.
  const bsp = await readSourceBsp(thinFixture(0.25).blob());
  const shifted = { ...funcWall, entityIndex: 8, matrix: new Float64Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 1, 1]) };
  const assemble = (world, brushes) => assembleSourceEntityCollision(world, { brushes, placements: [], models: new Map() });
  const result = await assemble(await decodeSourceWorld(bsp), [funcWall, shifted, funcWall]);
  assert.deepEqual(result.collision.map(c => c.entity), [7, 8, 7]);
  const extents = result.collision.map(c => zExtent(c.vertices));
  assert.ok(Math.abs(extents[1][1] - 1) < 1e-12 && Math.abs(extents[1][0] - (1 - 0.25 * 0.0254)) < 1e-12, 'A distinct placement keeps its own transform');
  assert.deepEqual(extents[2], extents[0]);
  assert.notStrictEqual(result.collision[2].vertices, result.collision[0].vertices, 'A repeated alias owns its own placed vertices');
  const minimum = brushes => smallestAdmitted(0, 1 << 24, limit => admitted(async () => assemble(await decodeSourceWorld(bsp, { maxGeometryBytes: limit }), brushes)));
  // Retained placed hulls must exceed the earlier transient hull-construction peak.
  const prefix = Array.from({ length: 32 }, () => funcWall);
  const one = await minimum([...prefix, funcWall]), two = await minimum([...prefix, funcWall, funcWall]), three = await minimum([...prefix, funcWall, shifted, funcWall]);
  assert.ok(two - one >= result.collision[0].vertices.byteLength, 'A repeated placement pays at least its placed vertices');
  assert.equal(three - two, two - one, 'Aliased and distinct placements each pay the same independent quota');
  await assert.rejects(assemble(await decodeSourceWorld(bsp, { maxGeometryBytes: two }), [...prefix, funcWall, funcWall, funcWall]), RangeError,
    'A third placement beyond the shared quota is refused before its copy is allocated');
}
{
  const bsp = await readSourceBsp(fixture({ displacement: true }).blob());
  const vertices = (await decodeSourceWorld(bsp)).surfaces[0].positions.length / 3;
  await assert.rejects(decodeSourceWorld(bsp, { maxVertices: vertices - 1 }), RangeError, 'Every displacement grid vertex is charged');
  assert.equal((await decodeSourceWorld(bsp, { maxVertices: vertices })).surfaces[0].gridSide, 5);
}
// Python stdlib is an independent real LZMA encoder, not a fake codec/mock.
function valveCompressed(payload, dictionarySize = 1 << 23) {
  const encoded = spawnSync('python3', ['-c', 'import lzma,sys;sys.stdout.buffer.write(lzma.compress(sys.stdin.buffer.read(),format=lzma.FORMAT_ALONE,filters=[{\"id\":lzma.FILTER_LZMA1,\"dict_size\":int(sys.argv[1])}]))', String(dictionarySize)], { input: payload });
  if (encoded.status !== 0) throw new Error(`Fixture LZMA encoding failed: ${encoded.stderr}`);
  const alone = encoded.stdout, valve = Buffer.alloc(17 + alone.length - 13);
  valve.write('LZMA'); valve.writeUInt32LE(payload.length, 4); valve.writeUInt32LE(alone.length - 13, 8); alone.copy(valve, 12, 0, 5); alone.copy(valve, 17, 13);
  return valve;
}
const payload = Buffer.from(Array.from({ length: 256 }, (_, i) => i)), valve = valveCompressed(payload);
for (const input of [payload, Buffer.from([0xc0, 0x80, 0xed, 0xa0, 0x80]), Buffer.from('quoted entity text')]) {
  assert.deepEqual(Buffer.from(await decodeValveLzma(valveCompressed(input), input.length, 1 << 26)), input, 'All bytes and noncanonical UTF-8 stay exact; binary output never becomes a JS string');
}
{
  const f = fixture(), entities = f.entries.get(0).bytes;
  f.put(0, valveCompressed(entities), 0, entities.length);
  assert.equal((await readSourceBsp(f.blob())).entities[1].values.classname, 'info_player_start', 'Valve LZMA executes inside the actual BSP reader');
}
{
  const f = fixture(); f.put(35, valve, 0, payload.length);
  const parsed = await readSourceBsp(f.blob());
  assert.deepEqual(Buffer.from(await parsed.getLump(35)), payload, 'Compressed preserved game-lump payload stays exact');
  assert.equal(parsed.lumps[35].raw.size, valve.length);
}
{
  const f = fixture(); f.put(43, Buffer.from('LZMA/custom\0'));
  const parsed = await readSourceBsp(f.blob());
  assert.equal(parsed.lumps[43].uncompressedSize, 0);
  assert.equal(Buffer.from(await parsed.getLump(43)).toString(), 'LZMA/custom\0', 'Descriptor-zero bytes are not sniffed as compression');
  assert.equal((await decodeSourceWorld(parsed)).surfaces[0].material, 'LZMA/custom');
}
{
  const f = fixture(); f.put(35, Buffer.alloc(18), 0, 1);
  const parsed = await readSourceBsp(f.blob());
  await assert.rejects(parsed.getLump(35), 'Declared compression still requires the Valve magic');
}
// Each wrapper's outer compressed length matches its actual bytes. The five
// initialization bytes can all exist while a later normalization read is EOF.
for (let compressedBytes = 0; compressedBytes <= 5; compressedBytes++) {
  const exhausted = Buffer.alloc(17 + compressedBytes);
  exhausted.write('LZMA'); exhausted.writeUInt32LE(1, 4); exhausted.writeUInt32LE(compressedBytes, 8);
  Buffer.from('5d00100000', 'hex').copy(exhausted, 12);
  await assert.rejects(decodeValveLzma(exhausted, 1, 4096));
  const f = fixture(); f.put(35, exhausted, 0, 1);
  const parsed = await readSourceBsp(f.blob());
  await assert.rejects(parsed.getLump(35), 'Exhaustion also fails through actual BSP lump decoding');
}
{
  const zero = valveCompressed(Buffer.alloc(8192, 65), 4096);
  zero.writeUInt32LE(0, 4);
  await assert.rejects(decodeValveLzma(zero, 0, 4096), 'Zero declared output cannot expand beyond zero or the 4096-byte ceiling');
  const alone = Buffer.alloc(13 + zero.length - 17);
  zero.copy(alone, 0, 12, 17); zero.copy(alone, 13, 17);
  const { promise, resolve, reject } = Promise.withResolvers();
  sourceLzmaCodec.decompress(alone, (bytes, error) => error ? reject(error) : resolve(bytes), () => {});
  await assert.rejects(promise, 'The private codec itself never interprets zero as unknown output length');
}
{
  const oversizedMatch = valveCompressed(Buffer.alloc(8192, 65), 4096);
  oversizedMatch.writeUInt32LE(2, 4);
  await assert.rejects(decodeValveLzma(oversizedMatch, 2, 4096), 'Match copies cannot overshoot the known output bound');
}
await assert.rejects(decodeValveLzma(valve, payload.length + 1, 1 << 26));
await assert.rejects(decodeValveLzma(valve.subarray(0, valve.length - 1), payload.length, 1 << 26));
await assert.rejects(decodeValveLzma(valve, payload.length, 10));
const malformed = Buffer.from(valve); malformed[12] = 255;
await assert.rejects(decodeValveLzma(malformed, payload.length, 1 << 26));
const during = new AbortController(), cancelled = decodeValveLzma(valve, payload.length, 1 << 26, during.signal); during.abort();
await assert.rejects(cancelled, { name: 'AbortError' });
// Aggregate ownership is import-scoped, not a multiplication of per-lump caps.
for (const [text, options] of [
  ['{}{}', { maxEntities: 1 }],
  ['{"a" "b" "a" "c"}', { maxEntityPairs: 1 }],
  ['{"a" "b" "a" "c"}', { maxStringCharacters: 3 }],
  ['{"a" "b"}', { maxEntityObjects: 5 }],
  ['{"a" "b"}', { maxEntityBytes: 1 }],
]) assert.throws(() => parseSourceEntities(text, options));
{
  const text = '{"path" "a\\\\b" "quote" "a\\"b" "path" "last" "unknown" "a\\nb"}';
  const result = parseSourceEntities(text);
  assert.deepEqual(result[0].pairs, [['path','a\\b'],['quote','a"b'],['path','last'],['unknown','a\\nb']]);
  assert.equal(result[0].values.path,'last');
}
{
  const f=fixture(), size=f.entries.get(0).bytes.length;
  f.put(35,Buffer.alloc(800,17)); f.put(36,Buffer.alloc(800,29));
  const parsed=await readSourceBsp(f.blob(),{maxDecodedBytes:size+800});
  const [a,b]=await Promise.all([parsed.getLump(35),parsed.getLump(35)]);
  assert.strictEqual(a,b,'Concurrent aliases of one logical lump share one allocation');
  await assert.rejects(parsed.getLump(36));
  assert.deepEqual([...a.subarray(0,3)],[17,17,17]);
  const concurrent=await readSourceBsp(f.blob(),{maxDecodedBytes:size+1000});
  const outcomes=await Promise.allSettled([concurrent.getLump(35),concurrent.getLump(36)]);
  assert.equal(outcomes.filter(o=>o.status==='fulfilled').length,1);
  
  const working=await readSourceBsp(f.blob(),{maxWorkingBytes:1000});
  const transient=await Promise.allSettled([working.getLump(35),working.getLump(36)]);
  assert.equal(transient.filter(o=>o.status==='fulfilled').length,1);
  
  assert.equal((await working.getLump(36)).length,800,'Rejected pre-allocation reservations do not consume capacity');
}
{
  const f=fixture(); f.put(35,valve,0,payload.length);
  const parsed=await readSourceBsp(f.blob(),{maxWorkingBytes:1024*1024});
  await assert.rejects(parsed.getLump(35),'An 8 MiB LZMA dictionary is reserved before invoking the codec');
  const during=new AbortController(), cancellable=await readSourceBsp(f.blob());
  const pending=cancellable.getLump(35,during.signal); during.abort();
  await assert.rejects(pending,{name:'AbortError'});
  const entities=fixture(); entities.put(0,Buffer.from('{} '.repeat(10000)));
  const cancel=new AbortController(), parsing=readSourceBsp(entities.blob(),{signal:cancel.signal});
  setTimeout(()=>cancel.abort(),0);
  await assert.rejects(parsing,{name:'AbortError'},'Entity scanning yields to cancellation inside an import');
}
{
  const f=fixture(); f.put(35,Buffer.alloc(16)); f.put(36,Buffer.alloc(16));
  const bytes=Buffer.from(await f.blob().arrayBuffer());
  bytes.copy(bytes,8+36*16,8+35*16,8+35*16+16);
  await assert.rejects(readSourceBsp(new Blob([bytes])),'Exactly aliased directory lumps cannot multiply decoded ownership');
  await assert.rejects(readSourceBsp(f.blob(),{maxEntityPairs:1}));
  await assert.rejects(readSourceBsp(f.blob(),{maxEntityBytes:1}));
}
// These retain real Blob payloads and gate only their read completion. Each
// caller must own its own cancellation, never the shared import-owned decode.
{
  class GatedSlice extends Blob {
    constructor(blob, gate) { super([blob]); this.gate=gate; }
    async arrayBuffer() { this.gate.reads++; this.gate.started.resolve(); await this.gate.release.promise; return super.arrayBuffer(); }
  }
  class GatedBsp extends Blob {
    constructor(blob,start,end,gate) { super([blob]); this.start=start; this.end=end; this.gate=gate; }
    slice(start,end,type) { const bytes=super.slice(start,end,type); return start===this.start&&end===this.end?new GatedSlice(bytes,this.gate):bytes; }
  }
  const makeGated=async()=>{
    const f=fixture(); f.put(35,Buffer.alloc(32,73));
    const original=f.blob(), header=new DataView(await original.slice(0,1036).arrayBuffer());
    const start=header.getUint32(8+35*16,true), length=header.getUint32(12+35*16,true);
    const gate={started:Promise.withResolvers(),release:Promise.withResolvers(),reads:0};
    return {parsed:await readSourceBsp(new GatedBsp(original,start,start+length,gate)),gate};
  };
  const first=await makeGated(), local=new AbortController();
  const a=first.parsed.getLump(35,local.signal), b=first.parsed.getLump(35);
  await first.gate.started.promise; local.abort(); first.gate.release.resolve();
  const firstOutcomes=await Promise.allSettled([a,b]);
  const firstResult={
    cancelled:firstOutcomes[0].status==='rejected'&&firstOutcomes[0].reason.name==='AbortError',
    survivor:firstOutcomes[1].status==='fulfilled'&&firstOutcomes[1].value.every(byte=>byte===73),
    reads:first.gate.reads,
  };
  if(firstOutcomes[1].status==='fulfilled')assert.strictEqual(await first.parsed.getLump(35),firstOutcomes[1].value,'Uncancelled caller populates the shared cache');
  const joining=await makeGated(), joinAbort=new AbortController();
  const owner=joining.parsed.getLump(35), waiter=joining.parsed.getLump(35,joinAbort.signal);
  await joining.gate.started.promise; joinAbort.abort();
  let timer;
  const joinOutcome=await Promise.race([
    waiter.then(()=> 'fulfilled',error=>error.name),
    new Promise(resolve=>{timer=setTimeout(()=>resolve('still-waiting-for-shared-read'),100);}),
  ]);
  clearTimeout(timer); joining.gate.release.resolve();
  const [ownerOutcome]=await Promise.allSettled([owner,waiter]);
  assert.deepEqual({first:firstResult,joining:{cancelledBeforeRelease:joinOutcome,survivor:ownerOutcome.status,reads:joining.gate.reads}},{
    first:{cancelled:true,survivor:true,reads:1},
    joining:{cancelledBeforeRelease:'AbortError',survivor:'fulfilled',reads:1},
  });
}
console.log('PASS: real BSP geometry, native triangles, brush reachability, displacement, binary LZMA and malformed/cancelled boundaries');
