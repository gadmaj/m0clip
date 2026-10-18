/** Retarget native Source bone rotations to R1, preserving native bone lengths and weights. */
import * as THREE from 'three';
import type { RenderModel } from '../../sim/protocol';

export interface NativeRig {
  bones: {name:string;parent:number;position:number[];quaternion:number[];inverseBind:number[]}[];
  footSamples:{position:number[];joints:number[];weights:number[]}[];
  bounds:number[][];
}
// Unmapped mechanisms/fingers retain their native local bind transforms.
const DOG_BODIES: Record<string,string[]> = {
  Pelvis:['pelvis'], Leg1_L:['left_hip_yaw_link'],Leg2_L:['left_knee_link'],Foot_L:['left_ankle_roll_link'],
  Leg1_R:['right_hip_yaw_link'],Leg2_R:['right_knee_link'],Foot_R:['right_ankle_roll_link'],
  Spine1:['waist_roll_link','torso_link'],Spine2:['torso_link'],Spine3:['torso_link'],
  Neck1:['head_pitch_link','torso_link'],Eye:['head_yaw_link','head_pitch_link','torso_link'],
  Arm1_L:['left_shoulder_yaw_link'],Arm2_L:['left_elbow_link'],Hand_L:['left_wrist_roll_link','left_elbow_link'],
  Arm1_R:['right_shoulder_yaw_link'],Arm2_R:['right_elbow_link'],Hand_R:['right_wrist_roll_link','right_elbow_link'],
};
export interface RigPose { position:THREE.Vector3;quaternion:THREE.Quaternion;bones:THREE.Quaternion[] }
const one=new THREE.Vector3(1,1,1);
function localFrame(pos:ArrayLike<number>,quat:ArrayLike<number>,index:number) {
  return new THREE.Matrix4().compose(new THREE.Vector3(pos[3*index],pos[3*index+1],pos[3*index+2]),
    new THREE.Quaternion(quat[4*index+1],quat[4*index+2],quat[4*index+3],quat[4*index]),one);
}

export class DogRetarget {
  readonly bindings: {body:number;geom:number;inverse:THREE.Matrix4;reference:THREE.Quaternion}[]=[];
  readonly parts:string[]=[];
  readonly scale:number;
  private mapped:(typeof this.bindings[number]|null)[]=[];
  private nativeWorld:THREE.Quaternion[]=[];
  private modelWorld:THREE.Quaternion[]=[];
  private alignment=new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0,0,1),Math.PI/2);
  private anchor=new THREE.Vector3();
  private matrix=new THREE.Matrix4();
  private current=new THREE.Quaternion();
  private inverseRoot=new THREE.Quaternion();
  private anchorWorld=new THREE.Vector3();
  private up=new THREE.Vector3();
  private nativeMatrices:THREE.Matrix4[]=[];
  private nativeSkin:THREE.Matrix4[]=[];
  private inverseBind:THREE.Matrix4[]=[];
  private local=new THREE.Matrix4();
  private rootMatrix=new THREE.Matrix4();
  private soles:{geom:number;vertices:Float32Array}[]=[];
  private footBindings:typeof this.bindings=[];
  private rootBinding:typeof this.bindings[number];
  readonly reference:THREE.Matrix4[]=[];

  static available(model:RenderModel) {
    return model.robot.startsWith('r1')&&!!model.bodyFrames&&!!model.geomFrames
      &&['pelvis','torso_link','left_knee_link','right_knee_link','left_elbow_link','right_elbow_link'].every(n=>model.bodyNames.includes(n));
  }
  constructor(readonly native:NativeRig,readonly model:RenderModel) {
    if(!DogRetarget.available(model))throw new Error('This robot does not expose the R1 body frames required for Dog.');
    const frames=model.bodyFrames!,geomFrames=model.geomFrames!;
    for(let i=0;i<model.bodyNames.length;i++) {
      const matrix=localFrame(frames.pos,frames.quat,i);
      this.reference.push(i===0?matrix:this.reference[frames.parent[i]].clone().multiply(matrix));
    }
    const byBody=new Map<number,typeof this.bindings[number]>();
    for(const bone of native.bones) {
      const candidates=DOG_BODIES[bone.name.replace('Dog_Model.','')]??[];
      const body=candidates.map(n=>model.bodyNames.indexOf(n)).find(i=>i>=0&&model.bodyid.includes(i));
      let binding=null;
      if(body!==undefined) {
        binding=byBody.get(body)??null;
        if(!binding) {
          const geom=Array.from(model.bodyid).findIndex(id=>id===body);
          if(geom<0)throw new Error(`R1 body ${model.bodyNames[body]} has no recorded geometry.`);
          binding={body,geom,inverse:localFrame(geomFrames.pos,geomFrames.quat,geom).invert(),
            reference:new THREE.Quaternion().setFromRotationMatrix(this.reference[body]).invert()};
          byBody.set(body,binding);this.bindings.push(binding);
        }
      }
      this.mapped.push(binding);
      const q=new THREE.Quaternion(...bone.quaternion as [number,number,number,number]).normalize();
      this.nativeWorld.push(bone.parent<0?q:this.nativeWorld[bone.parent].clone().multiply(q));
      this.modelWorld.push(new THREE.Quaternion());
      this.nativeMatrices.push(new THREE.Matrix4());this.nativeSkin.push(new THREE.Matrix4());
      this.inverseBind.push(new THREE.Matrix4().fromArray(bone.inverseBind));
      const label=bone.name.replace('Dog_Model.','');
      this.parts.push(label==='Eye'?'head_yaw_link':label==='Neck1'?'head_pitch_link':
        binding?(model.bodyNames[binding.body]==='pelvis'?'pelvis_link':model.bodyNames[binding.body]):bone.parent>=0?this.parts[bone.parent]:'pelvis_link');
    }
    this.rootBinding=this.mapped[0]!;
    this.anchor.fromArray(native.bones[0].position);
    const pelvisZ=new THREE.Vector3().setFromMatrixPosition(this.reference[this.rootBinding.body]).z;
    const feet=['left_ankle_roll_link','right_ankle_roll_link'].map(n=>model.bodyNames.indexOf(n)).filter(i=>i>=0);
    let sole=Infinity;
    for(let g=0;g<model.ngeom;g++) {
      if(!feet.includes(model.bodyid[g])||model.contype[g]!==0)continue;
      const mesh=model.meshes[model.dataid[g]];if(!mesh)continue;
      this.soles.push({geom:g,vertices:mesh.vert});
      const matrix=this.reference[model.bodyid[g]].clone().multiply(localFrame(geomFrames.pos,geomFrames.quat,g)),e=matrix.elements;
      for(let i=0;i<mesh.vert.length;i+=3)sole=Math.min(sole,e[2]*mesh.vert[i]+e[6]*mesh.vert[i+1]+e[10]*mesh.vert[i+2]+e[14]);
    }
    if(!Number.isFinite(sole))sole=Math.min(...feet.map(i=>new THREE.Vector3().setFromMatrixPosition(this.reference[i]).z));
    this.footBindings=this.bindings.filter(b=>feet.includes(b.body));
    const height=pelvisZ-sole;
    const nativeHeight=this.anchor.z-native.bounds[0][2];
    this.scale=height/nativeHeight;
    if(!Number.isFinite(this.scale)||this.scale<=0)throw new Error('Invalid native Dog fit.');
  }
  createPose():RigPose {
    return{position:new THREE.Vector3(),quaternion:new THREE.Quaternion(),bones:this.native.bones.map(()=>new THREE.Quaternion())};
  }
  evaluate(geomWorld:(geom:number,out:THREE.Matrix4)=>void,out:RigPose) {
    geomWorld(this.rootBinding.geom,this.matrix);this.matrix.multiply(this.rootBinding.inverse);
    out.position.setFromMatrixPosition(this.matrix);
    out.quaternion.setFromRotationMatrix(this.matrix).multiply(this.rootBinding.reference).multiply(this.alignment).normalize();
    this.inverseRoot.copy(out.quaternion).invert();
    this.anchorWorld.copy(this.anchor).multiplyScalar(this.scale).applyQuaternion(out.quaternion);
    out.position.sub(this.anchorWorld);
    for(let i=0;i<this.native.bones.length;i++) {
      const bone=this.native.bones[i],binding=this.mapped[i],world=this.modelWorld[i];
      if(binding) {
        geomWorld(binding.geom,this.matrix);this.matrix.multiply(binding.inverse);
        this.current.setFromRotationMatrix(this.matrix).multiply(binding.reference);
        world.copy(this.inverseRoot).multiply(this.current).multiply(this.alignment).multiply(this.nativeWorld[i]).normalize();
        out.bones[i].copy(bone.parent<0?world:this.modelWorld[bone.parent].clone().invert().multiply(world));
      } else {
        out.bones[i].fromArray(bone.quaternion).normalize();
        world.copy(bone.parent<0?out.bones[i]:this.modelWorld[bone.parent]).multiply(bone.parent<0?new THREE.Quaternion():out.bones[i]);
      }
    }
    // Keep the original shape, but anchor its sole plane to the recorded R1 feet.
    // Work along the robot's up axis so rigid rotations and airborne motion remain coherent.
    this.up.set(0,0,1).applyQuaternion(out.quaternion);
    this.rootMatrix.compose(out.position,out.quaternion,new THREE.Vector3().setScalar(this.scale));
    for(let i=0;i<this.native.bones.length;i++) {
      const bone=this.native.bones[i];this.local.compose(new THREE.Vector3().fromArray(bone.position),out.bones[i],one);
      this.nativeMatrices[i].copy(bone.parent<0?this.rootMatrix:this.nativeMatrices[bone.parent]).multiply(this.local);
      this.nativeSkin[i].copy(this.nativeMatrices[i]).multiply(this.inverseBind[i]);
    }
    let nativeSole=Infinity,targetSole=Infinity;
    for(const sample of this.native.footSamples) {
      let x=0,y=0,z=0;const p=sample.position;
      for(let j=0;j<sample.joints.length;j++) {
        const weight=sample.weights[j];if(!weight)continue;const e=this.nativeSkin[sample.joints[j]].elements;
        x+=weight*(e[0]*p[0]+e[4]*p[1]+e[8]*p[2]+e[12]);
        y+=weight*(e[1]*p[0]+e[5]*p[1]+e[9]*p[2]+e[13]);
        z+=weight*(e[2]*p[0]+e[6]*p[1]+e[10]*p[2]+e[14]);
      }
      nativeSole=Math.min(nativeSole,x*this.up.x+y*this.up.y+z*this.up.z);
    }
    for(const sole of this.soles) {
      geomWorld(sole.geom,this.matrix);const e=this.matrix.elements,p=sole.vertices;
      for(let i=0;i<p.length;i+=3) {
        const x=e[0]*p[i]+e[4]*p[i+1]+e[8]*p[i+2]+e[12];
        const y=e[1]*p[i]+e[5]*p[i+1]+e[9]*p[i+2]+e[13];
        const z=e[2]*p[i]+e[6]*p[i+1]+e[10]*p[i+2]+e[14];
        targetSole=Math.min(targetSole,x*this.up.x+y*this.up.y+z*this.up.z);
      }
    }
    if(!this.soles.length)for(const binding of this.footBindings) {
      geomWorld(binding.geom,this.matrix);this.matrix.multiply(binding.inverse);
      targetSole=Math.min(targetSole,new THREE.Vector3().setFromMatrixPosition(this.matrix).dot(this.up));
    }
    if(Number.isFinite(nativeSole)&&Number.isFinite(targetSole))out.position.addScaledVector(this.up,targetSole-nativeSole);
  }
  fromFrame(xpos:Float32Array,xmat:Float32Array,out:RigPose) {
    this.evaluate((g,m)=>{const r=9*g,p=3*g;m.set(xmat[r],xmat[r+1],xmat[r+2],xpos[p],xmat[r+3],xmat[r+4],xmat[r+5],xpos[p+1],xmat[r+6],xmat[r+7],xmat[r+8],xpos[p+2],0,0,0,1)},out);
  }
  fromRecorded(poses:ArrayLike<number>,offset:number,out:RigPose) {
    this.evaluate((g,m)=>{const p=offset+7*g;m.compose(new THREE.Vector3(poses[p],poses[p+1],poses[p+2]),new THREE.Quaternion(poses[p+4],poses[p+5],poses[p+6],poses[p+3]),one)},out);
  }
}
