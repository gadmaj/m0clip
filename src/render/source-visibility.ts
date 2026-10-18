/** Source BSP visibility, following noclip.website Main.ts / StaticDetailObject.ts.
 * Copyright (c) 2018 Jasper St. Pierre, MIT; see LICENSE.noclip. */
import * as THREE from 'three';
import { SourcePVS, type SourceVisibilityData } from './source-sky3d';

interface Surface {
  mesh: THREE.Mesh; original: THREE.BufferGeometry; filtered: THREE.BufferGeometry;
  source: THREE.BufferAttribute; index: THREE.BufferAttribute; ranges: number[][];
}
interface ObjectEntry { object: THREE.Object3D; clusters: number[]; overlay: boolean; visible: boolean; selected: boolean }

/** Restrict rendering to the camera's PVS without changing the exported map or raycasts. */
export class SourceVisibility {
  readonly pvs: SourcePVS;
  private surfaces: Surface[] = [];
  private objects: ObjectEntry[] = [];
  private point = new THREE.Vector3();
  private lastCluster = -2;
  stats = { cluster: -1, fallback: false, faces: 0, staticProps: 0, overlays: 0 };

  constructor(data: SourceVisibilityData, root: THREE.Object3D) {
    this.pvs = new SourcePVS(data);
    root.traverse(object => {
      if (object instanceof THREE.Mesh && object.geometry.userData.sourceFaceRanges) {
        const original = object.geometry, source = original.index;
        if (!source) throw new Error('Source world surface has no index buffer');
        const filtered = new THREE.BufferGeometry();
        for (const name of Object.keys(original.attributes)) filtered.setAttribute(name,original.getAttribute(name));
        filtered.boundingBox = original.boundingBox?.clone() ?? null;
        filtered.boundingSphere = original.boundingSphere?.clone() ?? null;
        filtered.userData = original.userData;
        const index = new THREE.BufferAttribute(new Uint32Array(source.count),1).setUsage(THREE.DynamicDrawUsage);
        filtered.setIndex(index);
        this.surfaces.push({mesh:object,original,filtered,source,index,ranges:original.userData.sourceFaceRanges});
      } else if (typeof object.userData.sourceStaticIndex === 'number' || object.userData.sourceOverlay) {
        const clusters = object.userData.sourceVisibilityClusters as number[] | undefined
          ?? [...new Set((object.userData.sourceVisibilityFaces as number[] ?? []).flatMap(f => data.faceClusters[f]))];
        this.objects.push({object,clusters,overlay:!!object.userData.sourceOverlay,visible:true,selected:false});
      }
    });
  }

  draw(camera: THREE.Camera, draw: () => void) {
    camera.getWorldPosition(this.point);
    const cluster = this.pvs.cluster(this.point), row = this.pvs.row(cluster);
    // noclip's main view enables the all-clusters fallback outside a valid BSP leaf.
    // The separate 3D sky view deliberately does not use this fallback.
    if (cluster !== this.lastCluster) {
      this.lastCluster = cluster; let faces = 0, staticProps = 0, overlays = 0;
      const visible = (clusters: number[]) => row ? this.pvs.visible(row,clusters) : clusters.some(c => c !== 65535);
      for (const surface of this.surfaces) {
        let count = 0;
        for (const [face,start,length] of surface.ranges) {
          if (!visible(this.pvs.data.faceClusters[face])) continue;
          (surface.index.array as Uint32Array).set(surface.source.array.subarray(start,start+length),count);
          count += length; faces++;
        }
        surface.index.needsUpdate = true; surface.filtered.setDrawRange(0,count);
      }
      for (const entry of this.objects) {
        entry.selected = visible(entry.clusters);
        if (entry.selected) { if (entry.overlay) overlays++; else staticProps++; }
      }
      this.stats = {cluster,fallback:row === null,faces,staticProps,overlays};
    }
    try {
      for (const surface of this.surfaces) surface.mesh.geometry = surface.filtered;
      for (const entry of this.objects) {
        entry.visible = entry.object.visible;
        entry.object.visible = entry.visible && entry.selected;
      }
      draw();
    } finally {
      for (const surface of this.surfaces) surface.mesh.geometry = surface.original;
      for (const entry of this.objects) entry.object.visible = entry.visible;
    }
  }

  dispose() { for (const surface of this.surfaces) surface.filtered.dispose(); this.surfaces = []; this.objects = []; }
}
