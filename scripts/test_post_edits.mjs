/** Real recorded tracks survive non-destructive edits, zip persistence and punctual-light export. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { build } from 'esbuild';
import { mkdir, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { unzipSync, zipSync } from 'fflate';
import * as THREE from 'three';
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js';

const file = resolve('node_modules/.cache/post-edits-test.mjs');
await mkdir(resolve('node_modules/.cache'), { recursive: true });
try {
  await build({ stdin: { contents: "export * from './src/core/geometry';export * from './src/record/take';export * from './src/record/post';export {ShotPath} from './src/record/shot';export {shotLightObjects} from './src/render/shot-lights';", resolveDir: process.cwd() }, bundle: true, packages: 'external', platform: 'node', format: 'esm', outfile: file });
  const { GeometryTrack, denseGeometryPartition, Take, TakeRecorder, saveTake, loadTake, motionCsv, validTakeRange, ShotPath, validLook, validShotLight, validShotLights, validShotEdits, MAX_SHOT_LIGHTS, shotLightObjects } = await import(file);
  const lighting = { sunAzimuth: 27, sunElevation: 61, sunIntensity: 1.5, sunColor: 0xffffff, ambient: .8, skyColor: 0xdfeaf5, groundColor: 0x1a2028, fill: .7, reflections: .55, exposure: 1, shadows: false, background: 0x0b0e12 };
  const meta = { robot: 'r1', terrain: 'flat', policy: 'recorded', created: new Date(0).toISOString(), ngeom: 1, nq: 8, baseQadr: 0, hinges: [{ name: 'elbow', qadr: 7 }], sourceHead: 'ghost', appearance: { colorway: 'product', parts: {}, sourceBody: 'stock' }, look: { preset: 'studio', custom: lighting, antialiasing: 'fxaa' } };
  const recorder = new TakeRecorder(structuredClone(meta), denseGeometryPartition());
  for (const clock of [10, 10.02, 10.04]) {
    const step = (clock - 10) * 25;
    recorder.push({ clock, xpos: new Float32Array([step, -step, 1 + step]), xmat: new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 1]), qpos: new Float64Array([step, -step, 1, 1, 0, 0, 0, step * .4]), hoistAnchor: [step, 0, 2] }, [step, .2, -.3], { pos: [2 + step, -3, 2], target: [step, 0, 1], fov: 53 });
  }
  recorder.mark('move', 'Forward');
  const take = recorder.finish();
  assert.ok(take);
  const trackNames = ['t', 'qpos', 'cmd', 'cam', 'hoist', 'camOrientation', 'geomValues', 'geomFixedIds'];
  const tracks = take => ({ ...take, geomValues: take.geom.values, geomFixedIds: take.geom.fixedIds });
  const originalTracks = Object.fromEntries(trackNames.map(name => [name, tracks(take)[name].slice()]));
  const trackHash = array => createHash('sha256').update(new Uint8Array(array.buffer, array.byteOffset, array.byteLength)).digest('hex');
  const originalHashes = Object.fromEntries(trackNames.map(name => [name, trackHash(tracks(take)[name])]));
  const originalEvents = structuredClone(take.events);
  const originalPose = new Float32Array(7), originalQpos = new Float64Array(8);
  take.geomPoseAt(.015, originalPose); take.qposAt(.015, originalQpos);
  const point = { id: 'key', name: 'Key point', kind: 'point', enabled: true, color: 0xffaa77, intensity: 73, position: [2, -3, 4], target: [0, 0, 1], range: 17, angle: 35, penumbra: .3 };
  const spot = { ...point, id: 'rim', name: 'Rim spot', kind: 'spot', intensity: 127, color: 0x4477ff, position: [-4, 2, 5], target: [1, -1, .7], range: 8, angle: 41, penumbra: .45 };
  const directional = { ...point, id: 'sun', name: 'Directional', kind: 'directional', intensity: 2.7, position: [7, 8, 9], target: [-2, 1, 3], range: 0 };
  const disabled = { ...point, id: 'off', name: 'Disabled', enabled: false };
  const edits = { version: 1, appearance: { colorway: 'model', sourceBody: 'dog', sourceBodyColorway: 'model', modules: { arms: 'prism' }, parts: { elbow: { color: 0x18a5ef, finish: 'metal', roughness: .24, metalness: .8, clearcoat: .3 }, torso: { finish: 'metal' }, head: { color: 0x33aaff }, wrist: { roughness: .71 } }, robotLight: { brightness: 31, color: 0xffcc88, range: 7, dull: false } }, sourceHead: 'stock', look: { preset: 'custom', custom: { ...lighting, sunIntensity: 3.2, exposure: 1.4 }, antialiasing: 'msaa4' }, lights: [point, spot, directional, disabled] };
  assert.ok(validShotEdits(edits, meta.robot));
  take.meta.edits = structuredClone(edits);
  const cameraRecipe={mode:'orbit',focal:85,sensor:24.89,distance:5.25,azimuth:73,elevation:21,height:0,orbitPeriod:-8.5,smooth:.65};
  take.shot=structuredClone(cameraRecipe);
  take.range = [.01, .03];
  const saved = new Uint8Array(await (await saveTake(take)).arrayBuffer());
  const reopened = await loadTake(saved.buffer);
  assert.deepEqual(reopened.meta, { ...meta, edits });
  assert.deepEqual(reopened.shot,cameraRecipe);
  assert.deepEqual(reopened.range, [.01, .03]);
  const [start, end] = reopened.range, csv = motionCsv(reopened, 100, start, end).trim().split('\n').map(row => row.split(',').map(Number));
  assert.equal(csv.length, 3);
  assert.ok(Math.abs(csv[0][0] - .25) < 1e-6, 'Trim sampling starts at the restored nonzero take offset');
  assert.ok(Math.abs(csv.at(-1)[0] - .75) < 1e-6, 'Trim sampling ends at the restored out point');
  const path = new ShotPath(reopened, reopened.shot, start), camera = path.at(start), relative = camera.pos.clone().sub(camera.target);
  assert.ok(Math.abs(Math.atan2(relative.y, relative.x) * 180 / Math.PI - cameraRecipe.azimuth) < 1e-8, 'Orbit starts at its authored azimuth at the restored in point');
  const fixed = new ShotPath(reopened, { ...reopened.shot, mode: 'fixed', smooth: 0 }, start);
  assert.ok(Math.abs(fixed.at(end).target.x - .25) < 1e-6, 'Fixed camera centers on the trimmed starting pose, not frame zero');
  reopened.range[0] = .015;
  assert.deepEqual(take.range, [.01, .03], 'Reopened trim bounds are independently owned');
  reopened.shot.focal=135;
  assert.equal(take.shot.focal,85,'Reopened camera settings are independently owned');
  for (const name of trackNames) {
    assert.deepEqual(tracks(take)[name], originalTracks[name], `Editing leaves live ${name} unchanged`);
    assert.deepEqual(tracks(reopened)[name], originalTracks[name], `Persisted ${name} is unchanged`);
    assert.equal(trackHash(tracks(reopened)[name]), originalHashes[name], `All bytes of ${name} survive range/camera/paint roundtrip`);
  }
  assert.deepEqual(take.events, originalEvents); assert.deepEqual(reopened.events, originalEvents);
  const reopenedPose = new Float32Array(7), reopenedQpos = new Float64Array(8);
  reopened.geomPoseAt(.015, reopenedPose); reopened.qposAt(.015, reopenedQpos);
  assert.deepEqual(reopenedPose, originalPose); assert.deepEqual(reopenedQpos, originalQpos);
  reopened.meta.edits.appearance.parts.elbow.color = 0x112233;
  assert.equal(take.meta.edits.appearance.parts.elbow.color, edits.appearance.parts.elbow.color, 'Reopened edit data is independently owned');
  assert.deepEqual(take.meta.appearance, meta.appearance); assert.deepEqual(take.meta.look, meta.look);

  const files = unzipSync(saved), header = JSON.parse(new TextDecoder().decode(files['take.json']));
  assert.deepEqual(JSON.parse(new TextDecoder().decode(files['range.json'])), [.01, .03]);
  assert.deepEqual(JSON.parse(new TextDecoder().decode(files['shot.json'])), cameraRecipe, 'Camera recipe remains separate and unchanged');
  assert.equal(Object.hasOwn(header, 'range'), false, 'Original take header has no duplicate range');
  for (const range of [[0, take.duration], [.01, .03], [0, Number.MIN_VALUE], [take.duration - 1e-9, take.duration]]) {
    assert.equal(validTakeRange(range, take.duration), true);
    const bounded = new Take(take.meta, take.t, take.geom, take.qpos, take.cmd, take.cam, take.hoist, take.events, take.camOrientation);
    bounded.range = range;
    assert.deepEqual((await loadTake(await (await saveTake(bounded)).arrayBuffer())).range, range);
  }
  for (const range of [null, {}, [], [0], [0, .01, .02], [0, 0], [.02, .01], [-.001, .01], [0, take.duration + 1e-9], [NaN, .02], [0, Infinity], ['0', .02], new Array(2)]) {
    assert.equal(validTakeRange(range, take.duration), false);
    const invalid = new Take(take.meta, take.t, take.geom, take.qpos, take.cmd, take.cam, take.hoist, take.events, take.camOrientation);
    invalid.range = range;
    await assert.rejects(saveTake(invalid), /take file: invalid shot range/);
    const zip = zipSync({ ...files, 'range.json': new TextEncoder().encode(JSON.stringify(range)) });
    await assert.rejects(loadTake(zip.buffer), /take file: invalid shot range/);
  }
  for (const raw of ['', '{', 'undefined']) {
    const zip = zipSync({ ...files, 'range.json': new TextEncoder().encode(raw) });
    await assert.rejects(loadTake(zip.buffer), /take file: invalid shot range/);
  }
  assert.equal(validTakeRange([0, .01], 0), false);
  assert.equal(validTakeRange([0, .01], NaN), false);
  const zero = new Take(meta, new Float64Array([0]), GeometryTrack.dense(1, 1, take.geom.values.slice(0, 7)), take.qpos.slice(0, 8), take.cmd.slice(0, 3), take.cam.slice(0, 7), take.hoist.slice(0, 3), []);
  assert.equal((await loadTake(await (await saveTake(zero)).arrayBuffer())).duration, 0, 'Untrimmed zero-duration legacy data is not newly rejected');
  const malformedEdits = [null, { ...edits, version: 2 }, { ...edits, version: '1' }, { ...edits, head: 'ghost' }, { ...edits, sourceHead: 'unknown' }, { ...edits, appearance: { ...edits.appearance, sourceBody: 'invented' } }, { ...edits, appearance: { ...edits.appearance, parts: { elbow: { color: -1, finish: 'metal' } } } }, { ...edits, look: { ...edits.look, antialiasing: 'taa' } }, { ...edits, look: { ...edits.look, custom: { ...lighting, exposure: NaN } } }];
  for(const paint of [{},{color:undefined},{finish:'chrome'},{metalness:1.01},{roughness:-.01},{clearcoat:NaN},{color:0.5},{unknown:1}])
    malformedEdits.push({...edits,appearance:{...edits.appearance,parts:{torso:paint}}});
  for (const update of [{ id: '' }, { name: ' ' }, { name: 'x'.repeat(121) }, { kind: 'ambient' }, { enabled: 1 }, { color: .5 }, { color: 0x1000000 }, { intensity: 0 }, { intensity: Infinity }, { intensity: 100001 }, { position: [0, NaN, 1] }, { target: [1, 2] }, { range: -1 }, { range: 10001 }, { angle: .5 }, { angle: 90 }, { penumbra: 1.01 }, { shadows: true }]) {
    const bad = { ...point, ...update };
    assert.equal(validShotLight(bad), false);
    malformedEdits.push({ ...edits, lights: [bad] });
  }
  for (const kind of ['spot', 'directional']) malformedEdits.push({ ...edits, lights: [{ ...point, kind, target: point.position }] });
  malformedEdits.push({ ...edits, lights: [point, { ...spot, id: point.id }] }, { ...edits, lights: [point, { ...spot, name: point.name }] }, { ...edits, lights: Array.from({ length: MAX_SHOT_LIGHTS + 1 }, (_, i) => ({ ...point, id: `id${i}`, name: `name${i}` })) });
  for (const bad of malformedEdits) {
    assert.equal(validShotEdits(bad, meta.robot), false);
    const invalid = new Take({ ...take.meta, edits: bad }, take.t, take.geom, take.qpos, take.cmd, take.cam, take.hoist, take.events, take.camOrientation);
    await assert.rejects(saveTake(invalid), /invalid shot edits/);
    const zip = zipSync({ ...files, 'take.json': new TextEncoder().encode(JSON.stringify({ ...header, meta: { ...header.meta, edits: bad } })) });
    await assert.rejects(loadTake(zip.buffer), /invalid shot edits/);
  }
  assert.equal(validShotLight({ ...point, position: new Array(3) }), false);
  assert.equal(validShotLights(new Array(1)), false);
  assert.equal(validShotEdits(edits, 'g1'), false, 'Dog cannot replace another robot topology');
  assert.equal(validShotEdits({ version: 1, sourceHead: 'ghost' }, 'go2'), false);
  assert.ok(validShotEdits({ version: 1, appearance: { colorway: 'grey', parts: {}, sourceBody: 'stock' }, sourceHead: 'stock', lights: [] }, 'g1'));
  const quadruped={version:1,appearance:{colorway:'model',parts:{},sourceBody:'psx-dog'},sourceHead:'stock'};
  assert.equal(validShotEdits(quadruped,'go2'),true);
  assert.equal(validShotEdits(quadruped,'r1_air'),false,'A quadruped calibration cannot use humanoid recorded topology');
  assert.equal(validShotEdits(edits,'go2'),false,'The humanoid Half-Life 2 Dog remains distinct from the Go2 PSX Dog');
  for (const look of [null, { ...meta.look, preset: 'unknown' }, { ...meta.look, custom: { ...lighting, fill: null } }, { ...meta.look, custom: { ...lighting, shadows: 0 } }]) {
    assert.equal(validLook(look), false);
    await assert.rejects(saveTake(new Take({ ...meta, look }, take.t, take.geom, take.qpos, take.cmd, take.cam, take.hoist, [])), /invalid recorded look/);
    const zip = zipSync({ ...files, 'take.json': new TextEncoder().encode(JSON.stringify({ ...header, meta: { ...header.meta, look } })) });
    await assert.rejects(loadTake(zip.buffer), /invalid recorded look/);
  }
  for(const camera of [null,[],{...cameraRecipe,mode:'invalid'},{...cameraRecipe,focal:0},{...cameraRecipe,sensor:NaN},{...cameraRecipe,distance:-1},{...cameraRecipe,orbitPeriod:0},{...cameraRecipe,smooth:-.1},{...cameraRecipe,height:Infinity}]) {
    const invalid=new Take(take.meta,take.t,take.geom,take.qpos,take.cmd,take.cam,take.hoist,take.events,take.camOrientation);
    invalid.shot=camera;
    await assert.rejects(saveTake(invalid),/invalid shot camera/);
    const zip=zipSync({...files,'shot.json':new TextEncoder().encode(JSON.stringify(camera))});
    await assert.rejects(loadTake(zip.buffer),/invalid shot camera/);
  }
  const legacyMeta = structuredClone(header.meta); delete legacyMeta.look; delete legacyMeta.edits;
  const legacyFiles={...files};delete legacyFiles['shot.json'];delete legacyFiles['range.json'];
  const legacyZip = zipSync({ ...legacyFiles, 'take.json': new TextEncoder().encode(JSON.stringify({ ...header, meta: legacyMeta })) });
  const legacy = await loadTake(legacyZip.buffer);
  assert.deepEqual(legacy.meta, legacyMeta); assert.equal(legacy.meta.look, undefined); assert.equal(legacy.meta.edits, undefined);
  assert.equal(legacy.shot,undefined,'A legacy file does not invent a camera recipe');
  assert.equal(legacy.range, undefined, 'Legacy takes do not invent trim bounds');
  assert.equal(unzipSync(new Uint8Array(await (await saveTake(legacy)).arrayBuffer()))['range.json'], undefined);
  assert.deepEqual((await loadTake(await (await saveTake(legacy)).arrayBuffer())).meta, legacyMeta);
  for (const name of trackNames) assert.deepEqual(tracks(legacy)[name], originalTracks[name]);

  const lightsBefore = structuredClone(edits.lights), group = shotLightObjects(edits.lights);
  const scene = new THREE.Scene(), wrap = new THREE.Group();
  wrap.quaternion.setFromAxisAngle(new THREE.Vector3(1, 0, 0), -Math.PI / 2); wrap.add(group); scene.add(wrap); scene.updateMatrixWorld(true);
  const gltf = await new GLTFExporter().parseAsync(scene, { trs: true });
  assert.ok(gltf.extensionsUsed.includes('KHR_lights_punctual'));
  const definitions = gltf.extensions.KHR_lights_punctual.lights;
  assert.equal(definitions.length, 3, 'Disabled light omitted; three real punctual types exported');
  const matrices = new Map();
  function visit(index, parent) {
    const node = gltf.nodes[index], local = node.matrix ? new THREE.Matrix4().fromArray(node.matrix) : new THREE.Matrix4().compose(new THREE.Vector3(...(node.translation ?? [0, 0, 0])), new THREE.Quaternion(...(node.rotation ?? [0, 0, 0, 1])), new THREE.Vector3(...(node.scale ?? [1, 1, 1])));
    const world = parent.clone().multiply(local); matrices.set(index, world);
    for (const child of node.children ?? []) visit(child, world);
  }
  for (const root of gltf.scenes[gltf.scene ?? 0].nodes) visit(root, new THREE.Matrix4());
  for (const [index, node] of gltf.nodes.entries()) {
    const lightIndex = node.extensions?.KHR_lights_punctual?.light;
    if (lightIndex === undefined) continue;
    const definition = definitions[lightIndex], light = edits.lights.find(value => value.enabled && value.kind === definition.type);
    assert.ok(light); assert.equal(definition.intensity, light.intensity);
    const expectedColor = new THREE.Color(light.color).toArray();
    definition.color.forEach((value, channel) => assert.ok(Math.abs(value - expectedColor[channel]) < 1e-7));
    const expectedPosition = new THREE.Vector3(light.position[0], light.position[2], -light.position[1]);
    assert.ok(new THREE.Vector3().setFromMatrixPosition(matrices.get(index)).distanceTo(expectedPosition) < 1e-7, `${light.kind} position converted once`);
    if (light.kind !== 'point') {
      const aim = new THREE.Vector3().fromArray(light.target).sub(new THREE.Vector3().fromArray(light.position)).normalize();
      const expectedAim = new THREE.Vector3(aim.x, aim.z, -aim.y), exportedAim = new THREE.Vector3(0, 0, -1).transformDirection(matrices.get(index));
      assert.ok(exportedAim.distanceTo(expectedAim) < 1e-7, `${light.kind} aim survives real KHR export`);
    }
    if (light.kind !== 'directional') assert.equal(definition.range, light.range);
    if (light.kind === 'spot') {
      assert.ok(Math.abs(definition.spot.outerConeAngle - light.angle * Math.PI / 180) < 1e-12);
      assert.ok(Math.abs(definition.spot.innerConeAngle - light.angle * Math.PI / 180 * (1 - light.penumbra)) < 1e-12);
    }
  }
  assert.deepEqual(edits.lights, lightsBefore, 'Light export leaves saved metadata unchanged');
  console.log('PASS: nontrivial shot-edit roundtrip, original tracks/appearance/Look invariance, legacy takes, strict load/save rejection, actual KHR punctual-light data and once-converted positions/directions');
} finally { await rm(file, { force: true }); }
