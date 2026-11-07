/** CPU material packaging, not Chrome/GPU or complete-map qualification. */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { build } from 'esbuild';
const compiled=await build({stdin:{contents:"export * from './src/maps/raw-source-materials';export * from './src/maps/raw-source-gltf';export * from './src/maps/raw-source-files';export * from './src/maps/raw-source-vtf';",resolveDir:process.cwd(),loader:'ts'},bundle:true,platform:'node',format:'cjs',write:false});
const module={exports:{}};
new Function('module','require',compiled.outputFiles[0].text)(module,createRequire(import.meta.url));
const {SourceMaterialExport,SourceGlb,SourceFileSystem,readSourceVtf}=module.exports;
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
assert.deepEqual(second.pbrMetallicRoughness.baseColorFactor,[.5,128/255,64/255*.25,.75]);
assert.equal(second.alphaMode,'BLEND');
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
console.log('Source material GLB resources preserve real frames, transparent PNG pixels, HDR, cubemap bindings and bounded concurrent ownership; unresolved capabilities remain blocking.');
