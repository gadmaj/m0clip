/** Local-space pose sampling with Source bone-setup semantics: sequence cycle handling
 * (looping, realtime, cycle pose), 2D pose-parameter blend grids with explicit pose keys and
 * all-zero cells, delta/post sequences, autolayers (spline, cross-fade, no-blend, pose-driven),
 * overlay layers, autoplay sequences, bone controllers and axis/quaternion-interpolated procedural
 * bones. IK rules and locks are not solved; their count is reported in StudioPose.unsolvedIk.
 * Sampling allocates nothing after the sampler is constructed. */
import { trackPosition, trackQuaternion } from './animation';
import { StudioUnsupportedError } from './binary';
import {
  BONE_FIXED_ALIGNMENT, STUDIO_AL_LOCAL, STUDIO_AL_NOBLEND, STUDIO_AL_POSE, STUDIO_AL_SPLINE, STUDIO_AL_XFADE, STUDIO_ALLZEROS,
  STUDIO_CYCLEPOSE, STUDIO_DELTA, STUDIO_LOOPING, STUDIO_POST, STUDIO_REALTIME, STUDIO_TYPES, STUDIO_X, STUDIO_XR, STUDIO_Y,
  STUDIO_YR, STUDIO_Z, STUDIO_ZR,
} from './mdl';
import { studioRuntime, type SeqRuntime, type StudioRuntime } from './model';
import {
  quatBlend, quatFromRadianEuler, quatIdentityBlend, quatMultiplyScaled, quatNormalize, quatScaleMultiply, quatSlerp,
} from './quat';
import type { StudioModelData, StudioPose, StudioPoseRequest, StudioSequence } from './types';

export function createStudioPose(model: StudioModelData): StudioPose {
  const n = model.skeleton.count;
  return { boneCount: n, position: new Float32Array(n*3), quaternion: new Float32Array(n*4), unsolvedIk: 0 };
}

/** Source Studio_SetPoseParameter: authored value (degrees, units) to the encoded 0..1 value the
 * sampler takes. Looping parameters wrap first. */
export function encodeStudioPoseParameter(model: StudioModelData, index: number, value: number): number {
  const p = model.poseParameters[index];
  if (!p) throw new RangeError(`Studio model ${model.path} has no pose parameter ${index}.`);
  if (p.loop) {
    const wrap = (p.start + p.end)/2 + p.loop/2, shift = p.loop - wrap;
    value -= p.loop*Math.floor((value + shift)/p.loop);
  }
  const encoded = (value - p.start)/(p.end - p.start);
  return encoded < 0 ? 0 : encoded > 1 ? 1 : encoded;
}

let poseSetting = 0, poseIndex = 0;

/** Source Studio_LocalPoseParameter for blend axis `axis` into poseSetting / poseIndex. */
function localPose(model: StudioModelData, seq: StudioSequence, axis: 0 | 1, pose: Float32Array): void {
  const iPose = seq.blendPose[axis], size = seq.groupSize[axis];
  poseSetting = 0;
  poseIndex = 0;
  if (iPose < 0 || size < 2) return;
  const p = model.poseParameters[iPose];
  let value = pose[iPose];
  if (p.loop) {
    const wrap = (p.start + p.end)/2 + p.loop/2, shift = p.loop - wrap;
    value -= p.loop*Math.floor((value + shift)/p.loop);
  }
  let s: number, index = 0;
  const keys = seq.poseKeys;
  if (!keys) {
    const localStart = (seq.paramStart[axis] - p.start)/(p.end - p.start), localEnd = (seq.paramEnd[axis] - p.start)/(p.end - p.start);
    s = (value - localStart)/(localEnd - localStart);
    s = s < 0 ? 0 : s > 1 ? 1 : s;
    if (size > 2) {
      index = Math.floor(s*(size - 1));
      if (index === size - 1) index = size - 2;
      s = s*(size - 1) - index;
    }
  } else {
    value = value*(p.end - p.start) + p.start;
    const base = axis*seq.groupSize[0];
    for (;;) {
      s = (value - keys[base + index])/(keys[base + index + 1] - keys[base + index]);
      if (index < size - 2 && s > 1) { index++; continue; }
      break;
    }
    s = s < 0 ? 0 : s > 1 ? 1 : s;
  }
  poseSetting = s;
  poseIndex = index;
}

function cellAnimation(seq: StudioSequence, x: number, y: number): number {
  const gx = seq.groupSize[0], gy = seq.groupSize[1];
  return seq.animations[Math.min(y, gy - 1)*gx + Math.min(x, gx - 1)];
}

/** Source Studio_CPS: cycles per second of a sequence at the given encoded pose parameters. */
export function studioSequenceCps(model: StudioModelData, sequence: number, pose: Float32Array): number {
  return sequenceRate(model, model.sequences[sequence], pose, true);
}

/** Source Studio_Duration in seconds. */
export function studioSequenceDuration(model: StudioModelData, sequence: number, pose: Float32Array): number {
  return sequenceRate(model, model.sequences[sequence], pose, false);
}

function sequenceRate(model: StudioModelData, seq: StudioSequence, pose: Float32Array, cps: boolean): number {
  localPose(model, seq, 0, pose);
  const s0 = poseSetting, i0 = poseIndex;
  localPose(model, seq, 1, pose);
  const s1 = poseSetting, i1 = poseIndex;
  let total = 0;
  for (let c = 0; c < 4; c++) {
    const dx = c & 1, dy = c >> 1;
    const weight = (dx ? s0 : 1 - s0)*(dy ? s1 : 1 - s1);
    if (weight <= 0) continue;
    const anim = model.animations[cellAnimation(seq, i0 + dx, i1 + dy)];
    if (cps) { if (anim.frameCount > 1) total += anim.fps/(anim.frameCount - 1)*weight; }
    else if (anim.fps !== 0) total += (anim.frameCount - 1)/anim.fps*weight;
  }
  return total;
}

function cellAllZeros(model: StudioModelData, seq: StudioSequence, x: number, y: number): boolean {
  return (model.animations[cellAnimation(seq, x, y)].flags & STUDIO_ALLZEROS) !== 0;
}

/** Allocated once per model; holds the scratch poses bone setup needs. */
export class StudioPoseSampler {
  private readonly runtime: StudioRuntime;
  private readonly n: number;
  private readonly positions: Float32Array[] = [];
  private readonly quaternions: Float32Array[] = [];
  private depth = 0;
  private time = 0;
  private ik = 0;
  private readonly euler = new Float64Array(4);

  constructor(readonly model: StudioModelData) {
    this.runtime = studioRuntime(model);
    this.n = model.skeleton.count;
    // Each nested AccumulatePose holds one scratch pose; CalcPoseSingle needs two more.
    const levels = this.runtime.layerDepth + 4;
    for (let i = 0; i < levels + 2; i++) {
      this.positions.push(new Float32Array(this.n*3));
      this.quaternions.push(new Float32Array(this.n*4));
    }
  }

  /** InitPose, CalcPose(main), overlay AccumulatePose layers, autoplay sequences, bone
   * controllers, then procedural bones. */
  sample(request: StudioPoseRequest, out: StudioPose): void {
    const model = this.model, n = this.n, skeleton = model.skeleton;
    if (out.boneCount !== n) throw new RangeError(`Studio pose has ${out.boneCount} bones; ${model.path} has ${n}.`);
    if (request.poseParameters.length !== model.poseParameters.length)
      throw new RangeError(`Studio model ${model.path} has ${model.poseParameters.length} pose parameters; ${request.poseParameters.length} were given.`);
    if (!(request.time >= 0) || !Number.isFinite(request.time)) throw new RangeError(`Studio sample time ${request.time} must be finite and non-negative.`);
    if (model.boneControllers.length && !request.controllers)
      throw new RangeError(`Studio model ${model.path} has bone controllers; pass their encoded inputs.`);
    const pos = out.position, q = out.quaternion;
    pos.set(skeleton.position);
    q.set(skeleton.quaternion);
    this.time = request.time;
    this.ik = 0;
    this.depth = 0;
    const pose = request.poseParameters;
    this.calcPoseSingle(pos, q, request.sequence, request.cycle, pose);
    // Source passes the caller's cycle (not the wrapped or realtime one) to autolayers.
    this.addLayers(pos, q, request.sequence, request.cycle, pose, 1);
    const layers = request.layers;
    if (layers) for (let i = 0; i < layers.length; i++) this.accumulate(pos, q, layers[i].sequence, layers[i].cycle, pose, layers[i].weight);
    if (this.runtime.autoplay.length) {
      this.ik += model.ikAutoplayLockCount;
      for (let i = 0; i < this.runtime.autoplay.length; i++) {
        const s = this.runtime.autoplay[i];
        let cycle = request.time*studioSequenceCps(model, s, pose);
        cycle -= Math.trunc(cycle);
        this.accumulate(pos, q, s, cycle, pose, 1);
      }
    }
    if (request.controllers) this.controllers(pos, q, request.controllers);
    this.procedural(pos, q);
    out.unsolvedIk = this.ik;
  }

  private seq(index: number): SeqRuntime {
    const seq = this.runtime.seqs[index];
    if (!seq) throw new RangeError(`Studio model ${this.model.path} has no sequence ${index}.`);
    if (seq.data.unsupported) throw new StudioUnsupportedError(this.model.path, seq.data.unsupported);
    return seq;
  }

  private calcPoseSingle(pos: Float32Array, q: Float32Array, index: number, cycle: number, pose: Float32Array): boolean {
    const model = this.model, seqRt = this.seq(index), seq = seqRt.data;
    if (!Number.isFinite(cycle)) throw new RangeError(`Studio cycle ${cycle} for ${seq.label} is not finite.`);
    this.ik += seq.ikRuleCount + seq.ikLockCount;
    localPose(model, seq, 0, pose);
    const s0 = poseSetting, i0 = poseIndex;
    localPose(model, seq, 1, pose);
    const s1 = poseSetting, i1 = poseIndex;
    if (seq.flags & STUDIO_REALTIME) {
      cycle = this.time*studioSequenceCps(model, index, pose);
      cycle -= Math.trunc(cycle);
    } else if (seq.flags & STUDIO_CYCLEPOSE) {
      cycle = seq.cyclePose >= 0 ? pose[seq.cyclePose] : 0;
    } else if (cycle < 0 || cycle >= 1) {
      if (seq.flags & STUDIO_LOOPING) {
        cycle -= Math.trunc(cycle);
        if (cycle < 0) cycle += 1;
      } else cycle = cycle < 0 ? 0 : 1;
    }
    const d = this.depth;
    if (d + 2 > this.positions.length) throw new RangeError(`Studio layers of ${seq.label} nest deeper than the sampler was built for.`);
    const pos2 = this.positions[d], q2 = this.quaternions[d], pos3 = this.positions[d + 1], q3 = this.quaternions[d + 1];
    this.depth = d + 2;
    let result = true;
    if (s0 < 0.001) {
      if (s1 < 0.001) {
        if (cellAllZeros(model, seq, i0, i1)) result = false;
        else this.calcAnimation(pos, q, seqRt, cellAnimation(seq, i0, i1), cycle);
      } else if (s1 > 0.999) {
        this.calcAnimation(pos, q, seqRt, cellAnimation(seq, i0, i1 + 1), cycle);
      } else {
        this.calcAnimation(pos, q, seqRt, cellAnimation(seq, i0, i1), cycle);
        this.calcAnimation(pos2, q2, seqRt, cellAnimation(seq, i0, i1 + 1), cycle);
        this.blend(q, pos, seq, q2, pos2, s1);
      }
    } else if (s0 > 0.999) {
      if (s1 < 0.001) {
        if (cellAllZeros(model, seq, i0 + 1, i1)) result = false;
        else this.calcAnimation(pos, q, seqRt, cellAnimation(seq, i0 + 1, i1), cycle);
      } else if (s1 > 0.999) {
        this.calcAnimation(pos, q, seqRt, cellAnimation(seq, i0 + 1, i1 + 1), cycle);
      } else {
        this.calcAnimation(pos, q, seqRt, cellAnimation(seq, i0 + 1, i1), cycle);
        this.calcAnimation(pos2, q2, seqRt, cellAnimation(seq, i0 + 1, i1 + 1), cycle);
        this.blend(q, pos, seq, q2, pos2, s1);
      }
    } else if (s1 < 0.001) {
      if (cellAllZeros(model, seq, i0 + 1, i1)) {
        this.calcAnimation(pos, q, seqRt, cellAnimation(seq, i0, i1), cycle);
        this.scale(q, pos, seq, 1 - s0);
      } else if (cellAllZeros(model, seq, i0, i1)) {
        this.calcAnimation(pos, q, seqRt, cellAnimation(seq, i0 + 1, i1), cycle);
        this.scale(q, pos, seq, s0);
      } else {
        this.calcAnimation(pos, q, seqRt, cellAnimation(seq, i0, i1), cycle);
        this.calcAnimation(pos2, q2, seqRt, cellAnimation(seq, i0 + 1, i1), cycle);
        this.blend(q, pos, seq, q2, pos2, s0);
      }
    } else if (s1 > 0.999) {
      this.calcAnimation(pos, q, seqRt, cellAnimation(seq, i0, i1 + 1), cycle);
      this.calcAnimation(pos2, q2, seqRt, cellAnimation(seq, i0 + 1, i1 + 1), cycle);
      this.blend(q, pos, seq, q2, pos2, s0);
    } else {
      this.calcAnimation(pos, q, seqRt, cellAnimation(seq, i0, i1), cycle);
      this.calcAnimation(pos2, q2, seqRt, cellAnimation(seq, i0 + 1, i1), cycle);
      this.blend(q, pos, seq, q2, pos2, s0);
      this.calcAnimation(pos2, q2, seqRt, cellAnimation(seq, i0, i1 + 1), cycle);
      this.calcAnimation(pos3, q3, seqRt, cellAnimation(seq, i0 + 1, i1 + 1), cycle);
      this.blend(q2, pos2, seq, q3, pos3, s0);
      this.blend(q, pos, seq, q2, pos2, s1);
    }
    this.depth = d;
    return result;
  }

  /** Source CalcVirtualAnimation: weighted bones start from the sequence model's rest (or
   * identity for delta animations), then each authored track overwrites its bone. */
  private calcAnimation(pos: Float32Array, q: Float32Array, seqRt: SeqRuntime, animIndex: number, cycle: number): void {
    const anim = this.runtime.anims[animIndex], desc = anim.desc;
    const weights = seqRt.data.boneWeight, seqGroup = seqRt.group, rest = seqGroup.bones, map = seqGroup.boneMap;
    const nf = desc.frameCount, sf = desc.sectionFrames;
    const fFrame = cycle*(nf - 1);
    const frame = Math.floor(fFrame), s = fFrame - frame;
    let local = frame, section = 0;
    if (sf !== 0) {
      if (nf > sf && frame === nf - 1) { local = 0; section = Math.floor(nf/sf) + 1; }
      else { section = Math.floor(frame/sf); local = frame - section*sf; }
    }
    const tracks = anim.sections[section]!;
    const delta = (desc.flags & STUDIO_DELTA) !== 0;
    for (let i = 0; i < this.n; i++) {
      if (!(weights[i] > 0)) continue;
      if (delta) {
        pos[i*3] = 0; pos[i*3 + 1] = 0; pos[i*3 + 2] = 0;
        q[i*4] = 0; q[i*4 + 1] = 0; q[i*4 + 2] = 0; q[i*4 + 3] = 1;
      } else {
        const j = map[i];
        pos[i*3] = rest.position[j*3]; pos[i*3 + 1] = rest.position[j*3 + 1]; pos[i*3 + 2] = rest.position[j*3 + 2];
        q[i*4] = rest.quaternion[j*4]; q[i*4 + 1] = rest.quaternion[j*4 + 1]; q[i*4 + 2] = rest.quaternion[j*4 + 2]; q[i*4 + 3] = rest.quaternion[j*4 + 3];
      }
    }
    const masterBone = anim.group.masterBone, animBones = anim.group.bones;
    for (let t = 0; t < tracks.count; t++) {
      const j = masterBone[tracks.bone[t]];
      if (j < 0 || !(weights[j] > 0)) continue;
      trackQuaternion(tracks, t, local, s, animBones, q, j*4);
      trackPosition(tracks, t, local, s, animBones, pos, j*3);
    }
  }

  /** Source BlendBones: q1/pos1 toward q2/pos2 by s on the sequence's weighted bones. */
  private blend(q1: Float32Array, pos1: Float32Array, seq: StudioSequence, q2: Float32Array, pos2: Float32Array, s: number): void {
    if (s <= 0) return;
    const weights = seq.boneWeight, flags = this.model.skeleton.flags;
    if (s >= 1) {
      for (let i = 0; i < this.n; i++) if (weights[i] > 0) {
        for (let c = 0; c < 4; c++) q1[i*4 + c] = q2[i*4 + c];
        for (let c = 0; c < 3; c++) pos1[i*3 + c] = pos2[i*3 + c];
      }
      return;
    }
    const s1 = 1 - s;
    for (let i = 0; i < this.n; i++) {
      if (!(weights[i] > 0)) continue;
      quatBlend(q1, i*4, q2, i*4, q1, i*4, s1, (flags[i] & BONE_FIXED_ALIGNMENT) === 0);
      for (let c = 0; c < 3; c++) pos1[i*3 + c] = pos1[i*3 + c]*s1 + pos2[i*3 + c]*s;
    }
  }

  /** Source ScaleBones (delta poses toward identity). */
  private scale(q: Float32Array, pos: Float32Array, seq: StudioSequence, s: number): void {
    const weights = seq.boneWeight;
    for (let i = 0; i < this.n; i++) {
      if (!(weights[i] > 0)) continue;
      quatIdentityBlend(q, i*4, q, i*4, 1 - s);
      pos[i*3] *= s; pos[i*3 + 1] *= s; pos[i*3 + 2] *= s;
    }
  }

  /** Source SlerpBones: layers q2/pos2 onto q1/pos1 by s times each bone weight. */
  private slerp(q1: Float32Array, pos1: Float32Array, seq: StudioSequence, q2: Float32Array, pos2: Float32Array, s: number): void {
    if (s <= 0) return;
    if (s > 1) s = 1;
    const weights = seq.boneWeight, flags = this.model.skeleton.flags;
    const delta = (seq.flags & STUDIO_DELTA) !== 0, post = (seq.flags & STUDIO_POST) !== 0;
    for (let i = 0; i < this.n; i++) {
      const s2 = s*weights[i];
      if (!(s2 > 0)) continue;
      if (delta) {
        if (post) quatMultiplyScaled(q1, i*4, q1, i*4, s2, q2, i*4);
        else quatScaleMultiply(q1, i*4, s2, q2, i*4, q1, i*4);
        for (let c = 0; c < 3; c++) pos1[i*3 + c] += pos2[i*3 + c]*s2;
      } else {
        const s1 = 1 - s2;
        quatSlerp(q1, i*4, q2, i*4, q1, i*4, s1, (flags[i] & BONE_FIXED_ALIGNMENT) === 0);
        for (let c = 0; c < 3; c++) pos1[i*3 + c] = pos1[i*3 + c]*s1 + pos2[i*3 + c]*s2;
      }
    }
  }

  /** Source AccumulatePose. */
  private accumulate(pos: Float32Array, q: Float32Array, index: number, cycle: number, pose: Float32Array, weight: number): void {
    if (!Number.isFinite(weight)) throw new RangeError(`Studio layer weight ${weight} is not finite.`);
    weight = weight < 0 ? 0 : weight > 1 ? 1 : weight;
    const seq = this.seq(index).data;
    const d = this.depth;
    if (d + 3 > this.positions.length) throw new RangeError(`Studio layers of ${seq.label} nest deeper than the sampler was built for.`);
    const pos2 = this.positions[d], q2 = this.quaternions[d];
    this.depth = d + 1;
    if (this.calcPoseSingle(pos2, q2, index, cycle, pose)) this.slerp(q, pos, seq, q2, pos2, weight);
    this.depth = d;
    this.addLayers(pos, q, index, cycle, pose, weight);
  }

  /** Source AddSequenceLayers (non-local autolayers). */
  private addLayers(pos: Float32Array, q: Float32Array, index: number, cycle: number, pose: Float32Array, weight: number): void {
    const model = this.model, layers = this.runtime.seqs[index].data.layers;
    for (let i = 0; i < layers.length; i++) {
      const layer = layers[i];
      if (layer.flags & STUDIO_AL_LOCAL) continue;
      let layerCycle = cycle, layerWeight = weight;
      if (layer.start !== layer.end) {
        let at = cycle;
        if (layer.flags & STUDIO_AL_POSE) {
          const p = model.poseParameters[layer.pose];
          at = pose[layer.pose]*(p.end - p.start) + p.start;
        }
        if (at < layer.start || at >= layer.end) continue;
        let s = 1;
        if (at < layer.peak && layer.start !== layer.peak) s = (at - layer.start)/(layer.peak - layer.start);
        else if (at > layer.tail && layer.end !== layer.tail) s = (layer.end - at)/(layer.end - layer.tail);
        if (layer.flags & STUDIO_AL_SPLINE) s = 3*s*s - 2*s*s*s;
        if ((layer.flags & STUDIO_AL_XFADE) && at > layer.tail) layerWeight = s*weight/(1 - weight + s*weight);
        else if (layer.flags & STUDIO_AL_NOBLEND) layerWeight = s;
        else layerWeight = weight*s;
        if (!(layer.flags & STUDIO_AL_POSE)) layerCycle = (cycle - layer.start)/(layer.end - layer.start);
      }
      this.accumulate(pos, q, layer.sequence, layerCycle, pose, layerWeight);
    }
  }

  /** Source CalcBoneAdj. */
  private controllers(pos: Float32Array, q: Float32Array, inputs: Float32Array): void {
    const e = this.euler;
    const controllers = this.model.boneControllers;
    for (let i = 0; i < controllers.length; i++) {
      const c = controllers[i];
      if (c.inputField < 0 || c.inputField >= inputs.length) throw new RangeError(`Studio bone controller input ${c.inputField} is missing.`);
      let value = inputs[c.inputField];
      value = value < 0 ? 0 : value > 1 ? 1 : value;
      value = (1 - value)*c.start + value*c.end;
      const k = c.bone, rad = value*Math.PI/180;
      switch (c.type & STUDIO_TYPES) {
        case STUDIO_XR: quatFromRadianEuler(e, 0, rad, 0, 0); quatScaleMultiply(q, k*4, 1, e, 0, q, k*4); break;
        case STUDIO_YR: quatFromRadianEuler(e, 0, 0, rad, 0); quatScaleMultiply(q, k*4, 1, e, 0, q, k*4); break;
        case STUDIO_ZR: quatFromRadianEuler(e, 0, 0, 0, rad); quatScaleMultiply(q, k*4, 1, e, 0, q, k*4); break;
        case STUDIO_X: pos[k*3] += value; break;
        case STUDIO_Y: pos[k*3 + 1] += value; break;
        case STUDIO_Z: pos[k*3 + 2] += value; break;
      }
    }
  }

  /** Source DoAxisInterpBone / DoQuatInterpBone, evaluated in bone order on local transforms
   * (control bones always precede, and have a parent; checked at load). */
  private procedural(pos: Float32Array, q: Float32Array): void {
    const procedural = this.model.skeleton.procedural, e = this.euler;
    for (let i = 0; i < this.n; i++) {
      const rule = procedural[i];
      if (!rule) continue;
      const c = rule.control;
      if (rule.type === 'axisinterp') {
        // Column `axis` of the control bone's local rotation.
        const x = q[c*4], y = q[c*4 + 1], z = q[c*4 + 2], w = q[c*4 + 3];
        let a1: number, a2: number, a3: number;
        if (rule.axis === 0) { a1 = 1 - 2*(y*y + z*z); a2 = 2*(x*y + w*z); a3 = 2*(x*z - w*y); }
        else if (rule.axis === 1) { a1 = 2*(x*y - w*z); a2 = 1 - 2*(x*x + z*z); a3 = 2*(y*z + w*x); }
        else { a1 = 2*(x*z + w*y); a2 = 2*(y*z - w*x); a3 = 1 - 2*(x*x + y*y); }
        const k1 = a1 >= 0 ? 0 : 1, k2 = a2 >= 0 ? 2 : 3, k3 = a3 >= 0 ? 4 : 5;
        a1 = Math.abs(a1); a2 = Math.abs(a2); a3 = Math.abs(a3);
        const P = rule.position, Q = rule.quaternion;
        if (a1 + a2 > 0) {
          const t = 1/(a1 + a2 + a3);
          quatSlerp(q, i*4, Q, k2*4, Q, k1*4, a1/(a1 + a2), true);
          quatSlerp(q, i*4, q, i*4, Q, k3*4, a3*t, true);
          for (let k = 0; k < 3; k++) pos[i*3 + k] = P[k1*3 + k]*a1*t + P[k2*3 + k]*a2*t + P[k3*3 + k]*a3*t;
        } else {
          for (let k = 0; k < 4; k++) q[i*4 + k] = Q[k3*4 + k];
          for (let k = 0; k < 3; k++) pos[i*3 + k] = P[k3*3 + k];
        }
      } else {
        e[0] = q[c*4]; e[1] = q[c*4 + 1]; e[2] = q[c*4 + 2]; e[3] = q[c*4 + 3];
        quatNormalize(e, 0);
        let scale = 0;
        const triggers = rule.triggers;
        for (let t = 0; t < triggers.length; t++) {
          const trigger = triggers[t];
          const T = trigger.trigger;
          let dot = Math.abs(T[0]*e[0] + T[1]*e[1] + T[2]*e[2] + T[3]*e[3]);
          dot = dot > 1 ? 1 : dot;
          scale += Math.max(0, 1 - 2*Math.acos(dot)*trigger.inverseTolerance);
        }
        if (scale <= 0.001) {
          const t0 = triggers[0];
          for (let k = 0; k < 4; k++) q[i*4 + k] = t0.quaternion[k];
          for (let k = 0; k < 3; k++) pos[i*3 + k] = t0.position[k];
          continue;
        }
        let qx = 0, qy = 0, qz = 0, qw = 0, px = 0, py = 0, pz = 0;
        for (let t = 0; t < triggers.length; t++) {
          const trigger = triggers[t];
          const T = trigger.trigger;
          let dot = Math.abs(T[0]*e[0] + T[1]*e[1] + T[2]*e[2] + T[3]*e[3]);
          dot = dot > 1 ? 1 : dot;
          const weight = Math.max(0, 1 - 2*Math.acos(dot)*trigger.inverseTolerance);
          if (!weight) continue;
          const s = weight/scale, R = trigger.quaternion, P = trigger.position;
          // Align the running sum to this trigger's rotation before adding it (QuaternionAlign).
          const a = (R[0] - qx)**2 + (R[1] - qy)**2 + (R[2] - qz)**2 + (R[3] - qw)**2;
          const b = (R[0] + qx)**2 + (R[1] + qy)**2 + (R[2] + qz)**2 + (R[3] + qw)**2;
          if (a > b) { qx = -qx; qy = -qy; qz = -qz; qw = -qw; }
          qx += s*R[0]; qy += s*R[1]; qz += s*R[2]; qw += s*R[3];
          px += s*P[0]; py += s*P[1]; pz += s*P[2];
        }
        q[i*4] = qx; q[i*4 + 1] = qy; q[i*4 + 2] = qz; q[i*4 + 3] = qw;
        quatNormalize(q, i*4);
        pos[i*3] = px; pos[i*3 + 1] = py; pos[i*3 + 2] = pz;
      }
    }
  }
}
