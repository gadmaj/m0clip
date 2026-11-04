/** Third-person player body from a Source Studio player model in the person's own game files,
 * animated like Garry's Mod's base gamemode drives HL2MP-rigged player models: the main activity
 * from movement (ACT_HL2MP_IDLE / WALK / RUN / IDLE_CROUCH / WALK_CROUCH / JUMP, specialised by the
 * tool's hold type when the model has that variant), playback rate from speed over the
 * sequence's ground speed (capped at 2), move_x/move_y (or move_yaw) and aim pose parameters, and
 * the hold type's range-attack gesture as an overlay layer. Behavioural reference: GMod base
 * gamemode animations and Source CMultiPlayerAnimState; independent implementation. */
import * as THREE from 'three';
import { createStudioPose, encodeStudioPoseParameter, StudioPoseSampler, type StudioModelData, type StudioPose } from '../../player/studio';
import type { SourceMaterialLibrary } from '../../player/materials/library';
import type { PlayerAnimationLayer, PlayerPresentation, PlayerSimFrame, PlayerTool, SourceFrame } from '../../player/types';
import { INCH } from '../../player/source-frame';
import { angleDiff, DEG, HopTracker, placeBody, type PlayerBodyRig } from './body';
import { advanceCycle, hasActivity, poseParameterIndex, restControllers, restPoseParameters, SeededRandom, selectWeightedSequence } from './studio-anim';
import { StudioObject, type MaterialLighter } from './studio-object';

/** GMod SWEP hold types: physics gun "physgun", tool gun "pistol", knife "knife"; no tool "normal"
 * (which uses the base HL2MP activities). */
const HOLD: Record<PlayerTool, string> = { none: '', physgun: 'PHYSGUN', spawn: 'PISTOL', knife: 'KNIFE' };
/** GMod base gamemode CalcMainActivity speed thresholds (in/s). */
const RUN_SPEED = 150, WALK_SPEED = 0.5;
/** Idle feet turn once the view leaves this yaw window (CMultiPlayerAnimState max body yaw). */
const MAX_BODY_YAW = 45;

type Base = 'IDLE' | 'WALK' | 'RUN' | 'IDLE_CROUCH' | 'WALK_CROUCH' | 'JUMP';
const MP_FALLBACK: Record<Base, string> = {
  IDLE: 'ACT_MP_STAND_IDLE', WALK: 'ACT_MP_WALK', RUN: 'ACT_MP_RUN', IDLE_CROUCH: 'ACT_MP_CROUCH_IDLE', WALK_CROUCH: 'ACT_MP_CROUCHWALK', JUMP: 'ACT_MP_JUMP',
};

function activities(base: Base, hold: string): string[] {
  return [...(hold ? [`ACT_HL2MP_${base}_${hold}`] : []), `ACT_HL2MP_${base}`, MP_FALLBACK[base]];
}

/** True when the model has the activities this body needs to stand, walk and run. */
export function isPlayerBodyModel(model: StudioModelData): boolean {
  return (['IDLE', 'WALK', 'RUN'] as const).every(base => hasActivity(model, activities(base, '')));
}

export class StudioPlayerBody implements PlayerBodyRig {
  readonly kind = 'studio' as const;
  readonly object = new THREE.Group();
  readonly limitations: string[];
  readonly poseParameterNames: readonly string[];
  readonly pose: { sequence: number; cycle: number; poseParameters: Float32Array; layers: PlayerAnimationLayer[] };
  bodyYaw = 0;

  private readonly sampler: StudioPoseSampler;
  private readonly sampled: StudioPose;
  private readonly controllers: Float32Array;
  private readonly rest: Float32Array;
  private readonly hop = new HopTracker();
  private readonly random = new SeededRandom(0x5eed);
  private readonly gesture: PlayerAnimationLayer = { sequence: 0, cycle: 0, weight: 1 };
  private readonly withGesture = [this.gesture];
  private readonly noLayers: PlayerAnimationLayer[] = [];
  private readonly params: Record<'moveX' | 'moveY' | 'moveYaw' | 'aimYaw' | 'aimPitch' | 'bodyYaw' | 'bodyPitch', number>;
  private base: Base | null = null;
  private hold: string | null = null;

  private constructor(readonly path: string, readonly model: StudioModelData, private readonly studio: StudioObject) {
    if (!isPlayerBodyModel(model)) throw new Error(`${path} has no HL2MP/GMod player idle, walk and run activities.`);
    this.object.name = 'player_body';
    studio.root.scale.setScalar(INCH);
    this.object.add(studio.root);
    for (const mesh of studio.meshes) { mesh.castShadow = true; mesh.receiveShadow = true; }
    this.sampler = new StudioPoseSampler(model);
    this.sampled = createStudioPose(model);
    this.controllers = restControllers(model);
    this.rest = restPoseParameters(model);
    this.pose = { sequence: -1, cycle: 0, poseParameters: this.rest.slice(), layers: this.noLayers };
    this.poseParameterNames = model.poseParameters.map(p => `${p.name} (encoded)`);
    this.params = {
      moveX: poseParameterIndex(model, 'move_x'), moveY: poseParameterIndex(model, 'move_y'), moveYaw: poseParameterIndex(model, 'move_yaw'),
      aimYaw: poseParameterIndex(model, 'aim_yaw'), aimPitch: poseParameterIndex(model, 'aim_pitch'),
      bodyYaw: poseParameterIndex(model, 'body_yaw'), bodyPitch: poseParameterIndex(model, 'body_pitch'),
    };
    this.limitations = [...studio.limitations];
    if (model.ikChainCount) this.limitations.push('Authored foot IK is not solved; feet follow the sampled sequences.');
  }

  static async load(path: string, model: StudioModelData, library: SourceMaterialLibrary, light?: MaterialLighter, signal?: AbortSignal): Promise<StudioPlayerBody> {
    const studio = await StudioObject.create(model, library, { light, signal });
    try { return new StudioPlayerBody(path, model, studio); } catch (error) { studio.dispose(); throw error; }
  }

  attack(tool: PlayerTool): void {
    const hold = HOLD[tool], model = this.model;
    const seq = selectWeightedSequence(model, hold ? [`ACT_HL2MP_GESTURE_RANGE_ATTACK_${hold}`] : [], this.random);
    if (seq < 0) return;
    this.gesture.sequence = seq; this.gesture.cycle = 0; this.gesture.weight = 1;
    this.pose.layers = this.withGesture;
  }

  private groundSpeed(sequence: number): number {
    const seq = this.model.sequences[sequence], anim = this.model.animations[seq.animations[0]];
    const last = anim?.movements[anim.movements.length - 1];
    if (!last || anim.frameCount < 2 || !anim.fps) return 0;
    return Math.hypot(last.position[0], last.position[1]) / ((anim.frameCount - 1) / anim.fps);
  }

  private set(index: number, value: number) {
    if (index >= 0) this.pose.poseParameters[index] = encodeStudioPoseParameter(this.model, index, value);
  }

  advance(frame: PlayerSimFrame, dt: number): void {
    const pose = this.pose, model = this.model, v = frame.velocity, speed = Math.hypot(v[0], v[1]);
    const hopping = this.hop.update(frame), hold = HOLD[frame.tool];
    const base: Base = hopping ? 'JUMP' : frame.ducked ? (speed > WALK_SPEED ? 'WALK_CROUCH' : 'IDLE_CROUCH')
      : speed > RUN_SPEED ? 'RUN' : speed > WALK_SPEED ? 'WALK' : 'IDLE';
    if (base !== this.base || hold !== this.hold || pose.sequence < 0) {
      let seq = selectWeightedSequence(model, activities(base, hold), this.random);
      if (seq < 0) seq = selectWeightedSequence(model, activities(frame.ducked ? 'IDLE_CROUCH' : 'IDLE', hold), this.random);
      if (seq < 0) seq = selectWeightedSequence(model, activities('IDLE', ''), this.random);
      this.base = base; this.hold = hold;
      if (seq !== pose.sequence) { pose.sequence = seq; pose.cycle = 0; }
    }
    // Feet follow the view while moving; idle they turn only past the body-yaw window.
    if (speed > WALK_SPEED) this.bodyYaw = frame.yaw;
    else {
      const d = angleDiff(frame.yaw, this.bodyYaw);
      if (d > MAX_BODY_YAW) this.bodyYaw = frame.yaw - MAX_BODY_YAW;
      else if (d < -MAX_BODY_YAW) this.bodyYaw = frame.yaw + MAX_BODY_YAW;
    }
    this.bodyYaw = angleDiff(this.bodyYaw, 0);
    const ground = this.groundSpeed(pose.sequence);
    const yaw = this.bodyYaw * DEG, fwd = v[0] * Math.cos(yaw) + v[1] * Math.sin(yaw), left = -v[0] * Math.sin(yaw) + v[1] * Math.cos(yaw);
    const reference = ground > 0 ? ground : Math.max(speed, 1);
    this.set(this.params.moveX, Math.max(-1, Math.min(1, fwd / reference)));
    this.set(this.params.moveY, Math.max(-1, Math.min(1, -left / reference)));
    if (speed > WALK_SPEED) this.set(this.params.moveYaw, Math.atan2(left, fwd) / DEG);
    const look = angleDiff(frame.yaw, this.bodyYaw);
    this.set(this.params.aimYaw, look); this.set(this.params.bodyYaw, look);
    this.set(this.params.aimPitch, frame.pitch); this.set(this.params.bodyPitch, frame.pitch);
    const rate = speed > 0.2 && ground > 0 ? Math.min(speed / ground, 2) : 1;
    pose.cycle = advanceCycle(model, pose.sequence, pose.cycle, pose.poseParameters, rate, dt);
    if (pose.layers === this.withGesture) {
      this.gesture.cycle = advanceCycle(model, this.gesture.sequence, this.gesture.cycle, pose.poseParameters, 1, dt);
      if (this.gesture.cycle >= 1) pose.layers = this.noLayers;
    }
  }

  apply(frame: PlayerSimFrame, presentation: PlayerPresentation, clock: number, sourceFrame: SourceFrame): void {
    const body = presentation.body;
    if (!this.model.sequences[body.sequence]) throw new Error(`${this.path} has no sequence ${body.sequence}.`);
    if (body.poseParameters.length !== this.model.poseParameters.length)
      throw new Error(`${this.path} has ${this.model.poseParameters.length} pose parameters; the presentation has ${body.poseParameters.length}.`);
    this.sampler.sample({ sequence: body.sequence, cycle: body.cycle, poseParameters: body.poseParameters, time: Math.max(0, clock),
      layers: body.layers, controllers: this.controllers }, this.sampled);
    this.studio.setPose(this.sampled);
    placeBody(this.object, frame.origin, sourceFrame, presentation.bodyYaw, 0);
  }

  /** Local game files are never re-exported; the exporter keeps the placement only. */
  exportCopy() { return null; }

  reset(): void {
    this.hop.reset(); this.base = null; this.hold = null;
    this.pose.sequence = -1; this.pose.cycle = 0; this.pose.poseParameters.set(this.rest); this.pose.layers = this.noLayers;
  }

  dispose(): void { this.object.removeFromParent(); this.studio.dispose(); }
}
