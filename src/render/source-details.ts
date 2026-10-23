/** Batch Source's upright cutout detail sprites without changing their shapes or tint. */
import * as THREE from 'three';
import { sourceDiffuseOnly, sourceTextureControl, setSourceTexturesEnabled } from './source-textures';

type Eye = {value:THREE.Vector3};
interface BatchData {eye:Eye;positions:Float64Array;colors:Float64Array;names:string[]}
interface Owner {own<T extends {dispose():void}>(value:T):T;discard(value:{dispose():void}):void}
const batches=new WeakMap<THREE.BufferGeometry,BatchData>();
const billboards=new WeakMap<THREE.Material,Eye>();

export function patchDetailBillboard(material:THREE.Material,eye:Eye) {
  if(billboards.has(material))return;
  billboards.set(material,eye);
  const previous=material.onBeforeCompile.bind(material),key=material.customProgramCacheKey();
  material.onBeforeCompile=(shader,renderer)=>{
    previous(shader,renderer);shader.uniforms.sourceDetailEye=eye;
    shader.vertexShader='uniform vec3 sourceDetailEye;\n'+shader.vertexShader.replace('#include <begin_vertex>',`
      vec3 detailCenter=(modelMatrix*instanceMatrix*vec4(0.,0.,0.,1.)).xyz;
      float detailAngle=atan(sourceDetailEye.y-detailCenter.y,sourceDetailEye.x-detailCenter.x)-1.5707963267948966;
      float detailCos=cos(detailAngle),detailSin=sin(detailAngle);
      vec3 transformed=vec3(position.x*detailCos-position.y*detailSin,position.x*detailSin+position.y*detailCos,position.z);
    `);
  };
  material.customProgramCacheKey=()=>key+'-source-detail-instances-v1';material.needsUpdate=true;
}

export function copyDetailBillboard(from:THREE.Material,to:THREE.Material) {
  const eye=billboards.get(from);if(eye)patchDetailBillboard(to,eye);
}

/** Keep unusual or transformed detail objects on their original path. */
export function batchSourceDetails(root:THREE.Object3D,owner:Owner) {
  root.updateMatrixWorld(true);
  const identity=new THREE.Matrix4(),groups=new Map<string,THREE.Mesh[]>();
  root.traverse(object=>{
    if(!(object instanceof THREE.Mesh)||object instanceof THREE.InstancedMesh||!object.userData.sourceDetail
      ||Array.isArray(object.material)||!(object.material instanceof THREE.MeshStandardMaterial)
      ||object.material.transparent||!object.material.alphaTest||!object.parent?.matrixWorld.equals(identity)
      ||object.material.userData.sourceUnlit!==true
      ||!object.scale.equals(new THREE.Vector3(1,1,1)))return;
    const geometry=object.geometry,position=geometry.getAttribute('position'),normal=geometry.getAttribute('normal'),uv=geometry.getAttribute('uv');
    if(position?.count!==4||normal?.count!==4||uv?.count!==4||geometry.index?.count!==6
      ||Array.from({length:4},(_,i)=>position.getY(i)).some(y=>Math.abs(y)>1e-8))return;
    const m=object.material;
    const key=JSON.stringify([Array.from(position.array),Array.from(normal.array),Array.from(uv.array),Array.from(geometry.index.array),
      m.map?.uuid,m.alphaTest,m.opacity,m.side,m.depthTest,m.depthWrite,m.userData.sourceVertexLighting,m.userData.sourceUnlit]);
    const entries=groups.get(key)??[];entries.push(object);groups.set(key,entries);
  });
  const removedGeometry=new Set<THREE.BufferGeometry>(),removedMaterials=new Set<THREE.Material>();
  let instances=0,draws=0;
  const eye={value:new THREE.Vector3()},matrix=new THREE.Matrix4();
  for(const entries of groups.values()) {
    if(entries.length<2)continue;
    const geometry=owner.own(entries[0].geometry.clone());
    // Camera-facing rotation must stay inside the CPU's frustum bounds, including
    // sprites whose authored pivot is offset from the middle of the quad.
    geometry.computeBoundingBox();
    const box=geometry.boundingBox!,height=(box.min.z+box.max.z)/2;
    let radius=0;
    const position=geometry.getAttribute('position');
    for(let i=0;i<position.count;i++)radius=Math.max(radius,Math.hypot(position.getX(i),position.getY(i),position.getZ(i)-height));
    geometry.boundingSphere=new THREE.Sphere(new THREE.Vector3(0,0,height),radius);
    const material=owner.own((entries[0].material as THREE.MeshStandardMaterial).clone());material.color.setRGB(1,1,1);
    const mesh=owner.own(new THREE.InstancedMesh(geometry,material,entries.length));
    mesh.name='Source detail batch '+draws;mesh.userData={sourceDetail:true,sourceDetailBatch:true,sourceDetailCount:entries.length};
    mesh.instanceColor=new THREE.InstancedBufferAttribute(new Float32Array(entries.length*3),3);
    const data:BatchData={eye,positions:new Float64Array(entries.length*3),colors:new Float64Array(entries.length*3),names:[]};
    entries.forEach((object,i)=>{
      matrix.makeTranslation(object.position.x,object.position.y,object.position.z);mesh.setMatrixAt(i,matrix);
      const original=object.material as THREE.MeshStandardMaterial;
      mesh.setColorAt(i,original.color);original.color.toArray(data.colors,i*3);object.position.toArray(data.positions,i*3);data.names.push(object.name);
      removedGeometry.add(object.geometry);removedMaterials.add(original);object.removeFromParent();
    });
    mesh.instanceMatrix.needsUpdate=true;mesh.instanceColor.needsUpdate=true;mesh.computeBoundingSphere();
    const depth=owner.own(new THREE.MeshDepthMaterial({depthPacking:THREE.RGBADepthPacking,map:material.map,alphaTest:material.alphaTest,side:material.side}));
    patchDetailBillboard(depth,eye);mesh.customDepthMaterial=depth;
    batches.set(geometry,data);root.add(mesh);instances+=entries.length;draws++;
  }
  // Original geometry/materials may also be referenced by ordinary map objects.
  root.traverse(object=>{if(object instanceof THREE.Mesh){removedGeometry.delete(object.geometry);for(const material of [object.material].flat())removedMaterials.delete(material);}});
  for(const geometry of removedGeometry)owner.discard(geometry);
  for(const material of removedMaterials)owner.discard(material);
  return {instances,batches:draws};
}

export function prepareDetailBatch(mesh:THREE.Mesh,eye:THREE.Vector3) {
  const data=batches.get(mesh.geometry);
  if(!data)return false;
  data.eye.value.copy(eye);return true;
}

export function patchDetailBatchMaterial(mesh:THREE.Mesh,material:THREE.Material) {
  const data=batches.get(mesh.geometry);if(data)patchDetailBillboard(material,data.eye);
}

/** DCC exports keep ordinary meshes, native tints and the last preview's facing. */
export function expandDetailBatches(root:THREE.Object3D) {
  const meshes:THREE.InstancedMesh[]=[];
  root.traverse(object=>{if(object instanceof THREE.InstancedMesh&&object.userData.sourceDetailBatch)meshes.push(object);});
  const owned:THREE.Material[]=[];
  for(const batch of meshes) {
    const data=batches.get(batch.geometry);if(!data)continue;
    const source=batch.material as THREE.MeshBasicMaterial;
    for(let i=0;i<batch.count;i++) {
      const material=source.clone();material.color.fromArray(data.colors,i*3);
      material.onBeforeCompile=()=>{};material.customProgramCacheKey=THREE.Material.prototype.customProgramCacheKey;
      if(sourceDiffuseOnly(source)){sourceTextureControl(material);setSourceTexturesEnabled(material,false);}
      const mesh=new THREE.Mesh(batch.geometry,material);mesh.name=data.names[i];mesh.userData={sourceDetail:true};
      mesh.position.fromArray(data.positions,i*3);
      mesh.rotation.z=Math.atan2(data.eye.value.y-mesh.position.y,data.eye.value.x-mesh.position.x)-Math.PI/2;
      batch.parent!.add(mesh);owned.push(material);
    }
    batch.removeFromParent();
  }
  return ()=>{for(const material of owned)material.dispose();};
}
