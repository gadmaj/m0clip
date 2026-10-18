/** Native Dog skin fitted to R1. The physics model and recorded geom poses stay untouched. */
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { clone as cloneSkeleton } from 'three/addons/utils/SkeletonUtils.js';
import type { RenderModel } from '../../sim/protocol';
import { DogRetarget, type NativeRig, type RigPose } from './retarget';

export const DOG_URL='/assets/source-robots/halflife2-dog/dog.glb';
export type BodyVisual='stock'|'dog';
export interface BodyVisualState {choice:BodyVisual;applied:BodyVisual;available:boolean;loading:boolean;error:string|null}
export interface DogAsset {create(model:RenderModel,paint:(part:string,material:THREE.MeshPhysicalMaterial)=>void):DogBody}
interface MaterialEntry {part:string;source:THREE.MeshStandardMaterial;material:THREE.MeshPhysicalMaterial}
interface Detail {texture:THREE.Texture;scale:number;factor:number}

export class DogBody {
  readonly root:THREE.Object3D;
  readonly retarget:DogRetarget;
  readonly meshes:THREE.SkinnedMesh[]=[];
  readonly bones:THREE.Bone[];
  private pose:RigPose;
  private materials:MaterialEntry[]=[];
  private originalMaterial=new WeakMap<THREE.Material,{opacity:number;transparent:boolean;depthWrite:boolean}>();

  constructor(source:THREE.Object3D,metadata:NativeRig,model:RenderModel,
      private paint:(part:string,material:THREE.MeshPhysicalMaterial)=>void,details:Map<THREE.Material,Detail>) {
    this.retarget=new DogRetarget(metadata,model);this.root=cloneSkeleton(source);
    this.root.name='HalfLife2_Dog_R1';this.root.userData.sourceRobotPart='models/dog.mdl';
    this.root.traverse(object=>{if(object instanceof THREE.SkinnedMesh)this.meshes.push(object)});
    if(!this.meshes.length)throw new Error('Native Dog has no skinned meshes.');
    this.bones=this.meshes[0].skeleton.bones;
    if(this.bones.length!==metadata.bones.length)throw new Error('Native Dog skeleton differs from its metadata.');
    this.pose=this.retarget.createPose();this.root.scale.setScalar(this.retarget.scale);
    for(const mesh of this.meshes) {
      const sourceMaterial=mesh.material as THREE.MeshStandardMaterial;
      if(Array.isArray(sourceMaterial))throw new Error('Expected one original material per Dog primitive.');
      const geometry=mesh.geometry.clone(),index=geometry.index;
      if(!index)throw new Error('Native Dog is missing its original triangle indices.');
      const joints=geometry.getAttribute('skinIndex'),weights=geometry.getAttribute('skinWeight');
      const groups=new Map<string,number[]>();
      for(let start=0;start<index.count;start+=3) {
        const influence=new Map<string,number>();
        for(let k=0;k<3;k++)for(let j=0;j<4;j++) {
          const vertex=index.getX(start+k),weight=weights.getComponent(vertex,j);
          if(!weight)continue;
          const part=this.retarget.parts[joints.getComponent(vertex,j)];
          influence.set(part,(influence.get(part)??0)+weight);
        }
        const part=[...influence].sort((a,b)=>b[1]-a[1])[0]?.[0]??'pelvis_link';
        const list=groups.get(part)??[];list.push(index.getX(start),index.getX(start+1),index.getX(start+2));groups.set(part,list);
      }
      const indices:number[]=[],materials:THREE.MeshPhysicalMaterial[]=[],partNames:string[]=[];
      geometry.clearGroups();
      for(const [part,triangles]of groups) {
        const material=new THREE.MeshPhysicalMaterial();
        THREE.MeshStandardMaterial.prototype.copy.call(material,sourceMaterial);
        Object.assign(material,{defines:{STANDARD:'',PHYSICAL:''}});
        const opaque=!sourceMaterial.transparent&&sourceMaterial.alphaTest===0,detail=details.get(sourceMaterial);
        material.onBeforeCompile=shader=>{
          if(detail){Object.assign(shader.uniforms,{nativeRobotDetail:{value:detail.texture},nativeRobotDetailScale:{value:detail.scale},nativeRobotDetailFactor:{value:detail.factor}});
            shader.fragmentShader='uniform sampler2D nativeRobotDetail;\nuniform float nativeRobotDetailScale;\nuniform float nativeRobotDetailFactor;\n'+shader.fragmentShader;}
          // Source stores illumination/specular masks in opaque texture alpha.
          // A noclip fade must not turn that mask into holes in the robot.
          shader.fragmentShader=shader.fragmentShader.replace('#include <map_fragment>',
            '#include <map_fragment>\n'+(opaque?'diffuseColor.a = opacity;\n':'')+
            (detail?'#ifdef USE_MAP\n diffuseColor.rgb *= mix(vec3(1.0),2.0*texture2D(nativeRobotDetail,vMapUv*nativeRobotDetailScale).rgb,nativeRobotDetailFactor);\n#endif\n':''));
        };
        material.customProgramCacheKey=()=> `source-robot-native-map-v1-${opaque}-${!!detail}`;
        this.materials.push({part,source:sourceMaterial,material});
        geometry.addGroup(indices.length,triangles.length,materials.length);indices.push(...triangles);
        materials.push(material);partNames.push(part);
      }
      geometry.setIndex(indices);mesh.geometry=geometry;mesh.material=materials;
      mesh.userData.sourcePartNames=partNames;mesh.userData.sourceRobotPart='models/dog.mdl';
      mesh.frustumCulled=false;mesh.castShadow=true;mesh.receiveShadow=true;
    }
    this.updateMaterials();
    this.retarget.evaluate((g,m)=>{const body=model.bodyid[g];m.copy(this.retarget.reference[body]);
      const f=model.geomFrames!,p=3*g,q=4*g;const local=new THREE.Matrix4().compose(new THREE.Vector3(f.pos[p],f.pos[p+1],f.pos[p+2]),
        new THREE.Quaternion(f.quat[q+1],f.quat[q+2],f.quat[q+3],f.quat[q]),new THREE.Vector3(1,1,1));m.multiply(local)},this.pose);
    this.apply(this.pose);
  }
  partNames(){return[...new Set(this.materials.map(m=>m.part))].sort()}
  updateMaterials() {
    for(const {part,source,material}of this.materials) {
      THREE.MeshStandardMaterial.prototype.copy.call(material,source);
      Object.assign(material,{defines:{STANDARD:'',PHYSICAL:''}});
      material.clearcoat=0;material.specularIntensity=1;material.sheen=0;material.iridescence=0;
      this.paint(part,material);material.needsUpdate=true;
      this.originalMaterial.set(material,{opacity:material.opacity,transparent:material.transparent,depthWrite:material.depthWrite});
    }
  }
  eachMaterial(visit:(material:THREE.Material)=>void){for(const entry of this.materials)visit(entry.material)}
  private apply(pose:RigPose) {
    this.root.position.copy(pose.position);this.root.quaternion.copy(pose.quaternion);
    this.bones.forEach((bone,i)=>bone.quaternion.copy(pose.bones[i]));
    this.root.updateMatrixWorld(true);
    for(const mesh of this.meshes)mesh.skeleton.update();
  }
  sync(xpos:Float32Array,xmat:Float32Array){this.retarget.fromFrame(xpos,xmat,this.pose);this.apply(this.pose)}
  visibility(opacity:number,visible:boolean) {
    this.root.visible=visible&&opacity>0;
    for(const {material}of this.materials) {
      const original=this.originalMaterial.get(material)!;
      const fading=opacity>0&&opacity<1,transparent=original.transparent||fading;
      if(material.transparent!==transparent){material.transparent=transparent;material.needsUpdate=true}
      material.opacity=original.opacity*opacity;material.depthWrite=fading?false:original.depthWrite;
    }
  }
  /** Clone for DCC; keys are computed from the take, without touching the live rig. */
  export(poses:Float32Array,ngeom:number,times:Float32Array) {
    const root=cloneSkeleton(this.root);root.visible=true;
    const bones:THREE.Bone[][]=[];
    root.traverse(object=>{if(object instanceof THREE.SkinnedMesh) {
      bones.push(object.skeleton.bones);
      object.material=[object.material].flat().map(original=>{
        const material=original.clone(),saved=this.originalMaterial.get(original)!;
        material.opacity=saved.opacity;material.transparent=saved.transparent;material.depthWrite=saved.depthWrite;return material;
      });
    }});
    const pose=this.retarget.createPose(),positions:number[]=[],rotations:number[]=[],local=this.bones.map(()=>[] as number[]);
    const push=(array:number[],q:THREE.Quaternion)=>{
      const n=array.length,sign=n&&array[n-4]*q.x+array[n-3]*q.y+array[n-2]*q.z+array[n-1]*q.w<0?-1:1;
      array.push(q.x*sign,q.y*sign,q.z*sign,q.w*sign);
    };
    for(let i=0;i<times.length;i++) {
      this.retarget.fromRecorded(poses,i*ngeom*7,pose);positions.push(...pose.position.toArray());push(rotations,pose.quaternion);
      pose.bones.forEach((q,j)=>push(local[j],q));
    }
    root.position.fromArray(positions);root.quaternion.fromArray(rotations);
    bones[0].forEach((b,i)=>b.quaternion.fromArray(local[i]));root.updateMatrixWorld(true);
    const tracks:THREE.KeyframeTrack[]=[new THREE.VectorKeyframeTrack(`${root.uuid}.position`,times,positions),
      new THREE.QuaternionKeyframeTrack(`${root.uuid}.quaternion`,times,rotations),
      ...bones[0].map((bone,i)=>new THREE.QuaternionKeyframeTrack(`${bone.uuid}.quaternion`,times,local[i]))];
    return{root,tracks};
  }
  dispose(){for(const mesh of this.meshes)mesh.geometry.dispose();for(const skeleton of new Set(this.meshes.map(m=>m.skeleton)))skeleton.dispose();for(const {material}of this.materials)material.dispose();this.root.removeFromParent()}
}

export async function loadDog(url=DOG_URL):Promise<DogAsset> {
  const gltf=await new GLTFLoader().loadAsync(url);
  let metadata:NativeRig|null=null;const materials=new Set<THREE.Material>(),details=new Map<THREE.Material,Detail>();
  gltf.scene.traverse(object=>{if(object.userData.sourceRig)metadata=object.userData.sourceRig;
    if(object instanceof THREE.Mesh)for(const material of [object.material].flat())materials.add(material)});
  if(!metadata)throw new Error('Original Dog rig metadata is missing.');
  const rig=metadata as NativeRig;
  if(!rig.footSamples?.length||rig.bones.some(b=>b.inverseBind?.length!==16))throw new Error('Dog model data is incomplete.');
  await Promise.all([...materials].map(async material=>{
    const meta=material.userData.sourceMaterial;if(typeof meta?.detailIndex!=='number')return;
    const texture=await gltf.parser.getDependency('texture',meta.detailIndex) as THREE.Texture;
    texture.colorSpace=THREE.NoColorSpace;texture.needsUpdate=true;
    details.set(material,{texture,scale:meta.detailscale,factor:meta.detailblendfactor});
  }));
  return{create:(model,paint)=>new DogBody(gltf.scene,metadata!,model,paint,details)};
}
