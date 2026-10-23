/** Small code-built character shells. Each module follows its existing robot joint. */
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { KIT_STYLES, type KitStyle, type KitRegion } from './robot-kit-data';


function colored(geometry: THREE.BufferGeometry, color: number) {
  if(geometry.index){const expanded=geometry.toNonIndexed();geometry.dispose();geometry=expanded;}
  const c=new THREE.Color(color),colors=new Float32Array(geometry.getAttribute('position').count*3);
  for(let i=0;i<colors.length;i+=3){colors[i]=c.r;colors[i+1]=c.g;colors[i+2]=c.b;}
  geometry.setAttribute('color',new THREE.BufferAttribute(colors,3));return geometry;
}

function moduleGeometry(style: KitStyle, region: KitRegion, target: THREE.BufferGeometry, toFile: THREE.Matrix4) {
  const file=target.clone().applyMatrix4(toFile);file.computeBoundingBox();
  const box=file.boundingBox!,size=box.getSize(new THREE.Vector3()),center=box.getCenter(new THREE.Vector3());file.dispose();
  if(![...size.toArray(),...center.toArray()].every(Number.isFinite)||Math.min(size.x,size.y,size.z)<=0)return null;
  const shape=style==='boxy'?new THREE.BoxGeometry(1,1,1):style==='round'?new THREE.SphereGeometry(.5,12,8):new THREE.OctahedronGeometry(.5,0);
  shape.scale(size.x,size.y,size.z).translate(center.x,center.y,center.z);
  const pieces=[colored(shape,0xffffff)];
  // Faces point along the robot's file-space +X. Vertex color keeps the visor
  // with the same draw and exported mesh, without textures or extra objects.
  if(region==='head'&&size.z>.04) {
    const visor=new THREE.BoxGeometry(size.x*.12,size.y*.72,size.z*.20)
      .translate(center.x+size.x*.48,center.y,center.z+size.z*.10);
    pieces.push(colored(visor,0x10202a));
  }
  const geometry=mergeGeometries(pieces,false)!;for(const piece of pieces)piece.dispose();
  geometry.applyMatrix4(toFile.clone().invert());geometry.computeBoundingBox();geometry.computeBoundingSphere();
  return geometry;
}

export class RobotKit {
  private active=new Map<THREE.Mesh,{geometry:THREE.BufferGeometry;material:THREE.Material|THREE.Material[];owned:THREE.Material}>();

  /** Original geometry, even when a procedural shell is currently installed. */
  originalGeometry(mesh: THREE.Mesh, fallback = mesh.geometry) { return this.active.get(mesh)?.geometry ?? fallback; }

  preview(mesh: THREE.Mesh, style: KitStyle, region: KitRegion, frame: THREE.Matrix4,
    original = this.originalGeometry(mesh)) {
    return style==='stock'?original.clone():moduleGeometry(style,region,original,frame);
  }
  apply(mesh: THREE.Mesh, style: KitStyle, region: KitRegion, toFile: THREE.Matrix4) {
    this.restore(mesh);
    if(style==='stock'||!(KIT_STYLES as readonly string[]).includes(style))return;
    const geometry=moduleGeometry(style,region,mesh.geometry,toFile);if(!geometry)return;
    const original=[mesh.material].flat()[0] as THREE.MeshPhysicalMaterial;
    const material=original.clone();
    material.vertexColors=true;material.map=null;material.normalMap=null;
    this.active.set(mesh,{geometry:mesh.geometry,material:mesh.material,owned:material});
    mesh.geometry=geometry;mesh.material=material;
    mesh.userData.robotModule={region,style};
  }

  restore(mesh: THREE.Mesh) {
    const saved=this.active.get(mesh);if(!saved)return;
    mesh.geometry.dispose();saved.owned.dispose();mesh.geometry=saved.geometry;mesh.material=saved.material;
    delete mesh.userData.robotModule;this.active.delete(mesh);
  }
  reset(){for(const mesh of this.active.keys())this.restore(mesh);}
}
