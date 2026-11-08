/** CPU acceptance of complete raw Source intake on an OWNED conformance map.
 * The input is hand-authored by scripts/source_raw_map_fixture.cjs, not game data:
 * passing proves this importer's inspection, archive selection, full assembly,
 * worker finalization and local-map admission for these files, not genuine-game,
 * renderer, GPU or Chrome fidelity. Application modules are compiled by the real
 * Vite transforms (scripts/build-fixture.cjs) and called in source-assemble.worker.ts
 * order; expectations below are test-owned literals or independent decoders.
 * Run: node scripts/test_source_raw_assembly.mjs
 */
import assert from 'node:assert/strict';
import { createHash, webcrypto } from 'node:crypto';
import { inflateRawSync, inflateSync } from 'node:zlib';
import buildFixture from './build-fixture.cjs';
import { makeSourceFixture } from './source_raw_map_fixture.cjs';

if (!globalThis.crypto) globalThis.crypto = webcrypto;
const compiled = await buildFixture({ root: process.cwd(), platform: 'node', format: 'es', source: `
  export { inspectSourceFile, selectedSourceBsp } from './src/maps/source-import-index';
  export { assembleSourceMap } from './src/maps/raw-source-convert';
  export { finalizeSourceAssembly } from './src/maps/source-import-finalize';
  export { sourceBundle, sourceChoice, sourceImportFailure, sourceInspection } from './src/maps/source-import-protocol';
  export { companionMounts } from './src/ui/source-mounts';
  export { mapSource, registerLocalMap, validLocalMap } from './src/maps/source';
  export { readSourceVtf } from './src/maps/raw-source-vtf';
  export { SourceAmbient } from './src/render/source-ambient';
  export { SourcePVS } from './src/render/source-sky3d';` });
const api = await import(`data:text/javascript;base64,${Buffer.from(compiled.code).toString('base64')}`);

const MAP = 'm0clip_conformance', MATERIAL = 'materials/m0clip_fixture/floor.vmt', TEXTURE = 'materials/m0clip_fixture/floor.vtf';
const RGBA = { red: [255, 0, 0, 255], green: [0, 255, 0, 255] };
const ASSEMBLY_STAGES = ['bsp', 'companions', 'geometry', 'lighting', 'world', 'props', 'sky', 'packaging'];
const METRES = .0254;
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const bytesOf = async blob => Buffer.from(await blob.arrayBuffer());
function near(actual, expected, epsilon, message) {
  assert.equal(actual.length, expected.length, message);
  actual.forEach((value, i) => assert(Math.abs(value - expected[i]) <= epsilon, `${message}: [${actual}] != [${expected}]`));
}

// Independent container/format readers: they never call the importer under test.
function zipEntries(buffer) {
  const end = buffer.lastIndexOf(Buffer.from([0x50, 0x4b, 5, 6]));
  assert(end >= 0 && end + 22 + buffer.readUInt16LE(end + 20) === buffer.length, 'ZIP end record');
  const files = new Map();
  let at = buffer.readUInt32LE(end + 16);
  for (let i = buffer.readUInt16LE(end + 10); i > 0; i--) {
    assert.equal(buffer.readUInt32LE(at), 0x02014b50);
    const method = buffer.readUInt16LE(at + 10), compressed = buffer.readUInt32LE(at + 20), size = buffer.readUInt32LE(at + 24);
    const nameLength = buffer.readUInt16LE(at + 28), local = buffer.readUInt32LE(at + 42);
    assert.equal(buffer.readUInt32LE(local), 0x04034b50);
    const start = local + 30 + buffer.readUInt16LE(local + 26) + buffer.readUInt16LE(local + 28);
    const body = buffer.subarray(start, start + compressed), data = method === 8 ? inflateRawSync(body) : body;
    assert(method === 0 || method === 8); assert.equal(data.length, size);
    files.set(buffer.toString('utf8', at + 46, at + 46 + nameLength), Buffer.from(data));
    at += 46 + nameLength + buffer.readUInt16LE(at + 30) + buffer.readUInt16LE(at + 32);
  }
  return files;
}
function gmaEntries(buffer) {
  assert.equal(buffer.toString('latin1', 0, 4), 'GMAD'); assert.equal(buffer[4], 3);
  let at = 21;
  const string = () => { const end = buffer.indexOf(0, at), text = buffer.toString('utf8', at, end); at = end + 1; return text; };
  while (string());
  string(); string(); string(); at += 4;
  const records = [];
  while (buffer.readUInt32LE(at)) { at += 4; const path = string(); records.push([path, Number(buffer.readBigUInt64LE(at))]); at += 12; }
  at += 4;
  const files = new Map();
  for (const [path, size] of records) { files.set(path, buffer.subarray(at, at + size)); at += size; }
  return files;
}
const bspLump = (bsp, id) => bsp.subarray(bsp.readUInt32LE(8 + id * 16), bsp.readUInt32LE(8 + id * 16) + bsp.readUInt32LE(12 + id * 16));
function authoredBsp(input, format) {
  if (format === 'bsp') return input.selected.buffer;
  const files = format === 'gma' ? gmaEntries(input.selected.buffer) : zipEntries(input.selected.buffer);
  return files.get(`maps/${MAP}.bsp`);
}
function decodePng(buffer) {
  assert.deepEqual([...buffer.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  let at = 8, width = 0, height = 0;
  const idat = [];
  while (at < buffer.length) {
    const length = buffer.readUInt32BE(at), type = buffer.toString('latin1', at + 4, at + 8), data = buffer.subarray(at + 8, at + 8 + length);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0); height = data.readUInt32BE(4);
      assert.deepEqual([...data.subarray(8, 13)], [8, 6, 0, 0, 0], 'RGBA8, non-interlaced PNG');
    } else if (type === 'IDAT') idat.push(data);
    at += 12 + length;
  }
  const raw = inflateSync(Buffer.concat(idat)), stride = width * 4, out = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    assert(filter <= 4, `PNG filter ${filter}`);
    for (let x = 0; x < stride; x++) {
      const a = x >= 4 ? out[y * stride + x - 4] : 0, b = y ? out[(y - 1) * stride + x] : 0, c = x >= 4 && y ? out[(y - 1) * stride + x - 4] : 0;
      let predictor = 0;
      if (filter === 1) predictor = a;
      else if (filter === 2) predictor = b;
      else if (filter === 3) predictor = (a + b) >> 1;
      else if (filter === 4) {
        const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        predictor = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      out[y * stride + x] = raw[y * (stride + 1) + 1 + x] + predictor;
    }
  }
  return { width, height, data: out };
}
function unpackGlb(bytes) {
  assert.equal(bytes.readUInt32LE(0), 0x46546c67); assert.equal(bytes.readUInt32LE(4), 2); assert.equal(bytes.readUInt32LE(8), bytes.length);
  const jsonLength = bytes.readUInt32LE(12), json = JSON.parse(bytes.toString('utf8', 20, 20 + jsonLength));
  const binary = bytes.subarray(28 + jsonLength);
  const view = index => { const v = json.bufferViews[index]; return binary.subarray(v.byteOffset ?? 0, (v.byteOffset ?? 0) + v.byteLength); };
  const components = { 5121: [1, 'getUint8'], 5123: [2, 'getUint16'], 5125: [4, 'getUint32'], 5126: [4, 'getFloat32'] };
  const width = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 };
  const accessor = index => {
    const a = json.accessors[index], [size, read] = components[a.componentType], n = width[a.type], bytes = view(a.bufferView);
    const stride = json.bufferViews[a.bufferView].byteStride ?? size * n, data = new DataView(bytes.buffer, bytes.byteOffset + (a.byteOffset ?? 0));
    const values = [];
    for (let i = 0; i < a.count; i++) for (let k = 0; k < n; k++) values.push(data[read](i * stride + k * size, true));
    return values;
  };
  return { json, view, accessor };
}

async function intake(options) {
  const input = makeSourceFixture(options), format = options.format;
  const selected = new File([input.selected.buffer], input.selected.name, { type: input.selected.mimeType });
  const companions = input.companions.map(file => new File([file.buffer], file.name, { type: file.mimeType }));
  const bsp = authoredBsp(input, format);
  const inspection = await api.inspectSourceFile(selected);
  assert(api.sourceInspection(inspection));
  assert.deepEqual(inspection, { kind: 'source', format, name: MAP, game: format === 'gma' ? 'Garry\u2019s Mod' : 'Source',
    maps: [{ path: format === 'bsp' ? `${MAP}.bsp` : `maps/${MAP}.bsp`, bytes: bsp.length }] });
  const choice = { file: selected, format, mapPath: inspection.maps[0].path, name: inspection.name, game: inspection.game,
    mounts: api.companionMounts(companions) };
  assert(api.sourceChoice(choice));
  // Exactly the source-assemble.worker.ts sequence.
  const stages = [], selection = await api.selectedSourceBsp(choice);
  assert.equal(selection.mapName, MAP);
  assert(Buffer.from(await selection.file.arrayBuffer()).equals(bsp), 'Selection extracts the exact authored BSP');
  const assembly = await api.assembleSourceMap(selection.file, { mapName: selection.mapName, name: choice.name, game: choice.game,
    mounts: selection.mounts, onStage: stage => stages.push(stage) });
  let bundle, failure;
  try { bundle = await api.finalizeSourceAssembly(assembly, choice.name, choice.game, () => stages.push('verifying')); }
  catch (error) { failure = api.sourceImportFailure(error); }
  return { input, bsp, assembly, stages, bundle, failure };
}

async function admitted({ label, options, winner, source }) {
  const { input, bsp, assembly, stages, bundle, failure } = await intake(options);
  assert.equal(failure, undefined, `${label}: ${failure?.message} ${JSON.stringify(failure?.requirements)}`);
  assert.deepEqual(stages, [...ASSEMBLY_STAGES, 'verifying'], label);
  assert.deepEqual(assembly.requirements, [], `${label}: zero requirements, blocking or otherwise`);
  assert.deepEqual({ ...assembly.counts, outputBytes: 0 }, { worldFaces: 1, collision: 1, props: 0, skyFaces: 0, outputBytes: 0 }, label);
  assert.equal(input.expected.effectiveColor, winner); assert.deepEqual(input.expected.rgba, RGBA[winner]);

  // Final identity: protocol validation, then the main-thread local-map registry.
  assert(api.sourceBundle(bundle), label);
  assert.equal(bundle.id, `local-${bundle.fingerprint}`);
  assert.equal(bundle.index.name, MAP); assert.equal(bundle.index.game, options.format === 'gma' ? 'Garry\u2019s Mod' : 'Source');
  assert.deepEqual(bundle.index.resources.map(r => r.path).sort(),
    ['lighting.json', 'lightstyles.json', 'manifest.json', 'map.xml', 'props.glb', 'visibility.json', 'visual.glb']);
  const files = new Map();
  for (const resource of bundle.index.resources) {
    const bytes = await bytesOf(bundle.files.get(resource.path));
    assert.equal(bytes.length, resource.bytes); assert.equal(sha256(bytes), resource.sha256, `${label}: ${resource.path} SHA-256`);
    files.set(resource.path, bytes);
  }
  const map = api.registerLocalMap(bundle), terrain = `map:${bundle.id}`;
  assert(api.validLocalMap(map.identity, terrain)); assert.equal(api.mapSource(terrain), map);
  const manifest = await map.json('manifest.json');
  assert.deepEqual(manifest, { id: MAP, name: MAP, game: bundle.index.game, files: ['map.xml'], visual: 'visual.glb',
    boxes: 1, hulls: 0, hfields: 0, disp_prisms: 0,
    source_lightmaps: { version: 1, pages: 1, faces: 1, hdr: false, encoding: 'RGBM6' }, light: null,
    spawn: 'info_player_start', spawn_source: [16, 16, 0], spawn_yaw: 90, props: { visual: 'props.glb' },
    visibility: 'visibility.json', source_renderer: { version: 1, color: 'ldr-gamma-lut', antialiasing: 'fxaa' } }, label);

  // Collision: the one reachable authored brush, (-64..64, -64..64, -64..0), in the spawn frame.
  const theta = -Math.PI / 2, toFrame = ([x, y, z]) => [METRES * (Math.cos(theta) * (x - 16) - Math.sin(theta) * (y - 16)),
    METRES * (Math.sin(theta) * (x - 16) + Math.cos(theta) * (y - 16)), METRES * z];
  const boxes = [...files.get('map.xml').toString('utf8').matchAll(/<geom type="box" pos="([^"]+)" size="([^"]+)" quat="([^"]+)"/g)];
  assert.equal(boxes.length, 1, label);
  const numbers = text => text.split(' ').map(Number);
  near(numbers(boxes[0][1]), toFrame([0, 0, -32]), 1e-9, `${label}: box centre`);
  near(numbers(boxes[0][2]), [64 * METRES, 64 * METRES, 32 * METRES], 1e-9, `${label}: box half extents`);
  near(numbers(boxes[0][3]), [Math.cos(theta / 2), 0, 0, Math.sin(theta / 2)], 1e-9, `${label}: box yaw`);
  assert.equal((files.get('map.xml').toString('utf8').match(/<geom /g) ?? []).length, 1, `${label}: no other collision`);

  // Floor: the complete authored quad, covered by two non-overlapping upward triangles.
  const visual = unpackGlb(files.get('visual.glb'));
  const worldNodes = visual.json.nodes.filter(node => node.name === 'Source world');
  assert.equal(worldNodes.length, 1, label);
  assert.deepEqual(worldNodes[0].extras, { sourceOrigin: [16, 16, 0], sourceYaw: 90 });
  const primitives = visual.json.meshes[worldNodes[0].mesh].primitives;
  assert.equal(primitives.length, 1, label);
  const [floor] = primitives, indices = visual.accessor(floor.indices);
  assert.equal(indices.length / 3, 2);
  const positions = visual.accessor(floor.attributes.POSITION);
  const pointKey = point => point.map(value => Math.round(value * 1e6)).join(',');
  const triangles = [];
  for (let at = 0; at < indices.length; at += 3) {
    const points = indices.slice(at, at + 3).map(index => {
      assert(Number.isInteger(index) && index >= 0 && index * 3 + 2 < positions.length, `${label}: valid floor index`);
      return positions.slice(index * 3, index * 3 + 3);
    });
    const [a, b, c] = points;
    assert((b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]) > 0, `${label}: floor faces point upwards`);
    triangles.push(points);
  }
  // This fixture has no authored primitive indices; either valid quad diagonal
  // preserves the surface. Check coverage, not the decoder's fan/index ordering.
  const corners = [[0, 0, 0], [0, 64, 0], [64, 64, 0], [64, 0, 0]].map(toFrame).map(pointKey).sort();
  assert.deepEqual([...new Set(triangles.flat().map(pointKey))].sort(), corners, `${label}: complete authored floor coordinates`);
  const otherKeys = triangles[1].map(pointKey);
  const shared = triangles[0].filter(point => otherKeys.includes(pointKey(point)));
  assert.equal(shared.length, 2, `${label}: triangles share one edge`);
  const sharedKeys = shared.map(pointKey), opposite = triangles.map(points => points.find(point => !sharedKeys.includes(pointKey(point))));
  assert(opposite.every(Boolean), `${label}: distinct floor triangles`);
  const [a, b] = shared, side = point => (b[0] - a[0]) * (point[1] - a[1]) - (b[1] - a[1]) * (point[0] - a[0]);
  assert(side(opposite[0]) * side(opposite[1]) < 0, `${label}: floor triangles do not overlap or leave a hole`);
  assert.deepEqual(floor.extras, { sourceFaceRanges: [[0, 0, 6]] });
  assert(floor.attributes.TEXCOORD_1 !== undefined, `${label}: baked lightmap UVs`);

  // Material: the winning source's exact VMT and VTF, not a merged or substituted resource.
  const material = visual.json.materials[floor.material];
  assert.equal(material.name, MATERIAL);
  const original = visual.json.extras.sourceMaterials[MATERIAL];
  assert.equal(original.shader, 'lightmappedgeneric');
  assert.equal(original.parameters.$basetexture, 'm0clip_fixture/floor');
  assert.equal(original.parameters.$keywords, `m0clip-fixture-${winner}`, `${label}: winning VMT`);
  const archive = source === 'pak' ? zipEntries(bspLump(bsp, 40))
    : zipEntries(input.companions.find(file => file.name === `m0clip-companion-${winner}.zip`).buffer);
  const texture = visual.json.textures[material.pbrMetallicRoughness.baseColorTexture.index];
  const native = texture.extensions.M0CLIP_texture_vtf;
  assert.deepEqual({ path: native.path, frame: native.frame, face: native.face }, { path: TEXTURE, frame: 0, face: 0 });
  const payload = visual.view(native.bufferView);
  assert(payload.equals(archive.get(TEXTURE)), `${label}: embedded VTF bytes are the ${source} bytes`);
  const vtf = await api.readSourceVtf(payload), decoded = await vtf.decode();
  assert.deepEqual([vtf.header.width, vtf.header.height, vtf.header.mipCount, vtf.header.format], [4, 4, 3, 0]);
  assert.deepEqual([...decoded.data], Array(16).fill(RGBA[winner]).flat(), `${label}: native texels`);
  const image = visual.json.images[texture.source];
  assert.equal(image.mimeType, 'image/png');
  const png = decodePng(visual.view(image.bufferView));
  assert.deepEqual([png.width, png.height, ...png.data], [4, 4, ...Array(16).fill(RGBA[winner]).flat()], `${label}: PNG texels`);

  // The authored lightmap (ColorRGBExp32 128,128,128,0 = 128/255 linear) reaches the RGBM6 atlas.
  const atlas = decodePng(visual.view(visual.json.images[visual.json.textures[material.extras.sourceLightmap].source].bufferView));
  assert.deepEqual([atlas.width, atlas.height], [2048, 2048]);
  for (const [x, y] of [[1, 1], [5, 5]]) {
    const at = (y * atlas.width + x) * 4, multiplier = atlas.data[at + 3] / 255 * 6;
    near([...atlas.data.subarray(at, at + 3)].map(v => v / 255 * multiplier), [128 / 255, 128 / 255, 128 / 255], .01, `${label}: lightmap luxel`);
  }

  // Native ambient: leaf 0 owns one indexed probe; the solid leaf owns none.
  const lighting = JSON.parse(files.get('lighting.json'));
  assert.deepEqual({ ...lighting, leaves: undefined }, { origin: [16, 16, 0], yaw: 90, head: 0, nodes: [[1, 0, 0, 64, -1, -1]], leaves: undefined, lights: [] });
  const sides = [1, 2, 3, 4, 5, 6].flatMap(side => [side, 2, 4]);
  assert.equal(lighting.leaves.length, 2); assert.equal(lighting.leaves[0].length, 1); assert.deepEqual(lighting.leaves[1], []);
  near(lighting.leaves[0][0], [-64 + 128 * 153 / 255, -64 + 128 * 153 / 255, 64 * 128 / 255, ...sides], 1e-9, `${label}: ambient probe`);
  const ambient = new api.SourceAmbient(), cache = { cube: [], lights: [] };
  ambient.setData(lighting); ambient.sample(0, 0, 32 * METRES, cache);
  near(cache.cube.flat(), sides, 1e-9, `${label}: runtime ambient cube`); assert.deepEqual(cache.lights, []);

  // Native visibility: one self-visible cluster containing the floor face.
  const visibility = JSON.parse(files.get('visibility.json'));
  assert.deepEqual(visibility, { version: 1, spawn: [16, 16, 0], yaw: 90, head: 0, nodes: [[1, 0, 0, 64, -1, -1]], leafClusters: [0, 65535],
    faceClusters: [[0]], visibility: Buffer.from([1, 0, 0, 0, 12, 0, 0, 0, 13, 0, 0, 0, 1, 1]).toString('base64'), sky: null });
  const pvs = new api.SourcePVS(visibility);
  assert.equal(pvs.cluster({ x: 0, y: 0, z: 32 * METRES }), 0);
  assert(pvs.visible(pvs.row(0), visibility.faceClusters[0]));
  return { bundle, visual: sha256(files.get('visual.glb')) };
}

async function refused({ label, options, codes }) {
  const { assembly, stages, bundle, failure } = await intake(options);
  assert.equal(bundle, undefined, `${label}: no identity`);
  assert.deepEqual(stages, ASSEMBLY_STAGES, `${label}: refused before verification`);
  assert.deepEqual([...new Set(assembly.requirements.map(r => r.code))].sort(), codes, label);
  assert(assembly.requirements.every(r => r.blocking === true));
  assert.match(failure.message, /unresolved Source requirement/);
  assert.equal(failure.omittedRequirements, 0);
  assert.deepEqual([...new Set(failure.requirements.map(r => r.code))].sort(), codes);
  return { assembly, failure };
}

const originalFetch = globalThis.fetch;
globalThis.fetch = () => { throw new Error('Raw Source intake must never use HTTP'); };
try {
  const pak = await admitted({ label: 'BSP with embedded pak', options: { format: 'bsp' }, winner: 'red', source: 'pak' });
  const gma = await admitted({ label: 'GMAD v3 archive', options: { format: 'gma' }, winner: 'red', source: 'pak' });
  const zip = await admitted({ label: 'Deflate ZIP archive', options: { format: 'zip' }, winner: 'red', source: 'pak' });
  const pakFirst = await admitted({ label: 'Embedded pak over companion', options: { format: 'bsp', companionColors: ['green'] }, winner: 'red', source: 'pak' });
  const greenFirst = await admitted({ label: 'Ordered companions green, red', options: { format: 'zip', pakColor: null, companionColors: ['green', 'red'] }, winner: 'green', source: 'companion' });
  await admitted({ label: 'Ordered companions red, green', options: { format: 'bsp', pakColor: null, companionColors: ['red', 'green'] }, winner: 'red', source: 'companion' });
  // Identity depends only on generated content and name/game, never on container or ignored lower mounts.
  assert.equal(zip.bundle.fingerprint, pak.bundle.fingerprint, 'BSP and ZIP intake of one map share final identity');
  assert.equal(pakFirst.bundle.fingerprint, pak.bundle.fingerprint, 'A shadowed companion leaves no trace');
  assert.notEqual(gma.bundle.fingerprint, pak.bundle.fingerprint, 'Inspection game is part of identity');
  for (const result of [gma, zip, pakFirst]) assert.equal(result.visual, pak.visual);
  assert.notEqual(greenFirst.visual, pak.visual);

  const missing = await refused({ label: 'No material source', options: { format: 'bsp', pakColor: null }, codes: ['missing-material', 'world-material-unavailable'] });
  assert(missing.assembly.requirements.some(r => r.code === 'missing-material' && r.path === MATERIAL));
  assert(missing.assembly.requirements.some(r => r.code === 'world-material-unavailable' && r.face === 0));
  const visual = unpackGlb(await bytesOf(missing.assembly.files.get('visual.glb')));
  assert(!visual.json.nodes?.some(node => node.name === 'Source world'), 'No substitute floor material or geometry');
  const dark = await refused({ label: 'No leaf ambient', options: { format: 'gma', ambient: false }, codes: ['missing-ambient-probes'] });
  assert.deepEqual(JSON.parse(await dark.assembly.files.get('lighting.json').text()).leaves, [[], []], 'No probe was invented');
  console.log('raw Source owned-fixture assembly: 6 admitted, 2 refused');
} finally { globalThis.fetch = originalFetch; }
