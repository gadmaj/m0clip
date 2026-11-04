/** Activity-driven sequence choice and cycle bookkeeping for Studio models, following Source's
 * SelectWeightedSequence (random choice weighted by each sequence's authored activity weight) and
 * looping/non-looping cycle rules. Independent implementation; the SDK is a behavioural reference.
 * Live choices use a seeded generator, and the chosen sequence is what gets recorded, so replay
 * never re-rolls. */
import { encodeStudioPoseParameter, studioSequenceCps, type StudioModelData } from '../../player/studio';
import { STUDIO_LOOPING } from '../../player/studio/mdl';

/** Deterministic 32-bit generator (mulberry32). */
export class SeededRandom {
  constructor(private state: number) {}
  next(): number {
    let t = (this.state = (this.state + 0x6d2b79f5) | 0);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
}

/** Weighted choice among the sampleable sequences of the first listed activity the model has, or -1. */
export function selectWeightedSequence(model: StudioModelData, activities: readonly string[], random: SeededRandom): number {
  for (const activity of activities) {
    const wanted = activity.toUpperCase();
    let total = 0;
    for (const seq of model.sequences)
      if (!seq.unsupported && seq.activityName.toUpperCase() === wanted) total += Math.max(1, Math.abs(seq.activityWeight));
    if (!total) continue;
    let pick = random.next() * total;
    for (let i = 0; i < model.sequences.length; i++) {
      const seq = model.sequences[i];
      if (seq.unsupported || seq.activityName.toUpperCase() !== wanted) continue;
      pick -= Math.max(1, Math.abs(seq.activityWeight));
      if (pick < 0) return i;
    }
  }
  return -1;
}

export function hasActivity(model: StudioModelData, activities: readonly string[]): boolean {
  const wanted = new Set(activities.map(a => a.toUpperCase()));
  return model.sequences.some(seq => !seq.unsupported && wanted.has(seq.activityName.toUpperCase()));
}

export function sequenceLoops(model: StudioModelData, sequence: number): boolean {
  return (model.sequences[sequence].flags & STUDIO_LOOPING) !== 0;
}

/** Advances a cycle by `dt` seconds at `rate`; looping cycles wrap, others hold at 1. */
export function advanceCycle(model: StudioModelData, sequence: number, cycle: number, pose: Float32Array, rate: number, dt: number): number {
  const next = cycle + studioSequenceCps(model, sequence, pose) * rate * dt;
  return sequenceLoops(model, sequence) ? next - Math.floor(next) : Math.min(1, next);
}

/** Encoded pose parameters at the authored value 0, Source's initial pose-parameter setting. */
export function restPoseParameters(model: StudioModelData): Float32Array {
  return Float32Array.from(model.poseParameters, (_, i) => encodeStudioPoseParameter(model, i, 0));
}

/** Encoded bone-controller inputs at angle/offset 0 (Source SetBoneController(i, 0) at spawn). */
export function restControllers(model: StudioModelData): Float32Array {
  const out = new Float32Array(5);
  for (const c of model.boneControllers) {
    const range = c.end - c.start;
    out[c.inputField] = range ? Math.min(1, Math.max(0, -c.start / range)) : 0;
  }
  return out;
}

/** Index of a pose parameter by (case-insensitive) name, or -1. */
export function poseParameterIndex(model: StudioModelData, name: string): number {
  const wanted = name.toLowerCase();
  return model.poseParameters.findIndex(p => p.name.toLowerCase() === wanted);
}
