/** Anatomical pivots, independent attachments and animated GLB geometry through the real body factory. */
'use strict';
const assert=require('node:assert/strict'),path=require('node:path');
const {build}=require('esbuild');
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
(async()=>{
  const root=path.resolve(__dirname,'..');
  const bundle=await build({stdin:{resolveDir:root,sourcefile:'character-joints-fixture.ts',contents:`
    import * as THREE from 'three';
    import {GLTFLoader} from 'three/addons/loaders/GLTFLoader.js';
    import {GLTFExporter} from 'three/addons/exporters/GLTFExporter.js';
    import {characterAsset} from './src/render/characters/body';
    import {GeometryTrack} from './src/core/geometry';
    import {extraSkinningWriter,prepareExtraSkinning} from './src/render/extra-skin';
    const check=(ok,message)=>{if(!ok)throw Error(message)};
    const names=['world','pelvis','torso_link','left_shoulder_yaw_link','right_shoulder_yaw_link','left_elbow_link','right_elbow_link','left_wrist_roll_link','right_wrist_roll_link','left_hip_yaw_link','right_hip_yaw_link','left_knee_link','right_knee_link','left_ankle_roll_link','right_ankle_roll_link'];
    const centers=[[0,0,0],[0,0,.74],[0,0,.98],[0,.24,1.1],[0,-.24,1.1],[0,.24,.82],[0,-.24,.82],[0,.24,.59],[0,-.24,.59],[0,.12,.68],[0,-.12,.68],[0,.12,.4],[0,-.12,.4],[0,.12,.08],[0,-.12,.08]];
    const n=names.length,ngeom=n-1,bodyQuat=new Float64Array(n*4),geomQuat=new Float64Array(ngeom*4);
    for(let i=0;i<n;i++)bodyQuat[i*4]=1;for(let i=0;i<ngeom;i++)geomQuat[i*4]=1;
    const sole=new Float32Array([-.1,-.06,-.08,.15,-.06,-.08,.15,.06,-.08,-.1,.06,-.08]);
    const model={robot:'r1',ngeom,bodyNames:names,bodyid:Int32Array.from(names.slice(1),(_,i)=>i+1),bodyFrames:{parent:new Int32Array(n),pos:Float64Array.from(centers.flat()),quat:bodyQuat},geomFrames:{pos:new Float64Array(ngeom*3),quat:geomQuat},contype:new Int32Array(ngeom),dataid:new Int32Array(ngeom),meshes:[{vert:sole}]};
    const source=new THREE.Group(),hips=new THREE.Bone(),upper=new THREE.Bone(),lower=new THREE.Bone(),arm=new THREE.Bone(),grip=new THREE.Bone(),tip=new THREE.Bone();
    [hips,upper,lower,arm,grip,tip].forEach((b,i)=>b.name=['Hips','ReverseUpper','ReverseLower','Forearm','IndependentGrip','GripTip'][i]);
    hips.position.set(0,1,0);upper.position.set(.15,-.5,0);lower.position.set(0,-.5,0);arm.position.set(.3,-.2,0);grip.position.set(.5,.85,0);tip.position.set(.1,0,0);
    source.add(hips,grip);hips.add(upper,arm);upper.add(lower);grip.add(tip);
    const vertices=[0,1,0,.15,1,0,.15,.5,0,.15,1,0,.15,.5,0,.15,0,0,.15,.5,0,.15,0,0,.18,0,0,.5,.85,0,.6,.85,0,.5,.95,0];
    const joints=[0,0,0,1,1,1,2,2,2,4,4,4],geometry=new THREE.BufferGeometry();geometry.setAttribute('position',new THREE.Float32BufferAttribute(vertices,3));
    geometry.setAttribute('skinIndex',new THREE.Uint16BufferAttribute(joints.flatMap(j=>[j,0,0,0]),4));geometry.setAttribute('skinWeight',new THREE.Float32BufferAttribute(joints.flatMap(()=>[1,0,0,0]),4));geometry.setIndex([...Array(joints.length).keys()]);geometry.computeVertexNormals();
    const mesh=new THREE.SkinnedMesh(geometry,new THREE.MeshStandardMaterial({color:0xffffff}));source.add(mesh);source.updateMatrixWorld(true);mesh.bind(new THREE.Skeleton([hips,upper,lower,arm,grip,tip]));
    const definition={id:'joint-fixture',label:'Joint fixture',url:'',preview:'',attribution:{title:'Generated joint fixture',creator:'m0clip',source:'local fixture',license:'test fixture',modifications:[]},rig:{root:'Hips',alignment:[.5,.5,.5,.5],bindings:{Hips:['pelvis'],ReverseUpper:['left_hip_yaw_link'],ReverseLower:['left_knee_link'],Forearm:['left_elbow_link']},pivots:{ReverseUpper:[0,.5,0],ReverseLower:[0,.5,0]},aim:{ReverseUpper:{direction:[0,-1,0],target:['left_knee_link']},ReverseLower:{direction:[0,-1,0],target:['left_ankle_roll_link']}},attachments:{IndependentGrip:'Forearm'},feet:[{bone:'ReverseLower',target:['left_ankle_roll_link']}]}};
    const restGrip=arm.matrixWorld.clone().invert().multiply(grip.matrixWorld);
    const asset=characterAsset(source,definition),body=asset.create(model,()=>{}),native=body.meshes[0];
    const byName=new Map(body.retarget.bones.map(b=>[b.name,b]));
    const record=(hipAngle,kneeAngle,elbowAngle,move=new THREE.Matrix4())=>{
      const matrices=centers.map(p=>new THREE.Matrix4().makeTranslation(...p)),hip=names.indexOf('left_hip_yaw_link'),knee=names.indexOf('left_knee_link'),ankle=names.indexOf('left_ankle_roll_link'),elbow=names.indexOf('left_elbow_link');
      const hipQ=new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0,1,0),hipAngle),kneeQ=hipQ.clone().multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0,1,0),kneeAngle));
      const hipP=new THREE.Vector3().fromArray(centers[hip]),kneeP=new THREE.Vector3().fromArray(centers[knee]).sub(hipP).applyQuaternion(hipQ).add(hipP),ankleP=new THREE.Vector3().fromArray(centers[ankle]).sub(new THREE.Vector3().fromArray(centers[knee])).applyQuaternion(kneeQ).add(kneeP);
      matrices[hip].compose(hipP,hipQ,new THREE.Vector3(1,1,1));matrices[knee].compose(kneeP,kneeQ,new THREE.Vector3(1,1,1));matrices[ankle].compose(ankleP,kneeQ,new THREE.Vector3(1,1,1));matrices[elbow].compose(new THREE.Vector3().fromArray(centers[elbow]),new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1,0,0),elbowAngle),new THREE.Vector3(1,1,1));
      const worldMatrices=matrices.map(m=>move.clone().multiply(m)),recorded=new Float32Array(ngeom*7),xpos=new Float32Array(ngeom*3),xmat=new Float32Array(ngeom*9);
      for(let g=0;g<ngeom;g++){const m=worldMatrices[g+1],e=m.elements,p=new THREE.Vector3().setFromMatrixPosition(m),q=new THREE.Quaternion().setFromRotationMatrix(m);xpos.set(p.toArray(),g*3);xmat.set([e[0],e[4],e[8],e[1],e[5],e[9],e[2],e[6],e[10]],g*9);recorded.set([p.x,p.y,p.z,q.w,q.x,q.y,q.z],g*7)}
      return {recorded,xpos,xmat,matrices:worldMatrices};
    };
    const worldVertex=i=>native.getVertexPosition(i,new THREE.Vector3()).applyMatrix4(native.matrixWorld);
    const localPose=()=>body.retarget.bones.map(b=>({p:b.position.toArray(),q:b.quaternion.toArray()}));
    const snapshot=()=>JSON.stringify({p:body.root.position.toArray(),q:body.root.quaternion.toArray(),bones:localPose()});
    const verify=sample=>{
      body.sync(sample.xpos,sample.xmat);body.root.updateMatrixWorld(true);
      check(worldVertex(1).distanceTo(worldVertex(3))<2e-6,'Upper-tail anatomical joint tears from pelvis surface');
      check(worldVertex(4).distanceTo(worldVertex(6))<2e-6,'Lower-tail knee joint tears from upper segment');
      const actual=byName.get('Forearm').matrixWorld.clone().invert().multiply(byName.get('IndependentGrip').matrixWorld);
      check(actual.elements.every((v,i)=>Math.abs(v-restGrip.elements[i])<2e-6),'Independent attachment lost native grip transform');
      const up=new THREE.Vector3(0,0,1).applyMatrix3(new THREE.Matrix3().setFromMatrix4(sample.matrices[1])).normalize();
      let target=Infinity;const foot=names.indexOf('left_ankle_roll_link');for(let i=0;i<sole.length;i+=3)target=Math.min(target,new THREE.Vector3().fromArray(sole,i).applyMatrix4(sample.matrices[foot]).dot(up));
      const observed=Math.min(...[6,7,8].map(i=>worldVertex(i).dot(up)));check(Math.abs(observed-target)<3e-6,'Calf sole fitted to knee instead of configured ankle geometry');
      return [...Array(joints.length)].map((_,i)=>worldVertex(i));
    };
    const rest=record(0,0,0),bent=record(.65,-1.1,.9),restVertices=verify(rest),bentVertices=verify(bent),bentLocal=localPose();
    check(bentVertices[7].distanceTo(restVertices[7])>.05,'Joint bend did not deform actual weighted foot surface');
    const move=new THREE.Matrix4().makeRotationFromEuler(new THREE.Euler(.3,-.4,.7));move.setPosition(3,-4,8);
    const tilted=record(.65,-1.1,.9,move);const tiltedVertices=verify(tilted),tiltedLocal=localPose();
    for(let i=0;i<joints.length;i++)check(tiltedVertices[i].distanceTo(bentVertices[i].clone().applyMatrix4(move))<2e-5,'Rigid flight changed articulated mesh shape');
    for(let i=0;i<bentLocal.length;i++){
      check(new THREE.Vector3().fromArray(bentLocal[i].p).distanceTo(new THREE.Vector3().fromArray(tiltedLocal[i].p))<2e-5,'Rigid flight changed local pivot translation');
      check(new THREE.Quaternion().fromArray(bentLocal[i].q).angleTo(new THREE.Quaternion().fromArray(tiltedLocal[i].q))<2e-5,'Rigid flight changed local attachment rotation');
    }
    const before=snapshot(),preview=body.preview(null,()=>{});check(snapshot()===before,'Preview changed live translated pose');
    const poses=new Float32Array(ngeom*14);poses.set(rest.recorded);poses.set(bent.recorded,ngeom*7);
    const exported=body.export(GeometryTrack.dense(ngeom,2,poses),new Float32Array([0,.25]));check(snapshot()===before,'Export changed live translated pose');
    const output=await new GLTFExporter().register(extraSkinningWriter).parseAsync(exported.root,{binary:true,trs:true,animations:[new THREE.AnimationClip('motion',-1,exported.tracks)]});
    const loaded=await new GLTFLoader().parseAsync(output,'');prepareExtraSkinning(loaded.scene);const loadedMeshes=[];loaded.scene.traverse(o=>{if(o.isSkinnedMesh)loadedMeshes.push(o)});
    const mixer=new THREE.AnimationMixer(loaded.scene),action=mixer.clipAction(loaded.animations[0]);action.setLoop(THREE.LoopOnce,1);action.clampWhenFinished=true;action.play();
    for(const [time,expected]of [[0,restVertices],[.25,bentVertices]]){
      mixer.setTime(time);loaded.scene.updateMatrixWorld(true);
      for(const m of loadedMeshes)for(let i=0;i<m.geometry.index.count;i++){const index=m.geometry.index.getX(i);check(m.getVertexPosition(index,new THREE.Vector3()).applyMatrix4(m.matrixWorld).distanceTo(expected[index])<2e-5,'GLB animation lost joint translation or attachment geometry')}
    }
    check(snapshot()===before,'GLB reimport leaked into live pose');verify(rest);
    const invalid=structuredClone(definition);invalid.rig.attachments={IndependentGrip:'GripTip'};
    const bad=characterAsset(source,invalid);let rejected=false;try{bad.create(model,()=>{})}catch{rejected=true}check(rejected,'Cyclic virtual attachment was not rejected before pose evaluation');bad.dispose();
    preview.traverse(o=>{if(o.isMesh)o.geometry.dispose()});body.dispose();asset.dispose();window.done=true;
  `},bundle:true,format:'esm',platform:'browser',write:false});
  const browser=await chromium.launch({executablePath:process.env.CHROME_BIN||'/usr/bin/google-chrome',headless:true,args:['--no-sandbox','--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader']});
  try{
    const page=await browser.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.stack||e.message));
    await page.route('http://m0clip-joints.test/',r=>r.fulfill({contentType:'text/html',body:'<!doctype html><script type="module" src="/fixture.js"></script>'}));
    await page.route('http://m0clip-joints.test/fixture.js',r=>r.fulfill({contentType:'text/javascript',body:bundle.outputFiles[0].text}));
    await page.goto('http://m0clip-joints.test/');await Promise.race([page.waitForFunction(()=>window.done,null,{timeout:120000}),page.waitForEvent('pageerror').then(e=>{throw e})]);
    assert.deepEqual(errors,[]);console.log('Native joint geometry, anatomical soles, independent grips, rigid flight and animated GLB roundtrip PASS');
  }finally{await browser.close()}
})().catch(e=>{console.error(e);process.exitCode=1});
