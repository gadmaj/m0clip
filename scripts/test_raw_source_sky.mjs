/** CPU-only actual GLTFLoader/native VTF/Source sky material consumers.
 * node scripts/test_raw_source_sky.mjs [--bsp FILE --root EXPLICIT_LOOSE_ROOT]
 * No renderer/GPU, downloads, implicit game discovery or full-map qualification. */
import assert from 'node:assert/strict';



import buildFixture from './build-fixture.cjs';
// Real Vite transforms, as the application compiles these modules, with one bundled Three instance.
const compiled = await buildFixture({ root: process.cwd(), platform: 'node', format: 'es', source: `
  export * from './src/maps/raw-source-sky';
  export * from './src/maps/raw-source-gltf';
  export * from './src/maps/raw-source-materials';
  export * from './src/maps/raw-source-files';
  export * from './src/maps/raw-source-bsp';
  export * from './src/maps/raw-source-vtf';
  export * from './src/render/source-vtf';
  export * from './src/render/source-materials';
  export * from './src/render/source-lighting';
  export * from './src/render/source-textures';
  export { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
  export * as THREE from 'three';` });
const api = await import('data:text/javascript;base64,' + Buffer.from(compiled.code).toString('base64'));
const { SourceGlb, SourceMaterialExport, appendSourceSky, SourceFileSystem, readSourceBsp, decodeSourceWorld,
  readSourceVtf, SourceNativeTextures, SourceMaterials, GLTFLoader, THREE, sourceVertexMaterial,
  setSourceTexturesEnabled, sourceDiffuseOnly } = api;
const suffixes = ['rt', 'lf', 'bk', 'ft', 'up', 'dn'];
const axes = [[1,0,0],[-1,0,0],[0,1,0],[0,-1,0],[0,0,1],[0,0,-1]];
const faceCorners = [
  [[1,1,-1],[1,1,1],[1,-1,1],[1,-1,-1]],
  [[-1,-1,-1],[-1,-1,1],[-1,1,1],[-1,1,-1]],
  [[-1,1,-1],[-1,1,1],[1,1,1],[1,1,-1]],
  [[1,-1,-1],[1,-1,1],[-1,-1,1],[-1,-1,-1]],
  [[1,1,1],[-1,1,1],[-1,-1,1],[1,-1,1]],
  [[-1,1,-1],[1,1,-1],[1,-1,-1],[-1,-1,-1]],
];
const near = (a,b) => { assert.equal(a.length,b.length); a.forEach((v,i)=>assert(Math.abs(v-b[i])<1e-6,`${v} != ${b[i]}`)); };
function vtf(face, {format=0, frames=2, depth=1, cube=false}={}) {
  const header = Buffer.alloc(80); header.write('VTF\0'); header.writeUInt32LE(7,4); header.writeUInt32LE(2,8); header.writeUInt32LE(80,12);
  header.writeUInt16LE(2,16); header.writeUInt16LE(2,18); header.writeUInt32LE(0x40|4|8|256|(cube?0x4000:0),20);
  header.writeUInt16LE(frames,24); header.writeUInt16LE(0xffff,26); header.writeUInt32LE(format,52);
  header[56]=1; header.writeUInt32LE(0xffffffff,57); header.writeUInt16LE(depth,63);
  const payload=[];
  for(let frame=0;frame<frames;frame++) for(let j=0;j<(cube?6:1)*depth;j++) for(let pixel=0;pixel<4;pixel++)
    payload.push(format===24?Buffer.from([0,0x40,0,0x38,0,0,0,0x3c]):Buffer.from([face*20+pixel,frame*90+pixel,200-pixel,pixel?255:0]));
  return new Blob([header,...payload]);
}
function fixture(overrides={}) {
  const files={};
  for(let i=0;i<6;i++) {
    const suffix=suffixes[i];
    files[`materials/skybox/native${suffix}.vmt`]=new Blob([`UnlitGeneric { "$basetexture" "skybox/face${i}" "$frame" "1" "$ignorez" "1" "$nofog" "1" ${i<4?'"$basetexturetransform" "scale 1 2"':''} }`]);
    files[`materials/skybox/face${i}.vtf`]=vtf(i);
  }
  Object.assign(files,overrides);
  return { files, readFile: async (name,signal,maxBytes=Infinity)=>{signal?.throwIfAborted(); const file=files[name];if(file&&file.size>maxBytes)throw new Error('Selected input exceeds byte limit');return file;} };
}
async function emit(files, options={}, materialOptions={}) {
  const glb=new SourceGlb(), materials=new SourceMaterialExport(glb,files,{signal:options.signal,...materialOptions});
  return { glb,materials,result:await appendSourceSky(glb,materials,{yaw:90},'native',options) };
}
async function load(glb) {
  const owner=new SourceMaterials(), loader=new GLTFLoader();
  loader.register(parser=>new SourceNativeTextures(parser,owner,undefined));
  const loaded=await loader.parseAsync(await glb.finish().arrayBuffer(),'');
  return {...loaded,owner};
}
async function consume(emission, files, yaw=90, expectedPixels) {
  const {glb,result}=emission, loaded=await load(glb), sky=[];
  loaded.scene.traverse(object=>{if(object.isMesh&&object.userData.sourceSky)sky.push(object);});
  assert.equal(sky.length,6);assert.equal(result.faces.length,6);
  for(let i=0;i<6;i++) {
    const mesh=await loaded.parser.getDependency('node',result.faces[i].node);
    const direction=new THREE.Vector3(...axes[i]).applyAxisAngle(new THREE.Vector3(0,0,1),-yaw*Math.PI/180);
    const ray=new THREE.Raycaster(new THREE.Vector3(),direction);
    assert.equal(ray.intersectObject(mesh)[0]?.object, mesh, 'The authored sky face must be hit from inside');
    assert.equal(new THREE.Raycaster(direction.clone().multiplyScalar(2),direction.clone().negate()).intersectObject(mesh).length,0,'outside backface must remain culled');
    const p=mesh.geometry.attributes.position, uv=mesh.geometry.attributes.uv, normal=mesh.geometry.attributes.normal;
    for(let vertex=0;vertex<4;vertex++) {
      near(new THREE.Vector3().fromBufferAttribute(p,vertex).toArray(),
        new THREE.Vector3(...faceCorners[i][vertex]).applyAxisAngle(new THREE.Vector3(0,0,1),-yaw*Math.PI/180).toArray());
      assert(Math.abs(new THREE.Vector3().fromBufferAttribute(p,vertex).dot(direction)-1)<1e-6,'correct face and yaw without Source scale/translation');
      near(new THREE.Vector3().fromBufferAttribute(normal,vertex).toArray(),direction.clone().negate().toArray());
    }
    if(expectedPixels) {
      const scale=i<4?2:1;
      near([...uv.array],[1/512,511/512*scale,1/512,1/512*scale,511/512,1/512*scale,511/512,511/512*scale]);
    }
    const material=mesh.material, index=glb.json.materials[result.faces[i].material].pbrMetallicRoughness.baseColorTexture.index;
    const meta=glb.json.textures[index].extensions.M0CLIP_texture_vtf;
    const original=await readSourceVtf(await files.readFile(meta.path));
    const pixels=await original.decode({frame:meta.frame,face:meta.face});
    near([...material.map.image.data],[...pixels.data]);
    if(expectedPixels)near([...material.map.image.data],expectedPixels(i));
    assert.equal(material.map.flipY,false);
    const native=sourceVertexMaterial(material,material.userData.sourceVertexLighting,{value:1},{value:0},true);
    assert.equal(native.map,material.map);assert.equal(native.vertexColors,false);assert.equal(native.fog,false);
    // This is the actual textures-toggle consumer used by Scene: sky stays colored.
    assert.equal(setSourceTexturesEnabled(native,false),true);
    assert.equal(sourceDiffuseOnly(native),false,'the sky keeps authored color when scene textures are disabled');
    native.dispose();
  }
  loaded.owner.clear();
}
const input=fixture(), emitted=await emit(input);
assert.deepEqual(emitted.result.requirements,[]);
await consume(emitted,input,90,i=>Array.from({length:4},(_,p)=>[i*20+p,90+p,200-p,p?255:0]).flat());
// Native Sky shader HDR takes precedence over a perfectly available LDR texture.
const hdr=fixture({'materials/skybox/nativert.vmt':new Blob(['Sky { "$hdrbasetexture" "skybox/hdr" "$basetexture" "skybox/face0" }']), 'materials/skybox/hdr.vtf':vtf(0,{format:24,frames:1})});
const hdrEmission=await emit(hdr);assert.deepEqual(hdrEmission.result.requirements,[]);
const hdrLoaded=await load(hdrEmission.glb), hdrMesh=await hdrLoaded.parser.getDependency('node',hdrEmission.result.faces[0].node);
near([...hdrMesh.material.map.image.data],[2,.5,0,1,2,.5,0,1,2,.5,0,1,2,.5,0,1]);
assert.equal(hdrMesh.material.map.type,THREE.FloatType);
const hdrBinding=hdrEmission.glb.json.textures[0];assert.equal(hdrBinding.source,undefined,'no quantized HDR PNG fallback');
hdrLoaded.owner.clear();
for(const [overrides,code] of [
  [{'materials/skybox/nativeup.vmt':undefined},'missing-material'],
  [{'materials/skybox/face4.vtf':undefined},'missing-texture'],
  [{'materials/skybox/nativeup.vmt':new Blob(['Sky { "$hdrbasetexture" "missing-hdr" "$basetexture" "skybox/face4" }'])},'missing-texture'],
  [{'materials/skybox/nativeup.vmt':new Blob(['Sky { "$hdrcompressedtexture" "skybox/face4" "$basetexture" "skybox/face4" }'])},'sky-hdr-compressed-runtime'],
  [{'materials/skybox/face4.vtf':vtf(4,{format:999})},'sky-texture-format'],
  [{'materials/skybox/face4.vtf':vtf(4,{depth:2})},'sky-texture-dimensionality'],
  [{'materials/skybox/face4.vtf':vtf(4,{cube:true})},'sky-texture-dimensionality'],
  [{'materials/skybox/nativeup.vmt':new Blob(['UnlitGeneric { "$basetexture" "skybox/face4" "$frame" "99" }'])},'sky-texture-frame'],
  [{'materials/skybox/nativeup.vmt':new Blob(['UnlitGeneric { "$basetexture" "skybox/face4" Proxies { TextureScroll { texturescrollvar "$basetexturetransform" } } }'])},'sky-proxy-runtime'],
]) {
  const partial=await emit(fixture(overrides));
  assert(partial.result.requirements.some(r=>r.blocking&&r.code===code),code);
  assert.equal(partial.result.faces.length,0,'no partial/replacement sky');
  assert.equal(partial.glb.json.nodes.length,0);
}
let reads=0;const counted={readFile:async()=>{reads++;return undefined;}};
await assert.rejects(emit(counted,{maxGeometryBytes:779}));assert.equal(reads,0,'reject geometry before resource work');
await assert.rejects(emit(counted,{maxVertices:23}));assert.equal(reads,0);
await assert.rejects(emit(input,{}, {maxInputBytes:80}));
await assert.rejects(emit(input,{}, {maxTextureWorkingBytes:1}));
const aborted=new AbortController();aborted.abort(new Error('cancel sky'));
await assert.rejects(emit(counted,{signal:aborted.signal}));assert.equal(reads,0);
const during=new AbortController(), cancelled=fixture();
const cancelling={readFile:async(...args)=>{const blob=await cancelled.readFile(...args);during.abort(new Error('cancel selected sky read'));return blob;}};
await assert.rejects(emit(cancelling,{signal:during.signal}));
await assert.rejects(emit({readFile:async()=>{throw new Error('selected archive CRC failed');}}),'resource errors are not missing-file fallbacks');
console.log('Sky CPU consumers: six inward/yaw/UV faces, authored frame pixels, native HDR, actual GLTFLoader/Source material ABI, missing/format/cancel/bounds. No GPU/full-map qualification.');

let bspPath;

