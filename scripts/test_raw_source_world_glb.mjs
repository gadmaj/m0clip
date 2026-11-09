/** CPU fixtures for GLTFLoader/SourceVisibility/SourceSky3D/native materials.
 * Run: node scripts/test_raw_source_world_glb.mjs
 * No network, graphics, installations or raw-map qualification. */
import assert from 'node:assert/strict';


import path from 'node:path';
import buildFixture from './build-fixture.cjs';
// Real Vite transforms bundle the ACTUAL GLTFLoader and native consumers with a single Three instance.
const compiled = await buildFixture({ root: process.cwd(), platform: 'node', format: 'es', source: `
  export * from './src/maps/raw-source-world-glb';
  export * from './src/maps/raw-source-gltf';
  export * from './src/maps/raw-source-materials';
  export * from './src/maps/raw-source-files';
  export * from './src/maps/raw-source-bsp';
  export * from './src/maps/raw-source-props';
  export * from './src/maps/raw-source-lighting';
  export * from './src/render/source-visibility';
  export * from './src/render/source-sky3d';
  export * from './src/render/source-vtf';
  export * from './src/render/source-materials';
  export * from './src/render/source-lighting';
  export { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
  export * as THREE from 'three';` });
const api = await import('data:text/javascript;base64,' + Buffer.from(compiled.code).toString('base64'));
const { SourceGlb, SourceMaterialExport, SourceFileSystem, readSourceBsp, decodeSourceWorld, readSourceProps,
  buildSourceLighting, appendSourceWorld, SourceVisibility, SourceSky3D, SourceNativeTextures,
  SourceMaterials, sourceMaterial, sourceVertexMaterial, patchSourceMaterial, sourceNativeCube, GLTFLoader, THREE } = api;
const limits = { maxGeometryBytes: 256 * 1024 * 1024, maxVertices: 4_000_000 };
function record(size, fill) { const b = Buffer.alloc(size); fill(b); return b; }
function fixture({brushStyle=0}={}) {
  const lumps = new Map(), put = (id, bytes, version = 0) => lumps.set(id, { bytes, version });
  put(0, Buffer.from(`{"classname" "worldspawn"}
    {"classname" "info_player_start" "origin" "16 16 32" "angles" "0 90 0"}
    {"classname" "sky_camera" "origin" "64 0 0" "scale" "16"}
    {"classname" "func_wall" "model" "*1" "origin" "160 32 16" "angles" "0 45 0"}
    {"classname" "func_wall" "model" "*1" "origin" "192 32 16" "angles" "0 90 0"}
    {"classname" "func_wall" "model" "*1" "origin" "224 32 16" "StartDisabled" "1"}\0`));
  // Plane 0 is the floor; plane 1 divides the two genuine PVS leaves at X=64.
  put(1, record(40, b => { b.writeFloatLE(1, 8); b.writeFloatLE(1, 20); b.writeFloatLE(64, 32); }));
  put(2, record(96, b => { for (let i = 0; i < 3; i++) { b.writeInt32LE(i, i * 32 + 12); b.writeInt32LE(64, i * 32 + 16); b.writeInt32LE(64, i * 32 + 20); } }));
  const names = ['fixture/lit', 'fixture/blend', 'fixture/unlit'];
  put(43, Buffer.from(names.join('\0') + '\0'));
  put(44, record(12, b => { let offset = 0; names.forEach((name, i) => { b.writeInt32LE(offset, i * 4); offset += name.length + 1; }); }));
  put(3, record(6 * 48, b => {
    for (let face = 0; face < 6; face++) {
      const x = face === 5 ? 0 : face * 40;
      [x,0,0, x,32,0, x+32,32,0, x+32,0,0].forEach((v, i) => b.writeFloatLE(v, face * 48 + i * 4));
    }
  }));
  put(5, record(32, b => { b.writeInt32LE(1); b.writeInt32LE(-1, 4); b.writeInt32LE(-2, 8); }));
  put(6, record(3 * 72, b => { for (let i = 0; i < 3; i++) { const p = i * 72; b.writeFloatLE(1,p); b.writeFloatLE(1,p+20); b.writeFloatLE(1/16,p+32); b.writeFloatLE(1/16,p+52); b.writeInt32LE(i,p+68); if(i===0)b.writeInt32LE(0x800,p+64); } }));
  put(7, record(6 * 56, b => {
    let light = 0;
    for (let i = 0; i < 6; i++) {
      const p = i * 56; b.writeInt32LE(i*4,p+4); b.writeInt16LE(4,p+8); b.writeInt16LE(i===3||i===5&&brushStyle?1:i===4?2:0,p+10); b.writeInt16LE(i===3?0:-1,p+12);
      b[p+16]=i===5?brushStyle:0;b[p+17]=b[p+18]=b[p+19]=255; b.writeInt32LE(i===4?-1:light,p+20); b.writeInt32LE(i===5?0:Math.floor(i*40/16),p+28); b.writeInt32LE(2,p+36); b.writeInt32LE(2,p+40);
      if(i!==4)light+=9*4*(i===3?1:4);
    }
  }),1);
  put(8, record(9*4*17, b => { for(let i=0;i<b.length;i+=4){b[i]=80+(i/4)%50;b[i+1]=40;b[i+2]=20;b[i+3]=0;} }),1);
  put(10, record(64, b => {
    for(let i=0;i<2;i++){const p=i*32;b.writeUInt16LE(i,p+4);for(let axis=0;axis<3;axis++){b.writeInt16LE(-512,p+8+axis*2);b.writeInt16LE(512,p+14+axis*2);}b.writeUInt16LE(i===0?0:2,p+20);b.writeUInt16LE(i===0?2:3,p+22);}
  }),1);
  put(12, record(6*16,b=>{for(let f=0;f<6;f++)for(let i=0;i<4;i++){const p=f*16+i*4;b.writeUInt16LE(f*4+i,p);b.writeUInt16LE(f*4+(i+1)%4,p+2);}}));
  put(13, record(6*16,b=>{for(let i=0;i<24;i++)b.writeInt32LE(i,i*4);}));
  put(14, record(96,b=>{for(let model=0;model<2;model++){const p=model*48;for(let i=0;i<3;i++){b.writeFloatLE(-512,p+i*4);b.writeFloatLE(512,p+12+i*4);}b.writeInt32LE(model===0?0:5,p+40);b.writeInt32LE(model===0?5:1,p+44);}}));
  put(16,record(10,b=>[2,3,0,1,4].forEach((v,i)=>b.writeUInt16LE(v,i*2))));
  put(4,record(22,b=>{b.writeUInt32LE(2);for(let i=0;i<4;i++)b.writeUInt32LE(20+(i>=2?1:0),4+i*4);b[20]=1;b[21]=2;}));
  put(26,record(176,b=>{b.writeFloatLE(120);b.writeInt32LE(2,20);}));
  put(33,record(25*20,b=>{for(let i=0;i<25;i++){b.writeFloatLE(1,i*20+8);b.writeFloatLE((i%5)*.5,i*20+12);b.writeFloatLE(i*10,i*20+16);}}));
  put(48,Buffer.alloc(32*2,1));
  const header=Buffer.alloc(1036),bodies=[];header.write('VBSP');header.writeInt32LE(20,4);let offset=1036;
  for(const [id,{bytes,version}] of lumps){const p=8+id*16;header.writeUInt32LE(offset,p);header.writeUInt32LE(bytes.length,p+4);header.writeUInt32LE(version,p+8);bodies.push(bytes);offset+=bytes.length;}
  return new Blob([header,...bodies]);
}
function vtf(width,height,pixels,faces=1){
  const header=Buffer.alloc(80);header.write('VTF\0');header.writeUInt32LE(7,4);header.writeUInt32LE(2,8);header.writeUInt32LE(80,12);
  header.writeUInt16LE(width,16);header.writeUInt16LE(height,18);header.writeUInt32LE(faces===6?0x4000:0,20);header.writeUInt16LE(1,24);header.writeUInt16LE(0xffff,26);
  header.writeUInt32LE(0,52);header[56]=1;header.writeUInt32LE(0xffffffff,57);header.writeUInt16LE(1,63);
  return new Blob([header,pixels]);
}
async function mount(files){return SourceFileSystem.create([{kind:'loose',files:Object.entries(files).map(([path,blob])=>({path,blob:typeof blob==='string'?new Blob([blob]):blob}))}]);}
async function prepare(settings){
  const world=await decodeSourceWorld(await readSourceBsp(fixture(settings)));
  const filesystem=await mount({});const props=await readSourceProps(world,filesystem);
  const surfaces=[...world.surfaces,...new Map(props.brushes.map(b=>[b.model,b.surfaces])).values()].flat();
  const lighting=await buildSourceLighting({...world,surfaces},filesystem,{atlasSize:32});
  const files={
    'materials/fixture/lit.vmt':'LightmappedGeneric { "$envmap" "env_cubemap" "$bumpmap" "fixture/normal" }',
    'materials/fixture/blend.vmt':'WorldVertexTransition { "$basetexture" "fixture/base" "$basetexture2" "fixture/second" }',
    'materials/fixture/unlit.vmt':'UnlitGeneric { "$color" "[.5 .25 .125]" }',
    'materials/fixture/normal.vtf':vtf(1,1,Uint8Array.of(128,128,255,255)),
    'materials/fixture/base.vtf':vtf(1,1,Uint8Array.of(20,40,60,255)),
    'materials/fixture/second.vtf':vtf(1,1,Uint8Array.of(200,100,50,255)),
    'materials/fixture/cubeA.vtf':vtf(1,1,Uint8Array.from({length:24},(_,i)=>i%4===3?255:20+i),6),
    'materials/fixture/cubeB.vtf':vtf(1,1,Uint8Array.from({length:24},(_,i)=>i%4===3?255:180+i),6),
  };
  lighting.pages.forEach((p,i)=>p.layers.forEach((data,j)=>{files[`materials/atlas/${i}_${j}.vtf`]=vtf(p.width,p.height,data);}));
  const glb=new SourceGlb(),materials=new SourceMaterialExport(glb,await mount(files));
  // Real selected cube assets deliberately precede atlases: page IDs != texture IDs.
  const cubeA=await Promise.all(Array.from({length:6},(_,face)=>materials.texture('materials/fixture/cubeA.vtf',0,face)));
  const cubeB=await Promise.all(Array.from({length:6},(_,face)=>materials.texture('materials/fixture/cubeB.vtf',0,face)));
  const lightmaps=[];
  for(let i=0;i<lighting.pages.length;i++){const textures=[];for(let j=0;j<4;j++)textures.push(await materials.texture(`materials/atlas/${i}_${j}.vtf`));lightmaps.push({flat:textures[0],bump:textures.slice(1)});}
  return {world,props,lighting,glb,materials,options:{...limits,lightmaps,brushes:props.brushes,cubeForSurface:s=>s.face===2?cubeB:cubeA}};
}
async function load(glb){
  const owner=new SourceMaterials(),loader=new GLTFLoader();
  // loadTexture decodes original embedded VTF bytes into real DataTextures. It
  // does not use renderer capability/upload paths, so no WebGL renderer exists.
  loader.register(parser=>new SourceNativeTextures(parser,owner,undefined));
  const loaded=await loader.parseAsync(await glb.finish().arrayBuffer(),'');
  return {...loaded,owner};
}
function close(actual,expected,message){assert.equal(actual.length,expected.length,message);for(let i=0;i<actual.length;i++)assert(Math.abs(actual[i]-expected[i])<2e-5,`${message} component ${i}: ${actual[i]} != ${expected[i]}`);}
function meshFor(loaded,mesh,primitive){const matches=[];loaded.scene.traverse(o=>{const a=loaded.parser.associations.get(o);if(o.isMesh&&a?.meshes===mesh&&a?.primitives===primitive)matches.push(o);});return matches;}
async function checkFaces(loaded,world,lighting,result){
  const placements=new Map(lighting.placements.map(p=>[p.face,p])),surfaces=new Map(world.surfaces.map(s=>[s.face,s])),checkedPixels=new Map();
  const pixels=(texture,expected,message)=>{if(checkedPixels.get(texture)===expected)return;assert.deepEqual(texture.image.data,expected,message);checkedPixels.set(texture,expected);};
  const blockedFaces=new Set(result.requirements.filter(r=>r.code==='world-material-unavailable'||r.code==='world-face-lighting-unavailable').map(r=>r.face));
  assert.deepEqual(new Set(result.faces.map(r=>r.face)),new Set(world.surfaces.filter(s=>s.visible&&!blockedFaces.has(s.face)).map(s=>s.face)),'every visible native face is consumed or explicitly blocked');
  for(const r of result.faces){
    const surface=surfaces.get(r.face),mesh=meshFor(loaded,r.mesh,r.primitive)[0];assert(mesh,'actual GLTFLoader world primitive');
    const geometry=mesh.geometry;
    for(const [name,source,size] of [['position',surface.positions,3],['normal',surface.normals,3],['tangent',surface.tangents,4],['uv',surface.uv,2]])close(geometry.getAttribute(name).array.subarray(r.vertexStart*size,(r.vertexStart+r.vertexCount)*size),source,`face ${r.face} ${name}`);
    assert.deepEqual([...geometry.index.array.subarray(r.start,r.start+r.count)].map(i=>i-r.vertexStart),[...surface.indices],'unchanged native topology/winding');
    if(geometry.hasAttribute('uv1'))close(geometry.getAttribute('uv1').array.subarray(r.vertexStart*2,(r.vertexStart+r.vertexCount)*2),placements.get(r.face).uv,'actual packed lightmap UV');
    if(surface.alpha){const color=geometry.getAttribute('color');for(let i=0;i<r.vertexCount;i++)close([color.getX(r.vertexStart+i),color.getY(r.vertexStart+i),color.getZ(r.vertexStart+i),color.getW(r.vertexStart+i)],[1,1,1,surface.alpha[i]],'displacement blend alpha');}
    // Material custom-path consumer must receive actual texture identities/pixels.
    const original=mesh.material;
    if(original.userData.sourceLightmap!==undefined){
      const texture=await loaded.parser.getDependency('texture',original.userData.sourceLightmap);
      const placement=placements.get(r.face),page=lighting.pages[placement.page];
      pixels(texture,page.layers[0],'GLTFLoader atlas pixels from real CPU lighting');
      const native=sourceMaterial(original,texture,{value:1});assert.equal(texture.channel,1);assert.equal(texture.flipY,false);
      const bumps=await Promise.all((original.userData.sourceBumpLightmaps??[]).map(i=>loaded.parser.getDependency('texture',i)));
      for(let i=0;i<bumps.length;i++)pixels(bumps[i],page.layers[i+1],'directional material layer actual bytes');
      patchSourceMaterial(native,original,{normal:original.normalMap,lightmaps:bumps},undefined,undefined,world.frame.origin,world.frame.yaw,true,loaded.owner);
      assert.equal(native.vertexColors,original.userData.sourceMaterial.shader==='worldvertextransition');native.dispose();
    }else{const native=sourceVertexMaterial(original,original.userData.sourceVertexLighting,{value:1});assert.equal(native.vertexColors,false,'unlit native path does not manufacture vertex lighting');native.dispose();}
  }
}
const f=await prepare(),base=await f.materials.material('fixture/lit',f.options.cubeForSurface(f.world.surfaces[0]));
const originalBase=JSON.stringify(f.glb.json.materials[base]);
const result=await appendSourceWorld(f.glb,f.materials,f.world,f.lighting,f.options);
assert.equal(JSON.stringify(f.glb.json.materials[base]),originalBase,'lightmap variants must not mutate cached base material');
assert.deepEqual(result.resolvedUnlitFaces,[4]);assert(!result.requirements.some(r=>r.code==='face-without-baked-samples'&&r.face===4));
assert.equal(result.faces.find(r=>r.face===0).primitive,result.faces.find(r=>r.face===1).primitive,'shared native material/page/cube/layout really merges');
assert.notEqual(result.faces.find(r=>r.face===0).primitive,result.faces.find(r=>r.face===2).primitive,'different native cubes remain distinct');
assert.equal(result.brushes[0].faces[0].mesh,result.brushes[1].faces[0].mesh,'brush instances share one actual mesh');
assert.equal(result.brushes[2].attached,false);
const styledBrush=await prepare({brushStyle:32});
const styledResult=await appendSourceWorld(styledBrush.glb,styledBrush.materials,styledBrush.world,styledBrush.lighting,styledBrush.options);
const styledFace=styledBrush.props.brushes[0].surfaces[0].face;
assert.equal(styledBrush.lighting.placements.find(p=>p.face===styledFace).layersPerStyle,1,'actual flat animated brush, not the separately blocked directional path');
assert(styledResult.requirements.some(r=>r.code==='brush-lightstyle-runtime'&&r.face===styledFace&&r.blocking),'native brush consumer cannot silently freeze an authored style');
const loaded=await load(f.glb);await checkFaces(loaded,f.world,f.lighting,result);
for(const r of result.faces.filter(r=>f.world.surfaces.find(s=>s.face===r.face).material==='fixture/lit')){
  const mesh=meshFor(loaded,r.mesh,r.primitive)[0],faces=await Promise.all(mesh.material.userData.sourceMaterial.envmapFaces.map(i=>loaded.parser.getDependency('texture',i)));
  const cube=sourceNativeCube(faces);
  for(let face=0;face<6;face++)assert.deepEqual([...cube.images[face].data],[0,1,2,3].map(channel=>channel===3?255:(r.face===2?180:20)+face*4+channel),'actual per-surface cubemap face pixels');
  cube.dispose();
}
// Real parser's node matrix maps model-native metres once, with no yaw/origin bake.
for(const entry of result.brushes.filter(b=>b.attached)){
  const brush=f.props.brushes.find(b=>b.entityIndex===entry.entityIndex),node=await loaded.parser.getDependency('node',entry.node);node.updateWorldMatrix(true,true);
  const r=entry.faces[0],mesh=meshFor(loaded,r.mesh,r.primitive).find(o=>o===node||node.getObjectById(o.id));assert(mesh);
  assert.equal(mesh.geometry.userData.sourceFaceRanges,undefined,'brush does not enter WORLD-PVS filtering');
  const actual=new THREE.Vector3().fromBufferAttribute(mesh.geometry.getAttribute('position'),r.vertexStart).applyMatrix4(mesh.matrixWorld);
  const expected=new THREE.Vector3().fromArray(brush.surfaces[0].positions).applyMatrix4(new THREE.Matrix4().fromArray(brush.matrix));close(actual.toArray(),expected.toArray(),'brush authored matrix applied once');
  assert.equal(node.userData.sourceRender.initiallyDisabled,false);
}
const hidden=await loaded.parser.getDependency('node',result.brushes[2].node);assert(!loaded.scene.getObjectById(hidden.id),'disabled baseline absent from visible scene, not glTF ignored extras');
// Exercise ACTUAL PVS filtering against the serialized primitive index ranges.
const visibility=new SourceVisibility(f.lighting.native.visibility,loaded.scene),camera=new THREE.PerspectiveCamera();
const snapshots=result.faces.map(r=>{const mesh=meshFor(loaded,r.mesh,r.primitive)[0];return [mesh,mesh.geometry,Array.from(mesh.geometry.index.array)];});
for(const sourceX of [32,96]){
  const source=new THREE.Vector3(sourceX,16,32).sub(new THREE.Vector3(...f.world.frame.origin)).multiplyScalar(.0254).applyAxisAngle(new THREE.Vector3(0,0,1),-f.world.frame.yaw*Math.PI/180);camera.position.copy(source);camera.updateMatrixWorld();
  const cluster=visibility.pvs.cluster(camera.position),row=visibility.pvs.row(cluster);
  visibility.draw(camera,()=>{for(const [mesh,original] of snapshots){const expected=[];for(const [face,start,count] of original.userData.sourceFaceRanges)if(visibility.pvs.visible(row,f.lighting.native.visibility.faceClusters[face]))expected.push(...original.index.array.subarray(start,start+count));assert.deepEqual([...mesh.geometry.index.array.subarray(0,mesh.geometry.drawRange.count)],expected,'PVS actual selected triangle indices');}});
  for(const [mesh,geometry,indices] of snapshots){assert.equal(mesh.geometry,geometry);assert.deepEqual([...geometry.index.array],indices,'PVS restores export/raycast geometry');}
}
const sky=new SourceSky3D(f.lighting.native.visibility,loaded.scene,()=>{});sky.prepare(camera,true);
const skyRow=sky.pvs.row(sky.stats.cluster);
for(const mesh of sky.scene.children.filter(o=>o.isMesh)){
  const source=snapshots.find(([candidate])=>candidate.geometry.getAttribute('position')===mesh.geometry.getAttribute('position'));
  assert(source,'sky clone uses original vertex buffers');const expected=[];
  for(const [face,start,count] of source[1].userData.sourceFaceRanges)if(sky.pvs.visible(skyRow,f.lighting.native.visibility.faceClusters[face]))expected.push(...source[1].index.array.subarray(start,start+count));
  assert.deepEqual([...mesh.geometry.index.array.subarray(0,mesh.geometry.drawRange.count)],expected,'3D-sky consumer exact index filtering');
}
sky.dispose();visibility.dispose();loaded.owner.clear();
// Fail before allocating/exporting geometry for malformed attributes/indices,
// aggregate caps, duplicate lighting ownership and actual cancellation boundaries.
for(const mutate of [
  s=>({...s,indices:Uint32Array.of(0,1,s.positions.length/3)}),
  s=>({...s,normals:s.normals.subarray(0,3)}),
  s=>({...s,tangents:Float32Array.from(s.tangents,(_,i)=>i===0?NaN:1)}),
  s=>({...s,alpha:new Float32Array(s.positions.length/3).fill(2)}),
]){const bad=await prepare();bad.world={...bad.world,surfaces:[mutate(bad.world.surfaces[0]),...bad.world.surfaces.slice(1)]};await assert.rejects(appendSourceWorld(bad.glb,bad.materials,bad.world,bad.lighting,bad.options));assert.equal(bad.glb.json.accessors.length,0);}
for(const cap of [{maxGeometryBytes:1},{maxVertices:1}]){const bad=await prepare();await assert.rejects(appendSourceWorld(bad.glb,bad.materials,bad.world,bad.lighting,{...bad.options,...cap}));assert.equal(bad.glb.json.accessors.length,0);}
{const bad=await prepare();await assert.rejects(appendSourceWorld(bad.glb,bad.materials,bad.world,{...bad.lighting,placements:[...bad.lighting.placements,bad.lighting.placements[0]]},bad.options));}
{const bad=await prepare(),lightmaps=bad.options.lightmaps.map(b=>({...b,flat:0x7fffffff}));await assert.rejects(appendSourceWorld(bad.glb,bad.materials,bad.world,bad.lighting,{...bad.options,lightmaps}));}
{const bad=await prepare(),first=bad.lighting.placements[0],uv=Float32Array.from(first.uv,(_,i)=>i===0?Infinity:0);await assert.rejects(appendSourceWorld(bad.glb,bad.materials,bad.world,{...bad.lighting,placements:[{...first,uv},...bad.lighting.placements.slice(1)]},bad.options));assert.equal(bad.glb.json.accessors.length,0);}
{const bad=await prepare(),matrix=bad.props.brushes[0].matrix.slice();matrix[15]=0;await assert.rejects(appendSourceWorld(bad.glb,bad.materials,bad.world,bad.lighting,{...bad.options,brushes:[{...bad.props.brushes[0],matrix}]}));assert.equal(bad.glb.json.accessors.length,0);}
{const bad=await prepare(),controller=new AbortController();controller.abort(new Error('cancel before geometry'));await assert.rejects(appendSourceWorld(bad.glb,bad.materials,bad.world,bad.lighting,{...bad.options,signal:controller.signal}));assert.equal(bad.glb.json.accessors.length,0);}
{const bad=await prepare(),controller=new AbortController();const pending=appendSourceWorld(bad.glb,bad.materials,bad.world,bad.lighting,{...bad.options,signal:controller.signal});setTimeout(()=>controller.abort(new Error('cancel posted during conversion')),0);await assert.rejects(pending);assert.equal(bad.glb.json.accessors.length,0);}
{const bad=await prepare(),controller=new AbortController();await assert.rejects(appendSourceWorld(bad.glb,bad.materials,bad.world,bad.lighting,{...bad.options,signal:controller.signal,cubeForSurface:s=>{controller.abort(new Error('cancel during material selection'));return bad.options.cubeForSurface(s);}}));assert.equal(bad.glb.json.accessors.length,0);}
{const bad=await prepare(),lighting={...bad.lighting,placements:bad.lighting.placements.filter(p=>p.face!==0)};const partial=await appendSourceWorld(bad.glb,bad.materials,bad.world,lighting,bad.options);assert(partial.requirements.some(r=>r.code==='world-face-lighting-unavailable'&&r.face===0));assert(!partial.faces.some(r=>r.face===0),'no invented white tile');}
console.log('World CPU acceptance: actual BSP parser -> lighting/material export -> GLTFLoader geometry, native flat/bump bytes, cube/layout merging, displacement alpha, shared brush transforms, PVS/sky index consumers and malformed/cancel/allocation boundaries.');
