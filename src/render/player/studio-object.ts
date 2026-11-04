/** Three.js objects for decoded Source Studio models from the person's own game files.
 *
 * The conversion happens once here: geometry stays in native model space (inches, +Z up,
 * +X forward) under `root`; the caller scales/places `root`. Source draws clockwise front faces
 * (noclip MaterialBase.setCullMode: frontFace CW), so each triangle's winding is reversed for
 * Three's counter-clockwise front faces. Normals, UVs (Source V-down, matching the library's
 * flipY-off textures) and bone weights are kept as decoded. No DoubleSide or negative scale is
 * introduced; `$nocull` materials are double-sided because Source draws them that way.
 *
 * Materials come from SourceMaterialLibrary. VertexLitGeneric surfaces are lit by m0clip's moving
 * Source ambient cube (the same pattern as GoldSrc character bodies), through a lit material
 * that shares the library's albedo texture; Source effects that pattern can't reproduce are
 * listed in `limitations`. UnlitGeneric surfaces use the library material unchanged. */
import * as THREE from 'three';
import { bodyGroupModel, type StudioModelData, type StudioPose } from '../../player/studio';
import type { SourceMaterialDescriptor, SourceMaterialLibrary } from '../../player/materials/library';
import { SourceMaterialError } from '../../player/materials/errors';

/** Applies the scene's lighting (ambient cube, flashlight, shot lights) to a material. */
export type MaterialLighter = (material: THREE.Material) => void;

export interface StudioObjectOptions {
  /** Source skin family; default 0. */
  skin?: number;
  /** Source body (bodygroup) value; default 0. */
  body?: number;
  light?: MaterialLighter;
  signal?: AbortSignal;
}

const NOT_REPRODUCED: Readonly<Record<string, true>> = Object.fromEntries(['$bumpmap', '$bumpframe', '$phong', '$phongboost',
  '$phongexponent', '$phongexponenttexture', '$phongexponentfactor', '$phongfresnelranges', '$phongtint', '$phongalbedotint',
  '$phongalbedoboost', '$basemapalphaphongmask', '$invertphongmask', '$envmap', '$envmaptint', '$envmapcontrast', '$envmapsaturation',
  '$envmapmask', '$envmaplightscale', '$basealphaenvmapmask', '$normalmapalphaenvmapmask', '$selfillum', '$selfillumtint',
  '$selfillummask', '$detail', '$detailscale', '$detailblendfactor', '$detailblendmode', '$halflambert'].map(name => [name, true]));

export class StudioObject {
  readonly root = new THREE.Group();
  readonly bones: THREE.Bone[] = [];
  readonly meshes: THREE.SkinnedMesh[] = [];
  readonly skeleton: THREE.Skeleton;
  readonly limitations: string[] = [];
  /** Every material drawn, with its library descriptor (null for none). */
  readonly materials: { material: THREE.Material; descriptor: SourceMaterialDescriptor | null }[] = [];
  private readonly owned: THREE.Material[] = [];
  private readonly geometries: THREE.BufferGeometry[] = [];
  private readonly names = new Map<string, number>();

  private constructor(readonly model: StudioModelData) {
    const s = model.skeleton, inverses: THREE.Matrix4[] = [];
    this.root.name = `Studio_${model.name}`;
    for (let i = 0; i < s.count; i++) {
      const bone = new THREE.Bone();
      bone.name = s.names[i];
      bone.position.fromArray(s.position, i * 3);
      bone.quaternion.fromArray(s.quaternion, i * 4);
      this.bones.push(bone);
      if (!this.names.has(s.names[i].toLowerCase())) this.names.set(s.names[i].toLowerCase(), i);
      const m = s.poseToBone, o = i * 12;
      inverses.push(new THREE.Matrix4().set(m[o], m[o + 1], m[o + 2], m[o + 3], m[o + 4], m[o + 5], m[o + 6], m[o + 7],
        m[o + 8], m[o + 9], m[o + 10], m[o + 11], 0, 0, 0, 1));
    }
    for (let i = 0; i < s.count; i++) (s.parent[i] >= 0 ? this.bones[s.parent[i]] : this.root).add(this.bones[i]);
    this.skeleton = new THREE.Skeleton(this.bones, inverses);
  }

  /** Builds every mesh of the selected bodygroups with its material. Rejects with the library's
   * SourceMaterialError when a material or texture is missing or unsupported; only eyeball meshes
   * (Source Eyes/EyeRefract shaders, which m0clip doesn't render) are left out, and listed. */
  static async create(model: StudioModelData, library: SourceMaterialLibrary, options: StudioObjectOptions = {}): Promise<StudioObject> {
    const object = new StudioObject(model);
    try {
      await object.build(library, options);
      return object;
    } catch (error) {
      object.dispose();
      throw error;
    }
  }

  private async build(library: SourceMaterialLibrary, { skin = 0, body = 0, light, signal }: StudioObjectOptions): Promise<void> {
    const model = this.model, families = model.materials.skinFamilies;
    if (!families.length) throw new Error(`Studio model ${model.path} has no skin families.`);
    if (!Number.isInteger(skin) || skin < 0 || skin >= families.length) throw new Error(`Studio model ${model.path} has no skin family ${skin}.`);
    const family = families[skin];
    const loads = new Map<number, Promise<{ material: THREE.Material; descriptor: SourceMaterialDescriptor } | null>>();
    const materialFor = (texture: number, eyeball: boolean) => {
      let load = loads.get(texture);
      if (!load) {
        const name = model.materials.replacements.get(texture) ?? model.materials.textures[texture]?.name;
        if (name === undefined) throw new Error(`Studio model ${model.path} has no texture ${texture}.`);
        load = library.load(name, model.materials.searchDirectories, signal).then(basic => {
          const descriptor = library.describe(basic);
          if (!descriptor) throw new Error(`Material ${name} has no Source description.`);
          return { material: this.surface(basic, descriptor, light), descriptor };
        }, (error: unknown) => {
          if (eyeball && error instanceof SourceMaterialError && error.code === 'unsupported-shader') {
            this.note(`Eyeball surface ${name} is not drawn: ${error.message}`);
            return null;
          }
          throw error;
        });
        loads.set(texture, load);
      }
      return load;
    };
    const identity = new THREE.Matrix4();
    const pending: Promise<void>[] = [];
    try {
    for (let part = 0; part < model.bodyParts.length; part++) {
      const submodel = model.bodyParts[part].models[bodyGroupModel(model, body, part)];
      for (const mesh of submodel.meshes) {
        const texture = family[mesh.skinRef];
        if (texture === undefined) throw new Error(`Studio model ${model.path}: skin reference ${mesh.skinRef} is outside skin family ${skin}.`);
        const eyeball = mesh.materialType === 1 || (mesh.flags & 2) !== 0;
        pending.push(materialFor(texture, eyeball).then(entry => {
          if (!entry || !mesh.index.length) return;
          const n = mesh.vertexCount, geometry = new THREE.BufferGeometry();
          geometry.setAttribute('position', new THREE.BufferAttribute(mesh.position, 3));
          geometry.setAttribute('normal', new THREE.BufferAttribute(mesh.normal, 3));
          geometry.setAttribute('uv', new THREE.BufferAttribute(mesh.uv, 2));
          const joints = new Uint16Array(n * 4), weights = new Float32Array(n * 4);
          for (let v = 0; v < n; v++) for (let k = 0; k < 3; k++) {
            joints[v * 4 + k] = mesh.boneIndex[v * 3 + k];
            weights[v * 4 + k] = mesh.boneWeight[v * 3 + k];
          }
          geometry.setAttribute('skinIndex', new THREE.BufferAttribute(joints, 4));
          geometry.setAttribute('skinWeight', new THREE.BufferAttribute(weights, 4));
          const source = mesh.index, index = source instanceof Uint32Array ? new Uint32Array(source.length) : new Uint16Array(source.length);
          for (let t = 0; t + 2 < source.length; t += 3) { index[t] = source[t]; index[t + 1] = source[t + 2]; index[t + 2] = source[t + 1]; }
          geometry.setIndex(new THREE.BufferAttribute(index, 1));
          this.geometries.push(geometry);
          const skinned = new THREE.SkinnedMesh(geometry, entry.material);
          skinned.name = `${model.bodyParts[part].name}_${submodel.name}_${mesh.meshId}`;
          skinned.frustumCulled = false;
          skinned.bind(this.skeleton, identity);
          this.root.add(skinned);
          this.meshes.push(skinned);
        }));
      }
    }
    } catch (error) {
      await Promise.allSettled(pending);
      throw error;
    }
    // Let every load settle first, so nothing is added after a failure disposes this object.
    const failed = (await Promise.allSettled(pending)).find((result): result is PromiseRejectedResult => result.status === 'rejected');
    if (failed) throw failed.reason;
    if (!this.meshes.length) throw new Error(`Studio model ${model.path} has no drawable meshes in body ${body}.`);
    if (model.notEvaluated.length) this.note(`Authored data not evaluated: ${model.notEvaluated.join('; ')}.`);
  }

  private surface(basic: THREE.MeshBasicMaterial, d: SourceMaterialDescriptor, light?: MaterialLighter): THREE.Material {
    const known = this.materials.find(entry => entry.descriptor === d);
    if (known) return known.material;
    let material: THREE.Material = basic;
    if (d.shader === 'vertexlitgeneric') {
      const lit = new THREE.MeshStandardMaterial({
        name: basic.name, color: basic.color, map: basic.map, opacity: basic.opacity, transparent: basic.transparent,
        alphaTest: basic.alphaTest, side: basic.side, depthWrite: basic.depthWrite, roughness: 1, metalness: 0, envMapIntensity: 0,
      });
      lit.blending = basic.blending;
      lit.blendEquation = basic.blendEquation; lit.blendSrc = basic.blendSrc; lit.blendDst = basic.blendDst;
      lit.userData.sourceMaterial = basic.userData.sourceMaterial;
      light?.(lit);
      this.owned.push(lit);
      material = lit;
      const skipped = d.rendered.filter(p => NOT_REPRODUCED[p.name]).map(p => p.name);
      if (skipped.length) this.note(`${d.path}: ${[...new Set(skipped)].join(', ')} not reproduced; lit by the map's ambient cube and dynamic lights only.`);
    }
    if (d.requires.includes('scene-cubemap')) this.note(`${d.path}: env_cubemap reflection not reproduced.`);
    this.materials.push({ material, descriptor: d });
    return material;
  }

  private note(text: string) { if (!this.limitations.includes(text)) this.limitations.push(text); }

  /** Model bone index by (case-insensitive) name, or -1. */
  boneIndex(name: string): number { return this.names.get(name.toLowerCase()) ?? -1; }

  /** Writes a sampled local pose into the bones. */
  setPose(pose: StudioPose): void {
    const bones = this.bones;
    for (let i = 0; i < bones.length; i++) {
      bones[i].position.fromArray(pose.position, i * 3);
      bones[i].quaternion.fromArray(pose.quaternion, i * 4);
    }
  }

  /** A second hierarchy sharing geometry and materials, for exports. */
  cloneHierarchy(): { root: THREE.Group; bones: THREE.Bone[] } {
    const s = this.model.skeleton, root = new THREE.Group(), bones = this.bones.map(b => {
      const bone = new THREE.Bone(); bone.name = b.name; bone.position.copy(b.position); bone.quaternion.copy(b.quaternion); return bone;
    });
    for (let i = 0; i < bones.length; i++) (s.parent[i] >= 0 ? bones[s.parent[i]] : root).add(bones[i]);
    const skeleton = new THREE.Skeleton(bones, this.skeleton.boneInverses.map(m => m.clone())), identity = new THREE.Matrix4();
    for (const mesh of this.meshes) {
      const copy = new THREE.SkinnedMesh(mesh.geometry, mesh.material);
      copy.name = mesh.name; copy.frustumCulled = false; copy.bind(skeleton, identity); root.add(copy);
    }
    return { root, bones };
  }

  /** Disposes geometry and the lit materials created here; library materials and textures stay
   * with their library. */
  dispose(): void {
    for (const geometry of this.geometries) geometry.dispose();
    for (const material of this.owned) material.dispose();
    this.geometries.length = 0; this.owned.length = 0;
    this.root.removeFromParent();
  }
}
