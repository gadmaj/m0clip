/** ai_sport 1.5.4 FSM 505 "FsmPunchMode" (G1 EDU 29-DOF), decoded from the `humanoid` binary
 * (fsm_punch_mode.cpp: run loop sub_560C40, buttons sub_55FB30, twist sub_55A0E0, trajectories / fall
 * protection sub_55A9D0 + sub_559360, handler sub_55BCB0, targets sub_55EE70, odometry sub_559610) and checked
 * term by term against the bench MNN captures (tools/ai_sport_probe/captures_154/probe6/505*).
 *
 * Nets (policies/punch_mode): walk decoder g1_punch_walk_12500 (+ its estimator), punch_29dof_28000 (every
 * punch move + the entry clip), punch_29dof_add_getup_46000 (get down / get up). The config's `traj_loco` and
 * `traj_loco_stand_adjust` gaits are two sessions of the SAME walk decoder file, so the stand-adjust switch is
 * numerically irrelevant and not modelled.
 *
 * Per 50 Hz tick, in firmware order:
 *  1. twist     while no trajectory plays: sticks -> dead zone 0.1 -> EMA 0.3 -> rate-limited reference twist
 *               (speed level 1: max 0.8 / 0.6 / 2.0, accel 1.2 / 1 / 4, smoothstep low-accel band 0.5..1) ->
 *               reference pose -> 10-point path (0.1 s apart, EMA 0.3), exactly FSM 504's generator.
 *  2. obs       frame = [gyro·0.2, projected gravity, q − default, dq·0.05, last action] over the 23 joints
 *               without wrists, clipped ±100; 10-frame history, oldest first, filled with the first frame.
 *  3. combo     a remote combo from `combos` starts its trajectory when none plays or the current one is within
 *               its last 10 rows (then it replaces it). Punches need the upright state; `get_up` needs the fall
 *               pose to be complete (≥ fall_down_length) and picks the face-up (front) or face-down (back)
 *               get-up by the fall side. Starting (and ending) a trajectory resets the twist (v = 0, heading =
 *               IMU yaw). On the robot a combo = the first-listed key pressed while the modifier is held;
 *               single-key entries need a double press (< 0.5 s) — that is why bare keys "did nothing" on the
 *               bench. The web fires the named combo directly.
 *  4. trajectory rows round(t_start·fps) .. round(t_end·fps) of the take CSV (latent 64 | pos 3 | quat wxyz),
 *               one per tick; after the last row the walker takes over in the same tick. cmd (73) =
 *               [latent row (raw), 0, 0, 0 (mask_root_pos_error), rot6d(q_off · q_ref · q_robot⁻¹)], q_off =
 *               yaw-only part of q_robot · q_ref0⁻¹ at the trajectory's first row (bench: exact).
 *               FSM entry plays the default clip (vq_Take_007 clip_70_128, whole file) on the punch net.
 *  5. fall      while walking, or in a trajectory with rot_detect = 1: projected gravity z > −0.5 starts the fall
 *               pose — trajectory dropped, all 29 targets = a·down_jpos[side] + (1 − a)·q_at_fall,
 *               a = t / fall_down_length (2 s), side = gravity x ≥ −0.1 (face down → back_down_jpos, else
 *               front_down_jpos); the net still runs but its action is zeroed (last action = 0). Stays there
 *               until L2+Up (get_up). rot_detect = 0 trajectories (get up / get down) are never interrupted.
 *  6. walk cmd  (163) = [anchor_motion_latent, 10 path blocks, block 0 again]; block = [path − odom in the robot
 *               yaw frame (no clip), 0, rot6d(Rz(yaw_i) · R_base^T)] (bench: exact to float precision).
 *  7. targets   default + clip(act, ±20) (action_scale 1) for the 23 joints, wrists at 0; kp/kd = config.
 *  8. odometry  estimator(p_obs, [0.5]) → body v clipped ±8; while the reference twist is non-zero odom += v
 *               (world, per axis only when |v| > 0.01)·dt, else odom snaps to the reference pose (use_ai_odom).
 * The firmware only leaves 505 by remote (or low battery → 802), so the pack has no next_policy.
 */
import { clip, matFromWxyz, matTVec } from "../math";
import type { Command, EvalConfig, RobotSpec } from "../types";
import type { Engine } from "../../sim/engine";
import type { OnnxSession } from "../policy";
import { BaseDriver } from "./base";
import { Task137, loadRows, qyaw, resample } from "./g1_vq137";
import { TwistGen } from "./g1_vq";

const HIST = 10;
const DT = 0.02;

interface TrajCfg {
  file: string;          // aux_files role of the take CSV
  start?: number;        // t_start (s); omitted = whole file
  end?: number;          // t_end (s)
  fps?: number;
  rot_detect?: number;   // 1 = fall protection may interrupt it
  net?: string;          // aux_models role of the decoder
}

interface PunchCfg {
  anchor: number[];
  max_v?: number[]; max_acc?: number[]; low_acc_pts?: [number, number];
  deadzone?: number[]; back_v_max?: number; omega_drop_scale?: number; ema_alpha?: number;
  num_path_points?: number; dt_path_points?: number;
  estimator_cmd?: number;
  latent_dim?: number;
  trajs: Record<string, TrajCfg>;
  /** remote combo ("R1+Up", "L2+Down", "A", …) -> trajectory name, or "get_up" */
  combos: Record<string, string>;
  default_traj: string;
  front_get_up: string;
  back_get_up: string;
  projected_gravity_protect?: number;
  fall_down_length?: number;
  front_down_jpos: number[];
  back_down_jpos: number[];
  /** firmware behaviour: a combo may replace the playing trajectory within its last N rows */
  replace_rows?: number;
}

interface Traj { name: string; rows: Float32Array[]; rot: number; net: OnnxSession }

export class G1PunchDriver extends BaseDriver {
  private readonly p: PunchCfg;
  private readonly ctrl: Int32Array;
  private readonly tw: TwistGen;
  private readonly task: Task137;
  private readonly anchor: Float32Array;
  private trajs: Record<string, Traj> = {};
  private ready: Promise<void> | null = null;
  private hist: Float32Array[] = [];
  private lastRaw: Float32Array;
  private odom = [0, 0];
  private cur: Traj | null = null;
  private idx = -1;               // row of the playing trajectory (-1 = walking)
  private fallT = 0;              // fall-pose timer (s)
  private side = 2;               // 2 = upright, 0 = fallen face up, 1 = fallen face down
  private fallQ0: Float64Array | null = null;
  private pending: string | null = null;
  private started = false;
  activeNet = "walk";

  constructor(cfg: EvalConfig, spec: RobotSpec, eng: Engine, readonly sess: OnnxSession,
              readonly aux: Record<string, OnnxSession>, readonly files: Record<string, string>) {
    super(cfg, spec, eng);
    const g = cfg.g1!;
    this.p = g.punch as PunchCfg;
    if (!this.p) throw new Error(`${cfg.name}: g1.punch config block missing`);
    this.ctrl = Int32Array.from(g.control_joints);
    this.default = Float64Array.from(g.default_dof_pos);
    this.kp = Float64Array.from(g.kp ?? Array(this.n).fill(40));
    this.kd = Float64Array.from(g.kd ?? Array(this.n).fill(1));
    if (g.tau) this.lim = Float64Array.from(g.tau);
    const nj = this.ctrl.length;
    this.lastRaw = new Float32Array(nj);
    this.lastAction = new Float32Array(nj);
    this.actJointNames = Array.from(this.ctrl, (i) => this.names[i]);
    this.stackDepth = HIST;
    this.frameLayout = [["base_ang_vel", 3], ["projected_gravity", 3], ["joint_pos", nj], ["joint_vel", nj],
                        ["last_action", nj]];
    this.needsCommand = true;
    const p = this.p, mv = p.max_v ?? [0.8, 0.6, 2.0], back = p.back_v_max ?? 1.5;
    this.velRange = g.vel_range ?? [-Math.min(back, mv[0]), mv[0], -mv[1], mv[1], -mv[2], mv[2]];
    this.tw = new TwistGen({
      max_v: mv, max_acc: p.max_acc ?? [1.2, 1, 4], low_acc_pts: p.low_acc_pts ?? [0.5, 1],
      deadzone: p.deadzone ?? [0.1, 0.1, 0.1], back_v_max: back, omega_drop_scale: p.omega_drop_scale ?? 2,
      ema_alpha: p.ema_alpha ?? 0.3, num_path_points: p.num_path_points ?? 10, dt_path_points: p.dt_path_points ?? 0.1,
    });
    this.anchor = Float32Array.from(p.anchor);
    this.task = new Task137({ maxErr: 1.0, minErr: 0, latentDim: p.latent_dim ?? 64 });
  }

  /** remote combos this pack reacts to (UI buttons / gamepad pass-through) */
  override remoteCombos(): string[] { return Object.keys(this.p.combos); }

  /** queue a remote combo; handled at the next control tick like the firmware's button scan */
  override remote(combo: string) { if (this.p.combos[combo]) this.pending = combo; }

  prepare(): Promise<void> {
    this.ready ??= (async () => {
      const cache: Record<string, Promise<Float32Array[]>> = {};
      for (const [name, t] of Object.entries(this.p.trajs)) {
        const url = this.files[t.file];
        if (!url) throw new Error(`${this.name}: aux_files.${t.file} (trajectory csv) missing`);
        const all = await (cache[t.file] ??= loadRows(url));
        const rows = t.start === undefined ? all : resample(all, t.start, t.end ?? 0, t.fps ?? 50);
        const net = t.net ? this.aux[t.net] : undefined;
        if (!net) throw new Error(`${this.name}: aux_models.${t.net} (decoder of ${name}) missing`);
        this.trajs[name] = { name, rows, rot: t.rot_detect ?? 1, net };
      }
      for (const n of [this.p.default_traj, this.p.front_get_up, this.p.back_get_up, ...Object.values(this.p.combos)])
        if (n !== "get_up" && !this.trajs[n]) throw new Error(`${this.name}: trajectory ${n} not in punch.trajs`);
    })();
    return this.ready;
  }

  override reset() {
    this.seat(this.default, [1, 0, 0, 0], this.feet, 0.002);
    this.hist = [];
    this.lastRaw = new Float32Array(this.ctrl.length);
    this.lastAction = new Float32Array(this.ctrl.length);
    this.odom = [0, 0];
    this.cur = null; this.idx = -1; this.fallT = 0; this.side = 2; this.fallQ0 = null;
    this.pending = null; this.started = false; this.maneuver = false;
    this.done = false;
    this.activeNet = "walk";
  }

  private pose(): [Float64Array, Float64Array] {
    return [this.eng.qpos.slice(this.bqp, this.bqp + 3), this.baseQuat()];
  }

  private startTraj(t: Traj) {
    const [p, q] = this.pose();
    this.cur = t; this.idx = 0;
    this.task.align(p, q, t.rows[0]);
    this.resetTwist(q);
  }

  /** firmware twist reset at trajectory start / end: v = 0, heading = IMU yaw, position kept */
  private resetTwist(q: ArrayLike<number>) {
    const tw = this.tw;
    tw.pose = [tw.pose[0], tw.pose[1], qyaw(q)];
    tw.v = [0, 0, 0]; tw.tgt = [0, 0, 0]; tw.sf = [0, 0, 0];
  }

  private observe(q: Float64Array, qd: Float64Array, g: number[]): Float32Array {
    const w = this.baseAngVel(), n = this.ctrl.length;
    const f = new Float32Array(6 + 3 * n);
    for (let i = 0; i < 3; i++) { f[i] = w[i] * 0.2; f[3 + i] = g[i]; }
    for (let i = 0; i < n; i++) {
      const j = this.ctrl[i];
      f[6 + i] = q[j] - this.default[j];
      f[6 + n + i] = qd[j] * 0.05;
      f[6 + 2 * n + i] = this.lastRaw[i];
    }
    for (let i = 0; i < f.length; i++) f[i] = clip(f[i], -100, 100);
    this.hist.push(f);
    if (this.hist.length > HIST) this.hist = this.hist.slice(-HIST);
    this.lastFrame = f;
    const out = new Float32Array(HIST * f.length), pad = HIST - this.hist.length;
    for (let k = 0; k < HIST; k++) out.set(this.hist[Math.max(0, k - pad)], k * f.length);
    return out;
  }

  private run(sess: OnnxSession, pObs: Float32Array, cmd: Float32Array): Promise<Float32Array> {
    return sess.run({ p_obs: { data: pObs, dims: [1, HIST, pObs.length / HIST] },
                      cmd: { data: cmd, dims: [1, cmd.length] } });
  }

  async step(command: Command): Promise<Float64Array> {
    await this.prepare();
    const p = this.p, tw = this.tw, mv = tw.c.max_v;
    const [q, qd] = this.readQ();
    const [pos, bq] = this.pose();
    const g = matTVec(matFromWxyz(bq), [0, 0, -1]);
    if (!this.started) {                       // FSM entry: twist at the IMU heading, default clip on the punch net
      this.started = true;
      tw.reset(qyaw(bq));
      this.startTraj(this.trajs[p.default_traj]);
    }
    // 1. twist (only while walking)
    const vr = this.velRange!;
    const stick = [clip(command[0], vr[0], vr[1]) / mv[0], clip(command[1], vr[2], vr[3]) / mv[1],
                   clip(command[2], vr[4], vr[5]) / mv[2]];
    let path = this.idx < 0 ? tw.update(stick) : null;
    // 2. obs
    const pObs = this.observe(q, qd, g);
    // 3. combo
    if (this.pending) {
      let name: string | null = p.combos[this.pending];
      this.pending = null;
      const near = !this.cur || this.idx < 0 || this.idx >= this.cur.rows.length - (p.replace_rows ?? 10);
      if (name === "get_up")
        name = this.side !== 2 && this.fallT >= (p.fall_down_length ?? 2) ? (this.side === 0 ? p.front_get_up : p.back_get_up) : null;
      else if (this.side !== 2) name = null;
      if (name && near) {
        this.startTraj(this.trajs[name]);
        path = null;
      }
    }
    // 4. trajectory step
    let row: Float32Array | null = null;
    if (this.cur && this.idx >= 0) {
      if (this.idx >= this.cur.rows.length) {      // done: the walker takes over this tick
        this.idx = -1;
        this.resetTwist(bq);
        path = tw.update(stick);
      } else row = this.cur.rows[this.idx++];
    }
    // 5. fall protection
    const len = p.fall_down_length ?? 2;
    if (row && this.cur!.rot !== 1) { this.fallT = 0; this.side = 2; }
    else if (this.fallT > 0 || g[2] > (p.projected_gravity_protect ?? -0.5)) {
      if (this.fallT <= 0) {
        this.fallQ0 = Float64Array.from(q);
        this.idx = -1; row = null;
        if (!path) { this.resetTwist(bq); path = tw.update(stick); }
      }
      this.side = g[0] >= -0.1 ? 1 : 0;
    } else { this.fallT = 0; this.side = 2; }
    this.maneuver = this.side !== 2 || (!!row && this.cur!.rot !== 1);
    // 6. net
    let act: Float32Array;
    if (row) {
      const L = this.task.L, cmd = new Float32Array(L + 9);
      cmd.set(row.subarray(0, L), 0);
      this.task.fill(cmd, L, pos, bq, row, true);
      act = await this.run(this.cur!.net, pObs, cmd);
      this.activeNet = `${this.cur!.name} row ${this.idx - 1}/${this.cur!.rows.length}`;
    } else if (this.side === 2) {
      act = await this.run(this.sess, pObs, this.walkCmd(path!, bq));
      this.activeNet = "walk";
    } else {
      act = new Float32Array(this.ctrl.length);   // the walker's output is discarded while fallen
      this.activeNet = `fall pose ${this.side === 0 ? "face up" : "face down"}`;
    }
    act = act.map((a) => clip(a, -20, 20));
    // 7. targets
    let target: Float64Array;
    if (this.side !== 2) {
      const a = clip(this.fallT / len, 0, 1), down = this.side === 1 ? p.back_down_jpos : p.front_down_jpos;
      target = Float64Array.from(down, (d, i) => a * d + (1 - a) * this.fallQ0![i]);
      act.fill(0);
      this.fallT = Math.min(this.fallT + DT, 1e4);
    } else {
      target = Float64Array.from(this.default);
      for (let i = 0; i < this.ctrl.length; i++) target[this.ctrl[i]] += act[i];
      for (const j of [19, 20, 21, 26, 27, 28]) target[j] = 0;
    }
    this.lastRaw = Float32Array.from(act);
    this.lastAction = act;
    // 8. estimator odometry (runs every tick on the robot; only its integration matters here)
    if (Math.hypot(tw.v[0], tw.v[1], tw.v[2]) <= 0) {
      this.odom = [tw.pose[0], tw.pose[1]];
    } else if (this.aux.estimator) {
      const e = await this.run(this.aux.estimator, pObs, new Float32Array([p.estimator_cmd ?? 0.5]));
      const yaw = qyaw(bq), cy = Math.cos(yaw), sy = Math.sin(yaw);
      const ex = clip(e[0], -8, 8), ey = clip(e[1], -8, 8);
      const wx = ex * cy - ey * sy, wy = ex * sy + ey * cy;
      if (Math.abs(wx) > 0.01) this.odom[0] += DT * wx;
      if (Math.abs(wy) > 0.01) this.odom[1] += DT * wy;
    }
    return target;
  }

  /** 163-dim walk cmd: anchor latent, 10 path blocks relative to the odometry, block 0 again.
   * Block = [path − odom rotated into the robot's yaw frame (NOT clipped, unlike 504's decode), 0,
   * rot6d(Rz(yaw_i) · R_base^T)] (sub_557860: q_path ⊗ q_robot⁻¹, w ≥ 0; bench-verified). */
  private walkCmd(P: number[][], bq: ArrayLike<number>): Float32Array {
    const yaw = qyaw(bq), cy = Math.cos(yaw), sy = Math.sin(yaw), R = matFromWxyz(bq);
    const n = P.length, cmd = new Float32Array(64 + 9 * (n + 1));
    cmd.set(this.anchor, 0);
    for (let i = 0; i < n; i++) {
      const dx = P[i][0] - this.odom[0], dy = P[i][1] - this.odom[1];
      const ct = Math.cos(P[i][2]), st = Math.sin(P[i][2]);
      // M = Rz(yaw_i) R^T: M[0][c] = ct R[c][0] − st R[c][1], M[1][c] = st R[c][0] + ct R[c][1], M[2][c] = R[c][2]
      const m = [ct * R[0] - st * R[1], ct * R[3] - st * R[4], st * R[0] + ct * R[1], st * R[3] + ct * R[4], R[2], R[5]];
      cmd.set([cy * dx + sy * dy, -sy * dx + cy * dy, 0, ...m], 64 + 9 * i);
    }
    cmd.set(cmd.slice(64, 73), 64 + 9 * n);
    return cmd;
  }
}
