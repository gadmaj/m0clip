/** Native bind pose, geom/body-frame conversion, rigid motion and recording invariants. */
import assert from 'node:assert/strict';import fs from 'node:fs/promises';import{build}from'esbuild';
const result=await build({stdin:{contents:"export * as THREE from 'three';export {DogRetarget} from './src/render/source-robot/retarget';export {GeometryTrack} from './src/core/geometry';",resolveDir:process.cwd()},bundle:true,format:'esm',platform:'node',write:false});
const{THREE,DogRetarget,GeometryTrack}=await import('data:text/javascript;base64,'+Buffer.from(result.outputFiles[0].text).toString('base64'));
const native=JSON.parse(await fs.readFile('public/assets/source-robots/halflife2-dog/analysis.json','utf8'));
const names=['world','pelvis','torso_link','waist_roll_link','left_hip_yaw_link','left_knee_link','left_ankle_roll_link','right_hip_yaw_link','right_knee_link','right_ankle_roll_link','left_shoulder_yaw_link','left_elbow_link','left_wrist_roll_link','right_shoulder_yaw_link','right_elbow_link','right_wrist_roll_link','head_pitch_link','head_yaw_link'];
const pos=new Float64Array(names.length*3),quat=new Float64Array(names.length*4),parent=new Int32Array(names.length),gpos=new Float64Array((names.length-1)*3),gquat=new Float64Array((names.length-1)*4);
for(let i=0;i<names.length;i++){quat[i*4]=1;pos[i*3+2]=i===1?.74:names[i].includes('ankle')?.04:.5;if(i){gpos[(i-1)*3]=.03;gquat[(i-1)*4]=Math.cos(.2);gquat[(i-1)*4+3]=Math.sin(.2)}}
const model={robot:'r1',ngeom:names.length-1,bodyNames:names,bodyid:Int32Array.from(names.slice(1),(_,i)=>i+1),bodyFrames:{parent,pos,quat},geomFrames:{pos:gpos,quat:gquat},meshes:{},dataid:new Int32Array(names.length-1).fill(-1),contype:new Int32Array(names.length-1)};
const rig=new DogRetarget(native,model),pose=rig.createPose();
const local=Array.from(model.bodyid,(_,g)=>new THREE.Matrix4().compose(new THREE.Vector3(gpos[g*3],gpos[g*3+1],gpos[g*3+2]),new THREE.Quaternion(gquat[g*4+1],gquat[g*4+2],gquat[g*4+3],gquat[g*4]),new THREE.Vector3(1,1,1)));
const world=Array.from(model.bodyid,(body,g)=>rig.reference[body].clone().multiply(local[g]));
rig.evaluate((g,m)=>m.copy(world[g]),pose);
for(let i=0;i<native.bones.length;i++)assert.ok(pose.bones[i].angleTo(new THREE.Quaternion(...native.bones[i].quaternion).normalize())<1e-6,`bind ${i}`);
const original=pose.bones.map(q=>q.clone()),root=pose.position.clone(),orientation=pose.quaternion.clone();
const move=new THREE.Matrix4().makeRotationZ(.7);move.setPosition(3,-4,8);rig.evaluate((g,m)=>m.copy(move).multiply(world[g]),pose);
for(let i=0;i<original.length;i++)assert.ok(original[i].angleTo(pose.bones[i])<1e-6,`rigid ${i}`);
assert.ok(pose.position.distanceTo(root.clone().applyMatrix4(move))<1e-8);assert.ok(pose.quaternion.angleTo(new THREE.Quaternion().setFromRotationMatrix(move).multiply(orientation))<1e-6);
const xpos=new Float32Array(model.ngeom*3),xmat=new Float32Array(model.ngeom*9),recorded=new Float32Array(model.ngeom*7);
world.forEach((m,g)=>{const e=m.elements;new THREE.Vector3().setFromMatrixPosition(m).toArray(xpos,g*3);xmat.set([e[0],e[4],e[8],e[1],e[5],e[9],e[2],e[6],e[10]],g*9);const p=new THREE.Vector3().setFromMatrixPosition(m),q=new THREE.Quaternion().setFromRotationMatrix(m);recorded.set([p.x,p.y,p.z,q.w,q.x,q.y,q.z],g*7)});
const live=rig.createPose(),replay=rig.createPose();rig.fromFrame(xpos,xmat,live);rig.fromRecorded(GeometryTrack.dense(model.ngeom,1,recorded),0,replay);assert.ok(live.position.distanceTo(replay.position)<1e-7);for(let i=0;i<original.length;i++)assert.ok(live.bones[i].angleTo(replay.bones[i])<1e-6,`replay ${i}`);
const elbow=names.indexOf('left_elbow_link'),left=model.bodyid.indexOf(elbow),before=rig.createPose();rig.evaluate((g,m)=>m.copy(world[g]),before);
rig.evaluate((g,m)=>{m.copy(world[g]);if(g===left)m.premultiply(new THREE.Matrix4().makeRotationX(.6))},pose);
assert.ok(pose.bones[24].angleTo(before.bones[24])>.59);assert.ok(pose.bones[38].angleTo(before.bones[38])<1e-6);
const oldScale=rig.scale;for(let i=1;i<names.length;i++)pos[i*3+2]+=20;const translated=new DogRetarget(native,model);assert.ok(Math.abs(oldScale-translated.scale)<1e-10);
console.log('PASS: native bind pose, compiled geom offsets, global movement, live/replayed pose equivalence, independent limb rotation, fit independent of map elevation');
