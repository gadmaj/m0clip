/** Authored glTF skins on compatible recorded physics; separate from the specialized Source Dog pipeline. */
import * as THREE from 'three';
import type { GeometryTrack } from '../../core/geometry';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { clone as cloneSkeleton } from 'three/addons/utils/SkeletonUtils.js';
import type { RenderModel } from '../../sim/protocol';
import { prepareExtraSkinning } from '../extra-skin';
import { readPartPaint } from '../paint-material';
import type { PartPaint } from '../scene';
import { CharacterRetarget, characterCompatible, type CharacterPose } from './retarget';
import type { CharacterAsset, CharacterBody, CharacterBodyExport, CharacterDefinition, CharacterPaint } from './types';
export { characterCompatible } from './retarget';

interface MaterialEntry {
  part: string;
  source: THREE.MeshStandardMaterial | THREE.MeshBasicMaterial;
  material: THREE.MeshPhysicalMaterial;
  opacity: number;
  transparent: boolean;
  depthWrite: boolean;
}
// Extra-skinning composes shader hooks once per material. Keep only the native
// hook here so new materials never wrap an already-patched eight-weight shader.
const nativeShaders = new WeakMap<THREE.Material, {
  compile: THREE.Material['onBeforeCompile']; key: THREE.Material['customProgramCacheKey'];
}>();
function rememberShader(material: THREE.Material) {
  if (!nativeShaders.has(material)) nativeShaders.set(material, {
    compile: material.onBeforeCompile, key: material.customProgramCacheKey,
  });
}
function copyNativeShader(material: THREE.Material, source: THREE.Material) {
  rememberShader(source);
  const shader = nativeShaders.get(source)!;
  material.onBeforeCompile = shader.compile; material.customProgramCacheKey = shader.key;
  nativeShaders.set(material, shader);
}
function authoredMaterial(source: MaterialEntry['source']): THREE.MeshPhysicalMaterial {
  const material = new THREE.MeshPhysicalMaterial();
  resetMaterial(material, source);
  copyNativeShader(material, source);
  return material;
}
const physicalDefaults = new THREE.MeshPhysicalMaterial();
function resetMaterial(material: THREE.MeshPhysicalMaterial, source: MaterialEntry['source']) {
  if (!(source instanceof THREE.MeshPhysicalMaterial)) material.copy(physicalDefaults);
  if (source instanceof THREE.MeshPhysicalMaterial) material.copy(source);
  else if (source instanceof THREE.MeshStandardMaterial) THREE.MeshStandardMaterial.prototype.copy.call(material, source);
  else {
    THREE.Material.prototype.copy.call(material, source);
    material.color.setHex(0); material.map = null;
    material.emissive.copy(source.color); material.emissiveMap = source.map;
    material.emissiveIntensity = 1; material.alphaMap = source.alphaMap;
    material.vertexColors = source.vertexColors; material.fog = source.fog;
    material.lightMap = source.lightMap; material.lightMapIntensity = source.lightMapIntensity;
    material.aoMap = source.aoMap; material.aoMapIntensity = source.aoMapIntensity;
    material.wireframe = source.wireframe; material.wireframeLinewidth = source.wireframeLinewidth;
  }
  const custom = material as THREE.MeshPhysicalMaterial & { defines: Record<string, string> };
  const native = source as MaterialEntry['source'] & { defines?: Record<string, string> };
  custom.defines = { ...native.defines, STANDARD: '', PHYSICAL: '' };
}
function materials(mesh: THREE.Mesh) { return Array.isArray(mesh.material) ? mesh.material : [mesh.material]; }
function applyPaint(part: string, material: THREE.MeshPhysicalMaterial, source: MaterialEntry['source'], paint: CharacterPaint) {
  const unlit = source instanceof THREE.MeshBasicMaterial || !!source.userData.goldsrcFullbright;
  if (unlit) {
    material.color.copy(source instanceof THREE.MeshBasicMaterial ? source.color : source.emissive);
    material.metalness = 0; material.roughness = 1;
    material.clearcoat = 0; material.specularIntensity = 0; material.sheen = 0;
  }
  const ownsLighting = paint(part, material) === true;
  // Keep authored fullbright unless the callback deliberately owns lighting
  // (for example selection glow, robot illumination or Dull).
  if (unlit && !ownsLighting) {
    material.emissive.copy(material.color);
    material.color.setHex(0);
  }
}
function visibleInAsset(object: THREE.Object3D, root: THREE.Object3D) {
  for (let node: THREE.Object3D | null = object; node; node = node.parent) {
    if (!node.visible) return false;
    if (node === root) return true;
  }
  return false;
}
function attachmentBone(mesh: THREE.Mesh): THREE.Bone | null {
  for (let node = mesh.parent; node; node = node.parent) if (node instanceof THREE.Bone) return node;
  return null;
}
function poseOn(root: THREE.Object3D, bones: THREE.Bone[], pose: CharacterPose, meshes: THREE.SkinnedMesh[]) {
  root.position.copy(pose.position); root.quaternion.copy(pose.quaternion);
  for (let i = 0; i < bones.length; i++) {
    bones[i].quaternion.copy(pose.bones[i]);
    const position = pose.bonePositions?.[i];
    if (position) bones[i].position.copy(position);
  }
  root.updateMatrixWorld(true);
  for (const mesh of meshes) mesh.skeleton.update();
}

export class BaseCharacterBody implements CharacterBody {
  readonly root: THREE.Object3D;
  readonly meshes: THREE.Mesh[] = [];
  private skins: THREE.SkinnedMesh[] = [];
  readonly retarget: CharacterRetarget;
  private entries: MaterialEntry[] = [];
  private pose: CharacterPose;
  private fade = 1;
  private shown = true;
  private disposed = false;

  constructor(source: THREE.Object3D, readonly definition: CharacterDefinition, model: RenderModel,
      private paint: CharacterPaint) {
    const physics = definition.physics ?? 'r1';
    if (!characterCompatible(model, physics)) throw new Error(`${definition.label} requires compatible recorded body frames.`);
    const authored = cloneSkeleton(source);
    // Wrapper alone performs normalization. Authored scene/node transforms and inverse binds remain intact.
    const root = new THREE.Group(); root.name = `Character_${definition.id}`; root.add(authored);
    root.userData = structuredClone(source.userData);
    root.userData.characterDefinition = structuredClone(definition);
    root.userData.characterAttribution = structuredClone(definition.attribution);
    root.userData.characterMotion = `Compatible ${physics === 'go2' ? 'Go2' : 'R1'} physics and recorded geom tracks; not an independent controller.`;
    if (source.animations.length) root.animations = source.animations.map(clip => clip.clone());
    // Object3D.copy gives the authored clone its own shallow clip array.
    // Keep the independently-owned native tracks only on the public wrapper.
    authored.animations.length = 0;
    this.root = root;
    authored.traverse(object => {
      if (object.animations.length) object.animations = object.animations.map(clip => clip.clone());
      if (!(object instanceof THREE.Mesh) || !visibleInAsset(object, authored)) return;
      this.meshes.push(object);
      if (object instanceof THREE.SkinnedMesh) this.skins.push(object);
    });
    if (!this.meshes.length) throw new Error(`${definition.label}: asset has no visible rigged meshes.`);
    this.retarget = new CharacterRetarget(authored, this.meshes, definition, model);
    this.pose = this.retarget.createPose(); root.scale.setScalar(this.retarget.scale);
    for (const mesh of this.meshes) this.partition(mesh);
    prepareExtraSkinning(root);
    this.updateMaterials();
    this.retarget.referencePose(this.pose);
    poseOn(root, this.retarget.bones, this.pose, this.skins);
  }

  /** Split only triangle/material groups, never positions, UVs, joint indices, weights or inverse binds. */
  private partition(mesh: THREE.Mesh) {
    const source = mesh.geometry, geometry = source.clone(), sources = materials(mesh);
    const index = source.index, count = index?.count ?? source.getAttribute('position').count;
    const sourceGroups = source.groups.length ? source.groups : [{start: 0, count, materialIndex: 0}];
    const j0 = source.getAttribute('skinIndex'), w0 = source.getAttribute('skinWeight');
    const j1 = source.getAttribute('joints_1'), w1 = source.getAttribute('weights_1');
    const bone = mesh instanceof THREE.SkinnedMesh ? null : attachmentBone(mesh);
    const rigidPart = bone ? this.retarget.parts.get(bone) : null;
    if (!(mesh instanceof THREE.SkinnedMesh) && !rigidPart) throw new Error(`${this.definition.label}: unsupported unrigged mesh ${mesh.name}.`);
    const indices: number[] = [], output: THREE.MeshPhysicalMaterial[] = [], names: string[] = [];
    geometry.clearGroups();
    for (const group of sourceGroups) {
      const original = sources[group.materialIndex ?? 0];
      if (!(original instanceof THREE.MeshStandardMaterial) && !(original instanceof THREE.MeshBasicMaterial))
        throw new Error(`${this.definition.label}: unsupported surface material on ${mesh.name}.`);
      if (group.start % 3 || group.count % 3) throw new Error(`${this.definition.label}: incomplete triangle group.`);
      const groups = new Map<string, number[]>();
      for (let start = group.start; start < group.start+group.count; start += 3) {
        const influence = new Map<string, number>();
        if (rigidPart) influence.set(rigidPart, 1);
        for (let k = 0; k < 3; k++) {
          const vertex = index ? index.getX(start+k) : start+k;
          for (let set = 0; mesh instanceof THREE.SkinnedMesh && set < 2; set++) {
            const joints = set ? j1 : j0, weights = set ? w1 : w0;
            if (!joints || !weights) continue;
            for (let j = 0; j < 4; j++) {
              const weight = weights.getComponent(vertex, j); if (!weight) continue;
              const part = this.retarget.parts.get(mesh.skeleton.bones[joints.getComponent(vertex, j)]);
              if (!part) throw new Error(`${this.definition.label}: unmapped skin joint in ${mesh.name}.`);
              influence.set(part, (influence.get(part) ?? 0)+weight);
            }
          }
        }
        let part = '', best = -1;
        for (const [name, weight] of influence) if (weight > best) {best = weight; part = name;}
        if (!part) throw new Error(`${this.definition.label}: unweighted triangle in ${mesh.name}.`);
        let triangles = groups.get(part); if (!triangles) {triangles = []; groups.set(part, triangles);}
        for (let k = 0; k < 3; k++) triangles.push(index ? index.getX(start+k) : start+k);
      }
      for (const [part, triangles] of groups) {
        const material = authoredMaterial(original);
        this.entries.push({part, source: original, material, opacity: material.opacity,
          transparent: material.transparent, depthWrite: material.depthWrite});
        geometry.addGroup(indices.length, triangles.length, output.length);
        for (const i of triangles) indices.push(i);
        output.push(material); names.push(part);
      }
    }
    geometry.setIndex(indices); mesh.geometry = geometry; mesh.material = output;
    mesh.userData.sourcePartNames = names;
    mesh.userData.characterId = this.definition.id;
    mesh.frustumCulled = false; mesh.castShadow = true; mesh.receiveShadow = true;
  }
  partNames() { return [...new Set(this.entries.map(entry => entry.part))].sort(); }
  nativePaintFor(part: string): PartPaint | undefined {
    const entry = this.entries.find(entry => entry.part === part);
    return entry ? readPartPaint(entry.source) : undefined;
  }
  updateMaterials() {
    for (const entry of this.entries) {
      resetMaterial(entry.material, entry.source);
      applyPaint(entry.part, entry.material, entry.source, this.paint);
      entry.opacity = entry.material.opacity; entry.transparent = entry.material.transparent;
      entry.depthWrite = entry.material.depthWrite; entry.material.needsUpdate = true;
    }
    // Material.copy does not preserve shader callbacks. Recovery is geometry-marked and occurs only once.
    prepareExtraSkinning(this.root);
    this.visibility(this.fade, this.shown);
  }
  eachMaterial(visit: (material: THREE.Material) => void) { for (const entry of this.entries) visit(entry.material); }
  sync(xpos: Float32Array, xmat: Float32Array) {
    this.retarget.fromFrame(xpos, xmat, this.pose);
    poseOn(this.root, this.retarget.bones, this.pose, this.skins);
  }
  visibility(opacity: number, visible: boolean) {
    this.fade = THREE.MathUtils.clamp(opacity, 0, 1); this.shown = visible;
    this.root.visible = visible && this.fade > 0;
    const fading = this.fade < 1;
    for (const entry of this.entries) {
      const material = entry.material, transparent = entry.transparent || fading;
      if (material.transparent !== transparent) {material.transparent = transparent; material.needsUpdate = true;}
      material.opacity = entry.opacity*this.fade; material.depthWrite = fading ? false : entry.depthWrite;
    }
    for (const mesh of this.meshes) mesh.castShadow = visible && this.fade === 1;
  }

  /** Authored skinned and rigid triangles baked without mutating live resources. */
  preview(part: string | null, paint: CharacterPaint): THREE.Object3D {
    const root = new THREE.Group(); root.userData = structuredClone(this.root.userData);
    const skin = new THREE.Matrix4(), vertex = new THREE.Vector4(), point = new THREE.Vector3();
    this.root.updateMatrixWorld(true);
    for (const mesh of this.meshes) {
      if (mesh instanceof THREE.SkinnedMesh) mesh.skeleton.update();
      const source = mesh.geometry, live = materials(mesh), names = mesh.userData.sourcePartNames as string[];
      const geometry = new THREE.BufferGeometry(), indices: number[] = [], output: THREE.MeshPhysicalMaterial[] = [];
      for (const group of source.groups) {
        const slot = group.materialIndex ?? 0, name = names[slot]; if (part && part !== name) continue;
        const entry = this.entries.find(e => e.material === live[slot]);
        if (!entry) throw new Error(`${this.definition.label}: preview material mapping is missing.`);
        const material = authoredMaterial(entry.source); applyPaint(name, material, entry.source, paint);
        geometry.addGroup(indices.length, group.count, output.length); output.push(material);
        for (let i = group.start; i < group.start+group.count; i++) indices.push(source.index!.getX(i));
      }
      if (!output.length) {geometry.dispose(); continue;}
      for (const name of Object.keys(source.attributes)) {
        if (name === 'skinIndex' || name === 'skinWeight' || name === 'joints_1' || name === 'weights_1') continue;
        const attribute = source.getAttribute(name);
        geometry.setAttribute(name, name === 'position' || name === 'normal' || name === 'tangent'
          ? new THREE.Float32BufferAttribute(attribute.count*attribute.itemSize, attribute.itemSize) : attribute.clone());
      }
      const position = source.getAttribute('position'), normal = source.getAttribute('normal'), tangent = source.getAttribute('tangent');
      const bp = geometry.getAttribute('position'), bn = geometry.getAttribute('normal'), bt = geometry.getAttribute('tangent');
      const j0 = source.getAttribute('skinIndex'), w0 = source.getAttribute('skinWeight');
      const j1 = source.getAttribute('joints_1'), w1 = source.getAttribute('weights_1');
      const chrome = source.getAttribute('chromeOrigin'), bc = geometry.getAttribute('chromeOrigin');
      for (let i = 0; i < position.count; i++) {
        // CPU method is installed by prepareExtraSkinning and matches GPU's complete influence set.
        mesh.getVertexPosition(i, point); bp.setXYZ(i, point.x, point.y, point.z);
        if (mesh instanceof THREE.SkinnedMesh) skin.elements.fill(0);
        else skin.identity();
        for (let set = 0; mesh instanceof THREE.SkinnedMesh && set < 2; set++) {
          const joints = set ? j1 : j0, weights = set ? w1 : w0; if (!joints || !weights) continue;
          for (let k = 0; k < 4; k++) {
            const w = weights.getComponent(i, k); if (!w) continue;
            const offset = joints.getComponent(i, k)*16;
            for (let e = 0; e < 16; e++) skin.elements[e] += w*mesh.skeleton.boneMatrices[offset+e];
          }
        }
        if (mesh instanceof THREE.SkinnedMesh) skin.premultiply(mesh.bindMatrixInverse).multiply(mesh.bindMatrix);
        if (chrome) {
          point.fromBufferAttribute(chrome, i).applyMatrix4(skin);
          bc.setXYZ(i, point.x, point.y, point.z);
        }
        if (normal) {
          vertex.set(normal.getX(i), normal.getY(i), normal.getZ(i), 0).applyMatrix4(skin);
          bn.setXYZ(i, vertex.x, vertex.y, vertex.z);
        }
        if (tangent) {
          vertex.set(tangent.getX(i), tangent.getY(i), tangent.getZ(i), 0).applyMatrix4(skin);
          bt.setXYZW(i, vertex.x, vertex.y, vertex.z, tangent.getW(i));
        }
      }
      geometry.setIndex(indices);
      const bounds = new THREE.Box3();
      for (const i of indices) bounds.expandByPoint(point.fromBufferAttribute(bp, i));
      geometry.boundingBox = bounds; geometry.boundingSphere = bounds.getBoundingSphere(new THREE.Sphere());
      const baked = new THREE.Mesh(geometry, output); baked.name = mesh.name; baked.applyMatrix4(mesh.matrixWorld); root.add(baked);
    }
    return root;
  }

  /** Same evaluator as playback, isolated pose arrays and independently-owned export resources. */
  export(geometry: GeometryTrack, times: Float32Array): CharacterBodyExport {
    if (geometry.ngeom !== this.retarget.model.ngeom || !times.length || geometry.frames !== times.length)
      throw new Error(`${this.definition.label}: incompatible or empty recorded character take.`);
    const root = cloneSkeleton(this.root), meshes: THREE.SkinnedMesh[] = [], byName = new Map<string, THREE.Bone>();
    root.visible = true;
    root.traverse(object => {
      if (object.animations.length) object.animations = object.animations.map(clip => clip.clone());
      if (object instanceof THREE.Bone) byName.set(object.name, object);
      if (object instanceof THREE.Mesh) {
        if (object instanceof THREE.SkinnedMesh) meshes.push(object);
        object.geometry = object.geometry.clone();
        object.material = materials(object).map(original => {
          const entry = this.entries.find(e => e.material === original);
          const material = original.clone();
          copyNativeShader(material, original);
          if (entry) {
            material.opacity = entry.opacity; material.transparent = entry.transparent;
            material.depthWrite = entry.depthWrite;
          }
          return material;
        });
        if (visibleInAsset(object, root)) object.castShadow = true;
      }
    });
    prepareExtraSkinning(root);
    const bones = this.retarget.bones.map(b => {
      const clone = byName.get(b.name); if (!clone) throw new Error(`${this.definition.label}: export joint ${b.name} is missing.`); return clone;
    });
    const pose = this.retarget.createPose(), first = this.retarget.createPose();
    const positions = new Float32Array(times.length*3), rotations = new Float32Array(times.length*4);
    const local = bones.map(() => new Float32Array(times.length*4));
    const translations = pose.bonePositions?.map(position => position ? new Float32Array(times.length*3) : undefined);
    const put = (array: Float32Array, i: number, q: THREE.Quaternion) => {
      const n = i*4, sign = i && array[n-4]*q.x+array[n-3]*q.y+array[n-2]*q.z+array[n-1]*q.w < 0 ? -1 : 1;
      array[n] = q.x*sign; array[n+1] = q.y*sign; array[n+2] = q.z*sign; array[n+3] = q.w*sign;
    };
    for (let i = 0; i < times.length; i++) {
      this.retarget.fromRecorded(geometry, i, pose);
      positions[i*3] = pose.position.x; positions[i*3+1] = pose.position.y; positions[i*3+2] = pose.position.z;
      put(rotations, i, pose.quaternion);
      for (let j = 0; j < bones.length; j++) {
        put(local[j], i, pose.bones[j]);
        const position = pose.bonePositions?.[j], values = translations?.[j];
        if (position && values) position.toArray(values, i*3);
      }
      if (!i) {
        first.position.copy(pose.position); first.quaternion.copy(pose.quaternion);
        for (let j = 0; j < bones.length; j++) {
          first.bones[j].copy(pose.bones[j]);
          const position = pose.bonePositions?.[j];
          if (position) first.bonePositions?.[j]?.copy(position);
        }
      }
    }
    poseOn(root, bones, first, meshes);
    const tracks: THREE.KeyframeTrack[] = [new THREE.VectorKeyframeTrack(`${root.uuid}.position`, times, positions),
      new THREE.QuaternionKeyframeTrack(`${root.uuid}.quaternion`, times, rotations)];
    for (let i = 0; i < bones.length; i++) {
      tracks.push(new THREE.QuaternionKeyframeTrack(`${bones[i].uuid}.quaternion`, times, local[i]));
      const positions = translations?.[i];
      if (positions) tracks.push(new THREE.VectorKeyframeTrack(`${bones[i].uuid}.position`, times, positions));
    }
    return {root, tracks};
  }
  dispose() {
    if (this.disposed) return; this.disposed = true;
    const skeletons = new Set<THREE.Skeleton>();
    for (const mesh of this.meshes) {
      mesh.geometry.dispose();
    }
    this.root.traverse(object => {
      if (object instanceof THREE.SkinnedMesh) skeletons.add(object.skeleton);
      if (object instanceof THREE.Mesh) {
        object.customDepthMaterial?.dispose(); object.customDistanceMaterial?.dispose();
      }
    });
    for (const skeleton of skeletons) skeleton.dispose();
    for (const entry of this.entries) entry.material.dispose();
    // Texture maps belong to the cached loaded asset, not this instance.
    this.root.removeFromParent();
  }
}

/** Prepare either a parsed glTF or a native decoder's scene through one body pipeline. */
export function characterAsset(source: THREE.Object3D, definition: CharacterDefinition): CharacterAsset {
  const bones = new Set<THREE.Bone>();
  source.traverse(object => {if (object instanceof THREE.Bone) bones.add(object);});
  let surfaces = 0;
  source.traverse(object => {
    if (object instanceof THREE.Mesh) for (const material of materials(object)) rememberShader(material);
    if (!(object instanceof THREE.Mesh) || !visibleInAsset(object, source)) return;
    surfaces++;
    if (object.morphTargetInfluences?.some(weight => weight !== 0))
      throw new Error(`${definition.label}: active morph targets are unsupported.`);
    if (Object.keys(object.geometry.attributes).some(name => /^(?:joints|weights)_(?:[2-9]|[1-9][0-9]+)$/.test(name)))
      throw new Error(`${definition.label}: more than eight skin influences are unsupported.`);
    if (object instanceof THREE.SkinnedMesh) {
      if (!object.skeleton.bones.length || object.skeleton.bones.some(bone => !bones.has(bone)))
        throw new Error(`${definition.label}: skin joints must belong to the authored asset.`);
    } else {
      const bone = attachmentBone(object);
      if (!bone || !bones.has(bone)) throw new Error(`${definition.label}: unskinned mesh ${object.name} is not a native bone attachment.`);
    }
  });
  if (!surfaces || !bones.size) throw new Error(`${definition.label}: asset contains no visible authored rig.`);
  prepareExtraSkinning(source);
  // Embedded provenance and native clips remain alongside the concise notice.
  source.userData.characterAttribution = structuredClone(definition.attribution);
  let disposed = false;
  return {
    create(model, paint) {
      if (disposed) throw new Error(`${definition.label}: character asset has been disposed.`);
      return new BaseCharacterBody(source, definition, model, paint);
    },
    dispose() {
      if (disposed) return; disposed = true;
      const geometries = new Set<THREE.BufferGeometry>(), surfaces = new Set<THREE.Material>();
      const textures = new Set<THREE.Texture>(), skeletons = new Set<THREE.Skeleton>();
      source.traverse(object => {
        if (!(object instanceof THREE.Mesh)) return;
        geometries.add(object.geometry);
        for (const material of materials(object)) surfaces.add(material);
        if (object.customDepthMaterial) surfaces.add(object.customDepthMaterial);
        if (object.customDistanceMaterial) surfaces.add(object.customDistanceMaterial);
        if (object instanceof THREE.SkinnedMesh) skeletons.add(object.skeleton);
      });
      for (const material of surfaces) for (const value of Object.values(material)) {
        if (value instanceof THREE.Texture) textures.add(value);
      }
      for (const skeleton of skeletons) skeleton.dispose();
      for (const geometry of geometries) geometry.dispose();
      for (const material of surfaces) material.dispose();
      const images = new Set<ImageBitmap>();
      for (const texture of textures) {
        texture.dispose();
        if (typeof ImageBitmap !== 'undefined' && texture.source.data instanceof ImageBitmap) images.add(texture.source.data);
      }
      for (const image of images) image.close();
    },
  };
}

export async function loadCharacter(definition: CharacterDefinition): Promise<CharacterAsset> {
  const gltf = await new GLTFLoader().loadAsync(definition.url);
  gltf.scene.animations = gltf.animations;
  return characterAsset(gltf.scene, definition);
}
