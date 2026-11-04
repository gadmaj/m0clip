/** First-person view models from the person's own game files: the weapon model (and, for c_
 * models, the separate arms model bonemerged onto it by bone name, as Source's EF_BONEMERGE does)
 * animated by activity like CBaseCombatWeapon::SendWeaponAnim: draw on equip, idle when an
 * animation finishes, attack/inspect on request. Nothing is drawn for a tool without a real view
 * model. Behavioural reference: Source SDK basecombatweapon_shared.cpp / bone_merge_cache.cpp;
 * independent implementation. */
import * as THREE from 'three';
import { createStudioPose, StudioPoseSampler, type StudioModelData, type StudioPose } from '../../player/studio';
import type { SourceMaterialLibrary } from '../../player/materials/library';
import type { PlayerAnimationLayer, PlayerAnimationPose } from '../../player/types';
import { advanceCycle, hasActivity, restControllers, restPoseParameters, SeededRandom, selectWeightedSequence, sequenceLoops } from './studio-anim';
import { StudioObject, type MaterialLighter } from './studio-object';

/** Render layer of view-model meshes: only the view-model pass camera sees it, so the world pass,
 * the flashlight depth pass, shadow casting and picking all exclude them. */
export const PLAYER_VIEWMODEL_LAYER = 30;

export type ViewModelAction = 'draw' | 'attack' | 'attackHit' | 'attack2' | 'inspect';

/** Activities tried in order. The inspect activities are the ones Source games use for weapon
 * inspection/fidget; which one a model carries is read from the model. */
const ACTIVITIES: Record<ViewModelAction | 'idle', readonly string[]> = {
  draw: ['ACT_VM_DRAW', 'ACT_VM_DEPLOY'],
  idle: ['ACT_VM_IDLE'],
  attack: ['ACT_VM_PRIMARYATTACK', 'ACT_VM_MISSCENTER', 'ACT_VM_HITCENTER'],
  attackHit: ['ACT_VM_HITCENTER', 'ACT_VM_PRIMARYATTACK', 'ACT_VM_MISSCENTER'],
  attack2: ['ACT_VM_SECONDARYATTACK', 'ACT_VM_SWINGHARD', 'ACT_VM_MISSCENTER2', 'ACT_VM_HITCENTER2'],
  inspect: ['ACT_VM_IDLE_LOWERED', 'ACT_VM_FIDGET'],
};

export function isViewModel(model: StudioModelData): boolean {
  return hasActivity(model, ACTIVITIES.idle) && hasActivity(model, ACTIVITIES.draw);
}

export class ViewModelRig {
  /** Camera-relative node; its matrix is set by the view-model pass. */
  readonly object = new THREE.Group();
  readonly pose: { sequence: number; cycle: number; poseParameters: Float32Array; layers: PlayerAnimationLayer[] };
  readonly limitations: string[];
  private readonly sampler: StudioPoseSampler;
  private readonly sampled: StudioPose;
  private readonly controllers: Float32Array;
  private readonly random = new SeededRandom(0x7e41);
  private readonly rel: THREE.Matrix4[];
  private readonly handRel: THREE.Matrix4[];
  private readonly match: Int32Array;
  private readonly local = new THREE.Matrix4();
  private readonly inverse = new THREE.Matrix4();
  private readonly one = new THREE.Vector3(1, 1, 1);
  private readonly scaleTmp = new THREE.Vector3();

  private constructor(readonly path: string, readonly model: StudioModelData, private readonly studio: StudioObject,
                      private readonly hands: StudioObject | null) {
    if (!isViewModel(model)) throw new Error(`${path} has no ACT_VM_DRAW and ACT_VM_IDLE sequences, so it isn't a view model.`);
    this.object.name = 'player_viewmodel';
    this.object.matrixAutoUpdate = false;
    this.object.add(studio.root);
    if (hands) this.object.add(hands.root);
    for (const mesh of [...studio.meshes, ...(hands?.meshes ?? [])]) { mesh.castShadow = false; mesh.receiveShadow = false; }
    this.object.traverse(o => o.layers.set(PLAYER_VIEWMODEL_LAYER));
    this.sampler = new StudioPoseSampler(model);
    this.sampled = createStudioPose(model);
    this.controllers = restControllers(model);
    this.pose = { sequence: -1, cycle: 0, poseParameters: restPoseParameters(model), layers: [] };
    const parents = model.skeleton.parent;
    for (let i = 0; i < parents.length; i++) if (parents[i] >= i) throw new Error(`${path}: bone ${i} precedes its parent.`);
    this.rel = model.skeleton.names.map(() => new THREE.Matrix4());
    this.match = new Int32Array(hands ? hands.bones.length : 0).fill(-1);
    this.handRel = hands ? hands.bones.map(() => new THREE.Matrix4()) : [];
    if (hands) {
      const hp = hands.model.skeleton.parent;
      for (let i = 0; i < hp.length; i++) if (hp[i] >= i) throw new Error(`${hands.model.path}: bone ${i} precedes its parent.`);
      let merged = 0;
      hands.bones.forEach((bone, i) => { this.match[i] = studio.boneIndex(bone.name); if (this.match[i] >= 0) merged++; });
      if (!merged) throw new Error(`${hands.model.path} shares no bones with ${path}; it can't be bonemerged.`);
    }
    this.limitations = [...studio.limitations, ...(hands?.limitations ?? [])];
    this.start('draw');
  }

  static async load(path: string, model: StudioModelData, library: SourceMaterialLibrary, hands: StudioModelData | null,
                    light?: MaterialLighter, signal?: AbortSignal): Promise<ViewModelRig> {
    const studio = await StudioObject.create(model, library, { light, signal });
    let arms: StudioObject | null = null;
    try {
      arms = hands ? await StudioObject.create(hands, library, { light, signal }) : null;
      return new ViewModelRig(path, model, studio, arms);
    } catch (error) {
      studio.dispose(); arms?.dispose();
      throw error;
    }
  }

  /** SendWeaponAnim: plays the action's activity; false when the model has none. */
  start(action: ViewModelAction | 'idle'): boolean {
    const seq = selectWeightedSequence(this.model, ACTIVITIES[action], this.random);
    if (seq < 0) return false;
    this.pose.sequence = seq;
    this.pose.cycle = 0;
    return true;
  }

  /** Advances the live animation; a finished non-looping animation returns to idle. */
  advance(dt: number): void {
    const pose = this.pose;
    if (pose.sequence < 0) { this.start('idle'); return; }
    pose.cycle = advanceCycle(this.model, pose.sequence, pose.cycle, pose.poseParameters, 1, dt);
    if (pose.cycle >= 1 && !sequenceLoops(this.model, pose.sequence)) this.start('idle');
  }

  /** Poses the view model (and bonemerged arms) from a presentation pose. Pure. */
  apply(pose: PlayerAnimationPose, clock: number): void {
    if (!this.model.sequences[pose.sequence]) throw new Error(`${this.path} has no sequence ${pose.sequence}.`);
    if (pose.poseParameters.length !== this.model.poseParameters.length)
      throw new Error(`${this.path} has ${this.model.poseParameters.length} pose parameters; the presentation has ${pose.poseParameters.length}.`);
    this.sampler.sample({ sequence: pose.sequence, cycle: pose.cycle, poseParameters: pose.poseParameters, time: Math.max(0, clock),
      layers: pose.layers, controllers: this.controllers }, this.sampled);
    this.studio.setPose(this.sampled);
    const hands = this.hands;
    if (!hands) return;
    const parents = this.model.skeleton.parent, bones = this.studio.bones;
    for (let i = 0; i < bones.length; i++) {
      this.local.compose(bones[i].position, bones[i].quaternion, this.one);
      if (parents[i] >= 0) this.rel[i].multiplyMatrices(this.rel[parents[i]], this.local); else this.rel[i].copy(this.local);
    }
    const hp = hands.model.skeleton.parent, hb = hands.bones, s = hands.model.skeleton;
    for (let i = 0; i < hb.length; i++) {
      const p = hp[i];
      if (this.match[i] >= 0) this.handRel[i].copy(this.rel[this.match[i]]);
      else {
        hb[i].position.fromArray(s.position, i * 3); hb[i].quaternion.fromArray(s.quaternion, i * 4);
        this.local.compose(hb[i].position, hb[i].quaternion, this.one);
        if (p >= 0) this.handRel[i].multiplyMatrices(this.handRel[p], this.local); else this.handRel[i].copy(this.local);
        continue;
      }
      if (p >= 0) this.local.multiplyMatrices(this.inverse.copy(this.handRel[p]).invert(), this.handRel[i]); else this.local.copy(this.handRel[i]);
      this.local.decompose(hb[i].position, hb[i].quaternion, this.scaleTmp);
    }
  }

  dispose(): void {
    this.object.removeFromParent();
    this.studio.dispose();
    this.hands?.dispose();
  }
}
