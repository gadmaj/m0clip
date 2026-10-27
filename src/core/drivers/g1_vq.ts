/** ai_sport 1.5.4 "VQ-latent decoder" G1 FSMs, decoded from bench MNN captures (captures_154/probe2) and the
 * decompiled `humanoid` binary:
 *
 *   503 HumanMimic2 (dances)  decoder p_obs [10 x 93] + cmd [64] -> act [29]
 *   706 OneKeyBreak (get-up)  decoder p_obs [10 x 93] + cmd [64] -> act [29]
 *   504 TrajLoco (walking)    decoder p_obs [10 x 75] + cmd [163] -> act [23]; estimator p_obs + [0.5] -> v[2]
 *
 * Observation frame (history of 10, oldest first, one history shared by every net of the FSM):
 *   gyro (pelvis, raw) x 0.2 | projected gravity | q - default | dq x 0.05 | last raw net output
 * over all 29 joints (503/706) or the 23 non-wrist joints (504). Target = default + act (action_scale 1),
 * joints the net doesn't drive (504 wrists) are held at default (0). Gains are the config joint_kp/kd.
 *
 * cmd:
 *  - 503/706: one row of an offline latent CSV, L2-normalised; the row advances one per 50 Hz tick.
 *    503 runs the stance decoder on vq_stance_new while idle; a remote combo swaps in the dance decoder and
 *    streams its clip from row 0 to the last row, then goes back to stance (seamless, same history).
 *    706 (entered from damping, sitting in a deep squat) streams squat2stand rows 200..1000 in steps of 2
 *    (600 -> 800 and 900 -> 1000 are skipped), holds row 1000, and ramps kp from 0 over the first 100 ticks;
 *    actions are clipped to +-20.
 *  - 504: [anchor_motion_latent(64), 10 path blocks(9), block 0 again]. The remote sticks (deadzone,
 *    EMA 0.3, speed level 1: 2.5 / 1.2 / 2.5 max, accel limits) drive a reference twist that integrates a
 *    reference pose; the path is that pose rolled out at t = 0..0.9 s (EMA 0.3 over the points). Block i =
 *    [path_i - odom rotated into the robot's yaw frame and clipped to +-5*(0.02 + 0.1 i), 0,
 *    rot6d(R_base^T Rz(yaw_i))]. Odometry integrates the estimator's body velocity (world frame by IMU yaw)
 *    while the reference twist is non-zero, else it snaps to the reference pose. The stand-adjust decoder
 *    replaces the main one for the first 50 ticks and whenever 0.01 <= |last path point - odom| < 0.5
 *    (or its yaw error >= 0.05) with yaw error < 1.
 */
import { clip, matFromWxyz, matTVec } from "../math";
import type { Command, EvalConfig, RobotSpec } from "../types";
import type { Engine } from "../../sim/engine";
import type { OnnxSession } from "../policy";
import { BaseDriver } from "./base";
import { Task137, loadRows, resample } from "./g1_vq137";
import { fetchAsset } from '../prepared-assets';

/** `g1.vq` config block (all optional; defaults are the firmware values). */
/** one motion of the 137-dim family (Air 503 / 550) */
interface MotionCfg {
  file: string;               // aux_files role of the 135-column CSV
  start?: number;             // time_start / frame_start (s)
  end?: number;               // time_end / frame_end (s), <= 0: to the end
  fps?: number;
  mask_root_pos?: boolean;    // default true
  net?: string;               // aux_models role of the decoder (default: the main policy)
  combo?: string;             // remote mode: the remote combo that plays it (motion_string_map)
}

interface G1VqCfg {
  mode?: "dance" | "getup" | "traj" | "task";
  /** dance: aux_files roles of the clips played in order, and the stance latent role */
  clips?: string[];
  stance_latent?: string;
  pre_s?: number;             // stance before the first clip
  gap_s?: number;             // stance between clips
  /** getup: latent role, [first row, last row, rows per tick], row jumps [[from, to], ...], kp ramp ticks */
  latent?: string;
  frames?: [number, number, number];
  jumps?: [number, number][];
  kp_ramp?: number;
  act_clip?: number;
  spawn_quat?: number[];      // wxyz of the pelvis in the start pose
  stand_start?: boolean;      // getup: start standing at default (706 stand -> squat branch)
  done_after?: number;        // getup: ticks after the last row until the FSM hands over (sets done)
  /** task (137-dim cmd, g1_vq137.ts): stance CSV role (last row), stance net role, motions in order */
  motions?: MotionCfg[];
  /** task: stand on the stance row until a motion's remote `combo` is pressed (as on the robot) instead of
   * playing the motions in order; auto_exit_s then counts from the end of the first motion played */
  remote?: boolean;
  stance_net?: string;
  stance_task?: "track" | "identity";
  // task term while a motion plays: "odom" (= "track") feeds the root pose error / rot6d from the sim's ground-truth
  // base pose (what rt/state_estimator/fusion_odom provides on a robot with SLAM); "identity" = bench without odometry
  motion_task?: "odom" | "track" | "identity";
  final_transit?: boolean;    // blend back to stance after the last motion (default true; 550: false)
  transit_s?: number;
  post_s?: number;            // stance after the last motion
  auto_exit_s?: number;       // stance after the last motion before the FSM exits (sets done)
  masked_joints?: number[];   // joints absent on the robot variant (Air: waist roll/pitch, wrist pitch/yaw)
  max_root_pos_error?: number;
  min_root_pos_error?: number;
  /** traj: anchor latent, stick limits (speed level 1) and the estimator cmd */
  anchor?: number[];
  max_v?: number[]; max_acc?: number[]; low_acc_pts?: [number, number];
  deadzone?: number[]; back_v_max?: number; omega_drop_scale?: number; ema_alpha?: number;
  num_path_points?: number; dt_path_points?: number;
  stand_adjust_thresh?: [number, number]; should_stop_thresh?: [number, number];
  stand_adjust_ticks?: number;
  estimator_cmd?: number;
}

type TwistParams = {
  max_v: number[]; max_acc: number[]; low_acc_pts: [number, number]; deadzone: number[];
  back_v_max: number; omega_drop_scale: number; ema_alpha: number; num_path_points: number; dt_path_points: number;
};

const HIST = 10;
const DT = 0.02;

function wrap(a: number): number { return Math.atan2(Math.sin(a), Math.cos(a)); }
function smooth(t: number): number { return t * t * (3 - 2 * t); }
function yawOf(q: ArrayLike<number>): number {   // wxyz
  const w = q[0], x = q[1], y = q[2], z = q[3];
  return Math.atan2(2 * (w * z + x * y), 1 - 2 * (y * y + z * z));
}

/** Parse a latent CSV and L2-normalise every row (the firmware normalises the cmd). */
async function loadLatent(url: string): Promise<Float32Array[]> {
  const r = await fetchAsset(url);
  if (!r.ok) throw new Error(`failed to fetch latent ${url}: ${r.status}`);
  const rows: Float32Array[] = [];
  for (const line of (await r.text()).split("\n")) {
    if (!line.trim()) continue;
    const v = Float32Array.from(line.split(",").map(Number));
    let n = 0;
    for (const x of v) n += x * x;
    n = Math.sqrt(n) || 1;
    for (let i = 0; i < v.length; i++) v[i] /= n;
    rows.push(v);
  }
  return rows;
}

/** FsmTrajLoco remote -> reference twist / pose / path generator (fsm_traj_loco.cpp). */
export class TwistGen {
  pose = [0, 0, 0];           // reference x, y, yaw
  v = [0, 0, 0];              // rate-limited reference twist (body frame)
  tgt = [0, 0, 0];
  sf = [0, 0, 0];             // EMA of the dead-zoned sticks
  constructor(readonly c: TwistParams) {}
  reset(yaw: number) {
    this.pose = [0, 0, yaw]; this.v = [0, 0, 0]; this.tgt = [0, 0, 0]; this.sf = [0, 0, 0];
  }
  private acc(v: number, ax: number): number {
    const [lo, hi] = this.c.low_acc_pts, ma = this.c.max_acc[ax];
    const t = ax < 2 ? (Math.abs(v) - lo) / (hi - lo) : Math.abs(v) / 0.01;
    if (t < 0) return 1;
    if (t > 1) return ma;
    const k = smooth(t);
    return (1 - k) + ma * k;
  }
  private stepV(v: number[], dt: number): number[] {
    return v.map((x, ax) => { const a = this.acc(x, ax) * dt; return x + clip(this.tgt[ax] - x, -a, a); });
  }
  /** one 50 Hz tick; returns the smoothed path [x, y, yaw] x N */
  update(stick: number[]): number[][] {
    const c = this.c, a = c.ema_alpha;
    for (let i = 0; i < 3; i++) {
      const s = Math.abs(stick[i]) < c.deadzone[i] ? 0 : clip(stick[i], -1, 1);
      this.sf[i] = (1 - a) * s + a * this.sf[i];
    }
    let wz = this.sf[2] * c.max_v[2];
    const h = Math.hypot(this.v[0], this.v[1]);
    if (h > 0.8) wz /= 1 + (h - 0.8) * c.omega_drop_scale;
    this.tgt = [clip(c.max_v[0] * this.sf[0], -c.back_v_max, c.max_v[0]), c.max_v[1] * this.sf[1], wz];
    this.v = this.stepV(this.v, DT);
    const [x, y, yaw] = this.pose, co = Math.cos(yaw), si = Math.sin(yaw);
    this.pose = [x + DT * (co * this.v[0] - si * this.v[1]), y + DT * (co * this.v[1] + si * this.v[0]),
                 wrap(yaw + DT * this.v[2])];
    // roll-out at t_i = i * dt_path from the reference pose, then EMA over the points
    let [px, py, pyaw] = this.pose, v = this.v.slice(), prev = 0;
    const raw: number[][] = [];
    for (let i = 0; i < c.num_path_points; i++) {
      const t = i * c.dt_path_points, dt = t - prev; prev = t;
      v = this.stepV(v, dt);
      const cc = Math.cos(pyaw), ss = Math.sin(pyaw);
      px += dt * (cc * v[0] - ss * v[1]); py += dt * (cc * v[1] + ss * v[0]); pyaw = wrap(pyaw + dt * v[2]);
      raw.push([px, py, pyaw]);
    }
    const out = [raw[0].slice()];
    let cs = Math.cos(raw[0][2]), sn = Math.sin(raw[0][2]);
    for (let i = 1; i < raw.length; i++) {
      const p = out[i - 1];
      cs = (1 - a) * Math.cos(raw[i][2]) + a * cs; sn = (1 - a) * Math.sin(raw[i][2]) + a * sn;
      out.push([(1 - a) * raw[i][0] + a * p[0], (1 - a) * raw[i][1] + a * p[1], Math.atan2(sn, cs)]);
    }
    return out;
  }
}

export class G1VqDriver extends BaseDriver {
  private readonly mode: "dance" | "getup" | "traj" | "task";
  private readonly vq: G1VqCfg;
  private readonly ctrl: Int32Array;
  private readonly kp0: Float64Array;
  private readonly initPose: Float64Array;
  private hist: Float32Array[] = [];
  private lastRaw: Float32Array;
  private ready: Promise<void> | null = null;
  private tick = 0;

  // dance / getup
  private stance: Float32Array | null = null;
  private clips: Float32Array[][] = [];
  private latent: Float32Array[] = [];
  private sched: { clip: number; row: number }[] = [];   // clip -1 = stance
  private frame = 0;

  private endTicks = 0;

  // task (137-dim cmd)
  private task: Task137 | null = null;
  private stanceRow: Float32Array | null = null;
  private tsched: { kind: "stance" | "motion" | "transit"; row: Float32Array | null; m: number; mask: boolean;
                    align?: boolean }[] = [];
  private masked: Int32Array = new Int32Array(0);
  private readonly cmd137 = new Float32Array(137);
  private motionRows: Float32Array[][] = [];   // remote mode: rows of each motion
  private played = false;                      // remote mode: a motion was triggered

  private trajTick = 0;

  // traj
  private tw: TwistGen | null = null;
  private odom = [0, 0];
  private anchor = new Float32Array(64);
  activeNet = "main";

  constructor(cfg: EvalConfig, spec: RobotSpec, eng: Engine, readonly sess: OnnxSession,
              readonly aux: Record<string, OnnxSession>, readonly files: Record<string, string>) {
    super(cfg, spec, eng);
    const g = cfg.g1!;
    this.vq = (g.vq ?? {}) as G1VqCfg;
    const fsm = g.fsm_id;
    this.mode = this.vq.mode ?? (fsm === 706 ? "getup" : fsm === 504 ? "traj" : "dance");
    this.ctrl = Int32Array.from(g.control_joints);
    this.default = Float64Array.from(g.default_dof_pos);
    this.kp0 = Float64Array.from(g.kp ?? Array(this.n).fill(40));
    this.kp = Float64Array.from(this.kp0);
    this.kd = Float64Array.from(g.kd ?? Array(this.n).fill(1));
    if (g.tau) this.lim = Float64Array.from(g.tau);
    this.initPose = Float64Array.from(g.init_pose ?? g.default_dof_pos);
    this.lastRaw = new Float32Array(this.ctrl.length);
    this.lastAction = new Float32Array(this.ctrl.length);
    this.actJointNames = Array.from(this.ctrl, (i) => this.names[i]);
    this.stackDepth = HIST;
    const nj = this.ctrl.length;
    this.frameLayout = [["base_ang_vel", 3], ["projected_gravity", 3], ["joint_pos", nj], ["joint_vel", nj],
                        ["last_action", nj]];
    if (this.mode === "dance" || this.mode === "task") this.clipDriven = true;
    if (this.mode === "task") {
      this.masked = Int32Array.from(this.vq.masked_joints ?? []);
      this.task = new Task137({ maxErr: this.vq.max_root_pos_error ?? 1.0, minErr: this.vq.min_root_pos_error ?? 0 });
    }
    if (this.mode === "getup") { this.groundStart = !this.vq.stand_start; this.maneuver = true; }
    if (this.mode === "traj") {
      this.needsCommand = true;
      const v = this.vq, mv = v.max_v ?? [2.5, 1.2, 2.5], back = v.back_v_max ?? 1.5;
      this.velRange = g.vel_range ?? [-back, mv[0], -mv[1], mv[1], -mv[2], mv[2]];
      this.tw = new TwistGen({
        max_v: mv, max_acc: v.max_acc ?? [1.2, 1, 4], low_acc_pts: v.low_acc_pts ?? [0.5, 1],
        deadzone: v.deadzone ?? [0.1, 0.1, 0.1], back_v_max: back, omega_drop_scale: v.omega_drop_scale ?? 2,
        ema_alpha: v.ema_alpha ?? 0.3, num_path_points: v.num_path_points ?? 10,
        dt_path_points: v.dt_path_points ?? 0.1,
      });
      if (v.anchor) this.anchor = Float32Array.from(v.anchor);
    }
  }

  /** Fetch the latent CSVs (once) and build the dance schedule. */
  prepare(): Promise<void> {
    this.ready ??= (async () => {
      const v = this.vq;
      if (this.mode === "dance") {
        const stRole = v.stance_latent ?? "stance";
        if (!this.files[stRole]) throw new Error(`${this.name}: aux_files.${stRole} (stance latent) missing`);
        this.stance = (await loadLatent(this.files[stRole]))[0];
        const roles = v.clips ?? Object.keys(this.files).filter((k) => k !== stRole).sort();
        this.clips = await Promise.all(roles.map((r) => loadLatent(this.files[r])));
        const pre = Math.round((v.pre_s ?? 2) / DT), gap = Math.round((v.gap_s ?? 1) / DT);
        const s: { clip: number; row: number }[] = Array.from({ length: pre }, () => ({ clip: -1, row: 0 }));
        this.clips.forEach((c, i) => {
          for (let r = 0; r < c.length; r++) s.push({ clip: i, row: r });
          if (i < this.clips.length - 1) for (let k = 0; k < gap; k++) s.push({ clip: -1, row: 0 });
        });
        this.sched = s;
      } else if (this.mode === "task") {
        const stRole = v.stance_latent ?? "stance";
        if (!this.files[stRole]) throw new Error(`${this.name}: aux_files.${stRole} (stance csv) missing`);
        const st = await loadRows(this.files[stRole]);
        this.stanceRow = st[st.length - 1];
        const ms = v.motions ?? [];
        const cache: Record<string, Promise<Float32Array[]>> = {};
        const rows = await Promise.all(ms.map((m) => {
          if (!this.files[m.file]) throw new Error(`${this.name}: aux_files.${m.file} (motion csv) missing`);
          return (cache[m.file] ??= loadRows(this.files[m.file]))
            .then((r) => resample(r, m.start ?? 0, m.end ?? 0, m.fps ?? 50));
        }));
        const S = this.stanceRow, sched: typeof this.tsched = [];
        this.motionRows = rows;
        if (v.remote) { this.tsched = []; return; }          // stance until a combo (remote())
        const stance = (secs: number) => { for (let k = 0, n = Math.round(secs / DT); k < n; k++)
          sched.push({ kind: "stance", row: S, m: -1, mask: true }); };
        stance(v.pre_s ?? 2);
        rows.forEach((_, i) => {
          this.pushMotion(sched, i, !(i === rows.length - 1 && v.final_transit === false));
          if (i < rows.length - 1) stance(v.gap_s ?? 1);
        });
        this.tsched = sched;
      } else if (this.mode === "getup") {
        const role = v.latent ?? "latent";
        if (!this.files[role]) throw new Error(`${this.name}: aux_files.${role} (latent) missing`);
        this.latent = await loadLatent(this.files[role]);
      }
    })();
    return this.ready;
  }

  /** Append motion i (its rows, then the blend back to the stance row over transit_s) to a task schedule. */
  private pushMotion(sched: typeof this.tsched, i: number, transit: boolean) {
    const v = this.vq, R = this.motionRows[i], S = this.stanceRow!;
    const mask = v.motions![i].mask_root_pos ?? true;
    R.forEach((r, k) => sched.push({ kind: "motion", row: r, m: i, mask, align: k === 0 }));
    const last = R[R.length - 1], nt = Math.round((v.transit_s ?? 0.5) / DT);
    for (let k = 1; transit && k <= nt; k++) {   // blend back to stance
      const a = 1 - k / nt, b = new Float32Array(last.length);
      for (let c = 0; c < b.length; c++) b[c] = a * last[c] + (1 - a) * S[c];
      sched.push({ kind: "transit", row: b, m: i, mask: true });
    }
  }

  override remoteCombos(): string[] {
    if (this.mode !== "task" || !this.vq.remote) return [];
    return (this.vq.motions ?? []).map((m) => m.combo).filter((c): c is string => !!c);
  }

  /** remote mode: a motion's combo starts it when the robot stands idle (nothing playing, not handing over). */
  override remote(combo: string) {
    if (!this.remoteCombos().includes(combo) || !this.motionRows.length || this.done) return;
    if (this.tick < this.tsched.length) return;                  // a motion is still playing / blending
    const i = this.vq.motions!.findIndex((m) => m.combo === combo);
    const S = this.stanceRow!;
    while (this.tsched.length < this.tick) this.tsched.push({ kind: "stance", row: S, m: -1, mask: true });
    this.pushMotion(this.tsched, i, this.vq.final_transit !== false);
    this.played = true;
  }

  override reset() {
    if (this.mode === "task" && this.vq.remote) { this.tsched = []; this.played = false; }
    if (this.mode === "getup" && !this.vq.stand_start) {
      const q = this.vq.spawn_quat ?? [1, 0, 0, 0];
      const all = Array.from({ length: this.eng.model.nbody }, (_, i) => i).filter((i) => i !== 0);
      this.seat(this.initPose, q, all, 0.005);
    } else {
      this.seat(this.default, [1, 0, 0, 0], this.feet, 0.002);
    }
    this.hist = [];
    this.tick = 0;
    this.lastRaw = new Float32Array(this.ctrl.length);
    this.lastAction = new Float32Array(this.ctrl.length);
    this.kp.set(this.kp0);
    this.frame = (this.vq.frames ?? [200, 1000, 2])[0];
    this.odom = [0, 0];
    this.activeNet = "main";
    this.endTicks = 0;
    this.done = false;
    this.trajTick = 0;
  }

  /** push the newest obs frame; return the 10-frame history (oldest first, padded with the first frame) */
  private observe(): Float32Array {
    const [q, qd] = this.readQ();
    const w = this.baseAngVel();
    const g = matTVec(matFromWxyz(this.baseQuat()), [0, 0, -1]);
    const n = this.ctrl.length;
    const f = new Float32Array(6 + 3 * n);
    for (let i = 0; i < 3; i++) { f[i] = w[i] * 0.2; f[3 + i] = g[i]; }
    for (let i = 0; i < n; i++) {
      const j = this.ctrl[i];
      f[6 + i] = q[j] - this.default[j];
      f[6 + n + i] = qd[j] * 0.05;
      f[6 + 2 * n + i] = this.lastRaw[i];
    }
    for (const j of this.masked) {        // joints absent on the robot variant read 0
      const i = this.ctrl.indexOf(j);
      if (i >= 0) { f[6 + i] = 0; f[6 + n + i] = 0; f[6 + 2 * n + i] = 0; }
    }
    for (let i = 0; i < f.length; i++) f[i] = clip(f[i], -100, 100);
    this.hist.push(f);
    if (this.hist.length > HIST) this.hist = this.hist.slice(-HIST);
    this.lastFrame = f;
    const p = new Float32Array(HIST * f.length);
    const pad = HIST - this.hist.length;
    for (let k = 0; k < HIST; k++) p.set(this.hist[Math.max(0, k - pad)], k * f.length);
    return p;
  }

  private run(sess: OnnxSession, pObs: Float32Array, cmd: Float32Array): Promise<Float32Array> {
    const fd = pObs.length / HIST;
    return sess.run({ p_obs: { data: pObs, dims: [1, HIST, fd] }, cmd: { data: cmd, dims: [1, cmd.length] } });
  }

  async step(command: Command): Promise<Float64Array> {
    await this.prepare();
    const pObs = this.observe();
    let act: Float32Array;
    if (this.mode === "dance") act = await this.stepDance(pObs);
    else if (this.mode === "getup") act = await this.stepGetup(pObs);
    else if (this.mode === "task") act = await this.stepTask(pObs);
    else act = await this.stepTraj(pObs, command);
    this.lastRaw = Float32Array.from(act);
    this.lastAction = act;
    this.tick++;
    const target = Float64Array.from(this.default);
    for (let i = 0; i < this.ctrl.length; i++) target[this.ctrl[i]] = this.default[this.ctrl[i]] + act[i];
    return target;
  }

  private stepDance(pObs: Float32Array): Promise<Float32Array> {
    const s = this.sched[this.tick];
    if (s && s.clip >= 0) {
      this.activeNet = `clip${s.clip}`;
      return this.run(this.sess, pObs, this.clips[s.clip][s.row]);
    }
    this.activeNet = "stance";
    return this.run(this.aux.stance ?? this.sess, pObs, this.stance!);
  }

  private async stepGetup(pObs: Float32Array): Promise<Float32Array> {
    const v = this.vq, [, end, inc] = v.frames ?? [200, 1000, 2];
    const row = this.latent[Math.min(Math.floor(this.frame), this.latent.length - 1)];
    // kp ramps from 0 over the first kp_ramp ticks (count taken before the increment, as the firmware does)
    const ramp = v.kp_ramp ?? 100, s = ramp > 0 ? Math.min(this.tick, ramp) / ramp : 1;
    for (let i = 0; i < this.n; i++) this.kp[i] = this.kp0[i] * s;
    const lim = v.act_clip ?? 20;
    const act = (await this.run(this.sess, pObs, row)).map((a) => clip(a, -lim, lim));
    this.activeNet = `row ${Math.floor(this.frame)}`;
    if (this.frame >= end && v.done_after !== undefined && ++this.endTicks >= v.done_after) this.done = true;
    this.frame = Math.min(this.frame + inc, end);
    for (const [from, to] of v.jumps ?? [[600, 800], [900, 1000]]) if (this.frame === from) { this.frame = to; break; }
    return act;
  }

  private async stepTask(pObs: Float32Array): Promise<Float32Array> {
    const v = this.vq, task = this.task!;
    const s = this.tsched[this.tick];
    const p = this.eng.qpos.slice(this.bqp, this.bqp + 3), q = this.baseQuat();
    if (this.tick === 0) task.align(p, q, this.stanceRow!);
    let sess = v.stance_net ? this.aux[v.stance_net] ?? this.sess : this.sess;
    const cmd = this.cmd137;
    if (s && s.kind === "motion") {
      const m = v.motions![s.m];
      if (s.align) task.align(p, q, s.row!);
      if (m.net && this.aux[m.net]) sess = this.aux[m.net];
      else if (!m.net) sess = this.sess;
      cmd.set(s.row!.subarray(0, 128), 0);
      task.fill(cmd, 128, p, q, v.motion_task === "identity" ? null : s.row, s.mask);
      this.activeNet = `motion${s.m}`;
    } else {
      const row = s ? s.row! : this.stanceRow!;
      const end = this.tsched.length;
      if (!s && this.tick === end) task.align(p, q, row);
      cmd.set(row.subarray(0, 128), 0);
      task.fill(cmd, 128, p, q, v.stance_task === "identity" ? null : row, true);
      this.activeNet = s ? s.kind : "stance";
      if (!s && v.auto_exit_s !== undefined && (!v.remote || this.played) &&
          this.tick - end >= Math.round(v.auto_exit_s / DT)) this.done = true;
    }
    const act = (await this.run(sess, pObs, cmd)).map((a) => clip(a, -20, 20));
    for (const j of this.masked) { const i = this.ctrl.indexOf(j); if (i >= 0) act[i] = 0; }
    return act;
  }

  private async stepTraj(pObs: Float32Array, command: Command): Promise<Float32Array> {
    const tw = this.tw!, v = this.vq, mv = tw.c.max_v;
    const bq = this.baseQuat();
    this.trajTick = this.tick;
    if (this.trajTick === 0) { tw.reset(yawOf(bq)); this.odom = [0, 0]; }
    const vr = this.velRange!;
    const stick = [clip(command[0], vr[0], vr[1]) / mv[0], clip(command[1], vr[2], vr[3]) / mv[1],
                   clip(command[2], vr[4], vr[5]) / mv[2]];
    const P = tw.update(stick);
    // path blocks relative to the odometry position and the IMU orientation
    const yaw = yawOf(bq), cy = Math.cos(yaw), sy = Math.sin(yaw);
    const R = matFromWxyz(bq);
    const n = P.length, cmd = new Float32Array(64 + 9 * (n + 1));
    cmd.set(this.anchor, 0);
    for (let i = 0; i < n; i++) {
      const dx = P[i][0] - this.odom[0], dy = P[i][1] - this.odom[1], lim = 5 * (DT + i * tw.c.dt_path_points);
      const ct = Math.cos(P[i][2]), st = Math.sin(P[i][2]);
      // rot6d of R^T Rz(yaw_i): first two columns, row-interleaved [m00, m01, m10, m11, m20, m21]
      const m: number[] = [];
      for (let r = 0; r < 3; r++) m.push(R[r] * ct + R[3 + r] * st, -R[r] * st + R[3 + r] * ct);
      cmd.set([clip(cy * dx + sy * dy, -lim, lim), clip(-sy * dx + cy * dy, -lim, lim), 0, ...m], 64 + 9 * i);
    }
    cmd.set(cmd.slice(64, 73), 64 + 9 * n);
    // stand-adjust decoder: first ticks after entry, or near-but-not-at the end of the path
    const [thD, thY] = v.stand_adjust_thresh ?? [0.5, 1.0], [stD, stY] = v.should_stop_thresh ?? [0.01, 0.05];
    const last = P[n - 1], dist = Math.hypot(this.odom[0] - last[0], this.odom[1] - last[1]);
    const ye = Math.abs(wrap(yaw - last[2]));
    const adjust = this.trajTick++ < (v.stand_adjust_ticks ?? 50) || ((dist >= stD || ye >= stY) && dist < thD && ye < thY);
    const dec = adjust && this.aux.stand_adjust ? this.aux.stand_adjust : this.sess;
    this.activeNet = dec === this.sess ? "traj_loco" : "stand_adjust";
    const act = await this.run(dec, pObs, cmd);
    // odometry from the velocity estimator (runs after the decoder on the same obs)
    if (Math.hypot(tw.v[0], tw.v[1], tw.v[2]) <= 0) {
      this.odom = [tw.pose[0], tw.pose[1]];
    } else if (this.aux.estimator) {
      const e = await this.run(this.aux.estimator, pObs, new Float32Array([v.estimator_cmd ?? 0.5]));
      const ex = clip(e[0], -8, 8), ey = clip(e[1], -8, 8);
      const wx = ex * cy - ey * sy, wy = ex * sy + ey * cy;
      if (Math.abs(wx) > 0.01) this.odom[0] += DT * wx;
      if (Math.abs(wy) > 0.01) this.odom[1] += DT * wy;
    }
    return act;
  }
}
