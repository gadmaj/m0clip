/** CPU-only actual Picardia decoder invariants. Parent runs after integration:
 * node scripts/test_goldsrc_character.cjs
 * No application, browser, server, network or generated repository output. */
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const Module = require('node:module');
const {build} = require('esbuild');

(async () => {
  const root = path.resolve(__dirname, '..');
  const bundle = await build({stdin:{resolveDir:root, sourcefile:'goldsrc-fixture-entry.ts', contents:`
    export {decodeGoldSrcScene,loadGoldSrcCharacter} from './src/render/characters/goldsrc';
    export {GeometryTrack} from './src/core/geometry';
    export * as THREE from 'three';
  `},bundle:true,platform:'node',format:'cjs',write:false,logLevel:'silent'});
  const compiled = new Module(path.join(__dirname, 'goldsrc-fixture-memory.cjs'), module);
  compiled.filename = path.join(__dirname, 'goldsrc-fixture-memory.cjs'); compiled.paths = module.paths;
  compiled._compile(bundle.outputFiles[0].text, compiled.filename);
  const {decodeGoldSrcScene,loadGoldSrcCharacter,THREE,GeometryTrack} = compiled.exports;
  const bytes = fs.readFileSync(path.join(root,'public/assets/characters/picardia-v1sc/picardia_v1sc.mdl'));
  assert.equal(bytes.length,1745672);
  assert.equal(crypto.createHash('sha256').update(bytes).digest('hex'),'f0acfbf74ed97eb7dcb403c338b463dda8234b116f280ad11f10681dab1f13a8');
  const buffer = value => Uint8Array.from(value).buffer;
  const source = {name:'picardia_v1sc', model:buffer(bytes), source:'https://github.com/wootguy/pmodels',
    thumbnail:'/assets/characters/picardia-v1sc/preview.png',
    readme:fs.readFileSync(path.join(root,'public/assets/characters/picardia-v1sc/picardia_v1sc.txt'),'utf8'),
    loadDependency:async filename => {throw new Error('Unexpected dependency '+filename);}};
  const {scene,definition} = await decodeGoldSrcScene(source);
  const meta = scene.userData.goldsrc;
  assert.equal(meta.boneCount,61); assert.equal(meta.sequenceCount,203); assert.equal(meta.clipCount,367);
  assert.equal(meta.textureCount,8); assert.equal(meta.bodyParts.length,7); assert.equal(meta.skinFamilies.length,1);
  assert.deepEqual(meta.bodyParts[0].models.map(m=>m.name),['Hot_Glasses','Hot_Glasses','blank']);
  assert.match(definition.attribution.creator,/TayKlor.*DAZ.*modelguy/);
  assert.equal(meta.readme,source.readme); assert.doesNotMatch(JSON.stringify(scene.userData),/\/home\/g\//);
  const aligned = new THREE.Vector3(0,0,1).applyQuaternion(scene.quaternion);
  assert.ok(aligned.distanceTo(new THREE.Vector3(0,1,0)) < 1e-6);
  aligned.applyQuaternion(new THREE.Quaternion().fromArray(definition.rig.alignment));
  assert.ok(aligned.distanceTo(new THREE.Vector3(0,0,1)) < 1e-6);
  const bones=[], meshes=[], visibleMeshes=[];
  scene.traverse(object=>{if(object.isBone)bones.push(object); if(object.isSkinnedMesh)meshes.push(object);});
  scene.traverseVisible(object=>{if(object.isSkinnedMesh)visibleMeshes.push(object);});
  assert.equal(bones.length,61); assert.equal(meshes.length,14); assert.equal(visibleMeshes.length,11);
  assert.equal(meshes.reduce((sum,m)=>sum+m.geometry.index.count/3,0),16378);
  assert.equal(visibleMeshes.reduce((sum,m)=>sum+m.geometry.index.count/3,0),13980);
  assert.equal(scene.getObjectByName('0_2_blank').visible,false);
  const point=new THREE.Vector3();
  for(const mesh of meshes) {
    const g=mesh.geometry; assert.equal(g.getAttribute('position').count,g.getAttribute('uv').count);
    assert.equal(g.getAttribute('position').count,g.getAttribute('chromeOrigin').count);
    mesh.skeleton.update();
    for(const vertex of [0,g.getAttribute('position').count-1]) {
      mesh.getVertexPosition(vertex,point);
      assert.ok(point.distanceTo(new THREE.Vector3().fromBufferAttribute(g.getAttribute('position'),vertex))<1e-4,'bind-space skin cancellation');
      assert.ok(Math.abs(new THREE.Vector3().fromBufferAttribute(g.getAttribute('normal'),vertex).length()-1)<1e-5);
      assert.equal(g.getAttribute('skinWeight').getX(vertex),1);
    }
    assert.equal(mesh.material.userData.goldsrcTextureFlags,meta.materials[mesh.userData.goldsrcSkinTextures[0]].flags);
    assert.equal(mesh.material.side,THREE.FrontSide,'native winding must not be hidden by material culling changes');
  }
  // The supplied real model has two locally inconsistent authored faces; the rest must face its normals.
  const a=new THREE.Vector3(), b=new THREE.Vector3(), c=new THREE.Vector3(), face=new THREE.Vector3(), authored=new THREE.Vector3();
  let outwardFaces=0;
  for(const mesh of meshes) {
    const g=mesh.geometry, p=g.getAttribute('position'), n=g.getAttribute('normal');
    for(let t=0;t<g.index.count;t+=3) {
      const ids=[g.index.getX(t),g.index.getX(t+1),g.index.getX(t+2)];
      a.fromBufferAttribute(p,ids[0]);b.fromBufferAttribute(p,ids[1]);c.fromBufferAttribute(p,ids[2]);
      face.crossVectors(b.sub(a),c.sub(a));authored.set(0,0,0);
      for(const id of ids)authored.add(point.fromBufferAttribute(n,id));
      if(face.dot(authored)>0)outwardFaces++;
    }
  }
  assert.ok(outwardFaces>16378*.999,'real Picardia triangle winding must agree with authored normals');
  // Independent byte-level palette lookup from the source, not decoder metadata.
  const tex=bytes.readInt32LE(184), pixels=bytes.readInt32LE(tex+76), width=bytes.readInt32LE(tex+68), height=bytes.readInt32LE(tex+72);
  const image=meshes[0].material.map.image.data, palette=pixels+width*height, color=bytes[pixels];
  assert.deepEqual(Array.from(image.slice(0,4)),[bytes[palette+color*3],bytes[palette+color*3+1],bytes[palette+color*3+2],255]);
  const boneOffset=bytes.readInt32LE(144), sequenceOffset=bytes.readInt32LE(168);
  // Deterministic native commands, retaining the real rig/texture metadata but no animation.
  // GoldSrc renders these clockwise fans/strips with GL_FRONT culled; Three needs reversed faces.
  // https://github.com/ValveSoftware/halflife/blob/b1b5cf5892918535619b2937bb927e46cb097ba1/utils/mdlviewer/studio_render.cpp#L653-L679
  {
    const positions=[[0,0,0],[0,1,0],[1,0,0],[1,1,0],[3,0,0],[3,1,0],[4,1,0],[4,0,0]];
    const normals=[[0,0,1],[0,0,1],[0,0,1],[1,0,0],[0,0,1],[0,0,1],[0,1,0],[0,0,1]];
    const posOffset=bytes.length, normOffset=posOffset+96, vbOffset=normOffset+96, nbOffset=vbOffset+8, commandsOffset=nbOffset+8;
    const fixture=Buffer.alloc(commandsOffset+70);bytes.copy(fixture);fixture.writeInt32LE(fixture.length,72);
    const part=bytes.readInt32LE(208), model=bytes.readInt32LE(part+72), mesh=bytes.readInt32LE(model+76);
    fixture.writeInt32LE(0,148);fixture.writeInt32LE(0,164);fixture.writeInt32LE(0,172);
    for(let bone=0;bone<meta.boneCount;bone++)for(let axis=0;axis<6;axis++)fixture.writeInt32LE(-1,boneOffset+bone*112+40+axis*4);
    fixture.writeInt32LE(-1,boneOffset+32);
    for(let axis=0;axis<6;axis++)fixture.writeFloatLE(0,boneOffset+64+axis*4);
    fixture.writeInt32LE(1,204);fixture.writeInt32LE(1,part+64);fixture.writeInt32LE(1,model+72);
    fixture.writeInt32LE(8,model+80);fixture.writeInt32LE(vbOffset,model+84);fixture.writeInt32LE(posOffset,model+88);
    fixture.writeInt32LE(8,model+92);fixture.writeInt32LE(nbOffset,model+96);fixture.writeInt32LE(normOffset,model+100);
    fixture.writeInt32LE(4,mesh);fixture.writeInt32LE(commandsOffset,mesh+4);
    for(let v=0;v<8;v++)for(let axis=0;axis<3;axis++) {
      fixture.writeFloatLE(positions[v][axis],posOffset+v*12+axis*4);
      fixture.writeFloatLE(normals[v][axis],normOffset+v*12+axis*4);
    }
    let cursor=commandsOffset;
    for(const [command,first] of [[4,0],[-4,4]]) {
      fixture.writeInt16LE(command,cursor);cursor+=2;
      for(let j=0;j<4;j++,cursor+=8) {
        const v=first+j;fixture.writeInt16LE(v,cursor);fixture.writeInt16LE(v,cursor+2);
        fixture.writeInt16LE(v*3,cursor+4);fixture.writeInt16LE(v*5,cursor+6);
      }
    }
    fixture.writeInt16LE(0,cursor);
    const fixtureBuffer=buffer(fixture), pristine=Buffer.from(fixtureBuffer);
    const fixtureScene=(await decodeGoldSrcScene({...source,model:fixtureBuffer})).scene, fixtureMeshes=[];
    fixtureScene.traverse(o=>{if(o.isSkinnedMesh)fixtureMeshes.push(o);});
    assert.equal(fixtureMeshes.length,1);assert.deepEqual(Buffer.from(fixtureBuffer),pristine,'decoder must not rewrite native bytes');
    const decoded=fixtureMeshes[0], g=decoded.geometry, image=decoded.material.map.image;
    const faces=[[0,2,1],[2,3,1],[4,6,5],[4,7,6]];
    assert.deepEqual(Array.from(g.getAttribute('position').array),positions.flat(),'positions remain authored');
    assert.deepEqual(Array.from(g.getAttribute('normal').array),normals.flat(),'normals remain authored, not negated or recomputed');
    assert.deepEqual(g.getAttribute('uv').array,Float32Array.from(positions.flatMap((_,v)=>[v*3/image.width,v*5/image.height])));
    assert.deepEqual(Array.from(g.getAttribute('skinIndex').array),Array(32).fill(0));
    assert.deepEqual(Array.from(g.getAttribute('skinWeight').array),positions.flatMap(()=>[1,0,0,0]));
    assert.deepEqual(Array.from(g.getAttribute('chromeOrigin').array),Array(24).fill(0));
    assert.equal(decoded.material.side,THREE.FrontSide);
    assert.equal(decoded.material.userData.goldsrcTextureFlags,bytes.readInt32LE(tex+64));
    fixtureScene.updateMatrixWorld(true);decoded.skeleton.update();
    const expectedBind=new THREE.Matrix4().compose(new THREE.Vector3(),fixtureScene.quaternion,new THREE.Vector3(1,1,1));
    decoded.bindMatrix.elements.forEach((value,i)=>assert.ok(Math.abs(value-expectedBind.elements[i])<1e-12,'bind transform unchanged'));
    for(let v=0;v<8;v++)assert.ok(decoded.getVertexPosition(v,point).distanceTo(new THREE.Vector3(...positions[v]))<1e-12,'bind-space positions unchanged');
    // Actual front/back ray consumers must see every parity/fan triangle, with no DoubleSide escape.
    for(const [triangle,ids] of faces.entries()) {
      const center=new THREE.Vector3();
      for(const id of ids)center.add(new THREE.Vector3(...positions[id]));center.multiplyScalar(1/3);
      for(const side of [1,-1]) {
        const origin=center.clone().add(new THREE.Vector3(0,0,side)).applyMatrix4(decoded.matrixWorld);
        const direction=new THREE.Vector3(0,0,-side).transformDirection(decoded.matrixWorld);
        const hits=new THREE.Raycaster(origin,direction).intersectObject(decoded,false);
        assert.equal(hits.length,side===1?1:0,`triangle ${triangle}: authored front hits, back is culled`);
        if(side===1)assert.equal(hits[0].faceIndex,triangle);
      }
    }
  }
  // Independently interpret one raw RLE channel through both held and non-held frames.
  let checkedChannel=false;
  for(let sequence=0;sequence<203&&!checkedChannel;sequence++) {
    const seq=sequenceOffset+sequence*176, frames=bytes.readInt32LE(seq+56), anim=bytes.readInt32LE(seq+124);
    if(frames<3) continue;
    for(let bone=0;bone<61&&!checkedChannel;bone++) for(let axis=0;axis<3&&!checkedChannel;axis++) {
      const address=anim+bone*12, delta=bytes.readUInt16LE(address+axis*2); if(!delta) continue;
      let cursor=address+delta;const values=[];
      while(values.length<frames) {
        const valid=bytes[cursor], total=bytes[cursor+1]; assert.ok(valid&&valid<=total);
        for(let n=0;n<total&&values.length<frames;n++)values.push(bytes.readInt16LE(cursor+2+Math.min(n,valid-1)*2));
        cursor+=(valid+1)*2;
      }
      const authored=bytes.toString('latin1',boneOffset+bone*112,boneOffset+bone*112+32).split('\0')[0];
      const name=THREE.PropertyBinding.sanitizeNodeName(authored);
      const clip=scene.animations.find(c=>c.name.startsWith(sequence+':'));
      const track=clip.tracks.find(t=>t.name===name+'.position');
      const rest=bytes.readFloatLE(boneOffset+bone*112+64+axis*4), scale=bytes.readFloatLE(boneOffset+bone*112+88+axis*4);
      const controller=bytes.readInt32LE(boneOffset+bone*112+40+axis*4); if(controller!==-1)continue;
      for(let frame=0;frame<frames;frame++)assert.ok(Math.abs(track.values[frame*3+axis]-(rest+values[frame]*scale))<1e-4,'actual RLE sample');
      checkedChannel=true;
    }
  }
  assert.ok(checkedChannel,'fixture must independently inspect an animated translation channel');
  assert.ok(scene.animations.every(clip=>clip.tracks.length===123));
  assert.ok(scene.animations.some(clip=>clip.name.includes('[blend 1]')));
  const moving=meta.sequences.find(s=>s.linearMovement.some(x=>Math.abs(x)>1e-6));
  if(moving) {
    const clip=scene.animations.find(c=>c.name===moving.clips[0]), track=clip.tracks.find(t=>t.name==='GoldSrcRootMotion.position');
    assert.ok(new THREE.Vector3().fromArray(track.values,track.values.length-3).distanceTo(new THREE.Vector3().fromArray(moving.linearMovement))<1e-4);
  }
  const mixer=new THREE.AnimationMixer(scene); mixer.clipAction(scene.animations.find(c=>c.duration>.2)).play();mixer.update(.15);
  assert.ok(bones.every(b=>Number.isFinite(b.quaternion.lengthSq())));mixer.stopAllAction();mixer.uncacheRoot(scene);
  // Consume the real CharacterAsset factory through a minimal compatible recorded R1.
  const names=['world','pelvis','torso_link','left_shoulder_yaw_link','right_shoulder_yaw_link',
    'left_elbow_link','right_elbow_link','left_wrist_roll_link','right_wrist_roll_link',
    'left_hip_yaw_link','right_hip_yaw_link','left_knee_link','right_knee_link',
    'left_ankle_roll_link','right_ankle_roll_link','head_pitch_link','head_yaw_link'];
  const centers=[[0,0,0],[0,0,.74],[0,0,.98],[0,.24,1.1],[0,-.24,1.1],[0,.24,.82],[0,-.24,.82],
    [0,.24,.59],[0,-.24,.59],[0,.12,.68],[0,-.12,.68],[0,.12,.4],[0,-.12,.4],
    [0,.12,.08],[0,-.12,.08],[0,0,1.23],[0,0,1.32]];
  const n=names.length,ngeom=n-1,quat=new Float64Array(n*4),gquat=new Float64Array(ngeom*4);
  for(let i=0;i<n;i++)quat[i*4]=1;for(let i=0;i<ngeom;i++)gquat[i*4]=1;
  const model={robot:'r1',ngeom,bodyNames:names,bodyid:Int32Array.from(names.slice(1),(_,i)=>i+1),
    bodyFrames:{parent:new Int32Array(n),pos:Float64Array.from(centers.flat()),quat},
    geomFrames:{pos:new Float64Array(ngeom*3),quat:gquat},contype:new Int32Array(ngeom),dataid:new Int32Array(ngeom),
    meshes:[{vert:new Float32Array([-.1,-.06,-.08,.15,-.06,-.08,.15,.06,-.08,-.1,.06,-.08])}]};
  const asset=await loadGoldSrcCharacter(source);
  const body=asset.create(model,()=>{});assert.equal(body.meshes.length,11);
  assert.equal(body.root.animations.length,367);
  const frame=new Float32Array(ngeom*7),x=new Float32Array(ngeom*3),r=new Float32Array(ngeom*9);
  for(let i=0;i<ngeom;i++){x.set(centers[i+1],i*3);r.set([1,0,0,0,1,0,0,0,1],i*9);frame.set([...centers[i+1],1,0,0,0],i*7);}
  body.sync(x,r);const preview=body.preview(null,()=>{});let previewTriangles=0;
  preview.traverse(object=>{if(object.isMesh){previewTriangles+=object.geometry.index.count/3;assert.ok(!object.isSkinnedMesh);}});
  assert.equal(previewTriangles,13980);
  const poses=new Float32Array(ngeom*14);poses.set(frame);poses.set(frame,ngeom*7);
  for(let i=0;i<ngeom;i++){poses[ngeom*7+i*7]+=2;poses[ngeom*7+i*7+1]-=1;poses[ngeom*7+i*7+2]+=3;}
  const exported=body.export(GeometryTrack.dense(ngeom,2,poses),new Float32Array([0,.1]));let exportedTriangles=0;
  exported.root.traverseVisible(object=>{if(object.isMesh)exportedTriangles+=object.geometry.index.count/3;});
  assert.equal(exportedTriangles,13980);assert.equal(exported.root.animations.length,367);
  {
  const mixer=new THREE.AnimationMixer(exported.root);
  const action=mixer.clipAction(new THREE.AnimationClip('recorded',.1,exported.tracks));
  action.clampWhenFinished=true;action.setLoop(THREE.LoopOnce,1).play();mixer.setTime(0);
  const start=exported.root.position.clone();mixer.setTime(.1);
  const delta=exported.root.position.clone().sub(start);
  assert.ok(delta.distanceTo(new THREE.Vector3(2,-1,3))<1e-5,'Recorded character motion must play on the exported rig');
  mixer.stopAllAction();mixer.uncacheRoot(exported.root);
  }
  body.dispose();asset.dispose();
  const reject=async(mutator,pattern)=>{const bad=Buffer.from(bytes);mutator(bad);await assert.rejects(decodeGoldSrcScene({...source,model:buffer(bad)}),pattern);};
  await reject(b=>b.write('IDAG',0),/unsupported model format/);
  await reject(b=>b.writeInt32LE(48,4),/version 10/);
  await assert.rejects(decodeGoldSrcScene({...source,model:source.model.slice(0,100)}),/out-of-bounds/);
  await reject(b=>b.writeInt32LE(0,boneOffset+32),/hierarchy/);
  await reject(b=>b.writeInt32LE(0x7fffffff,tex+76),/out-of-bounds/);
  await reject(b=>{b.writeInt32LE(100000,sequenceOffset+56);b.writeInt32LE(4,sequenceOffset+120);},/decoded model.*limit/);
  const firstAnim=bytes.readInt32LE(sequenceOffset+124);let rleOffset;
  for(let c=0;c<61*6&&!rleOffset;c++){const delta=bytes.readUInt16LE(firstAnim+c*2);if(delta)rleOffset=firstAnim+Math.floor(c/6)*12+delta;}
  assert.ok(rleOffset);await reject(b=>{b[rleOffset]=0;b[rleOffset+1]=0;},/RLE/);
  // A modified real header requires exactly its one texture MDL; no speculative downloads.
  const noTextures=Buffer.from(bytes);noTextures.writeInt32LE(0,180);const calls=[];
  await decodeGoldSrcScene({...source,model:buffer(noTextures),loadDependency:async name=>{calls.push(name);return buffer(bytes);}});
  assert.deepEqual(calls,['picardia_v1sct.mdl']);
  // An actual nonzero sequence-group reference requires IDSQ. Keep the real channel offsets.
  const external=Buffer.alloc(bytes.length+208);bytes.copy(external);external.writeInt32LE(external.length,72);
  external.writeInt32LE(2,172);external.writeInt32LE(bytes.length,176);external.writeInt32LE(1,sequenceOffset+156);
  external.write('picardia_v1sc01.mdl',bytes.length+104+32);const group=Buffer.from(bytes);group.write('IDSQ',0);const groupCalls=[];
  await decodeGoldSrcScene({...source,model:buffer(external),loadDependency:async name=>{groupCalls.push(name);return buffer(group);}});
  assert.deepEqual(groupCalls,['picardia_v1sc01.mdl']);
  // Preserve flags even when the supplied model does not happen to use them.
  const flagged=Buffer.from(bytes);flagged.writeInt32LE(2|4|16|32|64,tex+64);flagged[pixels]=255;
  const flaggedScene=(await decodeGoldSrcScene({...source,model:buffer(flagged)})).scene;
  let flaggedMaterial;flaggedScene.traverse(o=>{if(o.isSkinnedMesh&&o.userData.goldsrcSkinRef===0)flaggedMaterial=o.material;});
  assert.ok(flaggedMaterial.userData.goldsrcFullbright);assert.equal(flaggedMaterial.color.getHex(),0);
  assert.equal(flaggedMaterial.emissive.getHex(),0xffffff);assert.equal(flaggedMaterial.emissiveMap,flaggedMaterial.map);
  assert.equal(flaggedMaterial.map.image.data[3],0);assert.equal(flaggedMaterial.alphaTest,.5);
  assert.equal(flaggedMaterial.blending,THREE.AdditiveBlending);assert.equal(flaggedMaterial.depthWrite,false);
  // Real skin references, including nondefault families, remain available without dropping geometry.
  const refs=bytes.readInt32LE(192),familyBytes=refs*4,skins=Buffer.alloc(bytes.length+familyBytes);bytes.copy(skins);
  skins.writeInt32LE(skins.length,72);skins.writeInt32LE(2,196);skins.writeInt32LE(bytes.length,200);
  for(let slot=0;slot<refs;slot++){skins.writeInt16LE(meta.skinFamilies[0][slot],bytes.length+slot*2);skins.writeInt16LE(7-meta.skinFamilies[0][slot],bytes.length+refs*2+slot*2);}
  const skinsScene=(await decodeGoldSrcScene({...source,model:buffer(skins)})).scene;
  assert.equal(skinsScene.userData.goldsrc.skinFamilies.length,2);
  skinsScene.traverse(o=>{if(o.isSkinnedMesh)assert.equal(o.userData.goldsrcSkinTextures.length,2);});
  console.log(JSON.stringify({assetSHA256:crypto.createHash('sha256').update(bytes).digest('hex'),bones:61,sequences:203,clips:367,
    textures:8,bodyparts:7,visibleMeshes:visibleMeshes.length,allMeshes:meshes.length,visibleTriangles:13980,allTriangles:16378,outwardFaces,
    invariants:'native fan/strip winding, front/back raycasting, unchanged vertex attributes/bind/material flags, palette, bone-space geometry, bind skinning, RLE, clips, root motion, rig, authored material flags, malformed-data errors, required dependencies'},null,2));
})().catch(error=>{console.error(error);process.exitCode=1;});
