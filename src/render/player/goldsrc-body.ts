/** Third-person player body from a decoded GoldSrc (IDST v10) player model, animated the way the
 * Half-Life client animates players: an upper-body sequence chosen by the held weapon's extension
 * (ref_aim_/crouch_aim_/ref_shoot_…), a separate leg (gait) sequence chosen by activity from
 * speed and ducking whose frame advances with distance travelled, the torso twisted toward the
 * view through the four spine bone controllers, and the aim pitch as the sequence blend.
 * Behavioural reference: Half-Life SDK player.cpp SetAnimation and StudioModelRenderer gait/blend
 * code; independent implementation. Only the model's own authored sequences are played. */
import * as THREE from 'three';
import { decodeGoldSrcScene, type GoldSrcSource } from '../characters/goldsrc';
import type { PlayerAnimationLayer, PlayerPresentation, PlayerSimFrame, PlayerTool, SourceFrame } from '../../player/types';
import { INCH } from '../../player/source-frame';
import { angleDiff, DEG, HopTracker, placeBody, type PlayerBodyRig } from './body';
import type { MaterialLighter } from './studio-object';

/** Half-Life activity ids (activity.h) stored in each sequence. */
const ACT_WALK = 3, ACT_RUN = 4, ACT_HOP = 7, ACT_CROUCH = 17, ACT_CROUCHIDLE = 18;
/** Hull-centre origin above the feet: Half-Life standing (VEC_HULL_MIN z −36) and ducked (−18). */
const STAND_LIFT = 36, DUCK_LIFT = 18;
/** Half-Life runs the run gait above this horizontal speed (in/s). */
const RUN_GAIT_SPEED = 220;

/** Half-Life player weapon animation extensions for m0clip's tools. The physics gun holds like the
 * continuous-beam egon, the spawn tool like the one-handed pistol (GMod's tool gun holds as a
 * pistol), the knife like the crowbar melee weapon. No tool has no extension (look_idle). */
const EXTENSION: Record<PlayerTool, string> = { none: '', physgun: 'egon', spawn: 'onehanded', knife: 'crowbar' };

interface SequenceInfo {
  name: string; frames: number; fps: number; looping: boolean; blends: number;
  blendStart: number[]; blendEnd: number[]; linearMovement: number[]; clips: string[];
}
interface ControllerInfo { bone: number; type: number; start: number; end: number; rest: number; index: number }
type Interpolant = THREE.Interpolant & { evaluate(t: number): ArrayLike<number> };
interface Channels { position: (Interpolant | null)[]; quaternion: (Interpolant | null)[] }

export class GoldSrcPlayerBody implements PlayerBodyRig {
  readonly kind = 'goldsrc' as const;
  readonly object = new THREE.Group();
  readonly limitations: string[] = [
    'GoldSrc body: whole-body pitch beyond the aim blend range is not tilted; swim and death sequences are not driven.',
  ];
  readonly poseParameterNames = ['aim_blend', 'torso_yaw_deg'] as const;
  readonly pose = { sequence: 0, cycle: 0, poseParameters: new Float32Array(2), layers: [] as PlayerAnimationLayer[] };
  bodyYaw = 0;

  private readonly model: THREE.Group;
  private readonly bones: THREE.Bone[];
  private readonly sequences: SequenceInfo[];
  private readonly activity: Int32Array;
  private readonly weight: Int32Array;
  private readonly channels = new Map<string, Channels>();
  private readonly clips = new Map<string, THREE.AnimationClip>();
  /** 1 for "Bip01 Spine" and its descendants, which play the upper-body sequence. */
  private readonly upper: Uint8Array;
  private readonly torso: { bone: number; axis: number; rotation: boolean; start: number; end: number; loop: boolean; baked: number }[] = [];
  private readonly gaitLayer: PlayerAnimationLayer = { sequence: 0, cycle: 0, weight: 1 };
  private readonly withGait = [this.gaitLayer];
  private readonly noGait: PlayerAnimationLayer[] = [];
  private readonly hop = new HopTracker();
  private readonly materials = new Set<THREE.Material>();
  private readonly geometries = new Set<THREE.BufferGeometry>();
  private readonly euler = new THREE.Euler(0, 0, 0, 'ZYX');
  private readonly qb = new THREE.Quaternion();
  private gaitFrame = 0;
  private shooting = -1;
  private seed = 1;

  private constructor(readonly path: string, scene: THREE.Group, bytes: ArrayBuffer, light?: MaterialLighter) {
    // The decoder turns native Z-up to Y-up for glTF; the app is Z-up like GoldSrc, so undo only that.
    scene.rotation.set(0, 0, 0);
    this.model = scene;
    this.model.scale.setScalar(INCH);
    this.object.name = 'player_body';
    this.object.add(this.model);
    let skinned: THREE.SkinnedMesh | null = null;
    scene.traverse(o => {
      if (!(o instanceof THREE.Mesh)) return;
      if (o instanceof THREE.SkinnedMesh) skinned ??= o;
      o.castShadow = true; o.receiveShadow = true;
      this.geometries.add(o.geometry);
      for (const m of [o.material].flat()) { if (!this.materials.has(m)) { this.materials.add(m); light?.(m); } }
    });
    if (!skinned) throw new Error(`GoldSrc model ${path} has no skinned meshes.`);
    this.bones = (skinned as THREE.SkinnedMesh).skeleton.bones;
    const info = scene.userData.goldsrc as { sequences: SequenceInfo[]; controllers: ControllerInfo[] };
    this.sequences = info.sequences;
    for (const clip of scene.animations) this.clips.set(clip.name, clip);
    // Activity and weight are stored per sequence description (mstudioseqdesc_t +40/+44).
    const view = new DataView(bytes), seqIndex = view.getInt32(168, true);
    this.activity = new Int32Array(this.sequences.length);
    this.weight = new Int32Array(this.sequences.length);
    for (let s = 0; s < this.sequences.length; s++) {
      this.activity[s] = view.getInt32(seqIndex + s * 176 + 40, true);
      this.weight[s] = view.getInt32(seqIndex + s * 176 + 44, true);
    }
    // Half-Life copies the gait into the bones stored before "Bip01 Spine". That equals the
    // non-spine subtree only in the standard bone order, so select by hierarchy for every model.
    const spine = this.bones.find(b => b.userData.name === 'Bip01 Spine');
    this.upper = new Uint8Array(this.bones.length);
    if (spine) for (let i = 0; i < this.bones.length; i++) {
      for (let node: THREE.Object3D | null = this.bones[i]; node; node = node.parent) {
        if (node === spine) { this.upper[i] = 1; break; }
      }
    }
    for (const c of info.controllers) {
      if (c.index > 3) continue;
      const type = c.type & 0x7fff, rotation = type >= 8, loop = (c.type & 0x8000) !== 0;
      const axis = [1, 2, 4, 8, 16, 32].indexOf(type) % 3;
      let baked = loop ? c.start + c.rest * 360 / 256 : c.start + (c.end - c.start) * Math.min(1, c.rest / 255);
      if (rotation) baked *= DEG;
      this.torso.push({ bone: c.bone, axis, rotation, start: c.start, end: c.end, loop, baked });
    }
    if (this.lookupActivity(ACT_WALK) < 0 || this.lookupActivity(ACT_RUN) < 0 || this.lookupName('deep_idle') < 0)
      throw new Error(`GoldSrc model ${path} lacks the Half-Life player walk/run activities or deep_idle sequence.`);
  }

  static async load(id: string, source: GoldSrcSource, light?: MaterialLighter): Promise<GoldSrcPlayerBody> {
    const { scene } = await decodeGoldSrcScene(source);
    return new GoldSrcPlayerBody(id, scene, source.model, light);
  }

  /** Half-Life LookupActivity: weighted choice among sequences of an activity. */
  private lookupActivity(activity: number): number {
    let total = 0;
    for (let s = 0; s < this.activity.length; s++) if (this.activity[s] === activity) total += Math.max(1, this.weight[s]);
    if (!total) return -1;
    this.seed = (Math.imul(this.seed, 1664525) + 1013904223) >>> 0;
    let pick = (this.seed / 4294967296) * total;
    for (let s = 0; s < this.activity.length; s++) {
      if (this.activity[s] !== activity) continue;
      pick -= Math.max(1, this.weight[s]);
      if (pick < 0) return s;
    }
    return -1;
  }

  private lookupName(name: string): number {
    const wanted = name.toLowerCase();
    return this.sequences.findIndex(s => s.name.toLowerCase() === wanted);
  }

  private upperSequence(tool: PlayerTool, ducked: boolean, shoot: boolean): number {
    const ext = EXTENSION[tool];
    if (!ext) return 0;
    const s = this.lookupName(`${ducked ? 'crouch' : 'ref'}_${shoot ? 'shoot' : 'aim'}_${ext}`);
    return s < 0 ? 0 : s;
  }

  attack(tool: PlayerTool): void {
    if (tool === 'physgun' || !EXTENSION[tool]) return;
    this.shooting = this.upperSequence(tool, false, true);
    if (this.shooting === 0) this.shooting = -1;
  }

  advance(frame: PlayerSimFrame, dt: number): void {
    const pose = this.pose, v = frame.velocity, speed = Math.hypot(v[0], v[1]);
    const hopping = this.hop.update(frame);
    let upper: number;
    if (hopping) {
      if (this.activity[pose.sequence] !== ACT_HOP) upper = this.lookupActivity(ACT_HOP);
      else upper = pose.sequence;
      if (upper < 0) upper = this.upperSequence(frame.tool, frame.ducked, false);
    } else if (this.shooting >= 0) {
      upper = frame.ducked ? this.upperSequence(frame.tool, true, true) : this.shooting;
      if (upper === pose.sequence && pose.cycle >= 1) { this.shooting = -1; upper = this.upperSequence(frame.tool, frame.ducked, false); }
    } else upper = this.upperSequence(frame.tool, frame.ducked, frame.tool === 'physgun' && !!frame.grab);
    if (upper !== pose.sequence) { pose.sequence = upper; pose.cycle = 0; }
    else {
      const seq = this.sequences[upper], next = pose.cycle + seq.fps * dt / Math.max(1, seq.frames - 1);
      pose.cycle = seq.looping ? next - Math.floor(next) : Math.min(1, next);
    }
    const blend = this.sequences[pose.sequence];
    pose.poseParameters[0] = blend.blends === 2 && blend.blendEnd[0] - blend.blendStart[0] > 0.1
      ? Math.min(1, Math.max(0, (-frame.pitch - blend.blendStart[0]) / (blend.blendEnd[0] - blend.blendStart[0]))) : 0;

    if (hopping) {
      // SetAnimation clears the gait sequence for whole-body activities; the client then faces the
      // body along the view and centres the spine controllers.
      pose.layers = this.noGait;
      this.bodyYaw = frame.yaw;
      pose.poseParameters[1] = 0;
      return;
    }
    const gait = frame.ducked ? this.lookupActivityStable(speed > 0 ? ACT_CROUCH : ACT_CROUCHIDLE)
      : speed > RUN_GAIT_SPEED ? this.lookupActivityStable(ACT_RUN) : speed > 0 ? this.lookupActivityStable(ACT_WALK) : this.lookupName('deep_idle');
    let movement = speed * dt;
    if (speed === 0) {
      let diff = angleDiff(frame.yaw, this.bodyYaw);
      diff *= dt < 0.25 ? dt * 4 : dt;
      this.bodyYaw = angleDiff(this.bodyYaw + diff, 0);
    } else this.bodyYaw = Math.atan2(v[1], v[0]) / DEG;
    let torso = angleDiff(frame.yaw, this.bodyYaw);
    if (torso > 120) { this.bodyYaw -= 180; movement = -movement; torso -= 180; }
    else if (torso < -120) { this.bodyYaw += 180; movement = -movement; torso += 180; }
    this.bodyYaw = angleDiff(this.bodyYaw, 0);
    const gs = gait < 0 ? null : this.sequences[gait];
    if (!gs || gait === 0) { pose.layers = this.noGait; pose.poseParameters[1] = torso; return; }
    this.gaitFrame += gs.linearMovement[0] > 0 ? movement / gs.linearMovement[0] * gs.frames : gs.fps * dt;
    const span = Math.max(1, gs.frames - 1);
    this.gaitFrame -= Math.floor(this.gaitFrame / span) * span;
    this.gaitLayer.sequence = gait;
    this.gaitLayer.cycle = this.gaitFrame / span;
    pose.layers = this.withGait;
    pose.poseParameters[1] = torso;
  }

  /** Keeps the current gait choice while its activity is unchanged (no re-roll every frame). */
  private lookupActivityStable(activity: number): number {
    const current = this.gaitLayer.sequence;
    if (this.pose.layers === this.withGait && this.activity[current] === activity) return current;
    return this.lookupActivity(activity);
  }

  private channelsFor(sequence: number, blend: number): Channels {
    const seq = this.sequences[sequence];
    if (!seq) throw new Error(`GoldSrc model ${this.path} has no sequence ${sequence}.`);
    const name = seq.clips[Math.min(blend, seq.clips.length - 1)];
    let channels = this.channels.get(name);
    if (!channels) {
      const clip = this.clips.get(name);
      if (!clip) throw new Error(`GoldSrc model ${this.path} sequence ${seq.name} has no decoded clip.`);
      const byName = new Map(clip.tracks.map(track => [track.name, track]));
      // The decoder's tracks use linear interpolation; QuaternionKeyframeTrack's linear factory slerps.
      const make = (bone: THREE.Bone, property: string): Interpolant | null => byName.get(`${bone.name}.${property}`)?.InterpolantFactoryMethodLinear() ?? null;
      channels = { position: this.bones.map(b => make(b, 'position')), quaternion: this.bones.map(b => make(b, 'quaternion')) };
      this.channels.set(name, channels);
    }
    return channels;
  }

  private sampleBone(bone: number, sequence: number, cycle: number, blend: number, position: THREE.Vector3, quaternion: THREE.Quaternion) {
    const seq = this.sequences[sequence], t = Math.min(1, Math.max(0, cycle)) * Math.max(1, seq.frames - 1) / seq.fps;
    const a = this.channelsFor(sequence, 0);
    const pa = a.position[bone]?.evaluate(t), qa = a.quaternion[bone]?.evaluate(t);
    if (pa) position.set(pa[0], pa[1], pa[2]);
    if (qa) quaternion.set(qa[0], qa[1], qa[2], qa[3]);
    if (seq.blends < 2 || blend <= 0) return;
    const b = this.channelsFor(sequence, 1);
    const pb = b.position[bone]?.evaluate(t), qb = b.quaternion[bone]?.evaluate(t);
    if (pb) position.set(position.x + (pb[0] - position.x) * blend, position.y + (pb[1] - position.y) * blend, position.z + (pb[2] - position.z) * blend);
    if (qb) quaternion.slerp(this.qb.set(qb[0], qb[1], qb[2], qb[3]), blend);
  }

  apply(frame: PlayerSimFrame, presentation: PlayerPresentation, _clock: number, sourceFrame: SourceFrame): void {
    const body = presentation.body, blend = body.poseParameters[0] ?? 0, torso = body.poseParameters[1] ?? 0;
    const gait = body.layers.length ? body.layers[0] : null;
    if (gait && !this.sequences[gait.sequence]) throw new Error(`GoldSrc model ${this.path} has no gait sequence ${gait.sequence}.`);
    for (let i = 0; i < this.bones.length; i++) {
      const bone = this.bones[i];
      if (gait && !this.upper[i]) this.sampleBone(i, gait.sequence, gait.cycle, 0, bone.position, bone.quaternion);
      else this.sampleBone(i, body.sequence, body.cycle, blend, bone.position, bone.quaternion);
    }
    // Spine controllers: the client writes ((yaw / 4) + 30) / (60 / 255) with a gait, else 127.
    const byte = gait ? Math.min(255, Math.max(0, (torso / 4 + 30) / (60 / 255))) : 127;
    for (const c of this.torso) {
      let value = c.loop ? c.start + byte * 360 / 256 : c.start + (c.end - c.start) * byte / 255;
      if (c.rotation) value *= DEG;
      const delta = value - c.baked, bone = this.bones[c.bone];
      if (!delta || !bone) continue;
      if (!c.rotation) { bone.position.setComponent(c.axis, bone.position.getComponent(c.axis) + delta); continue; }
      this.euler.setFromQuaternion(bone.quaternion, 'ZYX');
      if (c.axis === 0) this.euler.x += delta; else if (c.axis === 1) this.euler.y += delta; else this.euler.z += delta;
      bone.quaternion.setFromEuler(this.euler);
    }
    placeBody(this.object, frame.origin, sourceFrame, presentation.bodyYaw, frame.ducked ? DUCK_LIFT : STAND_LIFT);
  }

  exportCopy() {
    const bones: THREE.Bone[] = [];
    const root = this.object.clone(false);
    const model = this.model.clone(false);
    root.add(model);
    const map = new Map<THREE.Object3D, THREE.Object3D>();
    const copy = (src: THREE.Object3D, dst: THREE.Object3D) => {
      for (const child of src.children) {
        let next: THREE.Object3D;
        if (child instanceof THREE.Bone) { next = child.clone(false); bones.push(next as THREE.Bone); }
        else if (child instanceof THREE.SkinnedMesh) next = new THREE.SkinnedMesh(child.geometry, child.material);
        else next = child.clone(false);
        next.name = child.name; next.visible = child.visible;
        map.set(child, next); dst.add(next); copy(child, next);
      }
    };
    copy(this.model, model);
    const sourceBones = bones.map(b => [...map].find(([, d]) => d === b)![0] as THREE.Bone);
    root.updateMatrixWorld(true);
    for (const [src, dst] of map) if (src instanceof THREE.SkinnedMesh && dst instanceof THREE.SkinnedMesh) {
      const skeleton = new THREE.Skeleton(src.skeleton.bones.map(b => map.get(b) as THREE.Bone), src.skeleton.boneInverses.map(m => m.clone()));
      dst.frustumCulled = false; dst.bind(skeleton, src.bindMatrix.clone());
    }
    return { root, bones, source: sourceBones };
  }

  reset(): void {
    this.hop.reset(); this.gaitFrame = 0; this.shooting = -1;
    this.pose.sequence = 0; this.pose.cycle = 0; this.pose.layers = this.noGait; this.pose.poseParameters.fill(0);
  }

  dispose(): void {
    this.object.removeFromParent();
    for (const g of this.geometries) g.dispose();
    for (const m of this.materials) {
      for (const value of Object.values(m)) if (value instanceof THREE.Texture) value.dispose();
      m.dispose();
    }
    this.geometries.clear(); this.materials.clear(); this.channels.clear();
  }
}
