/** Real GLTFLoader and raw-map finalization CPU consumers.
 * node scripts/test_raw_source_props_glb.mjs
 * No graphics, complete-map or native playback qualification. */
import assert from 'node:assert/strict';
import { rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import buildFixture from './build-fixture.cjs';
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
// Real Vite transforms (import.meta.glob included), as the application compiles them.
const compiled = await buildFixture({ root: process.cwd(), platform: 'node', format: 'es',
  source: "export * from './src/maps/raw-source-props-glb';export * from './src/maps/raw-source-gltf';export * from './src/maps/raw-source-materials';export * from './src/maps/raw-source-studio';export * from './src/maps/raw-source-props';export * from './src/maps/raw-source-bsp';export * from './src/maps/raw-source-files';export * from './src/maps/raw-source-vtf';export * from './src/maps/source-import-finalize';" });
const { appendSourceProps, SourceGlb, SourceMaterialExport, SourceFileSystem, sourcePropMatrix, readSourceStudioModel, selectSourceStudioMeshes, readSourceBsp, decodeSourceWorld, readSourceProps, readSourceVtf, finalizeSourceAssembly } =
  await import(`data:text/javascript;base64,${Buffer.from(compiled.code).toString('base64')}`);
// Keep runtime instanceof checks on the SAME Three module as the real GLTFLoader:
// packages stay external and resolve from the worktree, so the fixture is a file there.
const runtimeFile = resolve(process.cwd(), `.raw-source-props-glb-${process.pid}.mjs`);
const runtimeCompiled = await buildFixture({ root: process.cwd(), platform: 'node', format: 'es', externalPackages: true,
  source: `export * from './src/render/source-props';
export * from './src/render/source-lighting';export * from './src/render/source-materials';
export { SceneView } from './src/render/scene';export { SourceAmbient } from './src/render/source-ambient';
export { SourceColor } from './src/render/source-color';export { MapSource } from './src/maps/source';` });
await writeFile(runtimeFile, runtimeCompiled.code);
let runtime;
try { runtime = await import(pathToFileURL(runtimeFile).href); } finally { await rm(runtimeFile, { force: true }); }
const { SourceProps: SourcePropDisplay, SourceMaterials, sourceVertexMaterial, patchSourceMaterial, SceneView, SourceAmbient, SourceColor, MapSource } = runtime;
const limits = { maxGeometryBytes: 256 * 1024 ** 2, maxVertices: 4_000_000 };
const near = (actual, expected, epsilon = 2e-5) => actual.forEach((v, i) => assert(Math.abs(v - expected[i]) < epsilon, `${actual} != ${expected}`));
async function consume(glb) {
  const loader = new GLTFLoader();
  // Genuine VTF pixels through the native extension, no fake ImageBitmap/canvas.
  // This CPU-only loader plugin avoids browser image/GPU APIs; it is NOT renderer QA.
  loader.register(parser => ({ name: 'M0CLIP_texture_vtf', loadTexture: async index => {
    const meta = parser.json.textures[index].extensions?.M0CLIP_texture_vtf;
    if (!meta) throw new Error('CPU test requires an actual native VTF payload');
    const native = await readSourceVtf(new Uint8Array(await parser.getDependency('bufferView', meta.bufferView)));
    const decoded = await native.decode({ frame: meta.frame, face: meta.face });
    assert(decoded.data instanceof Uint8Array || decoded.data instanceof Float32Array, 'Unsupported signed CPU test texture, not substituted');
    const texture = new THREE.DataTexture(decoded.data, decoded.width, decoded.height, THREE.RGBAFormat, decoded.data instanceof Float32Array ? THREE.FloatType : THREE.UnsignedByteType);
    texture.userData.sourceVtf = meta; texture.flipY = false; texture.needsUpdate = true; return texture;
  } }));
  const parsed = await loader.parseAsync(await glb.finish().arrayBuffer(), '');
  parsed.scene.updateMatrixWorld(true); return parsed;
}
const frame = { origin: [100, 200, 300], yaw: 90, metresPerUnit: .0254, up: 'Z', spawnClass: 'fixture', floorFound: true };
const nativeAnimation = { animations: [], sequences: [], blocks: [], companions: [], includedModels: [], temporalSupport: 'encoded-data-preserved-not-sampled' };
function bone(name, parent, position, worldX) {
  const local = new THREE.Matrix4().makeTranslation(...position), world = new THREE.Matrix4().makeTranslation(worldX, 0, 0);
  return { name, parent, position, quaternion: [0, 0, 0, 1], rotation: [0, 0, 0], positionScale: [1, 1, 1], rotationScale: [1, 1, 1], localMatrix: Float64Array.from(local.elements), defaultWorldMatrix: Float64Array.from(world.elements), inverseBindMatrix: Float64Array.from(world.clone().invert().elements), flags: 0, proceduralType: 0 };
}
const materialA = { name: 'a', path: 'materials/a.vmt', candidates: ['materials/a.vmt'] }, materialB = { name: 'b', path: 'materials/b.vmt', candidates: ['materials/b.vmt'] };
function mesh(submodel, offset = 0) {
  return { bodypart: 0, submodel, bodyBase: 1, bodyCount: 2, name: `body${submodel}`, lod: 1, switchPoint: 12, skinref: 0,
    materialBySkin: [materialA, materialB], positions: Float32Array.from([16 + offset, 1, 0, -6 + offset, 1, 0, 5 + offset, 4, 0]), normals: Float32Array.from([0, 0, 1, 0, 0, 1, 0, 0, 1]), tangents: Float32Array.from([1, 0, 0, 1, 1, 0, 0, 1, 1, 0, 0, 1]), uv: Float32Array.from([0, 0, 1, 0, 0, 1]), indices: Uint32Array.from([0, 1, 2]), joints: Uint16Array.from([1, 0, 0, 0, 2, 0, 0, 0, 0, 0, 0, 0]), weights: Float32Array.from([1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0]), flexCount: 0, materialType: 0, materialParameter: 0 };
}
const model = { path: 'models/test.mdl', name: 'test', version: 48, checksum: 123, flags: 0, units: 'source-units', up: 'Z', pose: 'bind', illuminationPosition: [2, 3, 4], bounds: [[-6, 0, 0], [16, 4, 0]], materials: [materialA, materialB], skins: [Uint16Array.from([0]), Uint16Array.from([1])], bodyparts: [{ name: 'body', base: 1, models: ['body0', 'body1'] }], lod: 1, lodVertexCounts: [6, 6], meshes: [mesh(0), mesh(1, 3)], bones: [bone('root', -1, [5, 0, 0], 5), bone('left', 0, [10, 0, 0], 15), bone('right', 0, [-10, 0, 0], -5)], animation: nativeAnimation, rawBlob: new Blob(['owned mdl']), vvdBlob: new Blob(['owned vvd']), vtxBlob: new Blob(['owned vtx']), requiredCompanions: [], missingResources: [], limitations: [], renderBounds: [[-6, 0, 0], [16, 4, 0]] };
function placement(index, settings = {}) {
  const p = { kind: 'static-prop', index, modelPath: model.path, classname: 'prop_static', sourceOrigin: [100, 300, 300], sourceAngles: [0, 90, 0], scale: 2, skin: 0, body: 0, solid: 6, flags: 2, flagsEx: 4, leaves: Uint16Array.from([0, 1, 2]), castShadow: true, fadeMinDistance: -1, fadeMaxDistance: 0, forcedFadeScale: 1, diffuseModulation: [255, 128, 64, 255], render: { mode: 0, effect: 0, color: [255, 255, 255], amount: 255, initiallyDisabled: false, renderFx: '', castShadow: true, receiveShadow: true }, ...settings };
  p.matrix = sourcePropMatrix(frame, p.sourceOrigin, p.sourceAngles, p.scale); p.matrixInputUnits = 'metres'; return p;
}
const leafBytes = new Uint8Array(56 * 3), leafView = new DataView(leafBytes.buffer); [7, 2, 65535].forEach((v, i) => leafView.setUint16(i * 56 + 4, v, true));
const world = { frame, bsp: { lumps: Array.from({ length: 64 }, () => ({ version: 0 })), getLump: async id => { assert.equal(id, 10); return leafBytes; } } };
function propsFor(placements, models = new Map([[model.path, model]])) {
  return { placements, models, frame, brushes: [], entities: [], gameLumps: [], missingModels: [], missingMaterials: [], missingAnimationResources: [], completeResources: true, originalBspBlob: new Blob(['bsp']), limitations: [] };
}
const files = { readFile: async path => path === 'materials/a.vmt' ? new Blob(['VertexLitGeneric { "$color" "[.5 .25 1]" }']) : path === 'materials/b.vmt' ? new Blob(['VertexLitGeneric { "$color" "[.1 .7 .2]" "$alpha" ".8" }']) : undefined };
const cache = { cube: Array.from({ length: 6 }, (_, i) => [i / 10, i / 20, i / 30]), lights: [{ pos: [11, 22, 33], color: [1, 2, 3], attenuation: [0, .01, 0], kind: 1, normal: [0, 0, -1], exponent: 0, inner: 0, outer: 0 }] };
const placements = [placement(0), placement(1, { skin: 1, sourceOrigin: [120, 300, 310], sourceAngles: [0, 0, 0], scale: .5 }), placement(2, { body: 1 })];
const props = propsFor(placements), glb = new SourceGlb(), materials = new SourceMaterialExport(glb, files);
const emitted = await appendSourceProps(glb, materials, props, world, { ...limits, lightingForPlacement: () => cache });
assert.deepEqual(emitted.requirements, []); assert.deepEqual(materials.requirements, []);
assert.equal(glb.json.animations, undefined);
assert(emitted.placements.every(p => p.clip === undefined));
const parsed = await consume(glb);
async function loadedPlacement(parsed, emission) {
  const root = await parsed.parser.getDependency('node', emission.node), meshes = [];
  root.traverse(o => { if (o instanceof THREE.Mesh) meshes.push(o); }); return { root, meshes };
}
// Independent native Source-unit CPU oracle, never generated node matrices.
function expectedVertex(nativeModel, nativeMesh, vertex, placement, rotations = new Map()) {
  const worlds = [];
  for (let i = 0; i < nativeModel.bones.length; i++) {
    const b = nativeModel.bones[i], q = new THREE.Quaternion().fromArray(b.quaternion);
    if (rotations.has(i)) q.multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), rotations.get(i)));
    const local = new THREE.Matrix4().compose(new THREE.Vector3(...b.position), q, new THREE.Vector3(1, 1, 1));
    worlds.push(b.parent < 0 ? local : worlds[b.parent].clone().multiply(local));
  }
  const point = new THREE.Vector3().fromArray(nativeMesh.positions, vertex * 3), skinned = new THREE.Vector3();
  if (worlds.length) for (let j = 0; j < 4; j++) {
    const weight = nativeMesh.weights[vertex * 4 + j]; if (!weight) continue;
    const joint = nativeMesh.joints[vertex * 4 + j];
    skinned.addScaledVector(point.clone().applyMatrix4(new THREE.Matrix4().fromArray(nativeModel.bones[joint].inverseBindMatrix)).applyMatrix4(worlds[joint]), weight);
  } else skinned.copy(point);
  // Explicit Source QAngle yaw, authored scale, then world frame (synthetic uses yaw only).
  return skinned.multiplyScalar(.0254).applyMatrix4(new THREE.Matrix4().fromArray(placement.matrix)).toArray();
}
async function comparePlacement(parsed, emission, nativeModel, pose = false) {
  const { root, meshes } = await loadedPlacement(parsed, emission), nativeMeshes = emission.meshes;
  const rotations = new Map();
  if (pose) for (let i = 1; i < emission.bones.length; i++) {
    const angle = i % 2 ? Math.PI / 3 : -Math.PI / 3; rotations.set(i, angle);
    const boneNode = await parsed.parser.getDependency('node', emission.bones[i]); boneNode.quaternion.multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), angle));
  }
  parsed.scene.updateMatrixWorld(true);
  assert.equal(meshes.length, nativeMeshes.length);
  for (let i = 0; i < meshes.length; i++) {
    const mesh = meshes[i], source = nativeMeshes[i]; if (mesh.isSkinnedMesh) mesh.skeleton.update();
    const ids = [...new Set([0, Math.floor(source.positions.length / 6), source.positions.length / 3 - 1])];
    for (const vertex of ids) {
      const point = new THREE.Vector3().fromBufferAttribute(mesh.geometry.attributes.position, vertex);
      if (mesh.isSkinnedMesh) mesh.applyBoneTransform(vertex, point);
      point.applyMatrix4(mesh.matrixWorld); near(point.toArray(), expectedVertex(nativeModel, source, vertex, emission.placement, rotations), nativeModel === model ? 2e-5 : 2e-3);
    }
  }
  return { root, meshes };
}
const loaded = [];
for (const emission of emitted.placements) loaded.push(await comparePlacement(parsed, emission, model));
// Known independent bind coordinate catches placement/frame applied twice.
near(loaded[0].meshes[0].localToWorld(new THREE.Vector3(.0254 * 16, .0254, 0)).toArray(), [2.54 + .0254 * 32, .0254 * 2, 0]);
assert.strictEqual(loaded[0].meshes[0].geometry.attributes.position, loaded[1].meshes[0].geometry.attributes.position, 'GLTFLoader actually shares the geometry accessor');
assert.notStrictEqual(loaded[0].meshes[0].skeleton.bones[1], loaded[1].meshes[0].skeleton.bones[1]);
near(loaded[0].meshes[0].material.color.toArray(), [.5, .25 * 128 / 255, 64 / 255]);
near(loaded[1].meshes[0].material.color.toArray(), [.1, .7 * 128 / 255, .2 * 64 / 255]);
assert.equal(loaded[1].meshes[0].material.opacity, .8);
// A static alpha and normal-rendermode entity alpha differ even with identical raw RGBA.
for(const reverse of [false,true]){
  const mixed=[
    placement(40,{diffuseModulation:[255,128,64,128]}),
    placement(41,{kind:'entity-model',classname:'prop_dynamic',diffuseModulation:[255,128,64,128],render:{...placement(0).render,amount:128}}),
  ];
  if(reverse)mixed.reverse();
  const mixedGlb=new SourceGlb(),mixedMaterials=new SourceMaterialExport(mixedGlb,files);
  const mixedResult=await appendSourceProps(mixedGlb,mixedMaterials,propsFor(mixed),world,{...limits,lightingForPlacement:()=>cache});
  const mixedParsed=await consume(mixedGlb);
  for(const emitted of mixedResult.placements){
    const actual=await loadedPlacement(mixedParsed,emitted),isEntity=emitted.placement.kind==='entity-model';
    assert.equal(actual.meshes[0].material.opacity,isEntity?1:128/255);
    assert.equal(actual.meshes[0].material.transparent,!isEntity);
  }
}
const worldPoint = loaded[0].meshes[0].localToWorld(new THREE.Vector3(.0254 * 16, .0254, 0));
const shaderSourcePoint = worldPoint.clone().applyAxisAngle(new THREE.Vector3(0, 0, 1), loaded[0].root.userData.sourceYaw * Math.PI / 180).divideScalar(.0254).add(new THREE.Vector3(...loaded[0].root.userData.sourceOrigin));
near(shaderSourcePoint.toArray(), [98, 332, 300]);
assert.deepEqual(loaded[0].root.userData.sourceVisibilityClusters, [2, 7]);
const originalCache = cache.cube[0][0]; glb.json.nodes[emitted.placements[0].node].extras.sourceLighting.cube[0][0] = 900;
assert.equal(cache.cube[0][0], originalCache); assert.equal(glb.json.nodes[emitted.placements[1].node].extras.sourceLighting.cube[0][0], originalCache);
await comparePlacement(parsed, emitted.placements[0], model, true);
await comparePlacement(parsed, emitted.placements[1], model); // posing first must not move opposite instance.
assert.deepEqual(model.bones[1].quaternion, [0, 0, 0, 1]);
const blockedGlb = new SourceGlb(), blockedMaterials = new SourceMaterialExport(blockedGlb, files);
const blockedPlacement = placement(3, { fadeMaxDistance: 100, castShadow: false, animation: { defaultAnimation: 'idle', sequence: '0', cycle: .5, playbackRate: 1, skin: 0, body: 0, temporalSupport: 'authored-state-not-simulated' } });
const blockedModel = { ...model, meshes: model.meshes.map(m => ({ ...m, flexCount: 1 })), bones: model.bones.map((b, i) => ({ ...b, proceduralType: i === 1 ? 1 : 0 })) };
const blockedProps = propsFor([blockedPlacement], new Map([[model.path, blockedModel]]));
const blocked = await appendSourceProps(blockedGlb, blockedMaterials, blockedProps, world, { ...limits, lightingForPlacement: () => undefined });
for (const code of ['prop-light-cache', 'prop-procedural-bone-runtime', 'prop-flex-runtime', 'prop-fade-runtime', 'prop-shadow-runtime']) assert(blocked.requirements.some(r => r.code === code && r.blocking), code);
assert.equal(blockedGlb.json.nodes[blocked.placements[0].node].extras.sourceLighting, undefined); assert.equal(blockedGlb.json.animations, undefined);
assert.strictEqual(blocked.original.models.get(model.path).rawBlob, model.rawBlob);
assert.equal(blockedGlb.json.nodes[blocked.placements[0].node].extras.sourcePlacement.fadeMaxDistance, 100);
assert.equal(blockedGlb.json.nodes[blocked.placements[0].node].extras.castShadow, false);
const missingProps = propsFor([placement(5)], new Map()); missingProps.missingModels = [{ path: model.path, resources: ['models/test.vvd'] }];
const missing = await appendSourceProps(new SourceGlb(), blockedMaterials, missingProps, world, { ...limits, lightingForPlacement: () => cache });
assert.equal(missing.placements.length, 0); assert(missing.requirements.some(r => r.code === 'prop-missing-model'));
const absentMaterial = { name: 'absent', candidates: ['materials/absent.vmt'] };
const absentMaterialModel = { ...model, meshes: model.meshes.map(m => ({ ...m, materialBySkin: [absentMaterial, absentMaterial] })) };
const absentMaterialProps = propsFor([placement(7)], new Map([[model.path, absentMaterialModel]]));
const absentMaterialGlb = new SourceGlb();
const absentMaterialResult = await appendSourceProps(absentMaterialGlb, new SourceMaterialExport(absentMaterialGlb, files), absentMaterialProps, world, { ...limits, lightingForPlacement: () => cache });
assert(absentMaterialResult.requirements.some(r => r.code === 'prop-missing-material' && r.blocking));
assert(absentMaterialResult.requirements.some(r => r.code === 'prop-no-emitted-geometry' && r.blocking));
assert.strictEqual(absentMaterialResult.original.models.get(model.path).rawBlob, model.rawBlob);
for (const skin of [2, 55, -1]) {
  const skinGlb = new SourceGlb(), skinMaterials = new SourceMaterialExport(skinGlb, files);
  const selected = placement(6, { skin });
  const result = await appendSourceProps(skinGlb, skinMaterials, propsFor([selected]), world, { ...limits, lightingForPlacement: () => cache });
  assert.deepEqual(result.requirements, []);
  const skinParsed = await consume(skinGlb);
  const actual = await comparePlacement(skinParsed, result.placements[0], model);
  near(actual.meshes[0].material.color.toArray(), [.5, .25 * 128 / 255, 64 / 255]);
  assert.equal(actual.meshes[0].material.opacity, 1);
  assert.equal(actual.root.userData.skin, skin, 'native family selection does not rewrite authored skin metadata');
}
for (const skin of [.5, Number.MAX_SAFE_INTEGER + 1]) {
  const skinGlb = new SourceGlb(), skinMaterials = new SourceMaterialExport(skinGlb, files);
  const result = await appendSourceProps(skinGlb, skinMaterials, propsFor([placement(6, { skin })]), world, { ...limits, lightingForPlacement: () => cache });
  assert(result.requirements.some(r => r.code === 'prop-skin-selection' && r.blocking));
}
const boundedGlb = new SourceGlb(), boundedMaterials = new SourceMaterialExport(boundedGlb, files);
await assert.rejects(appendSourceProps(boundedGlb, boundedMaterials, props, world, { ...limits, maxVertices: 2, lightingForPlacement: () => cache }));
const bytesGlb = new SourceGlb(), bytesMaterials = new SourceMaterialExport(bytesGlb, files);
await assert.rejects(appendSourceProps(bytesGlb, bytesMaterials, props, world, { ...limits, maxGeometryBytes: 16, lightingForPlacement: () => cache }));
const abort = new AbortController(); abort.abort(new Error('cancel props'));
await assert.rejects(appendSourceProps(new SourceGlb(), blockedMaterials, props, world, { ...limits, signal: abort.signal, lightingForPlacement: () => cache }));
// Actual native cubemap face order/bytes and per-placement metadata ownership.
const cubeHeader = Buffer.alloc(80); cubeHeader.write('VTF\0'); cubeHeader.writeUInt32LE(7, 4); cubeHeader.writeUInt32LE(2, 8); cubeHeader.writeUInt32LE(80, 12);
cubeHeader.writeUInt16LE(1, 16); cubeHeader.writeUInt16LE(1, 18); cubeHeader.writeUInt32LE(0x4000, 20); cubeHeader.writeUInt16LE(1, 24); cubeHeader.writeUInt16LE(0xffff, 26);
cubeHeader.writeUInt32LE(0, 52); cubeHeader[56] = 1; cubeHeader.writeUInt32LE(0xffffffff, 57); cubeHeader.writeUInt16LE(1, 63);
const cubePixels = Buffer.from(Array.from({ length: 6 }, (_, face) => [10 + face, 20 + face, 30 + face, 255]).flat());
const cubeFiles = { readFile: async path => path === 'materials/native_cube.vtf' ? new Blob([cubeHeader, cubePixels]) : path === 'materials/c.vmt' ? new Blob(['VertexLitGeneric { "$envmap" "env_cubemap" }']) : files.readFile(path) };
const cubeGlb = new SourceGlb(), cubeMaterials = new SourceMaterialExport(cubeGlb, cubeFiles);
const faceBindings = [];
for (let face = 0; face < 6; face++) faceBindings.push(await cubeMaterials.texture('materials/native_cube.vtf', 0, face));
const cubeMaterial = { name: 'c', path: 'materials/c.vmt', candidates: ['materials/c.vmt'] };
const cubeModel = { ...model, meshes: model.meshes.map(m => ({ ...m, materialBySkin: [cubeMaterial, cubeMaterial] })) };
const cubeResult = await appendSourceProps(cubeGlb, cubeMaterials, propsFor([placement(8)], new Map([[model.path, cubeModel]])), world, { ...limits, lightingForPlacement: () => cache, cubeForPlacement: () => faceBindings });
assert.deepEqual(cubeResult.requirements, []); assert.deepEqual(cubeMaterials.requirements, []);
const originalBindings = [...faceBindings]; faceBindings.reverse();
assert.deepEqual(cubeGlb.json.nodes[cubeResult.placements[0].node].extras.sourceCubeFaces, originalBindings);
const cubeParsed = await consume(cubeGlb), cubeLoaded = await loadedPlacement(cubeParsed, cubeResult.placements[0]);
assert.deepEqual(cubeLoaded.meshes[0].material.userData.sourceMaterial.envmapFaces, originalBindings);
for (let face = 0; face < 6; face++) {
  const texture = await cubeParsed.parser.getDependency('texture', originalBindings[face]);
  assert.deepEqual(Array.from(texture.image.data), [10 + face, 20 + face, 30 + face, 255]);
}
// Actual native assembly -> GLTFLoader -> production display/material consumer.
// Oracles are Source's byte-domain squared-distance rules, not linear-distance
// interpolation or forcedFadeScale incorrectly multiplying authored distances.
const displayGlb = new SourceGlb(), displayMaterials = new SourceMaterialExport(displayGlb, files);
const opaqueRender = { ...placements[0].render };
const displayPlacement = (index, settings = {}) => placement(index, {
  sourceOrigin: [...frame.origin], sourceAngles: [0, 0, 0], scale: 1,
  diffuseModulation: [255, 255, 255, 255], render: { ...opaqueRender },
  flags: 1, fadeMinDistance: 100, fadeMaxDistance: 200, ...settings,
});
const displayModel = { ...model, renderBounds: [[-12, 0, 0], [32, 8, 0]] };
const noForcedModel = { ...displayModel, path: 'models/no-forced.mdl', flags: 0x800 };
const displayPlacements = [
  displayPlacement(20),
  displayPlacement(21, { sourceOrigin: [1100, 200, 300], forcedFadeScale: 2 }),
  displayPlacement(22, { castShadow: false, render: { ...opaqueRender, initiallyDisabled: true, receiveShadow: false } }),
  displayPlacement(23, { kind: 'entity-model', classname: 'prop_dynamic', flags: 0, fadeMinDistance: -1, fadeMaxDistance: 1000 }),
  displayPlacement(24, { flags: 0, forcedFadeScale: 2 }),
  displayPlacement(25, { flags: 0, forcedFadeScale: 0 }),
  displayPlacement(26, { flags: 1 | 32, fadeMinDistance: 20, fadeMaxDistance: 40, forcedFadeScale: 0 }),
  displayPlacement(27, { flags: 0, forcedFadeScale: 1 }),
  displayPlacement(28, { render: { ...opaqueRender, mode: 10 } }),
  displayPlacement(29, { render: { ...opaqueRender, mode: 6 } }),
  displayPlacement(30, { modelPath: noForcedModel.path, flags: 0, forcedFadeScale: 2 }),
  displayPlacement(31, { fadeMinDistance: 100, fadeMaxDistance: 100 }),
  displayPlacement(32, { kind: 'entity-model', flags: 0, fadeMinDistance: 100, fadeMaxDistance: 100 }),
  displayPlacement(33, { kind: 'entity-model', flags: 0, fadeMinDistance: 1000, fadeMaxDistance: 600 }),
];
const displayEmission = await appendSourceProps(displayGlb, displayMaterials,
  propsFor(displayPlacements, new Map([[model.path, displayModel], [noForcedModel.path, noForcedModel]])), world,
  { ...limits, lightingForPlacement: () => cache });
const displayParsed = await consume(displayGlb);
const displayLoaded = await Promise.all(displayEmission.placements.map(p => loadedPlacement(displayParsed, p)));
const pbrBefore = displayLoaded.map(p => p.meshes[0].material);
assert.strictEqual(pbrBefore[0], pbrBefore[1], 'native loader really shares the original material');
assert.strictEqual(displayLoaded[0].meshes[0].geometry.attributes.position, displayLoaded[1].meshes[0].geometry.attributes.position);
const display = new SourcePropDisplay([displayParsed.scene], { forcedScreenFade: true });
function updateDisplay(camera, view = {}) { display.update(camera, { viewportHeight: 1000, ...view }); }
const displayContext = new SourceMaterials(), pairs = [], shaders = [];
for (const item of displayLoaded) {
  const m = item.meshes[0], original = m.material;
  const source = displayContext.own(sourceVertexMaterial(original, 6, { value: 1 }));
  patchSourceMaterial(source, original, {}, item.root.userData.sourceLighting, undefined,
    item.root.userData.sourceOrigin, item.root.userData.sourceYaw, true, displayContext);
  display.bindMaterial(m, original); display.bindMaterial(m, source);
  const shader = {};
  for (const [name, material] of Object.entries({ original, source })) {
    const value = { uniforms: {}, vertexShader: THREE.ShaderLib[name === 'source' ? 'basic' : 'standard'].vertexShader,
      fragmentShader: THREE.ShaderLib[name === 'source' ? 'basic' : 'standard'].fragmentShader };
    material.onBeforeCompile(value, null);
    shader[name] = value;
  }
  pairs.push({ m, original, source }); shaders.push(shader);
}
assert.notStrictEqual(pairs[0].original, pairs[1].original);
const alpha = i => shaders[i].original.uniforms.sourcePropAlpha?.value ?? 1;
const effectiveVisible = mesh => { for (let o = mesh; o; o = o.parent) if (!o.visible) return false; return true; };
const camera = new THREE.PerspectiveCamera(90, 1, .001, 10000);
function atDistance(index, distance, entityCenter = false) {
  displayParsed.scene.updateWorldMatrix(true, true);
  const root = displayLoaded[index].root;
  const local = entityCenter ? root.localToWorld(new THREE.Vector3(5, 2, 0).multiplyScalar(.0254)) : root.getWorldPosition(new THREE.Vector3());
  displayParsed.scene.worldToLocal(local).add(new THREE.Vector3(distance * .0254, 0, 0));
  camera.position.copy(displayParsed.scene.localToWorld(local)); camera.updateMatrixWorld(true);
}
// Owner transformed AFTER binding/merge; prop scale and map/global scale are
// not a second conversion of authored Source-unit distances.
const mergedMap = new THREE.Group(); mergedMap.position.set(50, -30, 12);
mergedMap.rotation.set(.2, -.4, .7); mergedMap.scale.set(2, 3, 4); mergedMap.add(displayParsed.scene);
for (const [distance, expected] of [[0, 1], [100, 1], [Math.sqrt(25000), 127 / 255], [200, 0], [250, 0]]) {
  atDistance(0, distance); updateDisplay(camera);
  near([alpha(0)], [expected], 1e-10);
  assert.equal(displayLoaded[0].root.visible, true, 'display never writes a PVS root');
  assert.equal(pairs[0].m.visible, expected > 0);
}
atDistance(0, Math.sqrt(25000)); updateDisplay(camera);
assert.equal(alpha(1), 0, 'far shared-geometry placement has its OWN alpha');
assert.equal(shaders[0].source.uniforms.sourcePropAlpha.value, 127 / 255);
assert.equal(shaders[1].source.uniforms.sourcePropAlpha.value, 0);
assert.equal(pairs[0].original.transparent, true); assert.equal(pairs[0].original.depthWrite, false);
// Material/proxy opacity is independent, never destructively folded into fade.
pairs[0].original.opacity = .37; pairs[0].source.opacity = .61;
pairs[0].m.material = pairs[0].source; updateDisplay(camera);
assert.equal(pairs[0].source.opacity * shaders[0].source.uniforms.sourcePropAlpha.value, .61 * 127 / 255);
pairs[0].m.material = pairs[0].original; updateDisplay(camera);
assert.equal(pairs[0].original.opacity, .37);
atDistance(1, Math.sqrt(25000)); updateDisplay(camera);
assert.equal(alpha(1), 127 / 255, 'forced scale 2 must NOT halve distance fade endpoints');
assert.equal(alpha(0), 0);
// Rewinding camera, swapping the active camera, and replaying produce identical
// byte alphas; no cumulative opacity/time integration survives a rewind.
atDistance(0, 0); updateDisplay(camera);
assert.equal(alpha(0), 1); assert.equal(pairs[0].original.transparent, false); assert.equal(pairs[0].original.depthWrite, true);
atDistance(0, Math.sqrt(25000)); const recordedCamera = camera.clone();
atDistance(0, 250); updateDisplay(camera); updateDisplay(recordedCamera);
assert.equal(alpha(0), 127 / 255);
for (const pvs of [false, true, false, true]) {
  for (const index of [2, 8, 9]) displayLoaded[index].root.visible = pvs;
  updateDisplay(recordedCamera);
  for (const index of [2, 8, 9]) {
    assert.equal(displayLoaded[index].root.visible, pvs);
    assert.equal(effectiveVisible(displayLoaded[index].meshes[0]), false, 'authored hidden survives PVS re-entry');
  }
}
assert.equal(pairs[2].m.castShadow, false); assert.equal(pairs[2].m.receiveShadow, false);
assert.equal(pairs[0].m.castShadow, true); assert.equal(pairs[0].m.receiveShadow, true);
for (const [distance, expected] of [[600, 1], [800, 143 / 255], [1000, 0]]) {
  atDistance(3, distance, true); updateDisplay(camera); near([alpha(3)], [expected], 1e-10);
}
atDistance(11, 100); updateDisplay(camera); assert.equal(alpha(11), 0, 'static equal endpoint culls at max');
atDistance(12, 100, true); updateDisplay(camera); assert.equal(alpha(12), 1, 'entity equal endpoint keeps the inclusive min');
atDistance(13, 800, true); updateDisplay(camera); assert.equal(alpha(13), 143 / 255, 'entity swaps reversed endpoints');
atDistance(0, 75); updateDisplay(camera, { distanceScale: 2 }); assert.equal(alpha(0), 148 / 255);
// No FLAG_FADES => retained positive distances alone do not enable static fade.
atDistance(4, 10000); updateDisplay(camera); assert.equal(alpha(4), 1);
// Actual pixel projection, including Source's legacy width=2*diameter, and
// forced-scale semantics. Restore the owning document to an identity map frame.
mergedMap.remove(displayParsed.scene); displayParsed.scene.updateMatrixWorld(true);
const radius = Math.hypot(44, 8) * .0254 / 2, viewportHeight = 1000;
const target = displayLoaded[4].root.getWorldPosition(new THREE.Vector3());
function projectedWidth(width) {
  camera.position.copy(target).add(new THREE.Vector3(0, 0, 2 * radius * viewportHeight / width));
  camera.up.set(0, 1, 0); camera.lookAt(target); camera.updateMatrixWorld(true);
}
projectedWidth(60);
updateDisplay(camera, { viewportHeight, levelScreenFade: [20, 40] });
assert.equal(alpha(4), 127 / 255, 'width 60 / forced scale 2 = 30 in a 20..40 policy');
assert.equal(alpha(5), 1, 'forced scale zero disables only forced screen fading');
assert.equal(alpha(7), 1, 'unscaled width 60 exceeds the policy');
assert.equal(alpha(10), 1, 'MDL NO_FORCED_FADE overrides a positive static forced scale');
updateDisplay(camera, { viewportHeight, viewScreenFade: [30, 50] });
assert.equal(alpha(4), 0, 'exact minimum screen width is fully hidden');
updateDisplay(camera, { viewportHeight, levelScreenFade: [20, 40], viewScreenFade: [30, 50] });
assert.equal(alpha(4), 0, 'level/view/distance fades compose by minimum, not multiplication');
projectedWidth(30); updateDisplay(camera, { viewportHeight });
assert.equal(alpha(6), 127 / 255, 'SCREEN_SPACE_FADE fields are pixels, not Source distances');
projectedWidth(20); updateDisplay(camera, { viewportHeight }); assert.equal(alpha(6), 0);
projectedWidth(40); updateDisplay(camera, { viewportHeight }); assert.equal(alpha(6), 1);
assert.throws(() => display.update(camera));
// Real Scene staging/commit and SourceProps consumers, without constructing a
// WebGL renderer. CPU-only: camera/lighting setup and the scene display toggles
// (applyDisplay: map/decal visibility, texture/wireframe material modes) are
// excluded, so nothing here is display or raster proof.
let drawHeight=1000,policyId=0;
const sceneState=Object.assign(Object.create(SceneView.prototype),{
  scene:new THREE.Scene(),camera,terrainGeneration:0,terrainVisual:null,
  sourceMaterials:new SourceMaterials(),sourceAmbient:new SourceAmbient(),sourceColor:new SourceColor(),
  sourceExposure:{value:1},sourcePropViewport:new THREE.Vector4(),
  sourcePropView:{distanceScale:1,viewScreenFade:[0,-1]},
  renderer:{getCurrentViewport:target=>target.set(0,0,1000,drawHeight)},
  configureCamera(){},setSourceLighting(){},applyDisplay(){},patchDynamicLighting(){},
});
const policyVisual=displayGlb.finish();
function policySource(policy,{broken=false}={}){
  const id=`policy-${++policyId}`,manifest={visual:'visual.glb'};
  if(policy!==undefined)manifest.source_prop_view=policy;
  return new MapSource(id,{id,fingerprint:policyId.toString(16).padStart(64,'0'),name:id,game:'Fixture',
    files:new Map([['manifest.json',new Blob([JSON.stringify(manifest)],{type:'application/json'})],
      ['visual.glb',broken?new Blob(['not a GLB']):policyVisual]])});
}
function stagedAlpha(){
  let mesh;
  sceneState.terrainVisual.traverse(o=>{if(o.userData.sourcePlacement?.index===displayPlacements[4].index)o.traverse(m=>{if(m instanceof THREE.Mesh)mesh??=m;});});
  assert(mesh,'the actual imported prop reaches the installed scene');
  const material=Array.isArray(mesh.material)?mesh.material[0]:mesh.material;
  const shader={uniforms:{},vertexShader:THREE.ShaderLib.standard.vertexShader,fragmentShader:THREE.ShaderLib.standard.fragmentShader};
  material.onBeforeCompile(shader,null);
  sceneState.updateSourceProps(camera);
  // A display without a forced policy keeps the loader's shared material: constant alpha.
  return shader.uniforms.sourcePropAlpha?.value ?? 1;
}
projectedWidth(60);
const initialStage=await sceneState.stageTerrainVisual(policySource({levelScreenFade:[20,40]}));
assert.equal(sceneState.sourcePropView.levelScreenFade,undefined,'preparation cannot install map policy');
initialStage.commit();assert.equal(stagedAlpha(),127/255);
drawHeight=500;assert.equal(stagedAlpha(),0,'actual per-draw viewport changes the installed level fade');
drawHeight=1000;assert.equal(stagedAlpha(),127/255);
const cancelledStage=await sceneState.stageTerrainVisual(policySource({levelScreenFade:[60,80]}));
assert.equal(stagedAlpha(),127/255);cancelledStage.dispose();cancelledStage.commit();
assert.equal(stagedAlpha(),127/255,'disposed candidate cannot replace the current policy');
for(const policy of [null,[],{levelScreenFade:null},{levelScreenFade:[20]},{levelScreenFade:['20',40]},{levelScreenFade:[20,null]}]){
  await assert.rejects(sceneState.stageTerrainVisual(policySource(policy)));
  assert.equal(stagedAlpha(),127/255,'invalid provided policy fails before the current map is touched');
}
await assert.rejects(sceneState.stageTerrainVisual(policySource({levelScreenFade:[60,80]},{broken:true})));
assert.equal(stagedAlpha(),127/255,'failed visual preparation leaves current policy intact');
const staleStage=await sceneState.stageTerrainVisual(policySource({levelScreenFade:[60,80]}));
const missingStage=await sceneState.stageTerrainVisual(policySource(undefined));
staleStage.commit();assert.equal(stagedAlpha(),127/255,'stale candidate cannot install policy');
missingStage.commit();assert.equal(stagedAlpha(),1,'next map without policy clears the previous level fade');
assert.equal(sceneState.sourcePropView.distanceScale,1);
assert.deepEqual(sceneState.sourcePropView.viewScreenFade,[0,-1],'viewer policy is not map state');
for(const [range,expected] of [[[0,-1],1],[[-20,-40],1],[[40,20],0]]){
  (await sceneState.stageTerrainVisual(policySource({levelScreenFade:range}))).commit();
  assert.deepEqual(sceneState.sourcePropView.levelScreenFade,range,'finite authored zero/negative/reversed endpoints are retained');
  assert.equal(stagedAlpha(),expected,'retained endpoints reach the existing screen-fade consumer unchanged');
}
const cancelledClear=await sceneState.stageTerrainVisual(null);cancelledClear.dispose();cancelledClear.commit();
assert.deepEqual(sceneState.sourcePropView.levelScreenFade,[40,20],'cancelled clear cannot change the installed policy');
(await sceneState.stageTerrainVisual(null)).commit();
assert.equal(sceneState.sourcePropView.levelScreenFade,undefined);
(await sceneState.stageTerrainVisual(policySource({levelScreenFade:[20,40]}))).commit();
sceneState.sourceMaterials.dispose();assert.equal(sceneState.sourcePropView.levelScreenFade,undefined,'active resource disposal resets only map policy');
sceneState.sourceColor.dispose();
// Sky clones retain baseline/shadow ownership and get the current view alpha.
const skyClone = pairs[0].m.clone(); display.linkClone(pairs[0].m, skyClone);
atDistance(0, 250); updateDisplay(camera, { viewportHeight }); assert.equal(skyClone.visible, false);
atDistance(0, 0); updateDisplay(camera, { viewportHeight }); assert.equal(skyClone.visible, true);
// Lifetime: private clones only are disposed once; geometry/textures/borrowed
// originals remain alive, and old map instances regain their pre-bind state.
let privateDisposed = 0, borrowedDisposed = 0;
const privateMaterials = new Set(pairs.filter((p, i) => p.original !== pbrBefore[i]).map(p => p.original));
for (const material of privateMaterials) material.addEventListener('dispose', () => privateDisposed++);
for (const material of new Set(pbrBefore)) material.addEventListener('dispose', () => borrowedDisposed++);
pairs[1].m.material = pairs[1].source; // release while Source look, not only PBR, is active.
display.dispose(); display.dispose();
assert.equal(privateDisposed, privateMaterials.size); assert.equal(borrowedDisposed, 0);
assert.equal(pairs[2].m.visible, true); assert.equal(pairs[2].m.castShadow, false); assert.equal(pairs[2].m.receiveShadow, false);
for (let i = 0; i < pairs.length; i++) assert.strictEqual(pairs[i].m.material, pbrBefore[i]);
displayContext.dispose();
// Allocation contract: without a forced screen-fade policy, forced-only and
// permanently hidden placements keep the loader's shared material; distance
// fades stay private, and enabling a forced policy later is refused, not ignored.
const unforcedParsed = await consume(displayGlb);
const unforcedLoaded = await Promise.all(displayEmission.placements.map(p => loadedPlacement(unforcedParsed, p)));
const unforcedBefore = unforcedLoaded.map(p => p.meshes[0].material);
const unforced = new SourcePropDisplay([unforcedParsed.scene], { forcedScreenFade: false });
assert.notStrictEqual(unforcedLoaded[0].meshes[0].material, unforcedBefore[0]);
for (const index of [2, 4, 7, 8, 9]) assert.strictEqual(unforcedLoaded[index].meshes[0].material, unforcedBefore[index]);
unforced.update(camera, { viewportHeight });
assert.throws(() => unforced.update(camera, { viewportHeight, levelScreenFade: [20, 40] }), RangeError);
unforced.dispose();
for (let i = 0; i < unforcedLoaded.length; i++) assert.strictEqual(unforcedLoaded[i].meshes[0].material, unforcedBefore[i]);
// Legacy maps without sourcePlacement are entirely outside this owner.
const legacy = new THREE.Group(), legacyMaterial = new THREE.MeshStandardMaterial({ opacity: .4, transparent: true });
const legacyMesh = new THREE.Mesh(new THREE.BufferGeometry(), legacyMaterial); legacyMesh.visible = false;
legacy.add(legacyMesh); const legacyDisplay = new SourcePropDisplay([legacy], { forcedScreenFade: true });
legacyDisplay.bindMaterial(legacyMesh, legacyMaterial); legacyDisplay.update(camera); legacyDisplay.dispose();
assert.equal(legacyMesh.visible, false); assert.equal(legacyMesh.castShadow, false); assert.strictEqual(legacyMesh.material, legacyMaterial);
assert.equal(legacyMaterial.opacity, .4);
// Otherwise-valid generated files must not receive a local identity after the
// real BSP reader and prop writer encounter visible entities they cannot emit.
const entityBoundaryFiles = new Map([
  ['manifest.json', new Blob([JSON.stringify({ files: ['map.xml'], visual: 'visual.glb' })])],
  ['map.xml', new Blob(['<mujoco><worldbody><geom type="plane" size="10 10 .1"/></worldbody></mujoco>'])],
  ['visual.glb', glb.finish()],
]);
const entityBoundaryControl = await finalizeSourceAssembly(
  { files: entityBoundaryFiles, requirements: [] }, 'Entity boundary', 'Source fixture');
const entityFilesystem = await SourceFileSystem.create([{ kind: 'loose', files: [] }]);
for (const [classname, code] of [
  ['env_sprite', 'sprite-entity-runtime'],
  ['env_lightglow', 'sprite-entity-runtime'],
  ['move_rope', 'rope-entity-runtime'],
  ['keyframe_rope', 'rope-entity-runtime'],
]) {
  const entities = Buffer.from(`{"classname" "worldspawn"}
    {"classname" "${classname}" "origin" "0 0 0" "model" "sprites/glow01.vmt"}\0`);
  const header = Buffer.alloc(1036);
  header.write('VBSP'); header.writeInt32LE(20, 4);
  header.writeUInt32LE(header.length, 8); header.writeUInt32LE(entities.length, 12);
  const entityWorld = { frame, bsp: await readSourceBsp(new Blob([header, entities]), { variant: 'standard' }) };
  const entityProps = await readSourceProps(entityWorld, entityFilesystem);
  const entityGlb = new SourceGlb();
  const entityEmission = await appendSourceProps(entityGlb,
    new SourceMaterialExport(entityGlb, entityFilesystem), entityProps, entityWorld,
    { ...limits, lightingForPlacement: () => undefined });
  await assert.rejects(finalizeSourceAssembly(
    { files: entityBoundaryControl.files, requirements: entityEmission.requirements },
    'Entity boundary', 'Source fixture'),
  failure => failure.requirements?.some(item => item.code === code && item.blocking));
}
console.log('Native prop display CPU consumer: authored hidden/PVS, isolated Source/PBR fade uniforms, squared-distance byte boundaries, forced screen policies, transformed camera rewind, shadow flags and lifetime. No projector/GPU qualification.');
console.log('GLTFLoader: bind/posed vertices, opposing bones, shared geometry, body/skin/LOD, independent placements/material/cache/frame/PVS ownership; explicit fidelity blockers. No temporal channels sampled.');

