/** CPU material packaging plus actual GLTFLoader/Source material consumers.
 * node scripts/test_raw_source_materials.mjs
 * Not Chrome/GPU, native pixel or complete-map qualification: shader-patch
 * uniforms prove the bound UV matrix, not rasterized texels. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import buildFixture from './build-fixture.cjs';
// Real Vite transforms bundle the ACTUAL GLTFLoader and Source consumers with one Three instance.
const compiled=await buildFixture({root:process.cwd(),platform:'node',format:'es',source:`
  export * from './src/maps/raw-source-materials';
  export * from './src/maps/raw-source-gltf';
  export * from './src/maps/raw-source-files';
  export * from './src/maps/raw-source-vtf';
  export * from './src/maps/source-import-finalize';
  export * from './src/render/source-vtf';
  export * from './src/render/source-materials';
  export * from './src/render/source-lighting';
  export { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
  export * as THREE from 'three';`});
const {SourceMaterialExport,SourceGlb,SourceFileSystem,readSourceVtf,SourceNativeTextures,SourceMaterials,patchSourceMaterial,
  sourceVertexMaterial,bindSourceTemporalShadows,sourceBaseTransformWriter,finalizeSourceAssembly,GLTFLoader,THREE}=await import('data:text/javascript;base64,'+Buffer.from(compiled.code).toString('base64'));
function vtf({frames=2,faces=1,format=0,padding=0,alpha=true}={}){
  const header=Buffer.alloc(80);header.write('VTF\0');header.writeUInt32LE(7,4);header.writeUInt32LE(2,8);header.writeUInt32LE(80,12);
  header.writeUInt16LE(1,16);header.writeUInt16LE(1,18);header.writeUInt32LE((faces===6?0x4000:0)|(alpha?0x2000:0),20);
  header.writeUInt16LE(frames,24);header.writeUInt16LE(0xffff,26);header.writeUInt32LE(format,52);header[56]=1;header.writeUInt32LE(0xffffffff,57);header.writeUInt16LE(1,63);
  const pixels=format===24?Buffer.from([0,0x40,0,0x38,0,0,0,0x3c]):Buffer.concat(Array.from({length:frames*faces},(_,i)=>Buffer.from(i===0?[7,8,9,255]:[255,i,99,0])));
  return new Blob([header,pixels,Buffer.alloc(padding)]);
}
async function filesystem(files){return SourceFileSystem.create([{kind:'loose',files:Object.entries(files).map(([path,file])=>({path,blob:typeof file==='string'?new Blob([file]):file}))}]);}
async function unpack(glb){
  const bytes=Buffer.from(await glb.finish().arrayBuffer()),jsonLength=bytes.readUInt32LE(12),json=JSON.parse(bytes.subarray(20,20+jsonLength).toString());
  const binary=bytes.subarray(28+jsonLength),view=id=>{const v=json.bufferViews[id];return binary.subarray(v.byteOffset,v.byteOffset+v.byteLength);};
  return {json,view};
}
async function texturePixels(result,index){
  const meta=result.json.textures[index].extensions.M0CLIP_texture_vtf;
  return (await (await readSourceVtf(result.view(meta.bufferView))).decode({frame:meta.frame,face:meta.face})).data;
}
function pngPixels(result,index){
  const definition=result.json.textures[index],image=result.json.images[definition.source];
  const decoded=spawnSync('python3',['-c','import io,sys\nfrom PIL import Image\nim=Image.open(io.BytesIO(sys.stdin.buffer.read())).convert("RGBA")\nsys.stdout.buffer.write(im.tobytes())'],{input:result.view(image.bufferView)});
  assert.equal(decoded.status,0,decoded.stderr.toString());return [...decoded.stdout];
}
async function load(glb){
  const owner=new SourceMaterials(),loader=new GLTFLoader();
  // Original embedded VTF bytes become real DataTextures; no WebGL renderer exists.
  loader.register(parser=>new SourceNativeTextures(parser,owner,undefined));
  const loaded=await loader.parseAsync(await glb.finish().arrayBuffer(),'');
  return {...loaded,owner,material:index=>loaded.parser.getDependency('material',index)};
}
const near=(actual,expected,message='',epsilon=1e-6)=>{assert.equal(actual.length,expected.length,message);actual.forEach((v,i)=>assert(Math.abs(v-expected[i])<epsilon,`${message} ${actual} != ${expected}`));};
// Source renderers emit linear colour through gamma 2.2 (sourceVertexMaterial/
// sourceMaterial, noclip Main.ts): what a white unlit texel displays as.
const displayed=color=>color.toArray().map(v=>v**(1/2.2));
function compile(material,library){
  const shader={uniforms:{},vertexShader:THREE.ShaderLib[library].vertexShader,fragmentShader:THREE.ShaderLib[library].fragmentShader};
  material.onBeforeCompile(shader,null);return shader;
}
/** Independent Source ParameterMatrix oracle (noclip MaterialParameters.ts setMatrix):
 * T(center+translate)·R(rotate)·T(-center)·S(scale), applied to native UVs. */
function authoredUv(text,u,v){
  const o={center:[0,0],scale:[1,1],rotate:[0],translate:[0,0]};
  for(const [,key,values] of text.matchAll(/(center|scale|rotate|translate)((?:\s+[-+.\d]+)+)/g)){const n=values.trim().split(/\s+/).map(Number);o[key]=key==='rotate'||n.length===2?n:[n[0],n[0]];}
  const m=new THREE.Matrix3().makeTranslation(o.center[0]+o.translate[0],o.center[1]+o.translate[1])
    .multiply(new THREE.Matrix3().makeRotation(o.rotate[0]*Math.PI/180))
    .multiply(new THREE.Matrix3().makeTranslation(-o.center[0],-o.center[1]))
    .multiply(new THREE.Matrix3().makeScale(o.scale[0],o.scale[1]));
  return [...new THREE.Vector3(u,v,1).applyMatrix3(m).toArray().slice(0,2)];
}
const samples=[[0,0],[1,0],[0,1],[.3,.8],[-1.5,2.25]];
const boundUv=(matrix,u,v)=>[...new THREE.Vector3(u,v,1).applyMatrix3(matrix).toArray().slice(0,2)];
function assertBound(matrix,expected,message){assert(matrix,`${message}: no base UV binding`);for(const [u,v] of samples)near(boundUv(matrix,u,v),expected(u,v),`${message} (${u},${v})`);}
const input=vtf({padding:65536});
const diagnosticSource=`UnlitGeneric { ${Array.from({length:8},(_,i)=>`"k${i}" "v" [$UNKNOWN_${i}]`).join(' ')} }`;
const diagnosticFilesystem=await filesystem({'materials/diagnostics.vmt':diagnosticSource});
const diagnosticExporter=new SourceMaterialExport(new SourceGlb(),diagnosticFilesystem);
await diagnosticExporter.material('diagnostics');
assert.equal(diagnosticExporter.requirements.length,8);
assert(diagnosticExporter.requirements.every(requirement=>requirement.code==='material-condition-runtime'));
const cappedDiagnostics=new SourceMaterialExport(new SourceGlb(),diagnosticFilesystem,{maxResolvedEntries:102});
await assert.rejects(()=>cappedDiagnostics.material('diagnostics'));
assert(cappedDiagnostics.requirements.length>0&&cappedDiagnostics.requirements.length<8);
const cappedInput=vtf({frames:1}),allowances=[];
const cappedFs=await filesystem({'materials/cap-a.vtf':cappedInput,'materials/cap-b.vtf':cappedInput});
const cappedGlb=new SourceGlb(),cappedExporter=new SourceMaterialExport(cappedGlb,{
  readFile(path,signal,maxBytes){allowances.push(maxBytes);return cappedFs.readFile(path,signal,maxBytes);},
},{maxInputBytes:cappedInput.size*2-1});
const cappedResults=await Promise.allSettled([
  cappedExporter.texture('materials/cap-a.vtf'),cappedExporter.texture('materials/cap-b.vtf'),
]);
assert.equal(cappedResults[0].status,'fulfilled');
assert.equal(cappedResults[1].status,'rejected');
assert.deepEqual(allowances,[cappedInput.size*2-1,cappedInput.size-1]);
assert.deepEqual([...await texturePixels(await unpack(cappedGlb),cappedResults[0].value)],[7,8,9,255]);
const sharedGlb=new SourceGlb(),sharedExporter=new SourceMaterialExport(sharedGlb,await filesystem({
  'materials/base.vmt':'UnlitGeneric { "$alpha" ".25" "$surfaceprop" "metal" }',
  'materials/one.vmt':'Patch { include base }',
  'materials/two.vmt':'Patch { include base }',
  'materials/three.vmt':'Patch { include base }',
}),{maxEntries:9});
const sharedIndices=await Promise.all(['one','two','three'].map(name=>sharedExporter.material(name)));
const sharedOriginals=sharedGlb.json.extras.sourceMaterials;
assert.equal(sharedOriginals['materials/one.vmt'].sources[1].vmt,sharedOriginals['materials/two.vmt'].sources[1].vmt);
assert.equal(sharedOriginals['materials/two.vmt'].sources[1].vmt,sharedOriginals['materials/three.vmt'].sources[1].vmt);
for(const index of sharedIndices)assert.equal(sharedGlb.json.materials[index].pbrMetallicRoughness.baseColorFactor[3],.25);
const fs=await filesystem({
  'materials/shared.vtf':input,
  'materials/first.vmt':'LightmappedGeneric { "$basetexture" "shared" "$frame" "0" "$surfaceprop" "metal" }',
  'materials/second.vmt':'LightmappedGeneric { "$basetexture" "shared" "$frame" "1" "$bumpmap" "shared" "$bumpframe" "0" "$color" "{255 128 64}" "$color2" "[.5 1 .25]" "$alpha" ".75" "$translucent" "1" }',
  'materials/rooted-patch.vmt':String.raw`Patch { "include" "\materials\second.vmt" "replace" { "$basetexture" "\shared" } }`,
});
// Two simultaneous frame bindings must fit a one-payload budget and retain their
// DIFFERENT source pixels. Duplicating the original VTF would exceed this cap.
const glb=new SourceGlb(100000),exporter=new SourceMaterialExport(glb,fs,{maxTextureWorkingBytes:8});
const [a,b,rooted]=await Promise.all([exporter.material('first'),exporter.material('second'),exporter.material('\\rooted-patch')]);
assert.deepEqual(exporter.requirements,[]);
const result=await unpack(glb),first=result.json.materials[a],second=result.json.materials[b];
assert.deepEqual([...await texturePixels(result,first.pbrMetallicRoughness.baseColorTexture.index)],[7,8,9,255]);
assert.deepEqual([...await texturePixels(result,second.pbrMetallicRoughness.baseColorTexture.index)],[255,1,99,0]);
assert.deepEqual(pngPixels(result,second.pbrMetallicRoughness.baseColorTexture.index),[255,1,99,0]);
assert.deepEqual([...await texturePixels(result,second.normalTexture.index)],[7,8,9,255]);
assert.deepEqual([...await texturePixels(result,result.json.materials[rooted].pbrMetallicRoughness.baseColorTexture.index)],[255,1,99,0],'virtual-root Patch and texture references reach the actual selected VTF frame');
// Consumer fidelity, not exporter metadata: the loaded linear colour, carried by the
// real Source vertex material, displays as the authored gamma $color × $color2.
{
  const tintGlb=new SourceGlb(),tintExporter=new SourceMaterialExport(tintGlb,fs),tintIndex=await tintExporter.material('second');
  assert.deepEqual(tintExporter.requirements,[]);
  const loaded=await load(tintGlb),original=await loaded.material(tintIndex),native=sourceVertexMaterial(original,1,{value:1});
  near(displayed(native.color),[1*.5,128/255,64/255*.25]);
  assert.equal(native.opacity,.75);assert.equal(original.transparent,true);assert.equal(native.transparent,true);
  native.dispose();loaded.owner.clear();
}
const suffixGlb=new SourceGlb(),suffixExporter=new SourceMaterialExport(suffixGlb,await filesystem({
  'materials/literal.vmt':'VertexLitGeneric { "$basetexture" "literal.vmt" }',
  'materials/literal.vmt.vtf':vtf({frames:1}),
}));
const suffixMaterial=await suffixExporter.material('literal'),suffixResult=await unpack(suffixGlb);
assert.deepEqual(suffixExporter.requirements,[]);
assert.deepEqual([...await texturePixels(suffixResult,suffixResult.json.materials[suffixMaterial].pbrMetallicRoughness.baseColorTexture.index)],[7,8,9,255],'native expected suffix is appended, not guessed by stripping another extension');
const hdrGlb=new SourceGlb(),hdrExporter=new SourceMaterialExport(hdrGlb,await filesystem({'materials/hdr.vtf':vtf({frames:1,format:24})}));
const hdr=await hdrExporter.texture('materials/hdr.vtf'),hdrResult=await unpack(hdrGlb);
assert.deepEqual([...await texturePixels(hdrResult,hdr)],[2,.5,0,1]);
assert.equal(hdrResult.json.textures[hdr].source,undefined);
assert(hdrResult.json.extensionsRequired.includes('M0CLIP_texture_vtf'));
assert.equal(hdrResult.json.images,undefined,'HDR must not acquire a quantized byte-image fallback');
const cubeGlb=new SourceGlb(),cubeExporter=new SourceMaterialExport(cubeGlb,await filesystem({
  'materials/cube.vtf':vtf({frames:1,faces:6}),
  'materials/local.vmt':'VertexLitGeneric { "$envmap" "env_cubemap" }',
}));
const faces=await Promise.all(Array.from({length:6},(_,face)=>cubeExporter.texture('materials/cube.vtf',0,face)));
const pending=cubeExporter.material('local',faces);faces[0]=faces[5];
const local=await pending,cubeResult=await unpack(cubeGlb),bindings=cubeResult.json.materials[local].extras.sourceMaterial.envmapFaces;
assert.deepEqual(cubeExporter.requirements,[]);
assert.deepEqual([...await texturePixels(cubeResult,bindings[0])],[7,8,9,255]);
assert.deepEqual([...await texturePixels(cubeResult,bindings[5])],[255,5,99,0]);
assert.deepEqual(cubeResult.json.materials[local].pbrMetallicRoughness.baseColorFactor,[0,0,0,1]);
const sphericalGlb=new SourceGlb(),spherical=new SourceMaterialExport(sphericalGlb,await filesystem({
  'materials/sphere.vtf':vtf({frames:1}),
  'materials/sphere.vmt':'VertexLitGeneric { "$envmap" "sphere" }',
}));
const sphere=await spherical.material('sphere'),sphericalResult=await unpack(sphericalGlb);
assert.deepEqual(spherical.requirements,[]);
assert.equal(sphericalResult.json.materials[sphere].extras.sourceMaterial.envmap,'');
assert.deepEqual(sphericalResult.json.materials[sphere].pbrMetallicRoughness.baseColorFactor,[1,1,1,1]);
const blendGlb=new SourceGlb(),blendExporter=new SourceMaterialExport(blendGlb,await filesystem({
  'materials/alpha.vtf':vtf(),'materials/opaque.vtf':vtf({alpha:false}),'materials/cube.vtf':vtf({frames:1,faces:6}),
  'materials/glowmask.vmt':'VertexLitGeneric { "$basetexture" "alpha" "$frame" "1" "$translucent" "1" "$selfillum" "1" }',
  'materials/reflectionmask.vmt':'VertexLitGeneric { "$basetexture" "alpha" "$frame" "1" "$translucent" "1" "$basealphaenvmapmask" "1" }',
  'materials/forcedopaque.vmt':'VertexLitGeneric { "$basetexture" "alpha" "$translucent" "1" "$opaquetexture" "1" }',
  'materials/noalphaflag.vmt':'VertexLitGeneric { "$basetexture" "opaque" "$frame" "1" "$translucent" "1" }',
  'materials/wrongdimension.vmt':'VertexLitGeneric { "$basetexture" "cube" }',
  'materials/maskedadd.vmt':'VertexLitGeneric { "$basetexture" "alpha" "$translucent" "1" "$additive" "1" "$alphatest" "1" }',
}));
for(const name of ['glowmask','reflectionmask','forcedopaque','noalphaflag']){
  const index=await blendExporter.material(name);
  assert.equal(blendGlb.json.materials[index].alphaMode,'OPAQUE','lighting masks/opaque headers must not become transparent');
}
assert.deepEqual(blendExporter.requirements,[]);
const maskedAdd=await blendExporter.material('maskedadd');
assert.equal(blendGlb.json.materials[maskedAdd].alphaMode,'MASK');
assert.equal(blendGlb.json.materials[maskedAdd].extras.sourceMaterial.additive,false,'alpha testing must not activate additive blend state');
await blendExporter.material('wrongdimension');
assert(blendExporter.requirements.some(r=>r.code==='material-texture-dimensionality'&&r.blocking));
const missingGlb=new SourceGlb(),missing=new SourceMaterialExport(missingGlb,await filesystem({
  'materials/missing.vmt':'LightmappedGeneric { "$basetexture" "not_selected" }',
  'materials/proxy.vmt':'UnlitGeneric { Proxies { AnimatedTexture { animatedtexturevar "$basetexture" } } }',
  'materials/bright.vmt':'UnlitGeneric { "$color" "[2 1 1]" }',
}));
await missing.material('missing');assert(missing.requirements.some(r=>r.code==='missing-texture'&&r.path==='materials/not_selected.vtf'&&r.blocking));
await missing.material('proxy');assert(missing.requirements.some(r=>r.code==='material-proxy-runtime'&&r.blocking));
assert.equal(await missing.material('bright'),undefined);assert(missing.requirements.some(r=>r.code==='material-hdr-tint-runtime'&&r.blocking));
const broken=new SourceMaterialExport(new SourceGlb(),await filesystem({'materials/broken.vtf':new Blob(['VTF\0'])}));
await assert.rejects(broken.texture('materials/broken.vtf'));
const bounded=new SourceMaterialExport(new SourceGlb(),fs,{maxInputBytes:64});await assert.rejects(bounded.material('first'));
const smallWorking=new SourceMaterialExport(new SourceGlb(),fs,{maxTextureWorkingBytes:7});
await assert.rejects(smallWorking.material('first'));
const aborted=new AbortController();aborted.abort(new Error('cancel material conversion'));
const cancelled=new SourceMaterialExport(new SourceGlb(),fs,{signal:aborted.signal});assert.throws(()=>cancelled.material('first'));
// Authored scalar alpha, static $basetexturetransform and TextureScroll through the
// actual GLTFLoader -> Source lighting variants -> shadow/export consumers.
const ROTATED='center .5 .5 scale 2 .5 rotate 90 translate .25 -.125',SCALE2='scale 2 2';
const SCROLL='Proxies { TextureScroll { texturescrollvar "$basetexturetransform" texturescrollrate ".5" texturescrollangle "0" texturescale "3" } }';
const stateFs=await filesystem({
  'materials/alpha.vtf':vtf(),'materials/opaque.vtf':vtf({alpha:false}),
  'materials/before.vmt':`VertexLitGeneric { "$basetexture" "opaque" "$alpha" ".25" "$color" "[.5 .5 .5]" "$basetexturetransform" "${SCALE2}" }`,
  'materials/scalar.vmt':'UnlitGeneric { "$alpha" ".25" }',
  'materials/scalartested.vmt':'VertexLitGeneric { "$basetexture" "alpha" "$alpha" ".5" "$alphatest" "1" "$alphatestreference" ".4" }',
  'materials/scalarglow.vmt':'VertexLitGeneric { "$basetexture" "alpha" "$alpha" ".5" "$translucent" "1" "$selfillum" "1" }',
  'materials/scalaradd.vmt':'VertexLitGeneric { "$basetexture" "opaque" "$alpha" ".5" "$additive" "1" }',
  'materials/maskedadd.vmt':'VertexLitGeneric { "$basetexture" "alpha" "$additive" "1" "$alphatest" "1" "$alphatestreference" ".4" }',
  'materials/rotated.vmt':`LightmappedGeneric { "$basetexture" "opaque" "$basetexturetransform" "${ROTATED}" }`,
  'materials/cutout.vmt':`VertexLitGeneric { "$basetexture" "alpha" "$alphatest" "1" "$basetexturetransform" "${ROTATED}" }`,
  'materials/scrolled.vmt':`VertexLitGeneric { "$basetexture" "opaque" "$basetexturetransform" "${ROTATED}" ${SCROLL} }`,
  'materials/animated.vmt':`VertexLitGeneric { "$basetexture" "alpha" "$basetexturetransform" "${ROTATED}" Proxies { AnimatedTexture { animatedtexturevar "$basetexture" animatedtextureframenumvar "$frame" animatedtextureframerate "10" } } }`,
  'materials/detailed.vmt':`VertexLitGeneric { "$basetexture" "opaque" "$detail" "opaque" "$basetexturetransform" "${ROTATED}" }`,
  'materials/bumped.vmt':`LightmappedGeneric { "$basetexture" "opaque" "$bumpmap" "opaque" "$basetexturetransform" "${ROTATED}" }`,
  'materials/skewdetail.vmt':`VertexLitGeneric { "$basetexture" "opaque" "$detail" "opaque" "$detailscale" "[2 3]" }`,
  'materials/detailtransform.vmt':`VertexLitGeneric { "$basetexture" "opaque" "$detail" "opaque" "$detailtexturetransform" "scale 2 2" }`,
  'materials/maskedlightmap.vmt':'LightmappedGeneric { "$basetexture" "opaque" "$selfillum" "1" "$selfillummask" "opaque" }',
  'materials/maskedvertex.vmt':'VertexLitGeneric { "$basetexture" "opaque" "$selfillum" "1" "$selfillummask" "opaque" }',
});
const stateGlb=new SourceGlb(),stateExporter=new SourceMaterialExport(stateGlb,stateFs);
// Companions follow the effective base UVs in the renderer (WebGL coordinates:
// scripts/test_source_base_uv_runtime.cjs), so these combinations are now accepted.
const stateNames=['before','scalar','scalarglow','scalaradd','maskedadd','rotated','cutout','scrolled','animated','detailed','bumped','maskedvertex'];
const stateIndex=Object.fromEntries(await Promise.all(stateNames.map(async name=>[name,await stateExporter.material(name)])));
assert.deepEqual(stateExporter.requirements,[],'common static transforms, companions and scalar alpha are bound, not blocked');
// Still explicit: per-axis detail scale and an independent authored detail matrix.
const companionBlocked=new SourceMaterialExport(new SourceGlb(),stateFs);
for(const [name,code] of [['skewdetail','material-detail-scale-runtime'],['detailtransform','material-texture-transform-runtime']]){
  await companionBlocked.material(name);
  assert(companionBlocked.requirements.some(r=>r.blocking&&r.code===code&&r.path===`materials/${name}.vmt`),name);
}
// Unsupported raw states must stop before verification can assign an installable identity.
for (const [name, code] of [['scalartested', 'material-alpha-test-blend-runtime'], ['maskedlightmap', 'material-lightmapped-selfillum-mask-runtime']]) {
  const blocked = new SourceMaterialExport(new SourceGlb(), stateFs);
  assert.equal(await blocked.material(name), undefined);
  assert(blocked.requirements.some(requirement => requirement.code === code && requirement.blocking));
  let verifying = false;
  await assert.rejects(finalizeSourceAssembly({ files: new Map(), requirements: blocked.requirements }, name, 'Source fixture',
    () => { verifying = true; }), failure => failure.requirements?.some(requirement => requirement.code === code && requirement.blocking));
  assert.equal(verifying, false);
}
const state=await load(stateGlb),owner=state.owner;
const baseMatrix=material=>compile(material,material.isMeshBasicMaterial?'basic':material.isMeshDepthMaterial?'depth':'standard').uniforms.sourceProxyBaseTransform?.value;
async function patched(name,resources={}){
  const original=await state.material(stateIndex[name]),source=owner.own(sourceVertexMaterial(original,1,{value:1}));
  patchSourceMaterial(source,original,resources,undefined,undefined,undefined,0,false,owner);
  return {original,source};
}
// Constant alpha modulation blends; supported cutouts retain MASK. Compound
// alpha-test plus scalar blending is refused above instead of becoming opaque.
{
  const scalar=await state.material(stateIndex.scalar);
  assert.equal(scalar.transparent,true);assert.equal(scalar.opacity,.25);assert.equal(scalar.alphaTest,0);
  const glow=await state.material(stateIndex.scalarglow);
  assert.equal(glow.transparent,true,'selfillum suppresses texture-alpha blending, not constant alpha modulation');
  // BT_BLENDADD is the material's own blend state: the Studio (PBR) original and the
  // Source variant both add alpha-weighted colour without depth writes.
  const add=await patched('scalaradd');
  for(const material of [add.original,add.source]){
    assert.equal(material.transparent,true);assert.equal(material.blending,THREE.AdditiveBlending);assert.equal(material.depthWrite,false);
  }
  const masked=await patched('maskedadd');
  for(const material of [masked.original,masked.source]){
    assert.equal(material.alphaTest,.4,'alpha test keeps precedence');assert.equal(material.transparent,false);
    assert.equal(material.blending,THREE.NormalBlending,'alpha test suppresses additive state in every variant');assert.equal(material.depthWrite,true);
  }
}
// Main's before-control: alpha .25, tint .5, static scale 2 was OPAQUE, gamma factor, metadata-only.
{
  const {original,source}=await patched('before');
  assert.equal(original.transparent,true);assert.equal(source.opacity,.25);
  near(displayed(source.color),[.5,.5,.5],'authored gamma tint');
  for(const material of [original,source])assertBound(baseMatrix(material),(u,v)=>authoredUv(SCALE2,u,v),'static scale 2');
}
let rotatedSource;
{
  const {original,source}=await patched('rotated');rotatedSource=source;
  const lit=owner.own(sourceVertexMaterial(original,6,{value:1}));
  patchSourceMaterial(lit,original,{},undefined,undefined,undefined,0,false,owner);
  for(const material of [original,source,lit])assertBound(baseMatrix(material),(u,v)=>authoredUv(ROTATED,u,v),'static rotated transform in every lighting variant');
  // An opaque silhouette does not depend on UVs; a mesh-level custom depth material stays legal.
  const mesh=new THREE.Mesh(new THREE.BufferGeometry(),source);mesh.customDepthMaterial=new THREE.MeshDepthMaterial();
  bindSourceTemporalShadows(mesh,[original,source]);assert.equal(mesh.onBeforeShadow,THREE.Object3D.prototype.onBeforeShadow);
  // Exported DCC GLB: standard KHR_texture_transform, checked by the spec's own example
  // semantics (offset [0,1], rotation π/2, scale .5 selects the lower-left quadrant):
  // uv' = T(offset)·R·S·uv with R rows [cos sin; -sin cos].
  const writer={extensionsUsed:{}},definition={pbrMetallicRoughness:{baseColorTexture:{index:0}}};
  await sourceBaseTransformWriter(writer).writeMaterialAsync(source,definition);
  assert.equal(writer.extensionsUsed.KHR_texture_transform,true);
  const t=definition.pbrMetallicRoughness.baseColorTexture.extensions.KHR_texture_transform;
  const specUv=(u,v)=>{const c=Math.cos(t.rotation),s=Math.sin(t.rotation),x=t.scale[0]*u,y=t.scale[1]*v;return [c*x+s*y+t.offset[0],-s*x+c*y+t.offset[1]];};
  for(const [u,v] of samples)near(specUv(u,v),authoredUv(ROTATED,u,v),`exported KHR_texture_transform (${u},${v})`);
  // A Studio normal map follows the same base matrix at runtime, so it is exported too.
  const normalOnly={normalTexture:{index:1}};
  await sourceBaseTransformWriter({extensionsUsed:{}}).writeMaterialAsync(original,normalOnly);
  assert.deepEqual(normalOnly.normalTexture.extensions.KHR_texture_transform,t);
}
{
  const {original,source}=await patched('cutout');
  assert(source.alphaTest>0&&source.map,'actual cutout variant');
  const mesh=new THREE.Mesh(new THREE.BufferGeometry(),source);bindSourceTemporalShadows(mesh,[original,source]);
  // Three's shadow pass hands the mesh its private cutout depth material before the draw.
  const depth=new THREE.MeshDepthMaterial({map:source.map,alphaTest:source.alphaTest});
  mesh.onBeforeShadow(null,null,null,null,mesh.geometry,depth,null);
  assertBound(baseMatrix(depth),(u,v)=>authoredUv(ROTATED,u,v),'cutout shadow silhouette');
  const shared=new THREE.Mesh(new THREE.BufferGeometry(),source);shared.customDepthMaterial=new THREE.MeshDepthMaterial();
  assert.throws(()=>bindSourceTemporalShadows(shared,[original,source]),'an untransformed shared cutout shadow is refused');
}
// SDK 2013 TextureScroll OnBind replaces the WHOLE base matrix (src/game/client/
// texturescrollmaterialproxy.cpp, SetMatrixValue): the static transform is not composed.
{
  const {original,source}=await patched('scrolled');
  const sdk=time=>{
    let s=time*Math.cos(0)*.5,t=time*Math.sin(0)*.5;
    if(s<0)s+=1+-Math.trunc(s);if(t<0)t+=1+-Math.trunc(t);s-=Math.trunc(s);t-=Math.trunc(t);
    return (u,v)=>[3*u+s,3*v+t];
  };
  for(const time of [0,1.5,3.5]){owner.update(time);for(const material of [original,source])assertBound(baseMatrix(material),sdk(time),`TextureScroll at ${time}s`);}
  const definition={pbrMetallicRoughness:{baseColorTexture:{index:0}}};
  await sourceBaseTransformWriter({extensionsUsed:{}}).writeMaterialAsync(source,definition);
  assert.equal(definition.pbrMetallicRoughness.baseColorTexture.extensions,undefined,'a time-varying proxy matrix is not exported as static');
}
{
  const original=await state.material(stateIndex.animated);
  const frames=await Promise.all(original.userData.sourceMaterial.animationFrames.map(i=>state.parser.getDependency('texture',i)));
  const {source}=await patched('animated',{frames});
  owner.update(.15);assert.equal(source.map,frames[1]);
  for(const material of [original,source])assertBound(baseMatrix(material),(u,v)=>authoredUv(ROTATED,u,v),'AnimatedTexture keeps the static base matrix');
}
// Prebuilt converter metadata uses the same row-major key; its legacy scroll rate is
// the same SDK TextureScroll (texturescale 1) and replaces the static matrix.
{
  const converted=(meta)=>{
    const original=new THREE.MeshStandardMaterial({map:new THREE.Texture()});original.userData.sourceMaterial={shader:'vertexlitgeneric',unlit:true,...meta};
    const source=owner.own(sourceVertexMaterial(original,1,{value:1}));patchSourceMaterial(source,original,{},undefined,undefined,undefined,0,false,owner);return source;
  };
  assertBound(baseMatrix(converted({basetexturetransform:[0,-.5,.75,2,0,-.5,0,0,1]})),(u,v)=>[.75-.5*v,2*u-.5],'converted static transform');
  owner.update(1.75);
  assertBound(baseMatrix(converted({basetexturetransform:[2,0,0,0,2,0,0,0,1],scroll:[.5,0]})),(u,v)=>[u+.875,v],'converter TextureScroll on the shared base matrix');
}
owner.clear();
assert(baseMatrix(rotatedSource).equals(new THREE.Matrix3()),'a cleared map releases its static binding');
{
  const definition={pbrMetallicRoughness:{baseColorTexture:{index:0}}};
  await sourceBaseTransformWriter({extensionsUsed:{}}).writeMaterialAsync(rotatedSource,definition);
  assert.equal(definition.pbrMetallicRoughness.baseColorTexture.extensions,undefined);
}
console.log('Source material GLB resources preserve real frames, transparent PNG pixels, HDR, cubemap bindings and bounded concurrent ownership; unresolved capabilities remain blocking. GLTFLoader consumers: authored gamma tint, scalar-alpha blend/alpha-test precedence, static base UV in lighting/shadow/export, TextureScroll replacement. CPU uniforms only, no GPU pixels.');
