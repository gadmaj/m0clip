/** Authored per-bone animation tracks (mstudioanim_t) and their decoding: run-length encoded
 * Euler/position channels, Quaternion48/64 and Vector48 constants, delta tracks and
 * BONE_FIXED_ALIGNMENT. Track streams are validated once when the model loads, so sampling reads
 * them without further checks or allocation. */
import { BinaryFile, StudioFormatError, StudioUnsupportedError } from './binary';
import { BONE_FIXED_ALIGNMENT, type MdlBones } from './mdl';
import { quatAlign, quatBlend, quatFromRadianEuler } from './quat';

export const ANIM_RAWPOS = 0x01;
export const ANIM_RAWROT = 0x02;
export const ANIM_ANIMPOS = 0x04;
export const ANIM_ANIMROT = 0x08;
export const ANIM_DELTA = 0x10;
export const ANIM_RAWROT2 = 0x20;

/** Tracks of one animation section, validated to cover `frames` frames. */
export interface TrackSection {
  readonly view: DataView;
  readonly count: number;
  /** Group-local bone per track. */
  readonly bone: Uint8Array;
  readonly flags: Uint8Array;
  /** Byte offset of the rotation payload (Quaternion48/64 or value pointers), -1 when none. */
  readonly rot: Int32Array;
  /** Byte offset of the position payload (Vector48 or value pointers), -1 when none. */
  readonly pos: Int32Array;
  /** RLE stream offsets, 3 per track for rotation and 3 for position; -1 means a zero channel. */
  readonly rotStream: Int32Array;
  readonly posStream: Int32Array;
  readonly frames: number;
}

function streamCovers(file: BinaryFile, start: number, need: number, what: string): void {
  let o = start, covered = 0;
  while (covered < need) {
    file.range(o, 2, what);
    const valid = file.view.getUint8(o), total = file.view.getUint8(o + 1);
    if (valid === 0 || total === 0) throw new StudioFormatError(file.path, `${what} ends after ${covered} of ${need} frames`);
    file.range(o, 2 + valid*2, what);
    covered += total;
    if (covered < need) o += 2 + valid*2;
  }
}

/** Reads the track list at `start` and checks every stream it will be asked for. */
export function readTrackSection(file: BinaryFile, start: number, frames: number, bones: MdlBones, version: number, what: string): TrackSection {
  const bone: number[] = [], flags: number[] = [], rot: number[] = [], pos: number[] = [], rotStream: number[] = [], posStream: number[] = [];
  let o = start, previous = -1;
  for (;;) {
    file.range(o, 4, `${what} track header`);
    const b = file.view.getUint8(o), f = file.view.getUint8(o + 1), next = file.view.getInt16(o + 2, true);
    if (b === 255) break;
    if (b >= bones.count) file.fail(`${what} animates bone ${b} of ${bones.count}`);
    if (b <= previous) file.fail(`${what} lists bone ${b} after bone ${previous}; tracks must ascend`);
    if (f & ~0x3f) throw new StudioUnsupportedError(file.path, `${what} track flags 0x${f.toString(16)}`);
    if ((f & ANIM_RAWROT2) && version < 48) throw new StudioUnsupportedError(file.path, `${what} Quaternion64 rotation in an MDL v${version}`);
    const rawRot = f & (ANIM_RAWROT | ANIM_RAWROT2);
    if (rawRot === (ANIM_RAWROT | ANIM_RAWROT2) || (rawRot && (f & ANIM_ANIMROT)) || ((f & ANIM_RAWPOS) && (f & ANIM_ANIMPOS)))
      throw new StudioUnsupportedError(file.path, `${what} track flags 0x${f.toString(16)} on ${bones.names[b]} (conflicting encodings)`);
    // Source addresses a constant position after a constant rotation only, and an animated
    // position after animated rotation pointers only; mixed layouts overlap there.
    if (((f & ANIM_ANIMROT) && (f & ANIM_RAWPOS)) || (rawRot && (f & ANIM_ANIMPOS)))
      throw new StudioUnsupportedError(file.path, `${what} track flags 0x${f.toString(16)} on ${bones.names[b]} (mixed constant/animated layout)`);
    let d = o + 4;
    let rotAt = -1, posAt = -1;
    if (f & ANIM_RAWROT) { rotAt = file.range(d, 6, `${what} Quaternion48`); d += 6; }
    else if (f & ANIM_RAWROT2) { rotAt = file.range(d, 8, `${what} Quaternion64`); d += 8; }
    else if (f & ANIM_ANIMROT) { rotAt = file.range(d, 6, `${what} rotation pointers`); d += 6; }
    if (f & ANIM_RAWPOS) posAt = file.range(d, 6, `${what} Vector48`);
    else if (f & ANIM_ANIMPOS) posAt = file.range(d, 6, `${what} position pointers`);
    for (let c = 0; c < 3; c++) {
      let r = -1, p = -1;
      if (f & ANIM_ANIMROT) {
        const rel = file.view.getInt16(rotAt + c*2, true);
        if (rel > 0) { r = rotAt + rel; streamCovers(file, r, frames, `${what} ${bones.names[b]} rotation ${'xyz'[c]}`); }
      }
      if (f & ANIM_ANIMPOS) {
        const rel = file.view.getInt16(posAt + c*2, true);
        if (rel > 0) { p = posAt + rel; streamCovers(file, p, frames, `${what} ${bones.names[b]} position ${'xyz'[c]}`); }
      }
      rotStream.push(r);
      posStream.push(p);
    }
    bone.push(b); flags.push(f); rot.push(rotAt); pos.push(posAt);
    previous = b;
    if (next === 0) break;
    if (next < 4) file.fail(`${what} track for ${bones.names[b]} has next offset ${next}`);
    o += next;
  }
  return {
    view: file.view, count: bone.length, bone: Uint8Array.from(bone), flags: Uint8Array.from(flags),
    rot: Int32Array.from(rot), pos: Int32Array.from(pos), rotStream: Int32Array.from(rotStream), posStream: Int32Array.from(posStream), frames,
  };
}

let value1 = 0, value2 = 0;

/** Source ExtractAnimValue: value at frame k into value1 and, when `both`, frame k+1 into value2. */
function extract(view: DataView, o: number, k: number, scale: number, both: boolean): void {
  if (o < 0) { value1 = value2 = 0; return; }
  let valid = view.getUint8(o), total = view.getUint8(o + 1);
  if (valid === 1 && total === 1) { value1 = value2 = view.getInt16(o + 2, true)*scale; return; }
  while (total <= k) {
    k -= total;
    o += 2 + valid*2;
    valid = view.getUint8(o);
    total = view.getUint8(o + 1);
  }
  if (valid > k) {
    value1 = view.getInt16(o + 2 + k*2, true)*scale;
    if (!both) return;
    if (valid > k + 1) value2 = view.getInt16(o + 4 + k*2, true)*scale;
    else value2 = total > k + 1 ? value1 : view.getInt16(o + 4 + valid*2, true)*scale;
  } else {
    value1 = view.getInt16(o + valid*2, true)*scale;
    if (!both) return;
    value2 = total > k + 1 ? value1 : view.getInt16(o + 4 + valid*2, true)*scale;
  }
}

function float16(bits: number): number {
  const exponent = (bits >> 10) & 0x1f, mantissa = bits & 0x3ff, sign = bits & 0x8000 ? -1 : 1;
  if (exponent === 0) return sign*mantissa*2**-24;
  if (exponent === 31) return mantissa ? NaN : sign*Infinity;
  return sign*(1 + mantissa/1024)*2**(exponent - 15);
}

/** Euler angles of frames k and k+1 (0..5), then their quaternions (6..13). */
const angles = new Float64Array(14);

/** Local rotation of `track` at frame + s into out[o..o+3] (Source CalcBoneQuaternion). */
export function trackQuaternion(t: TrackSection, track: number, frame: number, s: number, bones: MdlBones, out: Float32Array, o: number): void {
  const view = t.view, f = t.flags[track], b = t.bone[track], at = t.rot[track];
  if (f & ANIM_RAWROT) {
    const x = (view.getUint16(at, true) - 32768)/32768, y = (view.getUint16(at + 2, true) - 32768)/32768;
    const zw = view.getUint16(at + 4, true), z = ((zw & 0x7fff) - 16384)/16384;
    const w = Math.sqrt(Math.max(0, 1 - x*x - y*y - z*z));
    out[o] = x; out[o + 1] = y; out[o + 2] = z; out[o + 3] = zw & 0x8000 ? -w : w;
    return;
  }
  if (f & ANIM_RAWROT2) {
    const lo = view.getUint32(at, true), hi = view.getUint32(at + 4, true);
    const x = ((lo & 0x1fffff) - 1048576)/1048576.5;
    const y = ((((hi & 0x3ff) << 11) | (lo >>> 21)) - 1048576)/1048576.5;
    const z = (((hi >>> 10) & 0x1fffff) - 1048576)/1048576.5;
    const w = Math.sqrt(Math.max(0, 1 - x*x - y*y - z*z));
    out[o] = x; out[o + 1] = y; out[o + 2] = z; out[o + 3] = hi & 0x80000000 ? -w : w;
    return;
  }
  if (!(f & ANIM_ANIMROT)) {
    if (f & ANIM_DELTA) { out[o] = 0; out[o + 1] = 0; out[o + 2] = 0; out[o + 3] = 1; }
    else { const q = bones.quaternion; out[o] = q[b*4]; out[o + 1] = q[b*4 + 1]; out[o + 2] = q[b*4 + 2]; out[o + 3] = q[b*4 + 3]; }
    return;
  }
  const both = s > 0.001, scale = bones.rotationScale, base = bones.euler, delta = (f & ANIM_DELTA) !== 0;
  for (let c = 0; c < 3; c++) {
    extract(view, t.rotStream[track*3 + c], frame, scale[b*3 + c], both);
    const add = delta ? 0 : base[b*3 + c];
    angles[c] = value1 + add;
    angles[c + 3] = (both ? value2 : value1) + add;
  }
  if (both && (angles[0] !== angles[3] || angles[1] !== angles[4] || angles[2] !== angles[5])) {
    quatFromRadianEuler(angles, 6, angles[0], angles[1], angles[2]);
    quatFromRadianEuler(angles, 10, angles[3], angles[4], angles[5]);
    quatBlend(out, o, angles, 6, angles, 10, s, true);
  } else {
    quatFromRadianEuler(out, o, angles[0], angles[1], angles[2]);
  }
  if (!delta && (bones.flags[b] & BONE_FIXED_ALIGNMENT)) quatAlign(out, o, bones.alignment, b*4, out, o);
}

/** Local translation of `track` at frame + s into out[o..o+2] (Source CalcBonePosition). */
export function trackPosition(t: TrackSection, track: number, frame: number, s: number, bones: MdlBones, out: Float32Array, o: number): void {
  const view = t.view, f = t.flags[track], b = t.bone[track], at = t.pos[track];
  if (f & ANIM_RAWPOS) {
    out[o] = float16(view.getUint16(at, true)); out[o + 1] = float16(view.getUint16(at + 2, true)); out[o + 2] = float16(view.getUint16(at + 4, true));
    return;
  }
  const delta = (f & ANIM_DELTA) !== 0, rest = bones.position;
  if (!(f & ANIM_ANIMPOS)) {
    if (delta) { out[o] = 0; out[o + 1] = 0; out[o + 2] = 0; }
    else { out[o] = rest[b*3]; out[o + 1] = rest[b*3 + 1]; out[o + 2] = rest[b*3 + 2]; }
    return;
  }
  const both = s > 0.001, scale = bones.positionScale;
  for (let c = 0; c < 3; c++) {
    extract(view, t.posStream[track*3 + c], frame, scale[b*3 + c], both);
    const v = both ? value1*(1 - s) + value2*s : value1;
    out[o + c] = delta ? v : v + rest[b*3 + c];
  }
}
