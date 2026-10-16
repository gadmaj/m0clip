/** Takes: a recorded stretch of the session. Every frame the sim worker posts while recording is
 * kept — each geom's world pose, the full qpos, the command the user was giving, the viewport
 * camera and the hoist — on the worker's frame clock (simulated seconds), together with the user's
 * discrete inputs as timeline events (FSM state, policy, remote moves, reset, hoist, clip).
 * The timeline plays a take back; the exporters resample it at any frame rate. */
import { unzip, zip } from "fflate";
import type { Command, RobotSpec } from "../core/types";
import { SPECS } from "../robots";

export type TakeEventKind = "state" | "policy" | "move" | "reset" | "hoist" | "clip";
export interface TakeEvent { t: number; kind: TakeEventKind; label: string }

export interface TakeMeta {
  robot: string;            // exact robot variant the model was compiled for (r1, r1_air, g1, ...)
  model?: string;           // display name of the variant ("R1 EDU · 24-DOF")
  terrain: string;
  policy: string;           // policy active when recording started
  created: string;          // ISO timestamp
  ngeom: number;
  nq: number;
  baseQadr: number;         // floating-base qpos address, -1 when none
  hinges: { name: string; qadr: number }[];
}

/** Per-frame layout of the geom track: position, then a wxyz quaternion. */
export const GEOM_STRIDE = 7;
/** Per-frame layout of the camera track: position, look-at target, vertical fov (deg). */
export const CAM_STRIDE = 7;

export interface CamPose { pos: [number, number, number]; target: [number, number, number]; fov: number }

/** Row-major 3x3 → unit wxyz quaternion (Shepperd), written to out[o..o+3]. */
function matToQuat(m: ArrayLike<number>, mo: number, out: Float32Array, o: number) {
  const m00 = m[mo], m01 = m[mo + 1], m02 = m[mo + 2];
  const m10 = m[mo + 3], m11 = m[mo + 4], m12 = m[mo + 5];
  const m20 = m[mo + 6], m21 = m[mo + 7], m22 = m[mo + 8];
  const tr = m00 + m11 + m22;
  let w, x, y, z;
  if (tr > 0) {
    const s = 2 * Math.sqrt(tr + 1);
    w = s / 4; x = (m21 - m12) / s; y = (m02 - m20) / s; z = (m10 - m01) / s;
  } else if (m00 > m11 && m00 > m22) {
    const s = 2 * Math.sqrt(1 + m00 - m11 - m22);
    w = (m21 - m12) / s; x = s / 4; y = (m01 + m10) / s; z = (m02 + m20) / s;
  } else if (m11 > m22) {
    const s = 2 * Math.sqrt(1 + m11 - m00 - m22);
    w = (m02 - m20) / s; x = (m01 + m10) / s; y = s / 4; z = (m12 + m21) / s;
  } else {
    const s = 2 * Math.sqrt(1 + m22 - m00 - m11);
    w = (m10 - m01) / s; x = (m02 + m20) / s; y = (m12 + m21) / s; z = s / 4;
  }
  const n = Math.hypot(w, x, y, z) || 1;
  out[o] = w / n; out[o + 1] = x / n; out[o + 2] = y / n; out[o + 3] = z / n;
}

/** Unit wxyz quaternion → row-major 3x3 at out[o..o+8]. */
function quatToMat(w: number, x: number, y: number, z: number, out: Float32Array, o: number) {
  out[o] = 1 - 2 * (y * y + z * z); out[o + 1] = 2 * (x * y - z * w); out[o + 2] = 2 * (x * z + y * w);
  out[o + 3] = 2 * (x * y + z * w); out[o + 4] = 1 - 2 * (x * x + z * z); out[o + 5] = 2 * (y * z - x * w);
  out[o + 6] = 2 * (x * z - y * w); out[o + 7] = 2 * (y * z + x * w); out[o + 8] = 1 - 2 * (x * x + y * y);
}

/** Short-arc normalized lerp of two wxyz quaternions (frames are 20 ms apart: as good as slerp). */
function nlerp(q: ArrayLike<number>, a: number, b: number, f: number, out: Float32Array | Float64Array, o: number) {
  const s = q[a] * q[b] + q[a + 1] * q[b + 1] + q[a + 2] * q[b + 2] + q[a + 3] * q[b + 3] < 0 ? -1 : 1;
  const w = q[a] + (s * q[b] - q[a]) * f, x = q[a + 1] + (s * q[b + 1] - q[a + 1]) * f;
  const y = q[a + 2] + (s * q[b + 2] - q[a + 2]) * f, z = q[a + 3] + (s * q[b + 3] - q[a + 3]) * f;
  const n = Math.hypot(w, x, y, z) || 1;
  out[o] = w / n; out[o + 1] = x / n; out[o + 2] = y / n; out[o + 3] = z / n;
}

export class Take {
  constructor(
    readonly meta: TakeMeta,
    readonly t: Float64Array,       // n — seconds from the first frame
    readonly geom: Float32Array,    // n · ngeom · GEOM_STRIDE
    readonly qpos: Float32Array,    // n · nq
    readonly cmd: Float32Array,     // n · 3 — vx, vy, wz as commanded
    readonly cam: Float32Array,     // n · CAM_STRIDE — the viewport camera
    readonly hoist: Float32Array,   // n · 3 — hoist anchor, NaN while the hoist is off
    readonly events: TakeEvent[],
  ) {}

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
    const S = this.meta.ngeom * GEOM_STRIDE, a0 = i * S, b0 = Math.min(i + 1, this.n - 1) * S, G = this.geom;
    for (let g = 0; g < this.meta.ngeom; g++) {
      const a = a0 + g * GEOM_STRIDE, b = b0 + g * GEOM_STRIDE, o = g * GEOM_STRIDE;
      for (let k = 0; k < 3; k++) out[o + k] = G[a + k] + (G[b + k] - G[a + k]) * f;
      nlerp(G, a + 3, b + 3, f, out, o + 3);
    }
  }

  private poseTmp: Float32Array | null = null;
  /** Interpolated geom transforms in the worker's frame layout (xpos ngeom·3, row-major xmat ngeom·9). */
  geomXformAt(time: number, xpos: Float32Array, xmat: Float32Array) {
    const p = this.poseTmp ??= new Float32Array(this.meta.ngeom * GEOM_STRIDE);
    this.geomPoseAt(time, p);
    for (let g = 0; g < this.meta.ngeom; g++) {
      const o = g * GEOM_STRIDE;
      xpos[3 * g] = p[o]; xpos[3 * g + 1] = p[o + 1]; xpos[3 * g + 2] = p[o + 2];
      quatToMat(p[o + 3], p[o + 4], p[o + 5], p[o + 6], xmat, 9 * g);
    }
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
    return { pos: [l(0), l(1), l(2)], target: [l(3), l(4), l(5)], fov: l(6) };
  }

  /** Hoist anchor at the nearest frame, or null while it was off. */
  hoistAt(time: number): [number, number, number] | null {
    const o = this.frameAt(time) * 3, H = this.hoist;
    return Number.isNaN(H[o]) ? null : [H[o], H[o + 1], H[o + 2]];
  }

  /** Commanded velocity at the nearest frame. */
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

/** Accumulates frames + events into a Take. Frames must belong to the model in `meta`. */
export class TakeRecorder {
  private t0 = NaN;
  private lastClock = -Infinity;
  private times: number[] = [];
  private geom = new Grow(1 << 16);
  private qpos = new Grow(1 << 14);
  private cmd = new Grow();
  private cam = new Grow();
  private hoist = new Grow();
  private events: TakeEvent[] = [];

  constructor(readonly meta: TakeMeta) {}

  get frames(): number { return this.times.length; }
  /** Seconds recorded so far (frame clock). */
  get elapsed(): number { return this.times.length ? this.times[this.times.length - 1] : 0; }
  /** Rough memory held, bytes. */
  get bytes(): number { return 4 * (this.geom.len + this.qpos.len) + 8 * this.times.length; }

  push(f: RecFrame, cmd: Command, cam: CamPose) {
    if (f.clock <= this.lastClock || f.xpos.length !== 3 * this.meta.ngeom || f.qpos.length !== this.meta.nq) return;
    if (Number.isNaN(this.t0)) this.t0 = f.clock;
    this.lastClock = f.clock;
    this.times.push(f.clock - this.t0);
    const ng = this.meta.ngeom, o = this.geom.reserve(ng * GEOM_STRIDE), G = this.geom.buf;
    for (let g = 0; g < ng; g++) {
      const k = o + g * GEOM_STRIDE;
      G[k] = f.xpos[3 * g]; G[k + 1] = f.xpos[3 * g + 1]; G[k + 2] = f.xpos[3 * g + 2];
      matToQuat(f.xmat, 9 * g, G, k + 3);
    }
    const qo = this.qpos.reserve(this.meta.nq);     // reserve first: it may swap in a bigger buffer
    this.qpos.buf.set(f.qpos, qo);
    this.cmd.push(cmd[0], cmd[1], cmd[2]);
    this.cam.push(...cam.pos, ...cam.target, cam.fov);
    const h = f.hoistAnchor;
    this.hoist.push(h ? h[0] : NaN, h ? h[1] : NaN, h ? h[2] : NaN);
  }

  /** Log a user input at the current end of the take. */
  mark(kind: TakeEventKind, label: string) {
    this.events.push({ t: this.elapsed, kind, label });
  }

  /** The take, or null when fewer than two frames arrived. */
  finish(): Take | null {
    if (this.times.length < 2) return null;
    return new Take(this.meta, Float64Array.from(this.times), this.geom.done(), this.qpos.done(),
                    this.cmd.done(), this.cam.done(), this.hoist.done(), this.events);
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
const TRACKS = ["t", "geom", "qpos", "cmd", "cam", "hoist"] as const;

const zipAsync = (files: Record<string, Uint8Array>) => new Promise<Uint8Array>((res, rej) =>
  zip(files, { level: 6 }, (e, d) => (e ? rej(e) : res(d))));
const unzipAsync = (data: Uint8Array) => new Promise<Record<string, Uint8Array>>((res, rej) =>
  unzip(data, (e, d) => (e ? rej(e) : res(d))));
const bytes = (a: Float32Array | Float64Array) => new Uint8Array(a.buffer, a.byteOffset, a.byteLength);

export async function saveTake(take: Take): Promise<Blob> {
  const head = { format: FORMAT, version: 1, frames: take.n, meta: take.meta, events: take.events };
  const files: Record<string, Uint8Array> = { "take.json": new TextEncoder().encode(JSON.stringify(head, null, 1)) };
  files["t.f64"] = bytes(take.t);
  for (const k of TRACKS.slice(1)) files[`${k}.f32`] = bytes(take[k]);
  return new Blob([(await zipAsync(files)) as Uint8Array<ArrayBuffer>], { type: "application/zip" });
}

export async function loadTake(data: ArrayBuffer): Promise<Take> {
  const files = await unzipAsync(new Uint8Array(data));
  const raw = files["take.json"];
  if (!raw) throw new Error("not a take file (take.json missing)");
  const head = JSON.parse(new TextDecoder().decode(raw));
  if (head.format !== FORMAT) throw new Error("not a take file");
  const meta = head.meta as TakeMeta, n = Number(head.frames);
  const arr = (name: string, per: number, f64 = false) => {
    const b = files[name];
    if (!b) throw new Error(`take file is missing ${name}`);
    const copy = b.slice().buffer;                // own, aligned buffer
    const a = f64 ? new Float64Array(copy) : new Float32Array(copy);
    if (a.length !== n * per) throw new Error(`take file: ${name} has ${a.length} values, expected ${n * per}`);
    return a;
  };
  return new Take(meta, arr("t.f64", 1, true) as Float64Array, arr("geom.f32", meta.ngeom * GEOM_STRIDE) as Float32Array,
                  arr("qpos.f32", meta.nq) as Float32Array, arr("cmd.f32", 3) as Float32Array,
                  arr("cam.f32", CAM_STRIDE) as Float32Array, arr("hoist.f32", 3) as Float32Array,
                  (head.events ?? []) as TakeEvent[]);
}
