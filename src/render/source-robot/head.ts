/** Optional original Ghost head cosmetic. Physics and geom indices stay untouched.
 * Source's head is a rigid prop, so this intentionally does not pretend to retarget
 * the connected torso/legs or arms into an articulated R1 skin. */
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { readPartPaint } from '../paint-material';
import type { PartPaint } from '../scene';

export const GHOST_HEAD_URL = '/assets/source-robots/neotokyo-girlbot/girlbot_head.glb';
export const R1_HEAD_PART = 'head_yaw_link';

/** Native Source is lying on its back: head points toward -X, face toward +Z.
 * A +90 degree rotation around Y makes its crown +Z and face +X (R1 forward). */
export function fitGhostHead(
  source: THREE.BufferGeometry,
  target: THREE.BufferGeometry,
  compiledToFile: THREE.Matrix4,
): THREE.BufferGeometry {
  const native = source.clone().rotateY(Math.PI / 2);
  native.computeBoundingBox();
  const targetInFile = target.clone().applyMatrix4(compiledToFile);
  targetInFile.computeBoundingBox();
  const nativeBox = native.boundingBox!, targetBox = targetInFile.boundingBox!;
  const nativeSize = nativeBox.getSize(new THREE.Vector3());
  const targetSize = targetBox.getSize(new THREE.Vector3());
  const scale = targetSize.z / nativeSize.z;
  if (!Number.isFinite(scale) || scale <= 0) {
    native.dispose(); targetInFile.dispose();
    throw new Error('Cannot fit the Ghost head to an empty robot head.');
  }
  const from = nativeBox.getCenter(new THREE.Vector3());
  const to = targetBox.getCenter(new THREE.Vector3());
  // Uniform scale preserves the original shape, normals, UVs and triangles.
  native.translate(-from.x, -from.y, -from.z).scale(scale, scale, scale)
    .translate(to.x, to.y, to.z).applyMatrix4(compiledToFile.clone().invert());
  native.computeBoundingBox(); native.computeBoundingSphere();
  targetInFile.dispose();
  return native;
}

export interface SourceHeadOverride {
  /** Representative authored defaults, independent of live paint and highlights. */
  nativePaintFor(): PartPaint | undefined;
  /** Restores the exact original geometry/material; call before rebuilding a robot. */
  restore(): void;
  /** Caller owns the cloned geometry/material; native maps remain asset-owned. */
  preview(patchMaterial?: (material: THREE.MeshPhysicalMaterial) => void): THREE.Mesh;
  /** Stock geometry saved before the native replacement; borrowed, not owned. */
  readonly originalGeometry: THREE.BufferGeometry;
}

export interface SourceHeadAsset {
  /** toFile is the compiled MuJoCo mesh's position/quaternion transform. */
  apply(target: THREE.Mesh, compiledToFile: THREE.Matrix4,
    patchMaterial?: (material: THREE.Material) => void): SourceHeadOverride;
  /** Release only after all applied overrides have been restored. */
  dispose(): void;
}

export async function loadGhostHead(url = GHOST_HEAD_URL): Promise<SourceHeadAsset> {
  const gltf = await new GLTFLoader().loadAsync(url);
  const meshes: THREE.Mesh[] = [];
  gltf.scene.traverse((object) => { if (object instanceof THREE.Mesh) meshes.push(object); });
  if (meshes.length !== 1 || Array.isArray(meshes[0].material)) {
    throw new Error('Expected the original Ghost head to have one mesh and one material.');
  }
  const source = meshes[0];
  const active = new Set<SourceHeadOverride>();
  let disposed = false;
  return {
    apply(target, compiledToFile, patchMaterial) {
      if (disposed) throw new Error('The Ghost head asset was already disposed.');
      if (target.userData.meshName !== R1_HEAD_PART) {
        throw new Error('The Ghost head proof only replaces the R1 head_yaw_link visual.');
      }
      const originalGeometry = target.geometry, originalMaterial = target.material;
      const geometry = fitGhostHead(source.geometry, originalGeometry, compiledToFile);
      const material = new THREE.MeshPhysicalMaterial();
      // Keep the native maps while supporting the existing robot paint/clearcoat controls.
      THREE.MeshStandardMaterial.prototype.copy.call(material, source.material as THREE.MeshStandardMaterial);
      Object.assign(material,{defines:{STANDARD:'',PHYSICAL:''}});
      const previewMaterial = material.clone();
      patchMaterial?.(material);
      target.geometry = geometry; target.material = material;
      const previous = target.userData.sourceRobotPart;
      target.userData.sourceRobotPart = 'models/nt/props_tech/girlbot_head.mdl';
      let restored = false;
      const override: SourceHeadOverride = { originalGeometry,
        nativePaintFor() {
          const material = source.material;
          return material instanceof THREE.MeshStandardMaterial || material instanceof THREE.MeshBasicMaterial
            ? readPartPaint(material) : undefined;
        },
        preview(patch) {
          const copy = previewMaterial.clone();
          patch?.(copy);
          return new THREE.Mesh(geometry.clone(), copy);
        },
        restore() {
        if (restored) return;
        restored = true;
        target.geometry = originalGeometry; target.material = originalMaterial;
        if (previous === undefined) delete target.userData.sourceRobotPart;
        else target.userData.sourceRobotPart = previous;
        geometry.dispose(); material.dispose(); previewMaterial.dispose(); active.delete(override);
      } };
      active.add(override);
      return override;
    },
    dispose() {
      if (disposed) return;
      for (const override of [...active]) override.restore();
      disposed = true;
      const textures = new Set<THREE.Texture>();
      for (const mesh of meshes) {
        mesh.geometry.dispose();
        for (const material of [mesh.material].flat()) {
          for (const value of Object.values(material)) if (value instanceof THREE.Texture) textures.add(value);
          material.dispose();
        }
      }
      for (const texture of textures) texture.dispose();
    },
  };
}
