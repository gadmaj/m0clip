/** Source's separate 3D sky view and BSP PVS, adapted from noclip.website
 * Main.ts, EntitySystem.ts and BSPFile.ts. Copyright (c) 2018 Jasper St. Pierre,
 * MIT; see LICENSE.noclip. Geometry/materials remain in authored coordinates. */
import * as THREE from 'three';

export interface SourceVisibilityData {
  version: 1; spawn: number[]; yaw: number; head: number; nodes: number[][];
  leafClusters: number[]; faceClusters: number[][]; visibility: string;
  sky: { origin: number[]; scale: number } | null;
}
interface Surface { mesh: THREE.Mesh; source: THREE.BufferAttribute; index: THREE.BufferAttribute; ranges: number[][] }
interface ObjectEntry { root: THREE.Object3D; clusters: number[]; overlay: boolean }

export class SourcePVS {
  private bytes: Uint8Array;
  private view: DataView;
  private rows = new Map<number, Uint8Array>();
  readonly rotation: THREE.Matrix3;
  private inverse: THREE.Matrix3;
  private point = new THREE.Vector3();
  constructor(readonly data: SourceVisibilityData) {
    this.bytes = Uint8Array.from(atob(data.visibility), c => c.charCodeAt(0));
    this.view = new DataView(this.bytes.buffer);
    const angle = -data.yaw * Math.PI / 180, c = Math.cos(angle), s = Math.sin(angle);
    this.rotation = new THREE.Matrix3().set(c,-s,0,s,c,0,0,0,1);
    this.inverse = this.rotation.clone().transpose();
  }
  cluster(world: THREE.Vector3): number {
    this.point.copy(world).applyMatrix3(this.inverse).multiplyScalar(1/.0254);
    this.point.add(new THREE.Vector3(...this.data.spawn as [number,number,number]));
    let index = this.data.head;
    while (index >= 0) {
      const n = this.data.nodes[index];
      index = n[this.point.x*n[0]+this.point.y*n[1]+this.point.z*n[2] >= n[3] ? 4 : 5];
    }
    return this.data.leafClusters[-index-1];
  }
  row(cluster: number): Uint8Array | null {
    const count = this.view.getUint32(0,true);
    if (cluster === 65535 || cluster < 0 || cluster >= count) return null;
    let row = this.rows.get(cluster); if (row) return row;
    row = new Uint8Array(Math.ceil(count/8));
    let at = this.view.getUint32(4+cluster*8,true), out = 0;
    if (!at) row.fill(255);
    else while (out < row.length) {
      if (at >= this.bytes.length) throw new Error('Truncated Source PVS row');
      const byte = this.bytes[at++];
      if (byte) row[out++] = byte;
      else {
        const run = this.bytes[at++];
        if (!run || out+run > row.length) throw new Error('Invalid Source PVS zero run');
        out += run;
      }
    }
    this.rows.set(cluster,row); return row;
  }
  visible(row: Uint8Array | null, clusters: number[]): boolean {
    return !!row && clusters.some(c => c !== 65535 && !!(row[c>>>3] & (1<<(c&7))));
  }
}

export class SourceSky3D {
  readonly scene = new THREE.Scene();
  camera: THREE.Camera = new THREE.PerspectiveCamera();
  readonly pvs: SourcePVS;
  readonly sky2D: THREE.Mesh[] = [];
  private surfaces: Surface[] = [];
  private objects: ObjectEntry[] = [];
  private ownedGeometry: THREE.BufferGeometry[] = [];
  private lastCluster = -2;
  private offset: THREE.Vector3;
  private scale: number;
  private projectionScale = new THREE.Matrix4();
  stats = { cluster: -1, faces: 0, staticProps: 0 };

  constructor(readonly data: SourceVisibilityData, root: THREE.Object3D,
      linkedMaterial: (original: THREE.Mesh, clone: THREE.Mesh) => void) {
    if (!data.sky || !Number.isFinite(data.sky.scale) || data.sky.scale <= 0) throw new Error('Invalid Source sky camera');
    this.pvs = new SourcePVS(data); this.scale = data.sky.scale;
    this.offset = new THREE.Vector3(...data.sky.origin as [number,number,number]);
    this.offset.addScaledVector(new THREE.Vector3(...data.spawn as [number,number,number]), 1/this.scale-1)
      .applyMatrix3(this.pvs.rotation).multiplyScalar(.0254);
    this.projectionScale.makeScale(this.scale,this.scale,this.scale);
    root.updateMatrixWorld(true);
    const cloneTree = (original: THREE.Object3D): THREE.Object3D => {
      const clone = original.clone(false);
      if (original instanceof THREE.Mesh && clone instanceof THREE.Mesh) linkedMaterial(original,clone);
      for (const child of original.children) clone.add(cloneTree(child));
      return clone;
    };
    root.traverse(object => {
      if (object instanceof THREE.Mesh && object.userData.sourceSky) {
        const clone = object.clone(false); clone.matrixAutoUpdate = true;
        this.sky2D.push(clone); this.scene.add(clone); linkedMaterial(object,clone);
      } else if (object instanceof THREE.Mesh && object.geometry.userData.sourceFaceRanges) {
        const source = object.geometry.index;
        if (!source) throw new Error('Source sky surface has no index buffer');
        const geometry = new THREE.BufferGeometry();
        for (const name of Object.keys(object.geometry.attributes)) geometry.setAttribute(name,object.geometry.getAttribute(name));
        geometry.boundingBox = object.geometry.boundingBox?.clone() ?? null;
        geometry.boundingSphere = object.geometry.boundingSphere?.clone() ?? null;
        const index = new THREE.BufferAttribute(new Uint32Array(source.count),1).setUsage(THREE.DynamicDrawUsage);
        geometry.setIndex(index); this.ownedGeometry.push(geometry);
        const clone = object.clone(false); clone.geometry = geometry; clone.matrixAutoUpdate = false;
        clone.matrix.copy(object.matrixWorld); this.scene.add(clone); linkedMaterial(object,clone);
        this.surfaces.push({mesh:clone,source,index,ranges:object.geometry.userData.sourceFaceRanges});
      } else if (typeof object.userData.sourceStaticIndex === 'number' || object.userData.sourceOverlay) {
        const clusters = object.userData.sourceVisibilityClusters as number[] | undefined
          ?? [...new Set((object.userData.sourceVisibilityFaces as number[] ?? []).flatMap(f => data.faceClusters[f]))];
        const clone = cloneTree(object); clone.matrixAutoUpdate = false; clone.matrix.copy(object.matrixWorld);
        this.scene.add(clone); this.objects.push({root:clone,clusters,overlay:!!object.userData.sourceOverlay});
      }
    });
  }

  prepare(main: THREE.Camera, decals: boolean) {
    main.updateWorldMatrix(true,false);
    // Keep perspective/orthographic metadata as well as any custom lens/view-offset matrix.
    if (this.camera.type !== main.type) this.camera = main.clone();
    else this.camera.copy(main,false);
    this.camera.position.setFromMatrixPosition(main.matrixWorld).multiplyScalar(1/this.scale).add(this.offset);
    main.getWorldQuaternion(this.camera.quaternion); this.camera.scale.set(1,1,1); this.camera.updateMatrixWorld(true);
    this.camera.projectionMatrix.copy(main.projectionMatrix).multiply(this.projectionScale);
    for (let i=0;i<16;i++) this.camera.projectionMatrix.elements[i] /= this.scale;
    this.camera.projectionMatrixInverse.copy(this.camera.projectionMatrix).invert();
    const cluster = this.pvs.cluster(this.camera.position), row = this.pvs.row(cluster);
    // A sky camera outside a valid PVS draws only the 2D sky, matching Source's no-fallback view.
    if (cluster !== this.lastCluster) {
      this.lastCluster = cluster; let faces = 0, staticProps = 0;
      for (const surface of this.surfaces) {
        let count = 0;
        for (const [face,start,length] of surface.ranges) {
          if (!this.pvs.visible(row,this.data.faceClusters[face])) continue;
          (surface.index.array as Uint32Array).set(surface.source.array.subarray(start,start+length),count);
          count += length; faces++;
        }
        surface.index.needsUpdate = true; surface.mesh.geometry.setDrawRange(0,count);
      }
      for (const entry of this.objects) {
        entry.root.visible = this.pvs.visible(row,entry.clusters);
        if (entry.root.visible && !entry.overlay) staticProps++;
      }
      this.stats = {cluster,faces,staticProps};
    }
    for (const entry of this.objects) if (entry.overlay) entry.root.visible = decals && this.pvs.visible(row,entry.clusters);
    for (const sky of this.sky2D) { sky.position.copy(this.camera.position); sky.visible = true; }
  }

  dispose() { for (const geometry of this.ownedGeometry) geometry.dispose(); this.scene.clear(); }
}
