/** CPU native-channel consumers; intentionally no renderer or whole-map claim.
 * node scripts/test_raw_source_animation.mjs
 * Optional: --model models/...mdl --sequence nativeName --root EXPLICIT_LOOSE_ROOT
 * (repeat --root). These are caller-selected existing files, never discovery/fetch.
 * --reference invokes the existing Python local-only AnimationModel for matching
 * supported ordinary channels; it is NOT the packed64/section/include oracle.
 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';



import { build } from 'esbuild';
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
const compiled=await build({stdin:{contents:"export * from './src/maps/raw-source-animation';export * from './src/maps/raw-source-studio';export * from './src/maps/raw-source-gltf';export * from './src/maps/raw-source-props-glb';export * from './src/maps/raw-source-props';export * from './src/maps/raw-source-materials';export * from './src/maps/raw-source-vtf';export * from './src/render/source-animations';",resolveDir:process.cwd(),loader:'ts'},bundle:true,platform:'node',format:'cjs',write:false});
const module={exports:{}};new Function('module','require',compiled.outputFiles[0].text)(module,createRequire(import.meta.url));
const {sampleSourceStudioSequence,SourceStudioClipWriter,readSourceStudioModel,readSourceProps,SourceGlb,appendSourceProps,SourceMaterialExport,readSourceVtf,SourceAnimations}=module.exports;
const limits={maxFrames:10000,maxSamples:2_000_000,maxInputBytes:256*1024**2};
const near=(actual,expected,epsilon=3e-6)=>actual.forEach((v,i)=>assert(Math.abs(v-expected[i])<epsilon,`${actual} != ${expected}`));
const u=(b,p,n)=>b.writeUInt32LE(n,p),i=(b,p,n)=>b.writeInt32LE(n,p),f=(b,p,n)=>b.writeFloatLE(n,p),h=(b,p,n)=>b.writeUInt16LE(n,p);
const seqOffset=1800,animOffset=2100,channelOffset=2400;
function channels(b,start,frames=3,values=[0,1,2],rotation=true){
  // Two independent native linked records. Source radian Euler Z has a
  // deliberately non-camera ordering and opposite left/right signed RLE.
  for(let side=0;side<2;side++){
    const p=start+side*64;b.fill(0,p,p+64);b[p]=side+1;b[p+1]=rotation?8:4;h(b,p+2,side?0:64);
    const pointer=p+4;h(b,pointer+(rotation?4:0),6);
    b[pointer+6]=values.length;b[pointer+7]=frames;
    values.forEach((value,j)=>b.writeInt16LE((side?-1:1)*value,pointer+8+j*2));
  }
}
function fixture({external=false,sectioned=false,raw=0,swap=false}={}){
  const mdl=Buffer.alloc(4096),vvd=Buffer.alloc(64+3*48+3*16),vtx=Buffer.alloc(256);
  mdl.write('IDST');u(mdl,4,48);u(mdl,8,123);mdl.write('native-animation-fixture',12);u(mdl,76,mdl.length);
  u(mdl,0x9c,3);u(mdl,0xa0,408);
  const boneNames=swap?['root','right','left']:['root','left','right'];
  for(let bone=0;bone<3;bone++){
    const p=408+bone*216,name=1100+bone*16,x=bone===0?5:boneNames[bone]==='left'?10:-10,world=bone===0?5:5+x;
    u(mdl,p,name-p);mdl.write(boneNames[bone],name);i(mdl,p+4,bone?0:-1);f(mdl,p+32,x);f(mdl,p+56,1);
    for(let axis=0;axis<3;axis++){f(mdl,p+72+axis*4,1);f(mdl,p+84+axis*4,Math.PI/2);f(mdl,p+96+axis*16+axis*4,1);}
    f(mdl,p+108,-world);
  }
  u(mdl,0xcc,1);u(mdl,0xd0,1200);u(mdl,1200,80);mdl.write('a',1280);
  u(mdl,0xdc,1);u(mdl,0xe0,1);u(mdl,0xe4,1290);h(mdl,1290,0);
  u(mdl,0xe8,1);u(mdl,0xec,1300);u(mdl,1300,16);mdl.write('body',1316);u(mdl,1304,1);u(mdl,1308,1);u(mdl,1312,24);
  mdl.write('mesh',1324);u(mdl,1324+72,1);u(mdl,1324+76,148);u(mdl,1324+80,3);u(mdl,1472+8,3);
  vvd.write('IDSV');u(vvd,4,4);u(vvd,8,123);u(vvd,12,1);u(vvd,16,3);u(vvd,56,64);u(vvd,60,208);
  [[16,1,0],[-6,1,0],[5,4,0]].forEach((point,vertex)=>{
    const p=64+vertex*48;f(vvd,p,1);vvd[p+12]=[1,2,0][vertex];vvd[p+15]=1;
    point.forEach((value,axis)=>f(vvd,p+16+axis*4,value));f(vvd,p+36,1);f(vvd,208+vertex*16,1);f(vvd,220+vertex*16,1);
  });
  u(vtx,0,7);u(vtx,16,123);u(vtx,20,1);u(vtx,28,1);u(vtx,32,36);u(vtx,36,1);u(vtx,40,8);u(vtx,44,1);u(vtx,48,8);
  u(vtx,52,1);u(vtx,56,12);u(vtx,64,1);u(vtx,68,9);vtx[72]=2;
  u(vtx,73,3);u(vtx,77,25);u(vtx,81,3);u(vtx,85,52);u(vtx,89,1);u(vtx,93,58);vtx[97]=2;
  for(let vertex=0;vertex<3;vertex++){const p=98+vertex*9;vtx[p+3]=1;h(vtx,p+4,vertex);h(vtx,125+vertex*2,vertex);}
  u(vtx,131,3);u(vtx,139,3);vtx[149]=1;
  u(mdl,0xbc,1);u(mdl,0xc0,seqOffset);u(mdl,seqOffset+4,220);mdl.write('opposed',seqOffset+220);u(mdl,seqOffset+8,228);
  u(mdl,seqOffset+56,1);u(mdl,seqOffset+60,232);u(mdl,seqOffset+68,1);u(mdl,seqOffset+72,1);i(mdl,seqOffset+76,-1);i(mdl,seqOffset+80,-1);
  u(mdl,seqOffset+156,240);for(let bone=0;bone<3;bone++)f(mdl,seqOffset+240+bone*4,1);
  const frames=sectioned?5:3;
  u(mdl,0xb4,1);u(mdl,0xb8,animOffset);u(mdl,animOffset+4,104);mdl.write('nativeChannels',animOffset+104);f(mdl,animOffset+8,2);u(mdl,animOffset+16,frames);u(mdl,animOffset+56,channelOffset-animOffset);
  channels(mdl,channelOffset);
  if(raw){
    mdl[channelOffset]=1;mdl[channelOffset+1]=raw===48?3:33;h(mdl,channelOffset+2,0);
    const p=channelOffset+4;
    if(raw===48){h(mdl,p,32768);h(mdl,p+2,32768);h(mdl,p+4,16384|32768);}else{
      const bits=BigInt(1048576)|(BigInt(1048576)<<21n)|(BigInt(1572864)<<42n)|(1n<<63n);mdl.writeBigUInt64LE(bits,p);
    }
    const pos=p+(raw===48?6:8);[0x3c00,0xc000,0x0001].forEach((value,axis)=>h(mdl,pos+axis*2,value));
  }
  const files={'models/fixture.mdl':new Blob([mdl]),'models/fixture.vvd':new Blob([vvd]),'models/fixture.dx90.vtx':new Blob([vtx]),'materials/a.vmt':new Blob(['VertexLitGeneric {}'])};
  if(sectioned){
    u(mdl,animOffset+80,160);u(mdl,animOffset+84,2);
    // Valve special last frame uses row floor(5/2)+1 == 3, NOT ceil-1 == 2.
    [2400,2600,2800,3000].forEach((start,row)=>{u(mdl,animOffset+160+row*8,external?1:0);u(mdl,animOffset+164+row*8,external?start-2300:start-animOffset);channels(mdl,start,2,[row*2,row*2+1],false);});
    channels(mdl,3000,1,[99],false);
  }
  if(external){
    const ani=Buffer.alloc(2048,0x7e);mdl.subarray(2300).copy(ani,100);
    u(mdl,0x15c,3400);mdl.write('models/fixture.ani',3400);u(mdl,0x160,2);u(mdl,0x164,3450);u(mdl,3458,100);u(mdl,3462,ani.length);
    u(mdl,animOffset+52,1);u(mdl,animOffset+56,100);
    files['models/fixture.ani']=new Blob([ani]);
  }
  const refresh=()=>{files['models/fixture.mdl']=new Blob([mdl]);};refresh();
  return {mdl,vvd,vtx,files,refresh,fs:{readFile:async path=>files[path]}};
}
async function sampleFixture(options={}){const data=fixture(options),model=await readSourceStudioModel(data.fs,'models/fixture.mdl');return{data,model,sample:await sampleSourceStudioSequence(model,'opposed',limits)};}
const baseline=await sampleFixture();assert.deepEqual(baseline.sample.requirements,[]);near(baseline.sample.times,[0,.5,1]);
near(baseline.sample.tracks[1].quaternions.subarray(4,8),[0,0,Math.SQRT1_2,Math.SQRT1_2]);near(baseline.sample.tracks[2].quaternions.subarray(4,8),[0,0,-Math.SQRT1_2,Math.SQRT1_2]);
const indexed=await sampleSourceStudioSequence(baseline.model,0,limits);assert.deepEqual(indexed.tracks,baseline.sample.tracks);
assert.deepEqual((await sampleSourceStudioSequence(baseline.model,'OPPOSED',limits)).tracks,indexed.tracks);
const unknown=await sampleSourceStudioSequence(baseline.model,'missing',limits);assert.equal(unknown.tracks.length,0);assert.equal(new SourceStudioClipWriter(new SourceGlb()).append(unknown,[]),undefined);
for(const external of [false,true]){
  const {sample}=await sampleFixture({external});assert.deepEqual(sample.requirements,[]);assert.deepEqual(sample.tracks,baseline.sample.tracks);
  const section=await sampleFixture({sectioned:true,external});assert.deepEqual(section.sample.requirements,[]);
  near(section.sample.tracks[1].positions,[10,0,0,11,0,0,12,0,0,13,0,0,109,0,0]);
  near(section.sample.tracks[2].positions,[-10,0,0,-11,0,0,-12,0,0,-13,0,0,-109,0,0]);
}
const lateChannels=fixture({sectioned:true});lateChannels.mdl[channelOffset]=255;lateChannels.refresh();
const lateSample=await sampleSourceStudioSequence(await readSourceStudioModel(lateChannels.fs,'models/fixture.mdl'),0,limits);
assert.deepEqual(lateSample.requirements,[]);
near(lateSample.tracks[1].positions,[10,0,0,10,0,0,12,0,0,13,0,0,109,0,0]);
for(const bits of [48,64]){
  const {sample}=await sampleFixture({raw:bits});assert.deepEqual(sample.requirements,[]);near(sample.tracks[1].positions.subarray(0,3),[1,-2,2**-24]);
  if(bits===48)near(sample.tracks[1].quaternions.subarray(0,4),[0,0,0,-1]);
  else {const z=524288/1048576.5;near(sample.tracks[1].quaternions.subarray(0,4),[0,0,z,-Math.sqrt(1-z*z)],3e-8);}
}
// Adjacent sections deliberately encode opposite quaternion hemispheres.
const hemispheres=fixture({sectioned:true});
for(const [row,start] of [2400,2600,2800,3000].entries()){
  hemispheres.mdl[start]=1;hemispheres.mdl[start+1]=2;h(hemispheres.mdl,start+2,0);
  h(hemispheres.mdl,start+4,32768);h(hemispheres.mdl,start+6,32768);h(hemispheres.mdl,start+8,16384|(row%2?32768:0));
}
hemispheres.refresh();const continuous=await sampleSourceStudioSequence(await readSourceStudioModel(hemispheres.fs,'models/fixture.mdl'),0,limits);
for(let frame=0;frame<5;frame++)near(continuous.tracks[1].quaternions.subarray(frame*4,frame*4+4),[0,0,0,1]);
const badFinal=fixture({sectioned:true});u(badFinal.mdl,animOffset+164+3*8,999999);badFinal.refresh();
await assert.rejects(sampleSourceStudioSequence(await readSourceStudioModel(badFinal.fs,'models/fixture.mdl'),0,limits));
// Signed RLE held tails; each bone's separate stream remains independently owned.
const runs=fixture();channels(runs.mdl,channelOffset,3,[4],false);channels(runs.mdl,channelOffset+64,3,[4],false);
for(const p of [channelOffset,channelOffset+64]){runs.mdl[p]=p===channelOffset?1:2;runs.mdl[p+1]=4;h(runs.mdl,p+2,p===channelOffset?64:0);}
runs.refresh();const runSample=await sampleSourceStudioSequence(await readSourceStudioModel(runs.fs,'models/fixture.mdl'),0,limits);near(runSample.tracks[1].positions,[14,0,0,14,0,0,14,0,0]);
const nextRun=fixture();
for(const p of [channelOffset,channelOffset+64]){
  nextRun.mdl[p+1]=4;h(nextRun.mdl,p+4,6);h(nextRun.mdl,p+6,0);h(nextRun.mdl,p+8,0);
  nextRun.mdl[p+10]=1;nextRun.mdl[p+11]=2;nextRun.mdl.writeInt16LE(4,p+12);
  nextRun.mdl[p+14]=1;nextRun.mdl[p+15]=1;nextRun.mdl.writeInt16LE(-3,p+16);
}
nextRun.refresh();const nextSample=await sampleSourceStudioSequence(await readSourceStudioModel(nextRun.fs,'models/fixture.mdl'),0,limits);
near(nextSample.tracks[1].positions,[14,0,0,14,0,0,7,0,0]);
// Included graph: case-insensitive Valve names reverse left/right indices;
// actual native parent compatibility is still required.
const include=fixture({swap:true});include.mdl.write('RIGHT\0',1116);include.mdl.write('LEFT\0',1132);include.refresh();
const includeModel=await readSourceStudioModel(include.fs,'models/fixture.mdl');
const includedRoot={...baseline.model,animation:{...baseline.model.animation,sequences:[],animations:[],includedModels:[{path:'models/include.mdl',rawBlob:includeModel.rawBlob,animation:includeModel.animation}]}};
const included=await sampleSourceStudioSequence(includedRoot,'opposed',limits);assert.deepEqual(included.requirements,[]);near(included.tracks[1].quaternions.subarray(4,8),baseline.sample.tracks[2].quaternions.subarray(4,8));assert.equal(included.owner.path,'models/include.mdl');
const duplicateRoot={...baseline.model,animation:{...baseline.model.animation,includedModels:includedRoot.animation.includedModels}};
const firstWins=await sampleSourceStudioSequence(duplicateRoot,0,limits);assert.strictEqual(firstWins.owner.rawBlob,baseline.model.rawBlob);assert.deepEqual(firstWins.tracks,baseline.sample.tracks);
const declared=fixture();u(declared.mdl,seqOffset+12,0x800);declared.refresh();const declaredModel=await readSourceStudioModel(declared.fs,'models/fixture.mdl');
const overridden=await sampleSourceStudioSequence({...declaredModel,animation:{...declaredModel.animation,includedModels:includedRoot.animation.includedModels}},0,limits);
// The included sequence overrides the declaration, but the duplicate ANIMATION
// name still resolves to the earlier root descriptor/skeleton, not the include.
assert.equal(overridden.owner.path,'models/include.mdl');assert.equal(overridden.owner.nativeIndex,0);
assert.strictEqual(overridden.animationOwner.rawBlob,declaredModel.rawBlob);assert.deepEqual(overridden.tracks,baseline.sample.tracks);
const includeAni=fixture({swap:true,sectioned:true,external:true}),includeAniModel=await readSourceStudioModel(includeAni.fs,'models/fixture.mdl');
const combined=await sampleSourceStudioSequence({...includedRoot,animation:{...includedRoot.animation,includedModels:[{path:'models/sectioned-include.mdl',rawBlob:includeAniModel.rawBlob,animation:includeAniModel.animation}]}},0,limits);
assert.deepEqual(combined.requirements,[]);near(combined.tracks[1].positions.subarray(12,15),[-89,0,0]);near(combined.tracks[2].positions.subarray(12,15),[89,0,0]);
const badHierarchy=fixture({swap:true});i(badHierarchy.mdl,408+216+4,-1);badHierarchy.refresh();const badModel=await readSourceStudioModel(badHierarchy.fs,'models/fixture.mdl');
const badInclude=await sampleSourceStudioSequence({...includedRoot,animation:{...includedRoot.animation,includedModels:[{path:'models/bad.mdl',rawBlob:badModel.rawBlob,animation:badModel.animation}]}},0,limits);assert.equal(badInclude.requirements[0].code,'studio-animation-include-skeleton');assert.equal(badInclude.tracks.length,0);
// Cross-group routing must also choose the actual earlier ANI, section table,
// frame count/fps and channel skeleton. Sequence defaults remain independent.
const routedRoot=fixture({sectioned:true,external:true});u(routedRoot.mdl,seqOffset+12,0x800);routedRoot.refresh();
const routedModel=await readSourceStudioModel(routedRoot.fs,'models/fixture.mdl');
const routedSequence=fixture({swap:true});f(routedSequence.mdl,408+32,7);f(routedSequence.mdl,animOffset+8,4);
for(let bone=0;bone<3;bone++){const p=408+bone*216+108;f(routedSequence.mdl,p,routedSequence.mdl.readFloatLE(p)-2);}
routedSequence.refresh();const routedSequenceModel=await readSourceStudioModel(routedSequence.fs,'models/fixture.mdl');
const routedGraph={...routedModel,animation:{...routedModel.animation,includedModels:[{path:'models/later-sequence.mdl',rawBlob:routedSequenceModel.rawBlob,animation:routedSequenceModel.animation}]}};
const routed=await sampleSourceStudioSequence(routedGraph,'opposed',limits);
assert.deepEqual(routed.requirements,[]);assert.equal(routed.owner.path,'models/later-sequence.mdl');assert.strictEqual(routed.animationOwner.rawBlob,routedModel.rawBlob);
near(routed.times,[0,.5,1,1.5,2]);near(routed.tracks[0].positions,[7,0,0,7,0,0,7,0,0,7,0,0,7,0,0]);
near(routed.tracks[1].positions.subarray(12,15),[109,0,0]);near(routed.tracks[2].positions.subarray(12,15),[-109,0,0]);
// MDL44 CalcVirtualAnimation permits a valid empty chain: sequence-group
// defaults still replace the target pose without inventing a motion clip.
const emptyDefaults=fixture({swap:true});emptyDefaults.mdl[channelOffset]=255;
f(emptyDefaults.mdl,408+32,7);f(emptyDefaults.mdl,408+2*216+32,12);emptyDefaults.refresh();
const emptyModel=await readSourceStudioModel(emptyDefaults.fs,'models/fixture.mdl');
const emptyGraph={...baseline.model,animation:{...baseline.model.animation,sequences:[],animations:[],
  includedModels:[{path:'models/empty-include.mdl',rawBlob:emptyModel.rawBlob,animation:emptyModel.animation}]}};
const constantPose=await sampleSourceStudioSequence(emptyGraph,0,{...limits,maxSamples:3});
assert.deepEqual(constantPose.requirements,[]);
assert.equal(constantPose.times.length,0);
near(constantPose.pose[0].positions,[7,0,0]);
near(constantPose.pose[1].positions,[12,0,0]);
near(constantPose.pose[2].positions,[-10,0,0]);
await assert.rejects(sampleSourceStudioSequence(emptyGraph,0,{...limits,maxSamples:2}));
for(const change of [[animOffset+12,0x20],[animOffset+56,0]]){
  const unavailable=fixture();u(unavailable.mdl,...change);unavailable.refresh();
  const blocked=await sampleSourceStudioSequence(await readSourceStudioModel(unavailable.fs,'models/fixture.mdl'),0,limits);
  assert(blocked.requirements.some(item=>item.code==='studio-animation-no-channels'));
  assert.equal(blocked.pose,undefined);
}
// Source offset -> root is NOT target root: offset has no channel and no
// target mapping. Both sequence-default and animation-channel remaps must fail.
const parentAlias=fixture(),aliasMdl=Buffer.alloc(8192);parentAlias.mdl.copy(aliasMdl);u(aliasMdl,76,aliasMdl.length);u(aliasMdl,0x9c,4);u(aliasMdl,0xa0,3500);
for(let bone=0;bone<4;bone++){
  const p=3500+bone*216,name=4500+bone*16;
  if(bone){parentAlias.mdl.copy(aliasMdl,p,408+(bone-1)*216,408+bone*216);i(aliasMdl,p+4,bone===1?0:1);f(aliasMdl,p+108,aliasMdl.readFloatLE(p+108)-7);}
  else {i(aliasMdl,p+4,-1);f(aliasMdl,p+32,7);f(aliasMdl,p+56,1);for(let axis=0;axis<3;axis++)f(aliasMdl,p+96+axis*16+axis*4,1);f(aliasMdl,p+108,-7);}
  u(aliasMdl,p,name-p);aliasMdl.write(['offset','root','left','right'][bone],name);
}
f(aliasMdl,seqOffset+252,1);parentAlias.files['models/fixture.mdl']=new Blob([aliasMdl]);
const aliasModel=await readSourceStudioModel(parentAlias.fs,'models/fixture.mdl');
const aliasGraph={...includedRoot,animation:{...includedRoot.animation,includedModels:[{path:'models/parent-alias.mdl',rawBlob:aliasModel.rawBlob,animation:aliasModel.animation}]}};
const aliasSequence=await sampleSourceStudioSequence(aliasGraph,0,limits);
assert.equal(aliasSequence.requirements[0].code,'studio-animation-include-skeleton');assert.equal(aliasSequence.tracks.length,0);
u(aliasMdl,0xbc,0);parentAlias.files['models/fixture.mdl']=new Blob([aliasMdl]);const aliasAnimationModel=await readSourceStudioModel(parentAlias.fs,'models/fixture.mdl');
const aliasAnimationGraph={...includedRoot,animation:{...includedRoot.animation,includedModels:[{path:'models/earlier-alias-animation.mdl',rawBlob:aliasAnimationModel.rawBlob,animation:aliasAnimationModel.animation},{path:'models/later-sequence.mdl',rawBlob:includeModel.rawBlob,animation:includeModel.animation}]}};
const aliasAnimation=await sampleSourceStudioSequence(aliasAnimationGraph,0,limits);
assert.equal(aliasAnimation.owner.path,'models/later-sequence.mdl');assert.equal(aliasAnimation.animationOwner.path,'models/earlier-alias-animation.mdl');
assert.equal(aliasAnimation.requirements[0].code,'studio-animation-include-skeleton');assert.equal(aliasAnimation.tracks.length,0);
// Explicit unsupported semantics never return fabricated defaults or first blend.
for(const [offset,value,code] of [[seqOffset+12,4,'delta'],[seqOffset+56,2,'blend'],[seqOffset+144,1,'ik'],[seqOffset+148,1,'layers'],[seqOffset+164,1,'ik'],[seqOffset+76,0,'pose-parameters'],[0xa4,1,'controllers'],[0x104,1,'flex'],[408+164,1,'procedural'],[animOffset+20,1,'root-motion'],[animOffset+60,1,'ik'],[animOffset+72,1,'local-hierarchy'],[animOffset+12,64,'format']]){
  // Metadata-only count changes must not accidentally turn into reader table failures.
  const data=fixture();u(data.mdl,offset,value);data.refresh();let model;
  if([0xa4,0x104].includes(offset))model={...baseline.model,rawBlob:new Blob([data.mdl])};else model=await readSourceStudioModel(data.fs,'models/fixture.mdl');
  const sample=await sampleSourceStudioSequence(model,0,limits);assert.equal(sample.tracks.length,0);assert(sample.requirements[0].code.endsWith(code),sample.requirements[0].code);
}
const delta=fixture();delta.mdl[channelOffset+1]|=16;delta.refresh();const deltaSample=await sampleSourceStudioSequence(await readSourceStudioModel(delta.fs,'models/fixture.mdl'),0,limits);assert.equal(deltaSample.requirements[0].code,'studio-animation-delta');
const masked=fixture();f(masked.mdl,seqOffset+240,.5);masked.refresh();assert.equal((await sampleSourceStudioSequence(await readSourceStudioModel(masked.fs,'models/fixture.mdl'),0,limits)).requirements[0].code,'studio-animation-bone-weights');
const missing=fixture({external:true});delete missing.files['models/fixture.ani'];assert.equal((await sampleSourceStudioSequence(await readSourceStudioModel(missing.fs,'models/fixture.mdl'),0,limits)).requirements[0].code,'studio-animation-missing-resource');
for(const [offset,value,size] of [[channelOffset+10,0,1],[channelOffset+11,0,1],[channelOffset+2,0x7fff,2],[channelOffset,99,1]]){
  const data=fixture();if(size===1)data.mdl[offset]=value;else h(data.mdl,offset,value);data.refresh();await assert.rejects(sampleSourceStudioSequence(await readSourceStudioModel(data.fs,'models/fixture.mdl'),0,limits));
}
const zeroFps=fixture();f(zeroFps.mdl,animOffset+8,0);zeroFps.refresh();
await assert.rejects(sampleSourceStudioSequence(await readSourceStudioModel(zeroFps.fs,'models/fixture.mdl'),0,limits));
for(const bound of [{maxFrames:2},{maxSamples:8},{maxInputBytes:100}])await assert.rejects(sampleSourceStudioSequence(baseline.model,0,{...limits,...bound}));
const cancel=new AbortController();cancel.abort();await assert.rejects(sampleSourceStudioSequence(baseline.model,0,{...limits,signal:cancel.signal}),error=>error.name==='AbortError');
const during=new AbortController();const pending=sampleSourceStudioSequence(baseline.model,0,{...limits,signal:during.signal});setTimeout(()=>during.abort(),0);await assert.rejects(pending,error=>error.name==='AbortError');

// Actual props writer -> GLTFLoader -> AnimationMixer -> real skinning. No direct
// bone mutation substitutes for sampled animation, and no fake clock is installed.
const frame={origin:[0,0,0],yaw:0,metresPerUnit:.0254,up:'Z',spawnClass:'fixture',floorFound:true};
function placement(index){return{kind:'entity-model',index,modelPath:'models/fixture.mdl',classname:'prop_dynamic',sourceOrigin:[0,0,0],sourceAngles:[0,0,0],scale:1,skin:0,body:0,solid:0,flags:0,flagsEx:0,leaves:new Uint16Array(),castShadow:true,fadeMinDistance:-1,fadeMaxDistance:0,forcedFadeScale:1,diffuseModulation:[255,255,255,255],render:{mode:0,effect:0,color:[255,255,255],amount:255,initiallyDisabled:false,renderFx:'',castShadow:true,receiveShadow:true},matrixInputUnits:'metres',matrix:new Float64Array([1,0,0,0,0,1,0,0,0,0,1,0,index*3,0,0,1])};}
async function emit(model,sample,filesystem,settings={}){
  const glb=new SourceGlb(),materials=new SourceMaterialExport(glb,filesystem);
  const request={defaultAnimation:sample.name,sequence:'',cycle:0,playbackRate:1,skin:0,body:0};
  const placements=Array.from({length:settings.count??2},(_,index)=>({...placement(index),modelPath:model.path,animation:{...request,...settings.requests?.[index]}}));
  if(settings.absent)for(const p of placements)delete p.animation;
  if(settings.static)for(const p of placements){p.kind='static-prop';p.classname='prop_static';}
  const models=new Map([[model.path,model]]);
  if(settings.secondary){placements[1].modelPath='models/second.mdl';models.set('models/second.mdl',settings.secondary);}
  const entities=placements.map(p=>{
    const values={classname:'prop_dynamic',model:model.path,origin:`${p.index*3/.0254} 0 0`,angles:'0 0 0',
      DefaultAnim:p.animation?.defaultAnimation??'',sequence:p.animation?.sequence??'',cycle:String(p.animation?.cycle??0),playbackrate:String(p.animation?.playbackRate??1)};
    return{values,pairs:Object.entries(values)};
  });
  const world={frame,bsp:{file:new Blob(),entities,lumps:Array.from({length:64},()=>({version:0,length:0})),getLump:async()=>new Uint8Array()}};
  const props=settings.fromReader?await readSourceProps(world,filesystem):{placements,models,frame,brushes:[],entities:[],gameLumps:[],missingModels:[],missingMaterials:[],missingAnimationResources:[],completeResources:true,originalBspBlob:new Blob(),limitations:[]};
  // Lighting intentionally absent, not substituted; geometry consumer only.
  const emitted=await appendSourceProps(glb,materials,props,world,{maxGeometryBytes:128*1024**2,maxVertices:1_000_000,lightingForPlacement:p=>{settings.onPlacement?.(p);return undefined;},animation:settings.limits,signal:settings.signal});
  assert.equal(emitted.placements.length,placements.length);assert(emitted.requirements.some(r=>r.code==='prop-light-cache'));
  const indices=emitted.placements.map(p=>p.clip);
  const loader=new GLTFLoader();
  loader.register(parser=>({name:'M0CLIP_texture_vtf',loadTexture:async index=>{
    const meta=parser.json.textures[index].extensions?.M0CLIP_texture_vtf;
    if(!meta)throw new Error('CPU native test requires actual native VTF payload');
    const native=await readSourceVtf(new Uint8Array(await parser.getDependency('bufferView',meta.bufferView))),decoded=await native.decode({frame:meta.frame,face:meta.face});
    assert(decoded.data instanceof Uint8Array||decoded.data instanceof Float32Array,'Unsupported CPU texture format, not substituted');
    const texture=new THREE.DataTexture(decoded.data,decoded.width,decoded.height,THREE.RGBAFormat,decoded.data instanceof Float32Array?THREE.FloatType:THREE.UnsignedByteType);texture.flipY=false;texture.needsUpdate=true;return texture;
  }}));
  const parsed=await loader.parseAsync(await glb.finish().arrayBuffer(),'');
  return{glb,parsed,emitted,indices};
}
const consumed=await emit(baseline.model,baseline.sample,baseline.data.fs);
const mixer=new THREE.AnimationMixer(consumed.parsed.scene),action=mixer.clipAction(consumed.parsed.animations[consumed.indices[0]]);action.setLoop(THREE.LoopOnce,1);action.clampWhenFinished=true;action.play();
async function vertex(result,instance,id){
  const root=await result.parsed.parser.getDependency('node',result.emitted.placements[instance].node);let mesh;root.traverse(o=>{if(o.isSkinnedMesh)mesh=o;});assert(mesh);
  result.parsed.scene.updateMatrixWorld(true);mesh.skeleton.update();return mesh.applyBoneTransform(id,new THREE.Vector3().fromBufferAttribute(mesh.geometry.attributes.position,id)).applyMatrix4(mesh.matrixWorld).toArray();
}
mixer.setTime(0);const bindLeft=await vertex(consumed,0,0),bindRight=await vertex(consumed,0,1),otherLeft=await vertex(consumed,1,0);
near(bindLeft,[16*.0254,.0254,0]);near(bindRight,[-6*.0254,.0254,0]);
mixer.setTime(.5);near(await vertex(consumed,0,0),[14*.0254,.0254,0]);near(await vertex(consumed,0,1),[-4*.0254,.0254,0]);near(await vertex(consumed,1,0),otherLeft);
mixer.setTime(1);near(await vertex(consumed,0,0),[14*.0254,-.0254,0]);near(await vertex(consumed,0,1),[-4*.0254,-.0254,0]);
assert.notDeepEqual(await vertex(consumed,0,0),bindLeft);assert.notDeepEqual(await vertex(consumed,0,1),bindRight);
const second=mixer.clipAction(consumed.parsed.animations[consumed.indices[1]]);second.setLoop(THREE.LoopOnce,1);second.play();mixer.setTime(.5);near(await vertex(consumed,1,0),[3+14*.0254,.0254,0]);
assert.throws(()=>new SourceStudioClipWriter(new SourceGlb()).append(baseline.sample,[0,1,2]));
const routedConsumed=await emit(routedGraph,routed,routedRoot.fs),routedMixer=new THREE.AnimationMixer(routedConsumed.parsed.scene),routedAction=routedMixer.clipAction(routedConsumed.parsed.animations[routedConsumed.indices[0]]);
routedAction.setLoop(THREE.LoopOnce,1);routedAction.clampWhenFinished=true;routedAction.play();
routedMixer.setTime(0);near(await vertex(routedConsumed,0,0),[18*.0254,.0254,0]);
routedMixer.setTime(2);near(await vertex(routedConsumed,0,0),[117*.0254,.0254,0]);near(await vertex(routedConsumed,0,1),[-103*.0254,.0254,0]);
near(await vertex(routedConsumed,1,0),[3+16*.0254,.0254,0]);
for(const [model,blocked] of [[aliasGraph,aliasSequence],[aliasAnimationGraph,aliasAnimation]]){
  const rejected=await emit(model,blocked,baseline.data.fs);
  assert.deepEqual(rejected.indices,[undefined,undefined]);assert.equal(rejected.glb.json.animations,undefined);assert.equal(rejected.parsed.animations.length,0);
  near(await vertex(rejected,0,0),[16*.0254,.0254,0]);
}
const constantConsumed=await emit(emptyGraph,constantPose,baseline.data.fs,{limits:{maxSamples:3}});
assert.equal(constantConsumed.parsed.animations.length,0);
near(await vertex(constantConsumed,0,0),[20*.0254,.0254,0]);
near(await vertex(constantConsumed,0,1),[-4*.0254,.0254,0]);
const constantPlayer=new SourceAnimations([constantConsumed.parsed]);constantPlayer.update(7);
near(await vertex(constantConsumed,0,0),[20*.0254,.0254,0]);
constantPlayer.dispose();
// Authored entity reader -> writer requests: DefaultAnim wins, and numeric
// sequence/default-zero aliases must share the SAME sampled/encoded channels.
const authored=await emit(baseline.model,baseline.sample,baseline.data.fs,{fromReader:true,limits:{maxSamples:9},
  requests:[{defaultAnimation:'OPPOSED',sequence:'999',cycle:.5,playbackRate:-.5},{defaultAnimation:'',sequence:'0',cycle:.5,playbackRate:0}]});
const authoredPlayer=new SourceAnimations([authored.parsed]);
authoredPlayer.update(0);near(await vertex(authored,0,0),[14*.0254,.0254,0]);near(await vertex(authored,1,0),[3+14*.0254,.0254,0]);
authoredPlayer.update(1);near(await vertex(authored,0,0),bindLeft);near(await vertex(authored,1,0),[3+14*.0254,.0254,0]);
authoredPlayer.update(0);near(await vertex(authored,0,0),[14*.0254,.0254,0]); // deterministic rewind, not accumulated delta.
authoredPlayer.dispose();
const looping=fixture();u(looping.mdl,seqOffset+12,1);looping.refresh();
const loopingModel=await readSourceStudioModel(looping.fs,'models/fixture.mdl'),loopingSample=await sampleSourceStudioSequence(loopingModel,0,limits);
const looped=await emit(loopingModel,loopingSample,looping.fs,{requests:[{cycle:.25,playbackRate:.5}]});
const loopPlayer=new SourceAnimations([looped.parsed]);loopPlayer.update(2.5);
near(await vertex(looped,0,0),[14*.0254,.0254,0]);
loopPlayer.dispose();
for(const settings of [{absent:true},{static:true},{requests:[{defaultAnimation:'',sequence:'missing'},{defaultAnimation:'',sequence:'missing'}]}]){
  const silent=await emit(baseline.model,baseline.sample,baseline.data.fs,settings);
  assert.deepEqual(silent.indices,[undefined,undefined]);assert.equal(silent.parsed.animations.length,0);
  near(await vertex(silent,0,0),bindLeft);assert.equal(silent.emitted.animationBytes,0);
  if(settings.requests)assert(silent.emitted.requirements.some(r=>r.code==='studio-animation-selection'));
}
for(const requests of [[{defaultAnimation:'missing',sequence:'999'},{defaultAnimation:'',sequence:''}],[{defaultAnimation:'',sequence:'opposed'},{}]]){
  const defaults=await emit(baseline.model,baseline.sample,baseline.data.fs,{requests,limits:{maxSamples:9}});
  assert.equal(defaults.parsed.animations.length,2);assert.equal(defaults.emitted.animationSamples,9);
}
for(const request of [{cycle:Infinity},{playbackRate:NaN}])await assert.rejects(emit(baseline.model,baseline.sample,baseline.data.fs,{requests:[request]}));
const secondNative=await sampleFixture({external:true});
for(const settings of [
  {limits:{maxFrames:2}},{limits:{maxSamples:8}},{limits:{maxBytes:32}},{limits:{maxInputBytes:100}},{limits:{maxClips:1}},{limits:{maxChannels:6}},
  {secondary:secondNative.model,limits:{maxSamples:9}},
  {secondary:secondNative.model,limits:{maxInputBytes:baseline.model.rawBlob.size+secondNative.model.rawBlob.size+secondNative.model.animation.companions[0].blob.size-1}},
])await assert.rejects(emit(baseline.model,baseline.sample,baseline.data.fs,settings));
const cachedCancel=new AbortController();let reachedCachedPlacement=false;
const cancelEmission=emit(baseline.model,baseline.sample,baseline.data.fs,{count:128,signal:cachedCancel.signal,onPlacement:p=>{
  if(p.index===1){reachedCachedPlacement=true;setTimeout(()=>cachedCancel.abort(),0);}
}});
await assert.rejects(cancelEmission,error=>error.name==='AbortError');assert(reachedCachedPlacement);
console.log('Native animation CPU fixtures: local/external/Valve special-final sections, signed RLE, half/raw48/raw64, include bone-name/hierarchy remap, selection, limits/cancellation, explicit blockers; actual props GLTFLoader+AnimationMixer known opposing skinned vertices and independent instances. No GPU/map qualification.');

