/** Standard glTF retargeting. Physics frames are inputs; authored bind data is never rewritten. */
import * as THREE from 'three';
import type { RenderModel } from '../../sim/protocol';
import type { CharacterDefinition, CharacterPhysics } from './types';
import { GEOM_SPHERE } from '../../sim/engine';
import type { GeometryTrack } from '../../core/geometry';

export interface CharacterPose {
  position: THREE.Vector3;
  quaternion: THREE.Quaternion;
  bones: THREE.Quaternion[];
  bonePositions?: (THREE.Vector3 | undefined)[];
}
interface Binding { body: number; geom: number; inverse: THREE.Matrix4; reference: THREE.Quaternion }
interface Node {
  object: THREE.Object3D; parent: number; bone: number;
  position: THREE.Vector3; rotation: THREE.Quaternion; scale: THREE.Vector3;
  bindWorld: THREE.Matrix4; bindRotation: THREE.Quaternion;
  world: THREE.Matrix4; rotationWorld: THREE.Quaternion;
  binding: Binding | null; calibrated: THREE.Quaternion;
  pivot?: { scaled: THREE.Vector3; parentPoint: THREE.Vector3 };
  attachment?: { parent: number; bind: THREE.Matrix4; rotation: THREE.Quaternion };
}
interface Skin {
  mesh: THREE.SkinnedMesh; node: number; bones: number[];
  matrices: THREE.Matrix4[]; outer: THREE.Matrix4;
  samples: { position: THREE.Vector3; joints: number[]; weights: number[] }[];
}
interface RigidSole { node: number; positions: THREE.BufferAttribute | THREE.InterleavedBufferAttribute }
const ONE = new THREE.Vector3(1, 1, 1);
const PHYSICS = {
  r1: {
    root: 'pelvis',
    required: ['pelvis', 'torso_link', 'left_shoulder_yaw_link', 'right_shoulder_yaw_link',
      'left_elbow_link', 'right_elbow_link', 'left_hip_yaw_link', 'right_hip_yaw_link',
      'left_knee_link', 'right_knee_link', 'left_ankle_roll_link', 'right_ankle_roll_link'],
    soles: ['left_ankle_roll_link', 'right_ankle_roll_link'], spheres: false,
  },
  go2: {
    root: 'base_link',
    required: ['base_link', 'FL_hip', 'FL_thigh', 'FL_calf', 'FR_hip', 'FR_thigh', 'FR_calf',
      'RL_hip', 'RL_thigh', 'RL_calf', 'RR_hip', 'RR_thigh', 'RR_calf'],
    soles: ['FL_calf', 'FR_calf', 'RL_calf', 'RR_calf'], spheres: true,
  },
} as const;
type PhysicsSole = { geom: number; vertices: Float32Array } | { geom: number; radius: number };
// GLTFLoader sanitizes punctuation in Object3D.name, but retains the exact authored name here.
function nativeName(object: THREE.Object3D): string {
  return typeof object.userData.name === 'string' ? object.userData.name : object.name;
}
function frame(pos: ArrayLike<number>, quat: ArrayLike<number>, i: number) {
  return new THREE.Matrix4().compose(new THREE.Vector3().fromArray(pos, i * 3),
    new THREE.Quaternion(quat[4*i+1], quat[4*i+2], quat[4*i+3], quat[4*i]), ONE);
}
/** Requires reconstructible body frames and the selected family's actual sole surfaces. */
export function characterCompatible(model: RenderModel, physics: CharacterPhysics): boolean {
  const profile = PHYSICS[physics], b = model.bodyFrames, g = model.geomFrames, n = model.bodyNames.length;
  if (!profile || (physics === 'r1' ? !model.robot.startsWith('r1') : model.robot !== physics)
      || !b || !g || b.parent.length !== n || b.pos.length !== n*3 ||
      b.quat.length !== n*4 || g.pos.length !== model.ngeom*3 || g.quat.length !== model.ngeom*4 ||
      model.bodyid.length !== model.ngeom) return false;
  if (profile.spheres && (model.type.length !== model.ngeom || model.size.length !== model.ngeom*3)) return false;
  for (const name of profile.required) {
    const id = model.bodyNames.indexOf(name);
    if (id < 0 || !model.bodyid.includes(id)) return false;
  }
  for (let i = 0; i < n; i++) {
    if (b.parent[i] < 0 || b.parent[i] >= n || (i !== 0 && b.parent[i] === i)) return false;
    for (let k = 0; k < 3; k++) if (!Number.isFinite(b.pos[i*3+k])) return false;
    let norm = 0;
    for (let k = 0; k < 4; k++) norm += b.quat[i*4+k] ** 2;
    if (!Number.isFinite(norm) || Math.abs(norm-1) > .01) return false;
  }
  const visited = new Uint8Array(n); visited[0] = 2;
  for (let i = 1; i < n; i++) {
    let p = i;
    while (visited[p] === 0) {visited[p] = 1; p = b.parent[p];}
    if (visited[p] === 1) return false;
    p = i;
    while (visited[p] === 1) {visited[p] = 2; p = b.parent[p];}
  }
  for (let i = 0; i < model.ngeom; i++) {
    if (model.bodyid[i] < 0 || model.bodyid[i] >= n) return false;
    for (let k = 0; k < 3; k++) if (!Number.isFinite(g.pos[i*3+k])) return false;
    let norm = 0;
    for (let k = 0; k < 4; k++) norm += g.quat[i*4+k] ** 2;
    if (!Number.isFinite(norm) || Math.abs(norm-1) > .01) return false;
  }
  for (const name of profile.soles) {
    const id = model.bodyNames.indexOf(name);
    let found = false;
    for (let i = 0; i < model.ngeom; i++) if (model.bodyid[i] === id) {
      if (profile.spheres ? model.contype[i] !== 0 && model.type[i] === GEOM_SPHERE
          && Number.isFinite(model.size[i*3]) && model.size[i*3] > 0
        : model.contype[i] === 0 && !!model.meshes[model.dataid[i]]?.vert.length) found = true;
    }
    if (!found) return false;
  }
  return true;
}

export class CharacterRetarget {
  readonly bones: THREE.Bone[] = [];
  readonly parts = new Map<THREE.Bone, string>();
  readonly reference: THREE.Matrix4[] = [];
  readonly scale: number;
  private nodes: Node[] = [];
  private skins: Skin[] = [];
  private rigidSoles: RigidSole[] = [];
  private poseNodes: Node[] | null = null;
  private translatedBones: number[] = [];
  private soles: PhysicsSole[] = [];
  private rootBinding: Binding;
  private alignment: THREE.Quaternion;
  private anchor = new THREE.Vector3();
  private matrix = new THREE.Matrix4();
  private local = new THREE.Matrix4();
  private rootMatrix = new THREE.Matrix4();
  private current = new THREE.Quaternion();
  private inverseRoot = new THREE.Quaternion();
  private parentInverse = new THREE.Quaternion();
  private deltaRoot = new THREE.Quaternion();
  private point = new THREE.Vector3();
  private up = new THREE.Vector3();
  private fitScale = new THREE.Vector3(1, 1, 1);
  private mode: 'reference' | 'frame' | 'recorded' = 'reference';
  private xpos: Float32Array | null = null;
  private xmat: Float32Array | null = null;
  private recorded: GeometryTrack | null = null;
  private recordedFrame = 0;

  constructor(source: THREE.Object3D, meshes: THREE.Mesh[], readonly definition: CharacterDefinition,
      readonly model: RenderModel) {
    const physics = definition.physics ?? 'r1', profile = PHYSICS[physics];
    if (!characterCompatible(model, physics)) throw new Error(`${definition.label} requires compatible ${physics} body frames and sole geometry.`);
    this.alignment = new THREE.Quaternion().fromArray(definition.rig.alignment);
    if (definition.rig.alignment.length !== 4 || !Number.isFinite(this.alignment.lengthSq()) || Math.abs(this.alignment.lengthSq()-1) > .001)
      throw new Error(`${definition.label}: invalid native coordinate alignment.`);
    const frames = model.bodyFrames!, geom = model.geomFrames!, state = new Uint8Array(model.bodyNames.length);
    const resolve = (i: number): THREE.Matrix4 => {
      if (state[i] === 1) throw new Error('Unsupported cyclic body frames.');
      if (state[i] === 2) return this.reference[i];
      state[i] = 1;
      const local = frame(frames.pos, frames.quat, i);
      this.reference[i] = i === 0 ? local : resolve(frames.parent[i]).clone().multiply(local);
      state[i] = 2; return this.reference[i];
    };
    for (let i = 0; i < state.length; i++) resolve(i);
    const byBody = new Map<number, Binding>();
    const bind = (candidates: readonly string[]): Binding | null => {
      for (const candidate of candidates) {
        const body = model.bodyNames.indexOf(candidate), index = model.bodyid.indexOf(body);
        if (body < 0 || index < 0) continue;
        let binding = byBody.get(body);
        if (!binding) {
          binding = {body, geom: index, inverse: frame(geom.pos, geom.quat, index).invert(),
            reference: new THREE.Quaternion().setFromRotationMatrix(this.reference[body]).invert()};
          byBody.set(body, binding);
        }
        return binding;
      }
      return null;
    };
    const objects = new Map<THREE.Object3D, number>(), names = new Map<string, number>();
    const actualNames = new Set<string>();
    const alias = (name: string, index: number) => {
      if (names.has(name) && names.get(name) !== index) throw new Error(`${definition.label}: ambiguous bone alias ${name}.`);
      names.set(name, index);
    };
    source.updateMatrixWorld(true);
    source.traverse(object => {
      const parent = objects.get(object.parent!) ?? -1, index = this.nodes.length;
      objects.set(object, index);
      let bone = -1;
      if (object instanceof THREE.Bone) {
        const name = nativeName(object);
        if (!object.name || actualNames.has(object.name)) throw new Error(`${definition.label}: ambiguous actual bone name ${object.name}.`);
        actualNames.add(object.name);
        bone = this.bones.length; this.bones.push(object); alias(name, index); alias(object.name, index);
      }
      const bindWorld = object.matrix.clone();
      if (parent >= 0) bindWorld.premultiply(this.nodes[parent].bindWorld);
      const position = new THREE.Vector3(), rotation = new THREE.Quaternion(), scale = new THREE.Vector3();
      bindWorld.decompose(position, rotation, scale);
      const binding = bone >= 0 ? bind(definition.rig.bindings[nativeName(object)] ?? [])
        ?? bind(definition.rig.bindings[object.name] ?? []) : null;
      this.nodes.push({object, parent, bone, position: object.position.clone(), rotation: object.quaternion.clone(),
        scale: object.scale.clone(), bindWorld, bindRotation: rotation, world: new THREE.Matrix4(),
        rotationWorld: new THREE.Quaternion(), binding, calibrated: rotation.clone()});
      if (bone >= 0) {
        // Quaternion-only retargeting cannot represent shear introduced by nonuniform rig ancestors.
        for (let p = index; p >= 0; p = this.nodes[p].parent) {
          const s = this.nodes[p].scale;
          if (s.x <= 0 || Math.abs(s.x-s.y) > 1e-4 || Math.abs(s.x-s.z) > 1e-4)
            throw new Error(`${definition.label}: unsupported nonuniform or reflected rig scale at ${this.nodes[p].object.name}.`);
        }
        let inherited: string | undefined;
        for (let p = parent; p >= 0 && !inherited; p = this.nodes[p].parent)
          inherited = this.parts.get(this.nodes[p].object as THREE.Bone);
        const part = binding ? model.bodyNames[binding.body] : inherited ?? profile.root;
        this.parts.set(object as THREE.Bone, part === 'pelvis' ? 'pelvis_link' : part);
      }
    });
    for (const name of Object.keys(definition.rig.bindings)) {
      const node = names.get(name);
      if (node === undefined) throw new Error(`${definition.label}: mapped bone ${name} is missing.`);
      if (!this.nodes[node].binding) throw new Error(`${definition.label}: no recorded physics frame for mapped bone ${name}.`);
    }
    const root = names.get(definition.rig.root);
    if (root === undefined || !this.nodes[root].binding) throw new Error(`${definition.label}: missing mapped rig root.`);
    this.rootBinding = this.nodes[root].binding!;
    if (model.bodyNames[this.rootBinding.body] !== profile.root) throw new Error(`${definition.label}: rig root must bind to ${profile.root}.`);
    this.anchor.setFromMatrixPosition(this.nodes[root].bindWorld);
    const vector = (value: readonly number[], name: string) => {
      if (value.length !== 3 || !value.every(Number.isFinite)) throw new Error(`${definition.label}: invalid native vector ${name}.`);
      return new THREE.Vector3().fromArray(value);
    };
    for (const [name, value] of Object.entries(definition.rig.pivots ?? {})) {
      const id = names.get(name);
      if (id === undefined || this.nodes[id].bone < 0) throw new Error(`${definition.label}: missing pivot bone ${name}.`);
      const node = this.nodes[id], scaled = vector(value, name).multiply(node.scale);
      node.pivot = {scaled, parentPoint: scaled.clone().applyQuaternion(node.rotation).add(node.position)};
      this.translatedBones.push(node.bone);
    }
    for (const [name, parentName] of Object.entries(definition.rig.attachments ?? {})) {
      const id = names.get(name), parent = names.get(parentName);
      if (id === undefined || parent === undefined || this.nodes[id].bone < 0 || this.nodes[parent].bone < 0)
        throw new Error(`${definition.label}: missing native attachment ${name} → ${parentName}.`);
      const node = this.nodes[id];
      if (node.binding || node.pivot) throw new Error(`${definition.label}: attachment ${name} cannot also own a physics binding or joint pivot.`);
      const relative = this.nodes[parent].bindWorld.clone().invert().multiply(node.bindWorld), rotation = new THREE.Quaternion();
      relative.decompose(this.point, rotation, this.up);
      node.attachment = {parent, bind: relative, rotation};
      this.translatedBones.push(node.bone);
    }
    if (Object.keys(definition.rig.attachments ?? {}).length) {
      const states = new Uint8Array(this.nodes.length), ordered: Node[] = [];
      const visit = (id: number) => {
        if (id < 0 || states[id] === 2) return;
        if (states[id] === 1) throw new Error(`${definition.label}: cyclic native pose attachment at ${this.nodes[id].object.name}.`);
        states[id] = 1;
        const node = this.nodes[id];
        visit(node.parent);
        if (node.attachment) visit(node.attachment.parent);
        states[id] = 2; ordered.push(node);
        if (node.bone >= 0 && !node.binding) {
          for (let p = node.attachment?.parent ?? node.parent; p >= 0; p = this.nodes[p].attachment?.parent ?? this.nodes[p].parent) {
            const part = this.parts.get(this.nodes[p].object as THREE.Bone);
            if (part) {this.parts.set(node.object as THREE.Bone, part); break;}
          }
        }
      };
      for (let i = 0; i < this.nodes.length; i++) visit(i);
      this.poseNodes = ordered;
    }
    const nativeDirection = new THREE.Vector3(), targetDirection = new THREE.Vector3(), start = new THREE.Vector3();
    const swing = new THREE.Quaternion();
    const aimed = new Set<number>();
    for (const [name, segment] of Object.entries(definition.rig.aim ?? {})) {
      const ni = names.get(name);
      if (ni === undefined) throw new Error(`${definition.label}: missing aim origin ${name}.`);
      const node = this.nodes[ni];
      if (!node.binding) throw new Error(`${definition.label}: aim origin ${name} is not mapped.`);
      let target = -1;
      if (typeof segment === 'string') {
        const ci = names.get(segment);
        if (ci === undefined) throw new Error(`${definition.label}: missing aim endpoint ${segment}.`);
        const child = this.nodes[ci];
        let p = child.parent;
        while (p >= 0 && p !== ni) p = this.nodes[p].parent;
        if (p !== ni) throw new Error(`${definition.label}: aim endpoint ${segment} is not a descendant of ${name}.`);
        nativeDirection.setFromMatrixPosition(child.bindWorld).sub(start.setFromMatrixPosition(node.bindWorld)).applyQuaternion(this.alignment);
        target = child.binding?.body ?? -1;
      } else {
        nativeDirection.copy(vector(segment.direction, name));
        if (nativeDirection.lengthSq() < 1e-10) throw new Error(`${definition.label}: zero-length native aim segment ${name}.`);
        nativeDirection.transformDirection(node.bindWorld).applyQuaternion(this.alignment);
        for (const candidate of segment.target) {
          target = model.bodyNames.indexOf(candidate);
          if (target >= 0) break;
        }
        if (target < 0) throw new Error(`${definition.label}: no physics reference endpoint for ${name}.`);
      }
      if (nativeDirection.lengthSq() < 1e-10) throw new Error(`${definition.label}: zero-length native aim segment ${name}.`);
      // Same-body spine segments and terminal toes inherit their ancestor's swing.
      if (target < 0 || target === node.binding.body) continue;
      targetDirection.setFromMatrixPosition(this.reference[target])
        .sub(start.setFromMatrixPosition(this.reference[node.binding.body]));
      if (targetDirection.lengthSq() < 1e-10) continue;
      swing.setFromUnitVectors(nativeDirection.normalize(), targetDirection.normalize());
      node.calibrated.copy(this.alignment).premultiply(swing).multiply(node.bindRotation);
      aimed.add(ni);
    }
    for (let i = 0; i < this.nodes.length; i++) {
      const node = this.nodes[i]; if (aimed.has(i)) continue;
      node.calibrated.copy(this.alignment).multiply(node.bindRotation);
      // Includes same-body spine segments and terminal hands/feet.
      for (let p = node.parent; p >= 0; p = this.nodes[p].parent) {
        const parent = this.nodes[p];
        if (!aimed.has(p)) continue;
        this.current.copy(this.alignment).multiply(parent.bindRotation).invert();
        swing.copy(parent.calibrated).multiply(this.current);
        node.calibrated.premultiply(swing);
        break;
      }
    }
    const feet = new Set<number>(), footBodies = new Set<number>();
    for (const foot of definition.rig.feet) {
      const name = typeof foot === 'string' ? foot : foot.bone, id = names.get(name);
      if (id === undefined || this.nodes[id].bone < 0) throw new Error(`${definition.label}: missing sole bone ${name}.`);
      feet.add(id);
      if (typeof foot !== 'string') {
        const binding = bind(foot.target);
        if (!binding) throw new Error(`${definition.label}: no recorded physics sole for ${name}.`);
        footBodies.add(binding.body);
      } else for (let p = id; p >= 0; p = this.nodes[p].parent) {
        const binding = this.nodes[p].binding;
        if (binding) {footBodies.add(binding.body); break;}
      }
    }
    if (!feet.size) throw new Error(`${definition.label}: no sole bones configured.`);
    const footNodes = new Set<number>();
    for (let i = 0; i < this.nodes.length; i++) {
      for (let p = i; p >= 0; p = this.nodes[p].attachment?.parent ?? this.nodes[p].parent) if (feet.has(p)) {footNodes.add(i); break;}
    }
    for (const mesh of meshes) {
      if (!(mesh instanceof THREE.SkinnedMesh)) {
        let attachment = mesh.parent;
        while (attachment && !(attachment instanceof THREE.Bone)) attachment = attachment.parent;
        if (!attachment || !objects.has(attachment)) throw new Error(`${definition.label}: mesh ${mesh.name} is not a native bone attachment.`);
        const node = objects.get(mesh)!;
        if (footNodes.has(node)) this.rigidSoles.push({node, positions: mesh.geometry.getAttribute('position')});
        continue;
      }
      if (mesh.morphTargetInfluences?.some(v => v !== 0)) throw new Error(`${definition.label}: active morph targets are unsupported.`);
      const skin: Skin = {mesh, node: objects.get(mesh)!, bones: mesh.skeleton.bones.map(b => {
        const i = objects.get(b); if (i === undefined) throw new Error(`${definition.label}: skin joint lies outside the asset.`); return i;
      }), matrices: mesh.skeleton.bones.map(() => new THREE.Matrix4()), outer: new THREE.Matrix4(), samples: []};
      const position = mesh.geometry.getAttribute('position');
      const j0 = mesh.geometry.getAttribute('skinIndex'), w0 = mesh.geometry.getAttribute('skinWeight');
      const j1 = mesh.geometry.getAttribute('joints_1'), w1 = mesh.geometry.getAttribute('weights_1');
      if (!j0 || !w0) throw new Error(`${definition.label}: mesh ${mesh.name} has no skin weights.`);
      for (let i = 0; i < position.count; i++) {
        const joints: number[] = [], weights: number[] = []; let footWeight = 0;
        for (let set = 0; set < 2; set++) {
          const js = set ? j1 : j0, ws = set ? w1 : w0; if (!js || !ws) continue;
          for (let k = 0; k < 4; k++) {
            const j = js.getComponent(i, k), w = ws.getComponent(i, k);
            if (!w) continue;
            if (!Number.isFinite(w) || w < 0 || !Number.isInteger(j) || j < 0 || j >= skin.bones.length)
              throw new Error(`${definition.label}: invalid skin influence.`);
            joints.push(j); weights.push(w); if (footNodes.has(skin.bones[j])) footWeight += w;
          }
        }
        if (footWeight >= .25) skin.samples.push({position: new THREE.Vector3().fromBufferAttribute(position, i).applyMatrix4(mesh.bindMatrix), joints, weights});
      }
      this.skins.push(skin);
    }
    if (!this.skins.some(s => s.samples.length) && !this.rigidSoles.length) throw new Error(`${definition.label}: no authored sole vertices.`);
    let referenceSole = Infinity;
    for (let g = 0; g < model.ngeom; g++) {
      if (!footBodies.has(model.bodyid[g])) continue;
      if (profile.spheres) {
        if (model.contype[g] === 0 || model.type[g] !== GEOM_SPHERE) continue;
        const radius = model.size[g*3];
        if (!Number.isFinite(radius) || radius <= 0) throw new Error(`${definition.label}: invalid physical sole radius.`);
        this.matrix.copy(this.reference[model.bodyid[g]]).multiply(frame(geom.pos, geom.quat, g));
        this.soles.push({geom: g, radius});
        referenceSole = Math.min(referenceSole, this.matrix.elements[14]-radius);
      } else {
        if (model.contype[g] !== 0) continue;
        const mesh = model.meshes[model.dataid[g]]; if (!mesh) continue;
        this.matrix.copy(this.reference[model.bodyid[g]]).multiply(frame(geom.pos, geom.quat, g));
        this.soles.push({geom: g, vertices: mesh.vert});
        for (let i = 0; i < mesh.vert.length; i += 3) referenceSole = Math.min(referenceSole, this.point.fromArray(mesh.vert, i).applyMatrix4(this.matrix).z);
      }
    }
    if (!Number.isFinite(referenceSole)) throw new Error(`${definition.label}: missing actual physics sole geometry.`);
    const pose = this.createPose();
    this.rotations(pose);
    pose.position.copy(this.anchor).applyQuaternion(pose.quaternion).negate();
    this.matrices(pose);
    this.up.set(0, 0, 1);
    const nativeSole = this.skinSole();
    const height = this.point.setFromMatrixPosition(this.reference[this.rootBinding.body]).z - referenceSole;
    this.scale = height / -nativeSole;
    if (!Number.isFinite(this.scale) || this.scale <= 0) throw new Error(`${definition.label}: invalid calibrated root-to-sole fit.`);
    this.fitScale.setScalar(this.scale);
  }

  createPose(): CharacterPose {
    const pose: CharacterPose = {position: new THREE.Vector3(), quaternion: new THREE.Quaternion(),
      bones: this.bones.map(() => new THREE.Quaternion())};
    if (this.translatedBones.length) {
      pose.bonePositions = new Array(this.bones.length);
      for (const bone of this.translatedBones) pose.bonePositions[bone] = new THREE.Vector3();
    }
    return pose;
  }
  private geomWorld(g: number, out: THREE.Matrix4) {
    if (this.mode === 'reference') {
      const f = this.model.geomFrames!;
      this.point.fromArray(f.pos, g*3);
      this.current.set(f.quat[4*g+1], f.quat[4*g+2], f.quat[4*g+3], f.quat[4*g]);
      out.compose(this.point, this.current, ONE).premultiply(this.reference[this.model.bodyid[g]]);
    } else if (this.mode === 'frame') {
      const r = 9*g, p = 3*g, m = this.xmat!, x = this.xpos!;
      out.set(m[r],m[r+1],m[r+2],x[p],m[r+3],m[r+4],m[r+5],x[p+1],m[r+6],m[r+7],m[r+8],x[p+2],0,0,0,1);
    } else {
      const p = this.recorded!.offset(this.recordedFrame, g), a = this.recorded!.values;
      this.point.set(a[p],a[p+1],a[p+2]); this.current.set(a[p+4],a[p+5],a[p+6],a[p+3]);
      out.compose(this.point, this.current, ONE);
    }
  }
  private rotations(out: CharacterPose) {
    this.geomWorld(this.rootBinding.geom, this.matrix); this.matrix.multiply(this.rootBinding.inverse);
    this.deltaRoot.setFromRotationMatrix(this.matrix).multiply(this.rootBinding.reference).normalize();
    out.position.setFromMatrixPosition(this.matrix);
    out.quaternion.copy(this.deltaRoot).multiply(this.alignment);
    this.inverseRoot.copy(out.quaternion).invert();
    for (const node of this.poseNodes ?? this.nodes) {
      if (node.attachment) {
        node.rotationWorld.copy(this.nodes[node.attachment.parent].rotationWorld).multiply(node.attachment.rotation).normalize();
        if (node.parent < 0) this.parentInverse.identity();
        else this.parentInverse.copy(this.nodes[node.parent].rotationWorld).invert();
        out.bones[node.bone].copy(this.parentInverse).multiply(node.rotationWorld).normalize();
      } else if (node.bone >= 0 && node.binding) {
        const b = node.binding;
        this.geomWorld(b.geom, this.matrix); this.matrix.multiply(b.inverse);
        this.current.setFromRotationMatrix(this.matrix).multiply(b.reference);
        node.rotationWorld.copy(this.inverseRoot).multiply(this.current).multiply(node.calibrated).normalize();
        if (node.parent < 0) this.parentInverse.identity();
        else this.parentInverse.copy(this.nodes[node.parent].rotationWorld).invert();
        out.bones[node.bone].copy(this.parentInverse).multiply(node.rotationWorld).normalize();
      } else {
        if (node.bone >= 0) out.bones[node.bone].copy(node.rotation);
        node.rotationWorld.copy(node.rotation);
        if (node.parent >= 0) node.rotationWorld.premultiply(this.nodes[node.parent].rotationWorld);
      }
    }
  }
  private matrices(out: CharacterPose) {
    this.rootMatrix.compose(out.position, out.quaternion, this.fitScale);
    for (const node of this.poseNodes ?? this.nodes) {
      const position = node.bone >= 0 ? out.bonePositions?.[node.bone] : undefined;
      if (position && node.attachment) {
        this.matrix.copy(this.nodes[node.attachment.parent].world).multiply(node.attachment.bind);
        this.local.copy(node.parent < 0 ? this.rootMatrix : this.nodes[node.parent].world).invert().multiply(this.matrix);
        position.setFromMatrixPosition(this.local);
      } else if (position && node.pivot) {
        position.copy(node.pivot.parentPoint).sub(this.point.copy(node.pivot.scaled).applyQuaternion(out.bones[node.bone]));
      }
      this.local.compose(position ?? node.position, node.bone >= 0 ? out.bones[node.bone] : node.rotation, node.scale);
      node.world.copy(node.parent < 0 ? this.rootMatrix : this.nodes[node.parent].world).multiply(this.local);
    }
    for (const skin of this.skins) {
      for (let i = 0; i < skin.bones.length; i++) skin.matrices[i].copy(this.nodes[skin.bones[i]].world).multiply(skin.mesh.skeleton.boneInverses[i]);
      if (skin.mesh.bindMode === 'detached') skin.outer.copy(this.nodes[skin.node].world).multiply(skin.mesh.bindMatrixInverse);
      else skin.outer.identity();
    }
  }
  private skinSole() {
    let sole = Infinity;
    for (const skin of this.skins) for (const sample of skin.samples) {
      let x = 0, y = 0, z = 0; const p = sample.position;
      for (let k = 0; k < sample.joints.length; k++) {
        const e = skin.matrices[sample.joints[k]].elements, w = sample.weights[k];
        x += w*(e[0]*p.x+e[4]*p.y+e[8]*p.z+e[12]);
        y += w*(e[1]*p.x+e[5]*p.y+e[9]*p.z+e[13]);
        z += w*(e[2]*p.x+e[6]*p.y+e[10]*p.z+e[14]);
      }
      this.point.set(x,y,z).applyMatrix4(skin.outer);
      sole = Math.min(sole, this.point.dot(this.up));
    }
    for (const rigid of this.rigidSoles) for (let i = 0; i < rigid.positions.count; i++) {
      this.point.fromBufferAttribute(rigid.positions, i).applyMatrix4(this.nodes[rigid.node].world);
      sole = Math.min(sole, this.point.dot(this.up));
    }
    return sole;
  }
  private evaluate(out: CharacterPose) {
    this.rotations(out);
    this.point.copy(this.anchor).multiplyScalar(this.scale).applyQuaternion(out.quaternion);
    out.position.sub(this.point);
    this.matrices(out);
    // This is physics-up, not native glTF Y-up and not global gravity. Rigid tilts and flight survive.
    this.up.set(0,0,1).applyQuaternion(this.deltaRoot);
    const nativeSole = this.skinSole(); let targetSole = Infinity;
    for (const sole of this.soles) {
      this.geomWorld(sole.geom, this.matrix);
      if ('radius' in sole) {
        targetSole = Math.min(targetSole, this.point.setFromMatrixPosition(this.matrix).dot(this.up)-sole.radius);
      } else for (let i = 0; i < sole.vertices.length; i += 3)
        targetSole = Math.min(targetSole, this.point.fromArray(sole.vertices, i).applyMatrix4(this.matrix).dot(this.up));
    }
    out.position.addScaledVector(this.up, targetSole-nativeSole);
  }
  referencePose(out: CharacterPose) { this.mode = 'reference'; this.evaluate(out); }
  fromFrame(xpos: Float32Array, xmat: Float32Array, out: CharacterPose) {
    if (xpos.length < this.model.ngeom*3 || xmat.length < this.model.ngeom*9) throw new Error('Incomplete character geom frame.');
    this.mode = 'frame'; this.xpos = xpos; this.xmat = xmat; this.evaluate(out);
  }
  fromRecorded(geometry: GeometryTrack, frame: number, out: CharacterPose) {
    if (geometry.ngeom !== this.model.ngeom || !Number.isSafeInteger(frame) || frame < 0 || frame >= geometry.frames)
      throw new Error('Incomplete character recorded frame.');
    this.mode = 'recorded'; this.recorded = geometry; this.recordedFrame = frame; this.evaluate(out);
  }
}
