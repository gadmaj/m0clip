import * as THREE from 'three';
import type { GLTFExporterPlugin } from 'three/examples/jsm/exporters/GLTFExporter.js';

// r185 GLTFLoader lowercases unmapped semantics, and normalizes WEIGHTS_0 alone.
// Keep these names: GLTFExporter uppercases them back to standard glTF semantics.
const recovered = 'm0clipExtraSkinWeightsRecovered';
const patched = new WeakSet<THREE.Material>();
const base = new THREE.Vector4(), weighted = new THREE.Vector4(), sum = new THREE.Vector4();
const boneMatrix = new THREE.Matrix4();
type SkinAttribute = THREE.BufferAttribute | THREE.InterleavedBufferAttribute;

function floatWeights(attribute: SkinAttribute): THREE.BufferAttribute {
  if (attribute instanceof THREE.BufferAttribute && attribute.array instanceof Float32Array && !attribute.normalized) return attribute;
  const result = new THREE.Float32BufferAttribute(new Float32Array(attribute.count * 4), 4);
  for (let i = 0; i < attribute.count; i++) {
    result.setXYZW(i, attribute.getX(i), attribute.getY(i), attribute.getZ(i), attribute.getW(i));
  }
  return result;
}

function weightSum(attribute: SkinAttribute, i: number): number {
  return attribute.getX(i) + attribute.getY(i) + attribute.getZ(i) + attribute.getW(i);
}

function recoverWeights(geometry: THREE.BufferGeometry): void {
  const indices = geometry.getAttribute('joints_1'), extra = geometry.getAttribute('weights_1');
  const first = geometry.getAttribute('skinWeight'), firstIndices = geometry.getAttribute('skinIndex');
  const positions = geometry.getAttribute('position');
  if (!indices || !extra || !first || !firstIndices || !positions) throw new Error('Eight-influence skin is missing joint, weight or position attributes.');
  for (const attribute of [indices, extra, first, firstIndices]) {
    if (attribute.itemSize !== 4 || attribute.count !== positions.count) throw new Error('Eight-influence skin attributes must be matching VEC4 accessors.');
  }
  if (geometry.userData[recovered]) return;
  const weights0 = floatWeights(first), weights1 = floatWeights(extra);
  for (let i = 0; i < positions.count; i++) {
    const mass1 = weightSum(weights1, i), mass0 = weightSum(weights0, i);
    for (let c = 0; c < 4; c++) {
      if (!Number.isFinite(weights0.getComponent(i, c)) || weights0.getComponent(i, c) < 0
          || !Number.isFinite(weights1.getComponent(i, c)) || weights1.getComponent(i, c) < 0) {
        throw new Error('Eight-influence skin contains invalid weights.');
      }
    }
    if (mass1 > 1 + 1e-5 || (mass0 === 0 && mass1 < 1 - 1e-5)) throw new Error('Eight-influence skin weights do not have recoverable unit mass.');
    // WEIGHTS_1 was untouched by GLTFLoader. Its mass determines the original
    // partial WEIGHTS_0 mass; dividing by mass0 also removes float rounding drift.
    const scale = mass0 > 0 ? Math.max(0, 1 - mass1) / mass0 : 0;
    weights0.setXYZW(i, weights0.getX(i) * scale, weights0.getY(i) * scale,
      weights0.getZ(i) * scale, weights0.getW(i) * scale);
  }
  geometry.setAttribute('skinWeight', weights0);
  geometry.setAttribute('weights_1', weights1);
  // Unlike JOINTS_0, the exporter doesn't coerce JOINTS_1 to unsigned short.
  if (!(indices.array instanceof Uint8Array || indices.array instanceof Uint16Array) || indices.normalized) {
    const joints = new THREE.Uint16BufferAttribute(new Uint16Array(indices.count * 4), 4);
    for (let i = 0; i < indices.count; i++) for (let c = 0; c < 4; c++) {
      const joint = indices.getComponent(i, c);
      if (!Number.isInteger(joint) || joint < 0 || joint > 65535) throw new Error('Eight-influence skin contains invalid joint indices.');
      joints.setComponent(i, c, joint);
    }
    geometry.setAttribute('joints_1', joints);
  }
  geometry.userData[recovered] = true;
  weights0.needsUpdate = true;
}

/** Compose after material cloning/paint; before or after other include-based hooks. */
export function patchExtraSkinMaterial(material: THREE.Material): void {
  if (patched.has(material)) return;
  patched.add(material);
  const previous = material.onBeforeCompile, previousKey = material.customProgramCacheKey();
  material.onBeforeCompile = function(shader, renderer) {
    previous.call(this, shader, renderer);
    shader.vertexShader = shader.vertexShader
      .replace('#include <skinning_pars_vertex>', `#include <skinning_pars_vertex>
#ifdef USE_SKINNING
attribute vec4 joints_1;
attribute vec4 weights_1;
#endif`)
      .replace('#include <skinbase_vertex>', `#include <skinbase_vertex>
#ifdef USE_SKINNING
mat4 extraBoneX = getBoneMatrix(joints_1.x);
mat4 extraBoneY = getBoneMatrix(joints_1.y);
mat4 extraBoneZ = getBoneMatrix(joints_1.z);
mat4 extraBoneW = getBoneMatrix(joints_1.w);
#endif`)
      .replace('#include <skinnormal_vertex>', `
#ifdef USE_SKINNING
mat4 skinMatrix = skinWeight.x * boneMatX + skinWeight.y * boneMatY
  + skinWeight.z * boneMatZ + skinWeight.w * boneMatW
  + weights_1.x * extraBoneX + weights_1.y * extraBoneY
  + weights_1.z * extraBoneZ + weights_1.w * extraBoneW;
skinMatrix = bindMatrixInverse * skinMatrix * bindMatrix;
objectNormal = (skinMatrix * vec4(objectNormal, 0.0)).xyz;
#ifdef USE_TANGENT
objectTangent = (skinMatrix * vec4(objectTangent, 0.0)).xyz;
#endif
#endif`)
      .replace('#include <skinning_vertex>', `
#ifdef USE_SKINNING
vec4 skinVertex = bindMatrix * vec4(transformed, 1.0);
vec4 skinned = (boneMatX * skinVertex) * skinWeight.x
  + (boneMatY * skinVertex) * skinWeight.y
  + (boneMatZ * skinVertex) * skinWeight.z
  + (boneMatW * skinVertex) * skinWeight.w
  + (extraBoneX * skinVertex) * weights_1.x
  + (extraBoneY * skinVertex) * weights_1.y
  + (extraBoneZ * skinVertex) * weights_1.z
  + (extraBoneW * skinVertex) * weights_1.w;
transformed = (bindMatrixInverse * skinned).xyz;
#endif`);
  };
  material.customProgramCacheKey = () => previousKey + '|m0clip-eight-influences-v1';
  material.needsUpdate = true;
}

function prepareShadows(mesh: THREE.SkinnedMesh): void {
  if (!mesh.customDepthMaterial) mesh.customDepthMaterial = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking });
  if (!mesh.customDistanceMaterial) mesh.customDistanceMaterial = new THREE.MeshDistanceMaterial();
  patchExtraSkinMaterial(mesh.customDepthMaterial);
  patchExtraSkinMaterial(mesh.customDistanceMaterial);
}

// Promotion rather than per-instance closures: Object3D.clone constructs this
// class, so SkeletonUtils.clone retains CPU transforms and custom shadow hooks.
class ExtraSkinnedMesh extends THREE.SkinnedMesh {
  override copy(source: THREE.SkinnedMesh, recursive = true): this {
    super.copy(source, recursive);
    if (source.customDepthMaterial) this.customDepthMaterial = source.customDepthMaterial.clone();
    if (source.customDistanceMaterial) this.customDistanceMaterial = source.customDistanceMaterial.clone();
    prepareShadows(this);
    return this;
  }

  override normalizeSkinWeights(): void {
    const first = this.geometry.getAttribute('skinWeight'), extra = this.geometry.getAttribute('weights_1');
    if (!extra) { super.normalizeSkinWeights(); return; }
    // Recovery is one-time. Never let a later normalization discard extra mass.
    if (!this.geometry.userData[recovered]) { recoverWeights(this.geometry); return; }
    for (let i = 0; i < first.count; i++) {
      const total = weightSum(first, i) + weightSum(extra, i);
      if (!Number.isFinite(total) || total <= 0) throw new Error('Eight-influence skin has no finite weight mass.');
      for (let c = 0; c < 4; c++) {
        first.setComponent(i, c, first.getComponent(i, c) / total);
        extra.setComponent(i, c, extra.getComponent(i, c) / total);
      }
    }
    first.needsUpdate = true; extra.needsUpdate = true;
  }

  override applyBoneTransform(index: number, target: THREE.Vector3): THREE.Vector3;
  applyBoneTransform(index: number, target: THREE.Vector4): THREE.Vector4;
  applyBoneTransform(index: number, target: THREE.Vector3 | THREE.Vector4): THREE.Vector3 | THREE.Vector4 {
    const geometry = this.geometry, skeleton = this.skeleton;
    const isDirection = target instanceof THREE.Vector4;
    base.set(target.x, target.y, target.z, isDirection ? target.w : 1).applyMatrix4(this.bindMatrix);
    sum.set(0, 0, 0, 0);
    for (let set = 0; set < 2; set++) {
      const indices = geometry.getAttribute(set === 0 ? 'skinIndex' : 'joints_1');
      const weights = geometry.getAttribute(set === 0 ? 'skinWeight' : 'weights_1');
      for (let c = 0; c < 4; c++) {
        const weight = weights.getComponent(index, c);
        if (weight === 0) continue;
        const joint = indices.getComponent(index, c);
        boneMatrix.multiplyMatrices(skeleton.bones[joint].matrixWorld, skeleton.boneInverses[joint]);
        sum.addScaledVector(weighted.copy(base).applyMatrix4(boneMatrix), weight);
      }
    }
    sum.w = base.w;
    sum.applyMatrix4(this.bindMatrixInverse);
    if (isDirection) target.copy(sum);
    else target.set(sum.x, sum.y, sum.z);
    return target;
  }
}

/** Call on a freshly loaded glTF scene, and after cloning/replacing materials. */
export function prepareExtraSkinning(root: THREE.Object3D): void {
  root.traverse(object => {
    if (!(object instanceof THREE.SkinnedMesh)) return;
    const geometry = object.geometry;
    if (!geometry.hasAttribute('joints_1') && !geometry.hasAttribute('weights_1')) return;
    recoverWeights(geometry);
    if (!(object instanceof ExtraSkinnedMesh)) Object.setPrototypeOf(object, ExtraSkinnedMesh.prototype);
    const materials = Array.isArray(object.material) ? object.material : [object.material];
    for (const material of materials) patchExtraSkinMaterial(material);
    prepareShadows(object);
    object.boundingBox = null!;
    object.boundingSphere = null!;
  });
}

/** Register with exporter.register(extraSkinningWriter), not the returned plugin. */
export function extraSkinningWriter(): GLTFExporterPlugin {
  return {
    writeMesh(mesh, definition) {
      if (!mesh.geometry.hasAttribute('weights_1')) return;
      if (!mesh.geometry.userData[recovered]) throw new Error('Prepare eight-influence skinning before GLB export.');
      const primitives = definition.primitives as { attributes: Record<string, number>; extras?: Record<string, unknown> }[];
      // r185's actual writer already maps loader-native lowercase semantics.
      // Assert the final primitive, not source geometry or custom underscore data.
      for (const primitive of primitives) {
        const { attributes } = primitive;
        if (attributes.JOINTS_1 === undefined || attributes.WEIGHTS_1 === undefined
            || attributes.JOINTS_0 === undefined || attributes.WEIGHTS_0 === undefined) {
          throw new Error('GLB export omitted standard eight-influence skin accessors.');
        }
        // This marker survives local geometry.clone(), but MUST NOT survive
        // export: a new GLTFLoader normalizes WEIGHTS_0 again on every parse.
        if (primitive.extras) {
          delete primitive.extras[recovered];
          if (Object.keys(primitive.extras).length === 0) delete primitive.extras;
        }
      }
    },
  };
}
