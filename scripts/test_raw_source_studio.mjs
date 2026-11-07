/** Browser studio/prop CPU boundaries; no temporal, physics or visual qualification.
 * node scripts/test_raw_source_studio.mjs
 * Real explicit loose mounts: append --model models/props_rooftop/roof_vent002.mdl
 * --root /.../vpk-files/https___z.noclip.website_HalfLife2_hl2_misc
 * --root /.../vpk-files/https___z.noclip.website_HalfLife2_hl2_textures
 * Optional --bsp /.../nt_ghost_ctg.bsp exercises real absolute sprp offsets.
 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';


import { spawnSync } from 'node:child_process';
import { build } from 'esbuild';
import { zipSync } from 'fflate';
const compiled=await build({stdin:{contents:"export * from './src/maps/raw-source-studio'; export * from './src/maps/raw-source-props'; export * from './src/maps/raw-source-bsp'; export * from './src/maps/raw-source-model-binary'; export * from './src/maps/raw-source-vmt'; export * from './src/maps/raw-source-files';",resolveDir:process.cwd(),loader:'ts'},bundle:true,platform:'node',format:'cjs',write:false});
const module={exports:{}};new Function('module','require',compiled.outputFiles[0].text)(module,createRequire(import.meta.url));
const {readSourceStudioModel,SourceStudioImport,SourceFileSystem,sourceStudioMeshMaterial,selectSourceStudioMeshes,SourceStudioMissingResourceError,sourcePropMatrix,sourceModelPoint,sourceQAngle,readSourceProps,readSourceBsp,decodeSourceWorld,resolveSourceMaterial}=module.exports;
const frame={origin:[100,200,300],yaw:90,metresPerUnit:.0254,up:'Z',spawnClass:'fixture',floorFound:true};
const near=(actual,expected)=>actual.forEach((v,i)=>assert(Math.abs(v-expected[i])<1e-6,`${actual} != ${expected}`));
near(sourceModelPoint(sourceQAngle([90,0,0]),[1,0,0]),[0,0,-1]);
near(sourceModelPoint(sourceQAngle([0,0,90]),[0,1,0]),[0,0,1]);
near(sourceModelPoint(sourceQAngle([0,90,0]),[1,0,0]),[0,1,0]);
near(sourceModelPoint(sourcePropMatrix(frame,[100,300,300],[0,90,0],2),[1,0,0]),[4.54,0,0]);
assert.throws(()=>sourcePropMatrix(frame,[0,0,0],[0,0,0],0));
function fixture(){
  const mdl=Buffer.alloc(1400),vvd=Buffer.alloc(64+36+3*48+3*16),vtx=Buffer.alloc(400);
  mdl.write('IDST');mdl.writeUInt32LE(48,4);mdl.writeUInt32LE(123,8);mdl.write('fixture',12);mdl.writeUInt32LE(mdl.length,76);
  const u=(b,p,n)=>b.writeUInt32LE(n,p),f=(b,p,n)=>b.writeFloatLE(n,p),h=(b,p,n)=>b.writeUInt16LE(n,p);
  // One default bone translated along +Y; bind positions must NOT get this
  // transform baked again. Global bone indices come from VVD, not HW slots.
  u(mdl,0x9c,1);u(mdl,0xa0,408);u(mdl,408,216);mdl.writeInt32LE(-1,412);f(mdl,408+36,2);f(mdl,408+56,1);
  for(let i=0;i<3;i++)f(mdl,408+96+i*16+i*4,1);f(mdl,408+96+16+12,-2);mdl.write('root',624);
  u(mdl,0xcc,2);u(mdl,0xd0,640);u(mdl,640,128);mdl.write('a',768);u(mdl,704,68);mdl.write('b',772);
  u(mdl,0xdc,1);u(mdl,0xe0,2);u(mdl,0xe4,780);h(mdl,780,0);h(mdl,782,1);
  u(mdl,0xe8,1);u(mdl,0xec,784);u(mdl,784,16);u(mdl,788,1);u(mdl,792,1);u(mdl,796,24);mdl.write('body',800);
  mdl.write('mesh',808);u(mdl,808+72,1);u(mdl,808+76,148);u(mdl,808+80,3);u(mdl,956+8,3);
  vvd.write('IDSV');u(vvd,4,4);u(vvd,8,123);u(vvd,12,2);u(vvd,16,3);u(vvd,20,3);u(vvd,48,3);u(vvd,52,64);u(vvd,56,100);u(vvd,60,244);
  // Independently permute the on-disk records: logical triangle uses 2,0,1.
  for(let i=0;i<3;i++){u(vvd,64+i*12,1);u(vvd,68+i*12,[2,0,1][i]);u(vvd,72+i*12,1);}
  [[1,0,0],[0,1,0],[0,0,0]].forEach((p,i)=>{const r=100+i*48;f(vvd,r,1);vvd[r+15]=1;p.forEach((n,k)=>f(vvd,r+16+k*4,n));f(vvd,r+36,1);f(vvd,244+i*16,1);f(vvd,256+i*16,1);});
  u(vtx,0,7);u(vtx,16,123);u(vtx,20,2);u(vtx,28,1);u(vtx,32,36);u(vtx,36,1);u(vtx,40,8);u(vtx,44,2);u(vtx,48,8);
  for(let l=0;l<2;l++){const p=52+l*12;u(vtx,p,1);u(vtx,p+4,24-l*12);f(vtx,p+8,l*20);}
  u(vtx,76,1);u(vtx,80,9);u(vtx,85,3);u(vtx,89,25);u(vtx,93,3);u(vtx,97,52);u(vtx,101,1);u(vtx,105,58);vtx[109]=2;
  for(let i=0;i<3;i++){const p=110+i*9;vtx[p+3]=1;h(vtx,p+4,i);vtx[p+6]=7;h(vtx,137+i*2,i);}
  u(vtx,143,3);u(vtx,151,3);vtx[161]=1;
  const files={'models/fixture.mdl':new Blob([mdl]),'models/fixture.vvd':new Blob([vvd]),'models/fixture.dx90.vtx':new Blob([vtx]),'materials/a.vmt':new Blob(['VertexLitGeneric {}']),'materials/b.vmt':new Blob(['VertexLitGeneric {}'])};
  return {mdl,vvd,vtx,files,fs:{readFile:async path=>files[path]}};
}
let data=fixture(),model=await readSourceStudioModel(data.fs,'models/fixture.mdl');
assert.deepEqual(Array.from(model.meshes[0].positions),[0,0,0,1,0,0,0,1,0]);
assert.deepEqual(Array.from(model.meshes[0].indices),[0,1,2]);
assert.deepEqual(Array.from(model.meshes[0].joints),new Array(12).fill(0));
assert.equal(model.bones[0].defaultWorldMatrix[13],2);assert.equal(model.bones[0].inverseBindMatrix[13],-2);
assert.equal(sourceStudioMeshMaterial(model.meshes[0],1).path,'materials/b.vmt');assert.equal(sourceStudioMeshMaterial(model.meshes[0],999).path,'materials/a.vmt');
assert.equal(selectSourceStudioMeshes(model).length,1);assert.equal((await readSourceStudioModel(data.fs,'models/fixture.mdl',{lod:1})).meshes[0].switchPoint,20);
// Render bounds and collision hulls have different consumers. A nonzero view
// endpoint must win even when its other endpoint is exactly the origin.
for (const [view, expectedWidth] of [
  [[[-10, -20, -30], [10, 20, 30]], 20],
  [[[0, 0, 0], [0, 0, 0]], 2],
  [[[0, 0, 0], [10, 20, 30]], 10],
  [[[-10, -20, -30], [0, 0, 0]], 10],
]) {
  const native = fixture();
  const hull = [[-1, -2, -3], [1, 2, 3]];
  for (let endpoint = 0; endpoint < 2; endpoint++) for (let axis = 0; axis < 3; axis++) {
    native.mdl.writeFloatLE(hull[endpoint][axis], 104 + endpoint * 12 + axis * 4);
    native.mdl.writeFloatLE(view[endpoint][axis], 128 + endpoint * 12 + axis * 4);
  }
  native.files['models/fixture.mdl'] = new Blob([native.mdl]);
  const selected = await readSourceStudioModel(native.fs, 'models/fixture.mdl');
  assert.equal(selected.bounds[1][0] - selected.bounds[0][0], 2, 'Render bounds cannot replace the collision hull');
  assert.equal(selected.renderBounds[1][0] - selected.renderBounds[0][0], expectedWidth,
    'Native view-bound selection controls projected render size independently of the collision hull');
}
const byteNamed=fixture();byteNamed.mdl.set([0x80,0xff,0],624);byteNamed.files['models/fixture.mdl']=new Blob([byteNamed.mdl]);
assert.equal((await readSourceStudioModel(byteNamed.fs,'models/fixture.mdl')).bones[0].name,'\u0080\u00ff');
for(const [file,offset,value] of [['vvd',8,9],['vvd',68,99],['vvd',80,2],['vtx',139,8],['mdl',780,9],['vtx',89,99999],['mdl',412,0]]){
  const f=fixture();if(file==='vtx'&&offset===139)f[file].writeUInt16LE(value,offset);else if(file==='mdl'&&offset===780)f[file].writeUInt16LE(value,offset);else f[file].writeUInt32LE(value,offset);
  f.files[`models/fixture.${file==='vtx'?'dx90.vtx':file}`]=new Blob([f[file]]);await assert.rejects(readSourceStudioModel(f.fs,'models/fixture.mdl'));
}
const missing=fixture();delete missing.files['models/fixture.vvd'];await assert.rejects(readSourceStudioModel(missing.fs,'models/fixture.mdl'),error=>error instanceof SourceStudioMissingResourceError&&error.paths[0]==='models/fixture.vvd');
const cancelled=new AbortController();cancelled.abort();await assert.rejects(readSourceStudioModel(data.fs,'models/fixture.mdl',{signal:cancelled.signal}),error=>error.name==='AbortError');
// Contradictory zero/cardinality fields reject before material or skin loops.
for(const [refs,families,options] of [[0,3,{}],[1,0,{}],[1,3,{maxSkinFamilies:2}],[3,1,{maxSkinReferences:2}]]){
  const malformed=fixture();malformed.mdl.writeUInt32LE(refs,0xdc);malformed.mdl.writeUInt32LE(families,0xe0);
  malformed.files['models/fixture.mdl']=new Blob([malformed.mdl]);
  await assert.rejects(readSourceStudioModel(malformed.fs,'models/fixture.mdl',options));
}
// A tiny decoded cap must reject before making even the first MDL buffer copy.
let decodedCopies=0;
class CountedStudioBlob extends Blob { async arrayBuffer(){decodedCopies++;return super.arrayBuffer();} }
const guarded=fixture();for(const key of ['mdl','vvd','dx90.vtx']){const path=`models/fixture.${key}`;guarded.files[path]=new CountedStudioBlob([guarded.files[path]]);}
await assert.rejects(readSourceStudioModel(guarded.fs,'models/fixture.mdl',{maxMetadataBytes:1400}));
assert.equal(decodedCopies,0);
await assert.rejects(readSourceStudioModel(data.fs,'models/fixture.mdl',{maxMetadataObjects:1}));
async function metadataFixture(sequenceCount,gridCount=4096){
  const animationStart=408,sequenceStart=508,gridStart=sequenceStart+sequenceCount*212,nameStart=gridStart+gridCount*2;
  const mdl=Buffer.alloc(nameStart+16),vvd=Buffer.alloc(64),vtx=Buffer.alloc(36),u=(b,p,n)=>b.writeUInt32LE(n,p);
  mdl.write('IDST');u(mdl,4,48);u(mdl,76,mdl.length);u(mdl,0xb4,1);u(mdl,0xb8,animationStart);u(mdl,animationStart+4,nameStart-animationStart);mdl.writeFloatLE(24,animationStart+8);u(mdl,animationStart+16,1);
  u(mdl,0xbc,sequenceCount);u(mdl,0xc0,sequenceStart);mdl.write('aliased',nameStart);
  for(let index=0;index<sequenceCount;index++){const p=sequenceStart+index*212;u(mdl,p+4,nameStart-p);u(mdl,p+8,nameStart+8-p);u(mdl,p+60,gridStart-p);u(mdl,p+68,gridCount);u(mdl,p+72,1);}
  vvd.write('IDSV');u(vvd,4,4);u(vvd,12,1);u(vvd,56,64);u(vvd,60,64);u(vtx,0,7);u(vtx,20,1);
  return SourceFileSystem.create([{kind:'loose',files:[{path:'models/metadata.mdl',blob:new Blob([mdl])},{path:'models/metadata.vvd',blob:new Blob([vvd])},{path:'models/metadata.dx90.vtx',blob:new Blob([vtx])}]}]);
}
const singleGrid=await readSourceStudioModel(await metadataFixture(1),'models/metadata.mdl',{maxMetadataBytes:32768});
assert.equal(singleGrid.animation.sequences[0].animationIndices.length,4096);
await assert.rejects(readSourceStudioModel(await metadataFixture(4),'models/metadata.mdl',{maxMetadataBytes:32768}));
await assert.rejects(readSourceStudioModel(await metadataFixture(4,1),'models/metadata.mdl',{maxMetadataObjects:60}));
const metadataCancel=new AbortController(),metadataPending=readSourceStudioModel(await metadataFixture(300,1),'models/metadata.mdl',{signal:metadataCancel.signal});
setTimeout(()=>metadataCancel.abort(),0);await assert.rejects(metadataPending,error=>error.name==='AbortError');
// Genuine compressed resources exercise canonical reader ownership, not a
// pre-extracted fixture filesystem. Every root/include keeps its own identity.
function graphMdl(includes=[]){
  const mdl=Buffer.alloc(2200);fixture().mdl.copy(mdl);mdl.writeUInt32LE(mdl.length,76);
  mdl.writeUInt32LE(1400,0x15c);mdl.write('Models\\Shared.ani',1400);
  mdl.writeUInt32LE(includes.length,0x150);mdl.writeUInt32LE(1480,0x154);
  let stringStart=1600;for(let index=0;index<includes.length;index++){const p=1480+index*8;mdl.writeUInt32LE(stringStart-p,p+4);mdl.write(includes[index],stringStart);stringStart+=includes[index].length+1;}
  return mdl;
}
const graphFiles={
  'models/fixture.mdl':graphMdl(['models/child.mdl','models/nested.mdl']),
  'models/fixture.vvd':fixture().vvd,'models/fixture.dx90.vtx':fixture().vtx,
  'models/second.mdl':graphMdl(['models/child.mdl']),
  'models/second.vvd':fixture().vvd,'models/second.dx90.vtx':fixture().vtx,
  'models/child.mdl':graphMdl(),'models/nested.mdl':graphMdl(['MODELS\\CHILD.MDL']),
  'models/shared.ani':Buffer.alloc(64),'materials/a.vmt':Buffer.from('VertexLitGeneric {}'),'materials/b.vmt':Buffer.from('VertexLitGeneric {}'),
};
const graphArchive=new Blob([zipSync(graphFiles)]),graphInputBytes=Object.values(graphFiles).reduce((n,bytes)=>n+bytes.length,0);
async function graphFilesystem(archive=graphArchive){
  const fs=await SourceFileSystem.create([{kind:'zip',file:archive}]),counts=new Map();
  return {counts,readFile:(path,signal,maxBytes)=>{
    counts.set(path,(counts.get(path)??0)+1);
    return fs.readFile(path,signal,maxBytes);
  }};
}
const graphFs=await graphFilesystem(),graphImport=new SourceStudioImport(graphFs,{maxInputBytes:graphInputBytes});
const [graphRoot,graphSecond]=await Promise.all([graphImport.readModel('MODELS\\FIXTURE.MDL'),graphImport.readModel('models/second.mdl')]);
const child=graphRoot.animation.includedModels[0],nested=graphRoot.animation.includedModels[1];
assert.equal(child.path,'models/child.mdl');assert.equal(nested.path,'models/nested.mdl');assert.notStrictEqual(child.rawBlob,nested.rawBlob);
assert.strictEqual(child,nested.animation.includedModels[0]);assert.strictEqual(child,graphSecond.animation.includedModels[0]);
assert.strictEqual(graphRoot.animation.companions[0].blob,child.animation.companions[0].blob);assert.strictEqual(child.animation.companions[0].blob,nested.animation.companions[0].blob);assert.strictEqual(graphSecond.animation.companions[0].blob,child.animation.companions[0].blob);
assert.strictEqual(await graphImport.readModel('models/fixture.mdl'),graphRoot);
const tightFs=await graphFilesystem(),tightImport=new SourceStudioImport(tightFs,{maxInputBytes:graphInputBytes-1});
await tightImport.readModel('models/fixture.mdl');await assert.rejects(tightImport.readModel('models/second.mdl'));
const fileCapFs=await graphFilesystem();await assert.rejects(readSourceStudioModel(fileCapFs,'models/fixture.mdl',{maxFileBytes:408}));
for(const [limits,blockedPath] of [[{maxIncludedModels:2},'models/nested.mdl'],[{maxIncludeDepth:1},'models/child.mdl']]){
  const fs=await graphFilesystem();await assert.rejects(readSourceStudioModel(fs,'models/fixture.mdl',limits));assert.equal(fs.counts.has(blockedPath),false);
}
const depthFs=await graphFilesystem(),depthImport=new SourceStudioImport(depthFs,{maxIncludeDepth:2});
await depthImport.readModel('models/second.mdl');await assert.rejects(depthImport.readModel('models/fixture.mdl'));
const strip=fixture(),oldStrip=Buffer.from(strip.vtx.subarray(143,170));oldStrip.copy(strip.vtx,155);
strip.vtx.writeUInt32LE(6,93);strip.vtx.writeUInt32LE(70,105);strip.vtx.writeUInt32LE(6,155);strip.vtx[173]=2;
[0,1,2,2,1,0].forEach((value,i)=>strip.vtx.writeUInt16LE(value,137+i*2));
strip.files['models/fixture.dx90.vtx']=new Blob([strip.vtx]);
assert.deepEqual(Array.from((await readSourceStudioModel(strip.fs,'models/fixture.mdl')).meshes[0].indices),[0,1,2,1,2,0]);
const quad=fixture(),quadPayload=Buffer.from(quad.vtx.subarray(110,170));
quad.mdl.writeUInt32LE(49,4);quad.vtx.fill(0,110,190);quadPayload.copy(quad.vtx,118);
quad.vtx.writeUInt32LE(33,89);quad.vtx.writeUInt32LE(60,97);quad.vtx.writeUInt32LE(66,105);
quad.files['models/fixture.mdl']=new Blob([quad.mdl]);
quad.files['models/fixture.dx90.vtx']=new Blob([quad.vtx]);
assert.deepEqual(Array.from((await readSourceStudioModel(quad.fs,'models/fixture.mdl')).meshes[0].indices),[0,1,2]);
for(const flag of [2,4]){
  quad.vtx[169]=flag;quad.files['models/fixture.dx90.vtx']=new Blob([quad.vtx]);
  await assert.rejects(readSourceStudioModel(quad.fs,'models/fixture.mdl'));
}
const bodygroups={...model,meshes:[{...model.meshes[0],bodyBase:2,bodyCount:2,submodel:0},{...model.meshes[0],bodyBase:2,bodyCount:2,submodel:1}]};
assert.equal(selectSourceStudioMeshes(bodygroups,2)[0].submodel,1);
const unresolved=fixture();delete unresolved.files['materials/b.vmt'];
assert.equal(sourceStudioMeshMaterial((await readSourceStudioModel(unresolved.fs,'models/fixture.mdl')).meshes[0],1).path,undefined);
const animated=fixture(),animatedMdl=Buffer.alloc(1600);animated.mdl.copy(animatedMdl);animatedMdl.writeUInt32LE(1600,76);
animatedMdl.writeUInt32LE(1,0xb4);animatedMdl.writeUInt32LE(1072,0xb8);animatedMdl.writeUInt32LE(100,1076);animatedMdl.write('move',1172);animatedMdl.writeFloatLE(24,1080);animatedMdl.writeUInt32LE(2,1088);
animatedMdl.writeUInt32LE(1,0xbc);animatedMdl.writeUInt32LE(1180,0xc0);animatedMdl.writeUInt32LE(212,1184);animatedMdl.write('run',1392);animatedMdl.writeUInt32LE(220,1240);animatedMdl.writeUInt32LE(1,1248);animatedMdl.writeUInt32LE(1,1252);
animatedMdl.writeUInt32LE(2,0x160);animatedMdl.writeUInt32LE(1420,0x164);animatedMdl.writeUInt32LE(4,1432);animatedMdl.writeUInt32LE(1440,0x15c);animatedMdl.write('models/fixture.ani',1440);animatedMdl.writeUInt32LE(1,1124);
animated.files['models/fixture.mdl']=new Blob([animatedMdl]);animated.files['models/fixture.ani']=new Blob([new Uint8Array(4)]);
const native=await readSourceStudioModel(animated.fs,'models/fixture.mdl');
assert.equal(native.animation.animations[0].fps,24);assert.equal(native.animation.sequences[0].name,'run');assert.equal(native.animation.companions[0].blob.size,4);assert.equal(native.animation.temporalSupport,'encoded-data-preserved-not-sampled');
delete animated.files['models/fixture.ani'];assert.deepEqual((await readSourceStudioModel(animated.fs,'models/fixture.mdl')).missingResources,['models/fixture.ani']);
animatedMdl.writeUInt32LE(1,0x150);animatedMdl.writeUInt32LE(1460,0x154);animatedMdl.writeUInt32LE(8,1464);animatedMdl.write('models/included',1468);
animated.files['models/fixture.mdl']=new Blob([animatedMdl]);animated.files['models/included.mdl']=new Blob([fixture().mdl]);
const included=await readSourceStudioModel(animated.fs,'models/fixture.mdl');assert.equal(included.animation.includedModels[0].path,'models/included.mdl');assert(included.requiredCompanions.includes('models/included.mdl'));
animatedMdl.fill(0,1468,1500);animatedMdl.write('models/fixture.mdl',1468);animated.files['models/fixture.mdl']=new Blob([animatedMdl]);
await assert.rejects(readSourceStudioModel(animated.fs,'models/fixture.mdl'));
function valveCompressed(payload){
  const encoded=spawnSync('python3',['-c','import lzma,sys;sys.stdout.buffer.write(lzma.compress(sys.stdin.buffer.read(),format=lzma.FORMAT_ALONE))'],{input:payload});
  if(encoded.status!==0)throw new Error(`Independent fixture LZMA encoding failed: ${encoded.stderr}`);
  const alone=encoded.stdout,result=Buffer.alloc(17+alone.length-13);
  result.write('LZMA');result.writeUInt32LE(payload.length,4);result.writeUInt32LE(alone.length-13,8);alone.copy(result,12,0,5);alone.copy(result,17,13);return result;
}
// Absolute BSP game-lump offset is deliberately unrelated to its Blob-relative
// directory position. Version5 carries lighting origin and authored leaf IDs.
function propWorld({version=5,bspVersion=20,compressed=false,outerCompressed=false,useLightingOrigin=true,lightingOrigin=[100,300,300]}={}){
  const sizes={4:56,5:60,6:64,11:80},sprp=Buffer.alloc(142+sizes[version]);sprp.writeUInt32LE(1,0);sprp.write('models/fixture.mdl',4);sprp.writeUInt32LE(1,132);sprp.writeUInt16LE(0,136);sprp.writeUInt32LE(1,138);
  const p=142;sprp.writeFloatLE(100,p);sprp.writeFloatLE(300,p+4);sprp.writeFloatLE(300,p+8);sprp.writeFloatLE(90,p+16);sprp.writeUInt16LE(1,p+28);sprp[p+31]=useLightingOrigin?2:0;lightingOrigin.forEach((v,i)=>sprp.writeFloatLE(v,p+44+i*4));
  if(version>=5)sprp.writeFloatLE(1,p+56);
  if(version===6){sprp.writeUInt16LE(70,p+60);sprp.writeUInt16LE(95,p+62);}
  if(version===11){Buffer.from([1,2,3,4,11,22,33,44]).copy(sprp,p+60);sprp.writeUInt32LE(0x100,p+72);sprp.writeFloatLE(2,p+76);}
  const payload=compressed?valveCompressed(sprp):sprp,game=Buffer.alloc(20+payload.length+(compressed?4:0));game.write('prps',4);game.writeUInt16LE(compressed?1:0,8);game.writeUInt16LE(version,10);game.writeUInt32LE(1020,12);game.writeUInt32LE(sprp.length,16);game.writeUInt32LE(1,0);payload.copy(game,20);
  const original=Buffer.alloc(1000+game.length);game.copy(original,1000);const worldModel=Buffer.alloc(48),lumps=Array.from({length:64},()=>({length:0,version:0}));lumps[35]={offset:1000,length:outerCompressed?40:game.length,uncompressedSize:outerCompressed?game.length:0};lumps[10]={length:56,version:0};
  // Budget ownership is proven by test_raw_source_admission.mjs against a real BSP reader.
  return {frame,bsp:{file:new Blob([original]),version:bspVersion,entities:[],lumps,getLump:async index=>index===35?new Uint8Array(game):index===10?new Uint8Array(56):index===14?new Uint8Array(worldModel):new Uint8Array(),reserve:()=>({complete(){},fail(){}})},surfaces:[],collision:[],reachableLeaves:new Uint32Array([0])};
}
const props=await readSourceProps(propWorld(),data.fs);assert.equal(props.placements.length,1);assert.equal(props.completeResources,true);near(props.placements[0].worldLightingOrigin,[2.54,0,0]);assert.equal(props.gameLumps[0].absoluteOffset,1020);
const absent=await readSourceProps(propWorld(),{readFile:async()=>undefined});assert.equal(absent.placements.length,1);assert.equal(absent.models.size,0);assert.equal(absent.completeResources,false);assert.equal(absent.missingModels[0].resources.length,3);
for(const settings of [{version:4},{version:6},{version:11,bspVersion:21},{compressed:true},{outerCompressed:true}]){
  const parsed=await readSourceProps(propWorld(settings),data.fs),p=parsed.placements[0];
  assert.equal(parsed.placements.length,1);near(p.worldLightingOrigin,[2.54,0,0]);
  if(settings.version===6)assert.deepEqual(p.dxLevels,[70,95]);
  if(settings.version===11){assert.equal(p.scale,2);assert.equal(p.flagsEx,0x100);assert.deepEqual(p.diffuseModulation,[11,22,33,44]);assert.deepEqual(p.cpuLevels,[1,2]);}
}
// Inactive native lighting-origin bytes may contain NaN/garbage; active fields remain strict.
const inactiveLight=await readSourceProps(propWorld({useLightingOrigin:false,lightingOrigin:[NaN,Infinity,-Infinity]}),data.fs);
near(inactiveLight.placements[0].sourceLightingOrigin,[100,300,300]);
near(inactiveLight.placements[0].worldLightingOrigin,[2.54,0,0]);
await assert.rejects(readSourceProps(propWorld({lightingOrigin:[NaN,300,300]}),data.fs));
const nofixup=fixture();nofixup.vvd.writeUInt32LE(0,48);nofixup.files['models/fixture.vvd']=new Blob([nofixup.vvd]);
assert.deepEqual(Array.from((await readSourceStudioModel(nofixup.fs,'models/fixture.mdl')).meshes[0].positions),[1,0,0,0,1,0,0,0,0]);
for(const path of ['../fixture.mdl','/models/fixture.mdl','models/../fixture.mdl','models/a:b.mdl','models/\u0001.mdl'])await assert.rejects(readSourceStudioModel(data.fs,path));
// Real BSP->shared geometry->prop assembly. The only face belongs to model1;
// worldmodel0 has no faces. Two brush entities instance that same owned model.
function brushBsp(renderKeys='"rendercolor" "10 20 30"',brushKeys='',extraEntities=[]){
  const entries=new Map(),put=(id,bytes,version=0)=>entries.set(id,{bytes,version});
  const entityText=[
    `{"classname" "func_door" "model" "*1" "origin" "100 300 300" "angles" "0 90 0" ${brushKeys}}`,
    '{"classname" "trigger_multiple" "model" "*1"}',
    `{"classname" "prop_dynamic" "model" "models/fixture.mdl" "origin" "100 300 300" "angles" "0 90 0" "modelscale" "2" "DefaultAnim" "idle" "skin" "1" ${renderKeys}}`,
    ...extraEntities,
  ].join(String.fromCharCode(10));
  put(0,Buffer.concat([Buffer.from(entityText),Buffer.alloc(1)]));
  const plane=Buffer.alloc(20);plane.writeFloatLE(1,8);put(1,plane);
  const texture=Buffer.alloc(32);texture.writeInt32LE(64,16);texture.writeInt32LE(64,20);put(2,texture);
  const verts=Buffer.alloc(36);verts.writeFloatLE(10,16);verts.writeFloatLE(10,24);put(3,verts);
  const texinfo=Buffer.alloc(72);texinfo.writeFloatLE(1,0);texinfo.writeFloatLE(-1,20);texinfo.writeFloatLE(1,32);texinfo.writeFloatLE(-1,52);put(6,texinfo);
  const face=Buffer.alloc(56);face.writeInt16LE(3,8);face.writeInt16LE(-1,12);face.fill(255,16,20);face.writeInt32LE(-1,20);put(7,face,1);
  const leaf=Buffer.alloc(56);leaf.writeInt16LE(-1,4);put(10,leaf);
  const edges=Buffer.alloc(12);[0,1,1,2,2,0].forEach((n,i)=>edges.writeUInt16LE(n,i*2));put(12,edges);
  const surfedges=Buffer.alloc(12);[0,1,2].forEach((n,i)=>surfedges.writeInt32LE(n,i*4));put(13,surfedges);
  const models=Buffer.alloc(96);models.writeInt32LE(-1,36);models.writeInt32LE(-1,84);models.writeInt32LE(1,92);put(14,models);
  put(43,Buffer.concat([Buffer.from('brick/fixture'),Buffer.alloc(1)]));put(44,Buffer.alloc(4));
  const header=Buffer.alloc(1036);header.write('VBSP');header.writeInt32LE(20,4);let offset=1036;const payloads=[];
  for(const [id,{bytes,version}] of entries){header.writeUInt32LE(offset,8+id*16);header.writeUInt32LE(bytes.length,12+id*16);header.writeUInt32LE(version,16+id*16);payloads.push(bytes);offset+=bytes.length;}
  return new Blob([header,...payloads]);
}
const brushWorld=await decodeSourceWorld(await readSourceBsp(brushBsp()),{spawn:{origin:frame.origin,yaw:frame.yaw}});
const visuals=await readSourceProps(brushWorld,data.fs);
assert.equal(brushWorld.surfaces.length,0);assert.equal(visuals.brushes.length,2);assert.equal(visuals.brushes[0].baselineVisible,true);assert.equal(visuals.brushes[1].baselineVisible,false);assert.equal(visuals.entities.length,3);
assert.equal(visuals.placements[0].animation.defaultAnimation,'idle');assert.deepEqual(visuals.placements[0].render.color,[10,20,30]);near(sourceModelPoint(visuals.placements[0].matrix,[1,0,0]),[4.54,0,0]);
assert.strictEqual(visuals.brushes[0].surfaces,visuals.brushes[1].surfaces,'Repeated submodels share one decoded surface array');
const surface=visuals.brushes[0].surfaces[0];assert.equal(surface.material,'brick/fixture');assert.equal(surface.indices.length,3);
near(Array.from(surface.sourcePositions.subarray(3,6)),[0,10,0]);near(Array.from(surface.positions.subarray(3,6)),[0,.254,0]);
near(sourceModelPoint(visuals.brushes[0].matrix,Array.from(surface.positions.subarray(3,6))),[2.54,.254,0]);
const propsGraphWorld=await decodeSourceWorld(await readSourceBsp(brushBsp(undefined,'',['{"classname" "prop_dynamic" "model" "models/second.mdl"}'])));
const propsGraphFs=await graphFilesystem(),propsGraph=await readSourceProps(propsGraphWorld,propsGraphFs,{maxInputBytes:graphInputBytes});
assert.equal(propsGraph.models.size,2);assert.equal(propsGraphFs.counts.get('models/shared.ani'),1);assert.equal(propsGraphFs.counts.get('models/child.mdl'),1);
assert.strictEqual(propsGraph.models.get('models/fixture.mdl').animation.includedModels[0],propsGraph.models.get('models/second.mdl').animation.includedModels[0]);
const missingTripletFiles={...graphFiles};delete missingTripletFiles['models/fixture.vvd'];
const missingTripletProps=await readSourceProps(propsGraphWorld,await graphFilesystem(new Blob([zipSync(missingTripletFiles)])));
assert.deepEqual(missingTripletProps.missingModels,[{path:'models/fixture.mdl',resources:['models/fixture.vvd']}]);assert.equal(missingTripletProps.models.has('models/second.mdl'),true);
for(const [keys,color,amount] of [
  ['"rendercolor" "221 244 255 50"',[221,244,255],50],
  ['"rendercolor" "221 244 255 50" "renderamt" "90"',[221,244,255],90],
  ['"renderamt" "90" "rendercolor32" "221 244 255 50"',[221,244,255],50],
  ['"rendercolor" "1 2 3 50" "rendercolor" "10 20 30"',[10,20,30],255],
  ['"rendercolor" "1 2 3 10" "rendercolor32#1" "221 244 255 50" "renderamt#2" "90"',[221,244,255],90],
  ['"rendercolor" "257 -1 258 256"',[1,255,2],0],
]){
  const world=await decodeSourceWorld(await readSourceBsp(brushBsp(keys)));
  const props=await readSourceProps(world,data.fs),render=props.placements[0].render;
  assert.deepEqual(render.color,color);assert.equal(render.amount,amount);
}
for(const [keys,visible] of [
  ['"rendermode" "0" "renderamt" "0"',true],
  ['"rendermode" "1" "renderamt" "0"',false],
  ['"rendermode" "1" "renderamt" "127"',true],
  ['"rendermode" "6" "renderamt" "255"',false],
  ['"rendermode" "10" "renderamt" "255"',false],
]){
  const world=await decodeSourceWorld(await readSourceBsp(brushBsp(undefined,keys)));
  assert.equal((await readSourceProps(world,data.fs)).brushes[0].baselineVisible,visible);
}
console.log('Studio synthetic geometry/skin/fixup/LOD/bone/transform/absolute-sprp boundaries passed.');

