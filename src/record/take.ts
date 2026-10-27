/** Takes: a recorded stretch of the session. Every frame the sim worker posts while recording is
 * kept — each geom's world pose, the full qpos, the command the user was giving, the viewport
 * camera and the hoist — on the worker's frame clock (simulated seconds), together with the user's
 * discrete inputs as timeline events (FSM state, policy, remote moves, reset, hoist, clip).
 * The timeline plays a take back; the exporters resample it at any frame rate. */
import type { Appearance } from "../render/scene";
import { validDisplay, type SceneDisplay } from '../render/display';
import { unzip, zip } from "fflate";
import {Matrix4,Quaternion,Vector3} from 'three';
import type { Command, RobotSpec } from "../core/types";
import { SPECS } from "../robots";
import { type RobotFade, recordedRobotOpacity } from '../render/robot-fade';
import type { LookState } from '../ui/look';
import { validLook, validShotEdits, validShotLights, type ShotEdits, type ShotLight } from './post';
import type { Shot } from './shot';
import { GEOM_STRIDE, GeometryTrack, validGeometryPartition, validGeometryData, matToQuat, quatToMat, nlerp, type GeometryPartition } from '../core/geometry';
import { validLocalMap, type LocalMapIdentity } from '../maps/source';

export type TakeEventKind = "state" | "policy" | "move" | "reset" | "hoist" | "clip" | "noclip";
export interface TakeEvent { t: number; kind: TakeEventKind; label: string }

/** Non-destructive export bounds in original take seconds. */
export type TakeRange = [number, number];
export function validTakeRange(value: unknown, duration: number): value is TakeRange {
  return Array.isArray(value) && value.length === 2
    && typeof value[0] === 'number' && Number.isFinite(value[0])
    && typeof value[1] === 'number' && Number.isFinite(value[1])
    && Number.isFinite(duration) && 0 <= value[0] && value[0] < value[1] && value[1] <= duration;
}

export interface TakeMeta {
  robot: string;            // exact robot variant the model was compiled for (r1, r1_air, g1, ...)
  model?: string;           // display name of the variant ("R1 EDU · 24-DOF")
  terrain: string;
  localMap?: LocalMapIdentity;
  sourceTime?: number;      // map animation / lighting clock at the start of the take
  appearance?: Appearance;   // fixed paint and robot illumination for this take
  sourceHead?: 'stock' | 'ghost'; // optional cosmetic geometry; older takes use the stock head
  look?: LookState;        // recorded Look; absent in older takes
  display?: SceneDisplay;   // initial viewport choices; absent in older takes
  flashlight?: boolean;    // initial camera flashlight state
  lights?: ShotLight[];    // initial world-space shot lights
  edits?: ShotEdits;       // non-destructive review edits, never applied to recorded tracks
  robotFade?: RobotFade;    // initial visual transition; noclip events drive subsequent fades
  policy: string;           // policy active when recording started
  created: string;          // ISO timestamp
  ngeom: number;
  nq: number;
  baseQadr: number;         // floating-base qpos address, -1 when none
  hinges: { name: string; qadr: number }[];
}

/** The optional export-camera recipe is separate from immutable recorded camera tracks. */
export function validShotCamera(value:unknown):value is Shot {
  if(!value||typeof value!=='object'||Array.isArray(value))return false;
  const shot=value as Record<string,unknown>;
  if(!['viewport','follow','orbit','fixed'].includes(shot.mode as string))return false;
  for(const key of ['focal','sensor','distance','azimuth','elevation','height','orbitPeriod','smooth'])
    if(typeof shot[key]!=='number'||!Number.isFinite(shot[key]))return false;
  return (shot.focal as number)>=4&&(shot.sensor as number)>0&&(shot.distance as number)>0
    &&(shot.orbitPeriod as number)!==0&&(shot.smooth as number)>=0;
}

/** Per-frame layout of the camera track: position, look-at target, vertical fov (deg). */
export const CAM_STRIDE = 7;

export interface CamPose { pos: [number, number, number]; target: [number, number, number]; fov: number; orientation?:[number,number,number,number] }
export function cameraOrientationAt(track:ArrayLike<number>,i:number,j:number,f:number):[number,number,number,number] {
  return new Quaternion().fromArray(track,i*4).normalize().slerp(new Quaternion().fromArray(track,j*4).normalize(),f).toArray();
}


export class Take {
  shot?:Shot;
  range?: TakeRange;
  constructor(
    readonly meta: TakeMeta,
    readonly t: Float64Array,       // n — seconds from the first frame
    readonly geom: GeometryTrack,
    readonly qpos: Float32Array,    // n · nq
    readonly cmd: Float32Array,     // n · 3 — vx, vy, wz as commanded
    readonly cam: Float32Array,     // n · CAM_STRIDE — the viewport camera
    readonly hoist: Float32Array,   // n · 3 — hoist anchor, NaN while the hoist is off
    readonly events: TakeEvent[],
    readonly camOrientation?:Float32Array, // optional n·4 xyzw; legacy tracks keep lookAt behavior
  ) {
    if (geom.ngeom !== meta.ngeom || geom.frames !== t.length) throw new Error('Take geometry dimensions do not match');
  }

  get n(): number { return this.t.length; }
  get duration(): number { return this.n ? this.t[this.n - 1] : 0; }
  /** Mean frame interval (the sim's control step, 20 ms for most policies). */
  get dt(): number { return this.n > 1 ? this.duration / (this.n - 1) : 0.02; }

  /** Bracketing frame and blend: t[i] ≤ time < t[i+1], f in [0, 1). */
  locate(time: number): [number, number] {
    const t = this.t, n = t.length;
    if (n < 2 || time <= t[0]) return [0, 0];
    if (time >= t[n - 1]) return [n - 1, 0];
    let lo = 0, hi = n - 1;
    while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (t[mid] <= time) lo = mid; else hi = mid; }
    return [lo, (time - t[lo]) / (t[hi] - t[lo])];
  }

  /** Nearest frame index to `time`. */
  frameAt(time: number): number {
    const [i, f] = this.locate(time);
    return f >= 0.5 ? Math.min(i + 1, this.n - 1) : i;
  }

  /** Interpolated pose of every geom: out[g·7 ..] = px py pz qw qx qy qz. */
  geomPoseAt(time: number, out: Float32Array) {
    const [i, f] = this.locate(time);
    const G = this.geom.values;
    for (let g = 0; g < this.meta.ngeom; g++) {
      const a = this.geom.offset(i, g), b = this.geom.offset(Math.min(i + 1, this.n - 1), g), o = g * GEOM_STRIDE;
      for (let k = 0; k < 3; k++) out[o + k] = G[a + k] + (G[b + k] - G[a + k]) * f;
      nlerp(G, a + 3, b + 3, f, out, o + 3);
    }
  }

  private pose?: { xpos: Float32Array; xmat: Float32Array };
  private quatTmp?: Float32Array;
  /** Borrowed full original-ID buffers, owned independently by this take. */
  poseAt(time: number): { xpos: Float32Array; xmat: Float32Array } {
    const first = !this.pose;
    const pose = this.pose ??= { xpos: new Float32Array(this.meta.ngeom * 3), xmat: new Float32Array(this.meta.ngeom * 9) };
    const [i, f] = this.locate(time), G = this.geom.values, q = this.quatTmp ??= new Float32Array(4);
    if (first) for (let row = 0; row < this.geom.fixedIds.length; row++) {
      const g = this.geom.fixedIds[row], a = row * GEOM_STRIDE;
      for (let k = 0; k < 3; k++) pose.xpos[g * 3 + k] = G[a + k];
      nlerp(G, a + 3, a + 3, 0, q, 0);
      quatToMat(q[0], q[1], q[2], q[3], pose.xmat, g * 9);
    }
    const count = this.geom.movingCount, fixed = this.geom.fixedIds.length, next = Math.min(i + 1, this.n - 1);
    for (let row = 0; row < count; row++) {
      const g = this.geom.movingGeom(row), a = (fixed + i * count + row) * GEOM_STRIDE, b = (fixed + next * count + row) * GEOM_STRIDE;
      for (let k = 0; k < 3; k++) pose.xpos[g * 3 + k] = G[a + k] + (G[b + k] - G[a + k]) * f;
      nlerp(G, a + 3, b + 3, f, q, 0);
      quatToMat(q[0], q[1], q[2], q[3], pose.xmat, g * 9);
    }
    return pose;
  }

  sampleGeometry(times: ArrayLike<number>, offset = 0): GeometryTrack {
    const fixedIds = this.geom.fixedIds.slice(), S = fixedIds.length * GEOM_STRIDE;
    const values = new Float32Array(S + times.length * this.geom.movingCount * GEOM_STRIDE);
    values.set(this.geom.values.subarray(0, S));
    for (let s = 0; s < fixedIds.length; s++) nlerp(values, s * 7 + 3, s * 7 + 3, 0, values, s * 7 + 3);
    const sampled = new GeometryTrack(this.meta.ngeom, times.length, { fixedIds, values }), G = this.geom.values;
    for (let frame = 0; frame < times.length; frame++) {
      const [i, f] = this.locate(times[frame] + offset);
      const count = this.geom.movingCount, next = Math.min(i + 1, this.n - 1);
      for (let row = 0; row < count; row++) {
        const a = S + (i * count + row) * GEOM_STRIDE, b = S + (next * count + row) * GEOM_STRIDE, o = S + (frame * count + row) * GEOM_STRIDE;
        for (let k = 0; k < 3; k++) values[o + k] = G[a + k] + (G[b + k] - G[a + k]) * f;
        nlerp(G, a + 3, b + 3, f, values, o + 3);
      }
    }
    return sampled;
  }

  /** Interpolated qpos (hinge angles lerped, base quaternion nlerped). */
  qposAt(time: number, out: Float64Array) {
    const [i, f] = this.locate(time);
    const nq = this.meta.nq, a = i * nq, b = Math.min(i + 1, this.n - 1) * nq, Q = this.qpos;
    for (let k = 0; k < nq; k++) out[k] = Q[a + k] + (Q[b + k] - Q[a + k]) * f;
    const bq = this.meta.baseQadr;
    if (bq >= 0) nlerp(Q, a + bq + 3, b + bq + 3, f, out, bq + 3);
  }

  /** Floating-base position at `time` (origin when the model has no free joint). */
  basePosAt(time: number): [number, number, number] {
    const bq = this.meta.baseQadr;
    if (bq < 0) return [0, 0, 0];
    const [i, f] = this.locate(time);
    const nq = this.meta.nq, a = i * nq + bq, b = Math.min(i + 1, this.n - 1) * nq + bq, Q = this.qpos;
    return [Q[a] + (Q[b] - Q[a]) * f, Q[a + 1] + (Q[b + 1] - Q[a + 1]) * f, Q[a + 2] + (Q[b + 2] - Q[a + 2]) * f];
  }

  /** The viewport camera at `time`, interpolated. */
  camAt(time: number): CamPose {
    const [i, f] = this.locate(time);
    const a = i * CAM_STRIDE, b = Math.min(i + 1, this.n - 1) * CAM_STRIDE, C = this.cam;
    const l = (k: number) => C[a + k] + (C[b + k] - C[a + k]) * f;
    return { pos: [l(0), l(1), l(2)], target: [l(3), l(4), l(5)], fov: l(6),
      ...(this.camOrientation?{orientation:cameraOrientationAt(this.camOrientation,i,Math.min(i+1,this.n-1),f)}:{}) };
  }

  /** Hoist anchor at the nearest frame, or null while it was off. */
  hoistAt(time: number): [number, number, number] | null {
    const o = this.frameAt(time) * 3, H = this.hoist;
    return Number.isNaN(H[o]) ? null : [H[o], H[o + 1], H[o + 2]];
  }

  /** Commanded velocity at the nearest frame. */
  robotOpacityAt(time: number) { return recordedRobotOpacity(this.meta.robotFade, this.events, time); }

  cmdAt(time: number): Command {
    const o = this.frameAt(time) * 3;
    return [this.cmd[o], this.cmd[o + 1], this.cmd[o + 2]];
  }
}

/** Float32 buffer that grows by doubling. */
class Grow {
  buf: Float32Array;
  len = 0;
  constructor(cap = 4096) { this.buf = new Float32Array(cap); }
  reserve(k: number): number {
    if (this.len + k > this.buf.length) {
      const nb = new Float32Array(Math.max(this.buf.length * 2, this.len + k));
      nb.set(this.buf.subarray(0, this.len));
      this.buf = nb;
    }
    const at = this.len;
    this.len += k;
    return at;
  }
  push(...v: number[]) { const o = this.reserve(v.length); this.buf.set(v, o); }
  done(): Float32Array { return this.buf.slice(0, this.len); }
}

export interface RecFrame {
  clock: number; xpos: Float32Array; xmat: Float32Array; qpos: Float64Array;
  hoistAnchor?: [number, number, number] | null;
}

/** Independently owned incremental tracks; frame times remain in original take seconds. */
export interface RecordingSnapshot {
  from: number;
  meta: TakeMeta;
  events: TakeEvent[];
  t: Float64Array;
  geom: Float32Array;
  geometry?: GeometryPartition;
  qpos: Float32Array;
  cmd: Float32Array;
  cam: Float32Array;
  hoist: Float32Array;
  camOrientation: Float32Array;
}

/** Accumulates frames + events into a Take. Frames must belong to the model in `meta`. */
export class TakeRecorder {
  private t0 = NaN;
  private lastClock = -Infinity;
  private times: number[] = [];
  private geom = new Grow(1 << 16);
  private qpos = new Grow(1 << 14);
  private cmd = new Grow();
  private cam = new Grow();
  private camOrientation=new Grow();
  private hoist = new Grow();
  private events: TakeEvent[] = [];

  private readonly geometry: GeometryPartition;
  private readonly movingIds: Uint32Array;
  constructor(readonly meta: TakeMeta, geometry: GeometryPartition) {
    if (!validGeometryPartition(geometry, meta.ngeom)) throw new Error('Invalid recording geometry partition');
    this.geometry = { fixedIds: geometry.fixedIds.slice(), fixed: geometry.fixed.slice() };
    this.movingIds = new Uint32Array(meta.ngeom - geometry.fixedIds.length);
    let fixed = 0, moving = 0;
    for (let g = 0; g < meta.ngeom; g++) {
      if (fixed < geometry.fixedIds.length && geometry.fixedIds[fixed] === g) fixed++;
      else this.movingIds[moving++] = g;
    }
  }

  get frames(): number { return this.times.length; }
  /** Seconds recorded so far (frame clock). */
  get elapsed(): number { return this.times.length ? this.times[this.times.length - 1] : 0; }
  /** Rough memory held, bytes. */
  get bytes(): number { return 4 * (this.geom.len + this.qpos.len) + 8 * this.times.length + this.geometry.fixed.byteLength + this.geometry.fixedIds.byteLength; }

  push(f: RecFrame, cmd: Command, cam: CamPose) {
    if (f.clock <= this.lastClock || f.xpos.length !== 3 * this.meta.ngeom || f.qpos.length !== this.meta.nq) return;
    if (Number.isNaN(this.t0)) this.t0 = f.clock;
    this.lastClock = f.clock;
    this.times.push(f.clock - this.t0);
    const o = this.geom.reserve(this.movingIds.length * GEOM_STRIDE), G = this.geom.buf;
    for (let row = 0; row < this.movingIds.length; row++) {
      const g = this.movingIds[row], k = o + row * GEOM_STRIDE;
      G[k] = f.xpos[3 * g]; G[k + 1] = f.xpos[3 * g + 1]; G[k + 2] = f.xpos[3 * g + 2];
      matToQuat(f.xmat, 9 * g, G, k + 3);
    }
    const qo = this.qpos.reserve(this.meta.nq);     // reserve first: it may swap in a bigger buffer
    this.qpos.buf.set(f.qpos, qo);
    this.cmd.push(cmd[0], cmd[1], cmd[2]);
    this.cam.push(...cam.pos, ...cam.target, cam.fov);
    const orientation=cam.orientation??new Quaternion().setFromRotationMatrix(new Matrix4().lookAt(
      new Vector3(...cam.pos),new Vector3(...cam.target),new Vector3(0,0,1))).toArray();
    this.camOrientation.push(...orientation);
    const h = f.hoistAnchor;
    this.hoist.push(h ? h[0] : NaN, h ? h[1] : NaN, h ? h[2] : NaN);
  }

  /** Log a user input at the current end of the take. */
  mark(kind: TakeEventKind, label: string) {
    this.events.push({ t: this.elapsed, kind, label });
  }

  /** Copy only the uncommitted span, never a growing prefix or the compiled model. */
  snapshot(from: number): RecordingSnapshot {
    if (!Number.isSafeInteger(from) || from < 0 || from > this.frames) throw new RangeError('Invalid recording snapshot frame.');
    const t = new Float64Array(this.frames - from);
    for (let i = 0; i < t.length; i++) t[i] = this.times[from + i];
    const { meta, events } = structuredClone({ meta: this.meta, events: this.events });
    return { from, meta, events, t,
      ...(from === 0 ? { geometry: { fixedIds: this.geometry.fixedIds.slice(), fixed: this.geometry.fixed.slice() } } : {}),
      geom: this.geom.buf.slice(from * this.movingIds.length * GEOM_STRIDE, this.geom.len),
      qpos: this.qpos.buf.slice(from * this.meta.nq, this.qpos.len),
      cmd: this.cmd.buf.slice(from * 3, this.cmd.len), cam: this.cam.buf.slice(from * CAM_STRIDE, this.cam.len),
      hoist: this.hoist.buf.slice(from * 3, this.hoist.len), camOrientation: this.camOrientation.buf.slice(from * 4, this.camOrientation.len) };
  }

  /** The take, or null when fewer than two frames arrived. */
  finish(): Take | null {
    if (this.times.length < 2) return null;
    const values = new Float32Array(this.geometry.fixed.length + this.geom.len);
    values.set(this.geometry.fixed); values.set(this.geom.buf.subarray(0, this.geom.len), this.geometry.fixed.length);
    const geometry = new GeometryTrack(this.meta.ngeom, this.frames, { fixedIds: this.geometry.fixedIds.slice(), values });
    return new Take(this.meta, Float64Array.from(this.times), geometry, this.qpos.done(),
                    this.cmd.done(), this.cam.done(), this.hoist.done(), this.events,this.camOrientation.done());
  }
}

// ---- motion CSV ---------------------------------------------------------

/** Joint order for a motion CSV: among the specs compiled from the same model file as the take's
 * robot, the one with the most joints (a 20-DOF policy recorded on the 24-DOF EDU model exports all
 * 24). Same model file only: joint names repeat across robots (the R1 model carries every G1 name). */
export function csvJointNames(meta: TakeMeta): string[] {
  const have = new Set(meta.hinges.map((h) => h.name));
  const key = (s: RobotSpec) => `${s.model_dir}/${s.scene ?? "scene.xml"}`;
  const own = SPECS[meta.robot];
  const fits = Object.values(SPECS).filter((s) =>
    (!own || key(s) === key(own)) && s.joint_names.every((n) => have.has(n)));
  fits.sort((a, b) => b.joint_names.length - a.joint_names.length ||
                      Number(b.robot === meta.robot) - Number(a.robot === meta.robot));
  return fits[0]?.joint_names ?? meta.hinges.map((h) => h.name);
}

/** Resampled motion as CSV rows of [base pos (3), base quat xyzw (4), joint angles] — the format the
 * app's Reference clip loader (and most retargeting tools) read. Headerless; the rate is the caller's. */
export function motionCsv(take: Take, fps: number, t0 = 0, t1 = take.duration): string {
  const names = csvJointNames(take.meta);
  const adr = names.map((n) => take.meta.hinges.find((h) => h.name === n)?.qadr ?? -1);
  const q = new Float64Array(take.meta.nq), bq = take.meta.baseQadr;
  const rows: string[] = [];
  const N = Math.max(1, Math.floor((t1 - t0) * fps + 1e-6) + 1);
  const f = (x: number) => (Math.abs(x) < 5e-7 ? "0" : x.toFixed(6));
  for (let i = 0; i < N; i++) {
    take.qposAt(t0 + i / fps, q);
    const base = bq >= 0 ? [q[bq], q[bq + 1], q[bq + 2], q[bq + 4], q[bq + 5], q[bq + 6], q[bq + 3]] : [0, 0, 0, 0, 0, 0, 1];
    rows.push([...base, ...adr.map((a) => (a >= 0 ? q[a] : 0))].map(f).join(","));
  }
  return rows.join("\n") + "\n";
}

// ---- take files (.take.zip) ----------------------------------------------
// take.json (meta + events) and one raw little-endian array per track.

const FORMAT = "unitree-mujoco-web/take";

const zipAsync = (files: Record<string, Uint8Array>) => new Promise<Uint8Array>((res, rej) =>
  zip(files, { level: 6 }, (e, d) => (e ? rej(e) : res(d))));
const unzipAsync = (data: Uint8Array) => new Promise<Record<string, Uint8Array>>((res, rej) =>
  unzip(data, (e, d) => (e ? rej(e) : res(d))));
const bytes = (a: Float32Array | Float64Array | Uint32Array) => new Uint8Array(a.buffer, a.byteOffset, a.byteLength);

export async function saveTake(take: Take): Promise<Blob> {
  if (take.meta.look !== undefined && !validLook(take.meta.look)) throw new Error('take file: invalid recorded look');
  if (take.meta.display !== undefined && !validDisplay(take.meta.display)) throw new Error('take file: invalid recorded display');
  if (take.meta.flashlight !== undefined && typeof take.meta.flashlight !== 'boolean') throw new Error('take file: invalid recorded flashlight');
  if (take.meta.lights !== undefined && !validShotLights(take.meta.lights)) throw new Error('take file: invalid recorded lights');
  if (take.meta.edits !== undefined && !validShotEdits(take.meta.edits, take.meta.robot))
    throw new Error('take file: invalid shot edits');
  if(take.shot!==undefined&&!validShotCamera(take.shot))throw new Error('take file: invalid shot camera');
  if (take.range !== undefined && !validTakeRange(take.range, take.duration)) throw new Error('take file: invalid shot range');
  const head = { format: FORMAT, version: 2, frames: take.n, meta: take.meta, events: take.events };
  const files: Record<string, Uint8Array> = { "take.json": new TextEncoder().encode(JSON.stringify(head, null, 1)) };
  if(take.shot!==undefined)files['shot.json']=new TextEncoder().encode(JSON.stringify(take.shot));
  if (take.range !== undefined) files['range.json'] = new TextEncoder().encode(JSON.stringify(take.range));
  files["t.f64"] = bytes(take.t);
  files['geom.f32'] = bytes(take.geom.values);
  files['geom-fixed.u32'] = bytes(take.geom.fixedIds);
  for (const k of ['qpos', 'cmd', 'cam', 'hoist'] as const) files[`${k}.f32`] = bytes(take[k]);
  if(take.camOrientation)files['camOrientation.f32']=bytes(take.camOrientation);
  return new Blob([(await zipAsync(files)) as Uint8Array<ArrayBuffer>], { type: "application/zip" });
}

export async function loadTake(data: ArrayBuffer): Promise<Take> {
  const files = await unzipAsync(new Uint8Array(data));
  const raw = files["take.json"];
  if (!raw) throw new Error("not a take file (take.json missing)");
  const head = JSON.parse(new TextDecoder().decode(raw));
  if (head.format !== FORMAT) throw new Error("not a take file");
  if (head.version !== 1 && head.version !== 2) throw new Error('take file: unsupported version');
  const meta = head.meta as TakeMeta, n = Number(head.frames);
  if ((meta.terrain.startsWith('map:local-') || meta.localMap !== undefined) && !validLocalMap(meta.localMap,meta.terrain))
    throw new Error('take file: invalid local map identity');
  if (meta.look !== undefined && !validLook(meta.look)) throw new Error('take file: invalid recorded look');
  if (meta.display !== undefined && !validDisplay(meta.display)) throw new Error('take file: invalid recorded display');
  if (meta.flashlight !== undefined && typeof meta.flashlight !== 'boolean') throw new Error('take file: invalid recorded flashlight');
  if (meta.lights !== undefined && !validShotLights(meta.lights)) throw new Error('take file: invalid recorded lights');
  if (meta.edits !== undefined && !validShotEdits(meta.edits, meta.robot))
    throw new Error('take file: invalid shot edits');
  const arr = (name: string, per: number, f64 = false) => {
    const b = files[name];
    if (!b) throw new Error(`take file is missing ${name}`);
    const copy = b.slice().buffer;                // own, aligned buffer
    const a = f64 ? new Float64Array(copy) : new Float32Array(copy);
    if (a.length !== n * per) throw new Error(`take file: ${name} has ${a.length} values, expected ${n * per}`);
    return a;
  };
  const orientation=files['camOrientation.f32']?arr('camOrientation.f32',4) as Float32Array:undefined;
  if(orientation)for(let i=0;i<n;i++) {
    const q=Array.from(orientation.subarray(i*4,i*4+4));
    if(!q.every(Number.isFinite)||Math.hypot(...q)<1e-8)throw new Error('take file: invalid camera orientation');
  }
  let geometry: GeometryTrack;
  if (head.version === 1) geometry = GeometryTrack.dense(meta.ngeom, n, arr('geom.f32', meta.ngeom * GEOM_STRIDE) as Float32Array);
  else {
    const ids = files['geom-fixed.u32'], rawGeometry = files['geom.f32'];
    if (!ids || !rawGeometry || ids.byteLength % 4 || rawGeometry.byteLength % 4) throw new Error('take file: invalid geometry data');
    const data = { fixedIds: new Uint32Array(ids.slice().buffer), values: new Float32Array(rawGeometry.slice().buffer) };
    if (!validGeometryData(data, meta.ngeom, n)) throw new Error('take file: invalid geometry data');
    geometry = new GeometryTrack(meta.ngeom, n, data);
  }
  const take=new Take(meta, arr("t.f64", 1, true) as Float64Array, geometry,
                  arr("qpos.f32", meta.nq) as Float32Array, arr("cmd.f32", 3) as Float32Array,
                  arr("cam.f32", CAM_STRIDE) as Float32Array, arr("hoist.f32", 3) as Float32Array,
                  (head.events ?? []) as TakeEvent[],orientation);
  if(files['shot.json']) {
    let shot:unknown;
    try{shot=JSON.parse(new TextDecoder().decode(files['shot.json']));}
    catch{throw new Error('take file: invalid shot camera');}
    if(!validShotCamera(shot))throw new Error('take file: invalid shot camera');
    take.shot=shot;
  }
  if (files['range.json']) {
    let range: unknown;
    try { range = JSON.parse(new TextDecoder().decode(files['range.json'])); }
    catch { throw new Error('take file: invalid shot range'); }
    if (!validTakeRange(range, take.duration)) throw new Error('take file: invalid shot range');
    take.range = range;
  }
  return take;
}
