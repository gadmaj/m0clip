import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

import { build } from 'esbuild';
const built = await build({ stdin: { contents: `export * from './src/maps/raw-source-bsp'; export * from './src/maps/raw-source-visibility'; export * from './src/render/source-sky3d'; export * from './src/render/source-visibility'; export * as THREE from 'three';`, resolveDir: process.cwd() }, bundle: true, platform: 'node', format: 'cjs', write: false });
const module = { exports: {} };
new Function('module', 'exports', 'require', built.outputFiles[0].text)(module, module.exports, createRequire(import.meta.url));
const { readSourceBsp, decodeSourceWorld, readSourceVisibility, SourcePVS, SourceVisibility, SourceSky3D, THREE } = module.exports;
function fixture({ leafVersion = 1, pvs = true, sky = true } = {}) {
  const entries = new Map(), put = (id, length, version = 0) => { const bytes = Buffer.alloc(length); entries.set(id, { bytes, version }); return bytes; };
  const entity = Buffer.from(`{"classname" "worldspawn"}${sky ? '{"classname" "sky_camera" "origin" "200 0 0" "scale" "16"}' : ''}\0`);
  entries.set(0, { bytes: entity, version: 0 });
  const planes = put(1, 40); planes.writeFloatLE(1, 0); planes.writeFloatLE(1, 20); planes.writeFloatLE(100, 32);
  const nodes = put(5, 64); nodes.writeInt32LE(1, 4); nodes.writeInt32LE(-2, 8); nodes.writeInt32LE(1, 32); nodes.writeInt32LE(-3, 36); nodes.writeInt32LE(-1, 40);
  const faces = put(7, 4 * 56, 1); for (let i = 0; i < 4; i++) faces.writeInt16LE(i === 3 ? 0 : -1, i * 56 + 12);
  const stride = leafVersion === 0 ? 56 : 32, leaves = put(10, stride * 3, leafVersion);
  for (let i = 0; i < 3; i++) { leaves.writeUInt16LE(i, i * stride + 4); leaves.writeUInt16LE(i, i * stride + 20); leaves.writeUInt16LE(1, i * stride + 22); }
  const models = put(14, 48); models.writeInt32LE(4, 44);
  const leafFaces = put(16, 6); for (let i = 0; i < 3; i++) leafFaces.writeUInt16LE(i, i * 2);
  if (pvs) { const vis = put(4, 31); vis.writeUInt32LE(3); for (let i = 0; i < 6; i++) vis.writeUInt32LE(28 + Math.floor(i / 2), 4 + i * 4); vis.set([1,2,4], 28); }
  put(26,176).writeInt32LE(2,20); put(33,25*20);
  const basePositions=Float64Array.from({length:75},(_,index)=>{
    const vertex=Math.floor(index/3),axis=index%3;
    return axis===0?-1+(vertex%5)*.5:axis===1?Math.floor(vertex/5)*.25:0;
  });
  const frame = { origin: [10,20,30], yaw: 90, metresPerUnit: .0254, up: 'Z' };
  const blob = () => {
    const header = Buffer.alloc(1036), bodies = []; header.write('VBSP'); header.writeInt32LE(20, 4); let offset = 1036;
    for (const [id, { bytes, version }] of entries) { const p = 8 + id * 16; header.writeUInt32LE(offset, p); header.writeUInt32LE(bytes.length, p + 4); header.writeUInt32LE(version, p + 8); bodies.push(bytes); offset += bytes.length; }
    return new Blob([header, ...bodies]);
  };
  const world = async () => ({ bsp: await readSourceBsp(blob()), frame, surfaces: [{ face: 3, displacement: 0, sourcePositions: basePositions.slice(), basePositions }] });
  return { entries, put, blob, world, frame };
}
const toWorld = (source, data) => new THREE.Vector3(...source).sub(new THREE.Vector3(...data.spawn)).multiplyScalar(.0254).applyAxisAngle(new THREE.Vector3(0,0,1), -data.yaw * Math.PI / 180);
for (const leafVersion of [0,1]) {
  const f = fixture({ leafVersion }), result = await readSourceVisibility(await f.world()), { data } = result;
  assert.deepEqual(result.requirements, []);
  assert.deepEqual(data.faceClusters, [[0],[1],[2],[0,1]]);
  assert.deepEqual(data.leafClusters, [0,1,2]);
  assert.deepEqual(Buffer.from(data.visibility, 'base64'), f.entries.get(4).bytes);
  const pvs = new SourcePVS(data);
  for (const [source, cluster] of [[[1,0,0],0],[[-1,0,0],1],[[200,0,0],2]]) {
    assert.equal(pvs.cluster(toWorld(source,data)), cluster);
    assert(pvs.visible(pvs.row(cluster), [cluster]));
    assert(!pvs.visible(pvs.row(cluster), [(cluster+1)%3]));
  }
  // Genuine runtime geometry filtering and restoration, including static props
  // and overlays using face identities rather than a duplicate fixture filter.
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array(36),3));
  geometry.setIndex(Array.from({length:12},(_,i)=>i)); geometry.userData.sourceFaceRanges = [[0,0,3],[1,3,3],[2,6,3],[3,9,3]];
  const mesh = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial()), root = new THREE.Group(); root.add(mesh);
  const prop = new THREE.Object3D(); prop.userData.sourceStaticIndex = 0; prop.userData.sourceVisibilityClusters = [1]; root.add(prop);
  const overlay = new THREE.Object3D(); overlay.userData.sourceOverlay = true; overlay.userData.sourceVisibilityFaces = [2]; root.add(overlay);
  const camera = new THREE.PerspectiveCamera(70,1,.1,100), visibility = new SourceVisibility(data,root);
  camera.position.copy(toWorld([1,0,0],data)); camera.updateMatrixWorld();
  visibility.draw(camera,()=>{ assert.deepEqual([...mesh.geometry.index.array.subarray(0,6)],[0,1,2,9,10,11]); assert.equal(mesh.geometry.drawRange.count,6); assert.equal(prop.visible,false); assert.equal(overlay.visible,false); });
  assert.equal(mesh.geometry,geometry); assert.equal(prop.visible,true); assert.equal(overlay.visible,true);
  const sky = new SourceSky3D(data,root,()=>{}); sky.prepare(camera,true);
  assert.equal(sky.stats.cluster,2); assert.equal(sky.stats.faces,1);
  assert(sky.camera.position.distanceTo(toWorld([200+1/16,0,0],data)) < 1e-12);
  assert.equal(sky.scene.children.find(object=>object instanceof THREE.Mesh).geometry.drawRange.count,3);
  f.entries.get(10).bytes.writeUInt16LE(65535,(leafVersion===0?56:32)*2+4);
  const invalidData=(await readSourceVisibility(await f.world())).data;
  const outsideSky=new SourceSky3D(invalidData,root,()=>{}); outsideSky.prepare(camera,true);
  assert.equal(outsideSky.stats.cluster,65535); assert.equal(outsideSky.stats.faces,0,'Separate sky view does not use the main-view invalid-leaf fallback');
  const outsideMain=new SourceVisibility(invalidData,root);
  camera.position.copy(toWorld([200,0,0],invalidData)); camera.updateMatrixWorld();
  outsideMain.draw(camera,()=>assert.equal(mesh.geometry.drawRange.count,9,'Native main view fallback includes only faces with valid cluster memberships'));
  outsideMain.dispose(); outsideSky.dispose();
  sky.dispose(); visibility.dispose(); geometry.dispose(); mesh.material.dispose();
}
{
  // Native float32 .1 * 10 rounds to exactly 1 before addition to the double
  // base grid. A JS double product is above 1 and wrongly misses the back leaf.
  const f=fixture({sky:false}); f.entries.get(1).bytes.writeFloatLE(1,12);
  const dv=f.entries.get(33).bytes, direction=Math.fround(.1), distance=10;
  for(let vertex=0;vertex<25;vertex++){dv.writeFloatLE(direction,vertex*20);dv.writeFloatLE(distance,vertex*20+12);}
  const world=await f.world(), surface=world.surfaces[0], original=direction*distance;
  for(let vertex=0;vertex<25;vertex++){
    surface.basePositions.set([0,(vertex%5)*.25,Math.floor(vertex/5)*.25],vertex*3);
    surface.sourcePositions.set([original,(vertex%5)*.25,Math.floor(vertex/5)*.25],vertex*3);
  }
  assert(original>1);
  const {data}=await readSourceVisibility(world),pvs=new SourcePVS(data);
  assert.deepEqual(data.faceClusters[3],[0,1],'Native f32 product touches both sides of the exact partition, without bbox inflation');
  assert(pvs.visible(pvs.row(1),data.faceClusters[3]));
  assert.equal(surface.sourcePositions[0],original,'Visibility does not rewrite source geometry to match its exporter arithmetic');
  assert.deepEqual(Buffer.from(await world.bsp.getLump(33)),dv,'Original native vector/distance records stay exact');
}
for (const mutate of [
  f=>f.entries.get(5).bytes.writeInt32LE(0,4),
  f=>f.entries.get(5).bytes.writeInt32LE(99,36),
  f=>f.entries.get(5).bytes.writeInt32LE(99),
  f=>f.entries.get(14).bytes.writeInt32LE(-99,36),
  f=>f.entries.get(10).version=2,
  f=>f.entries.get(10).bytes.writeUInt16LE(9,22),
  f=>f.entries.get(16).bytes.writeUInt16LE(99),
  f=>f.entries.get(10).bytes.writeUInt16LE(99,4),
  f=>f.entries.get(4).bytes.writeUInt32LE(4,4),
  f=>f.entries.get(4).bytes.writeUInt32LE(999,8),
  f=>f.entries.get(26).bytes.writeInt32LE(31,20),
  f=>f.entries.get(26).bytes.writeInt32LE(999,12),
  f=>f.entries.get(33).bytes.writeFloatLE(Infinity,0),
  f=>f.entries.get(4).bytes.set([0,0],28),
  f=>f.entries.get(4).bytes.set([0,2],28),
  f=>{f.entries.get(4).bytes[30]=0;},
]) { const f=fixture(); mutate(f); await assert.rejects(async()=>readSourceVisibility(await f.world())); }
{
  const f=fixture(), b=f.entries.get(4).bytes;
  for(let i=0;i<6;i++)b.writeUInt32LE(28,4+i*4);
  const {data}=await readSourceVisibility(await f.world());
  assert.deepEqual(Buffer.from(data.visibility,'base64'),b,'Aliased native row offsets remain exact and safe');
  assert.deepEqual([...new SourcePVS(data).row(2)],[1]);
  b.writeUInt32LE(0,4);
  assert.deepEqual([...new SourcePVS((await readSourceVisibility(await f.world())).data).row(0)],[255],'Genuine zero-offset row retains native all-clusters meaning');
}
for(const sky of [false,true]) {
  const {data,requirements}=await readSourceVisibility(await fixture({pvs:false,sky}).world());
  assert.equal(data,null);
  assert.deepEqual(requirements.map(r=>r.code),sky?['sky-without-pvs']:[]);
}
// Valve's nonempty zero-cluster header has no PVS rows. Non-sentinel native
// leaf identities remain useful to ambient lighting, but are not row indices.
for(const sky of [false,true])for(const sentinelLeaves of [false,true]) {
  const f=fixture({sky}); f.put(4,4);
  if(sentinelLeaves)for(let i=0;i<3;i++)f.entries.get(10).bytes.writeUInt16LE(65535,i*32+4);
  const world=await f.world(), result=await readSourceVisibility(world);
  assert.equal(result.data,null,`Zero-cluster PVS is absent (sky=${sky}, sentinel=${sentinelLeaves})`);
  assert.deepEqual(result.requirements.map(requirement=>requirement.code),sky?['sky-without-pvs']:[]);
  assert.deepEqual(result.tree.leafClusters,sentinelLeaves?[65535,65535,65535]:[0,1,2]);
  assert.equal(result.tree.head,0); assert.equal(result.tree.nodes.length,2);
  assert.deepEqual(Buffer.from(await world.bsp.getLump(4)),Buffer.alloc(4),'Original native zero-cluster header stays owned and unchanged');
  assert.deepEqual(Buffer.from(await world.bsp.lumps[4].raw.arrayBuffer()),Buffer.alloc(4));
}
for(const option of ['maxRecords','maxMemberships','maxWork','maxInputBytes','maxOutputBytes','maxDecodedBytes']) {
  await assert.rejects(async()=>readSourceVisibility(await fixture().world(),{[option]:1}));
}
{
  const f=fixture(), bytes=f.put(4,79); bytes.writeUInt32LE(9);
  for(let i=0;i<18;i++)bytes.writeUInt32LE(76,4+i*4);
  bytes.set([0,1,1],76);
  const data=(await readSourceVisibility(await f.world())).data,pvs=new SourcePVS(data);
  assert.deepEqual([...pvs.row(8)],[0,1],'Native RLE zero run followed by a literal spans both output bytes');
  assert(pvs.visible(pvs.row(8),[8])); assert(!pvs.visible(pvs.row(8),[0]));
}
{
  const f=fixture(), original=f.entries.get(5).bytes, nodes=f.put(5,96); original.copy(nodes);
  nodes.writeInt32LE(2,68); nodes.writeInt32LE(-1,72);
  await assert.rejects(async()=>readSourceVisibility(await f.world()),'Disconnected cycles must be rejected before runtime traversal');
}
{
  const world=await fixture().world(), abort=new AbortController(); abort.abort();
  await assert.rejects(readSourceVisibility(world,{signal:abort.signal}),{name:'AbortError'});
  const during=new AbortController(), pending=readSourceVisibility(world,{signal:during.signal}); setTimeout(()=>during.abort(),0);
  await assert.rejects(pending,{name:'AbortError'});
}

