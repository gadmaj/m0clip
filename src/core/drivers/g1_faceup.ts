/** ai_sport 1.5.4 FSM 702 "FaceupGetup" and FSM 703 "Squat2Stand" (G1), decoded from the decompiled `humanoid`
 * (fsm_faceup_getup.cpp / fsm_squat2stand.cpp) and checked against bench captures (captures_154/probe5).
 *
 * ── 702 FsmFaceupGetup (obs_scheme "faceup", 100 Hz = control_dt) ──────────────────────────────────────────
 * No network drives the first part — it is a scripted get-up; the only net is the post-train VQ decoder:
 *  1. check      pelvis pitch (IMU rpy[1]) < -1.4 → lying on the back → 2. Otherwise `face_down_safe_check`:
 *                pitch ≥ 0.7 (face down, mode 1) or pitch ∈ [-1.4, -1.05] (tilted back, mode 2), with
 *                |q hip_pitch L/R| ≤ 1.35, |q waist_yaw| ≤ 1 and at most 2 tries → face-down try; else the
 *                FSM gives up (kp → 0, back to damping).
 *  1b. fd try    joint-space waypoints, linear in ticks (sub_419600): mode 1 rolls the robot onto its back,
 *                mode 2 curls up and rocks the waist. Segment 0 blends kp/kd from getup_joint_k*_phase0 to
 *                getup_joint_k*; after the last waypoint it holds 40 ticks (0.4 s) and re-runs the check.
 *  2. interp     init_duration_amend = 2 s on the float32 FSM clock (201 ticks when it starts at entry):
 *                target = q0 + r·(getup_init_joint_q − q0), kp = r·getup_joint_kp, r = (t − t0)/2,
 *                kd = getup_joint_kd.
 *  3. script     "lay to squat": rows of period_angle_newtest_29 (EDU) / period_angle_newtest (Air) for the
 *                14 joints of joint_order, row k-1 → k over max_period_count_test_29[k-1] ticks (7 segments,
 *                6.1 s on EDU); during the last segment the firmware zeroes kp of joints 0-5 and 11 and sets
 *                kd[5..11] = [2, 10, 10, 10, 10, 10, 2] (sub_4159C0, reproduced as is).
 *  4. squat check pitch ∈ (0, 1) or give up.
 *  5. decoder    squat2stand post-train VQ decoder (EDU: squat2stand_new_decoder + the 29dof latent CSV):
 *                p_obs 10×93 = [gyro·0.2, projected gravity, q − default_joint_q_test, dq·0.05, last act]
 *                (history filled with the first frame), cmd = L2-normalised latent row, every 10 ms tick.
 *                Rows as captured (probe5/702assist): CSV row 0 for 121 ticks while kp ramps 0 → joint_kp_test
 *                over 120 ticks, then 204, 206 .. 598, 800 .. 898, then row 901 for 50 ticks and the FSM hands
 *                over to 802 (the decompiled counter reads 200/+2/600→800/900→1000; the captured rows are what
 *                the net gets). act clipped ±20, target = default_test + act (bench: exact), kd = joint_kd_test.
 *                |gravity x|,|y| ≥ 0.7 aborts (safe protection).
 * Sim fidelity: MuJoCo (this model and the bench's) does not reproduce the real robot's arm push-off in the
 * script — the pelvis stops at pitch ≈ -0.55 and falls back, so `squat_safe_check` fails there (it does on the
 * emulator bench too). `faceup.assist` (gain, N·m/rad) adds a pitch torque on the pelvis during script segments
 * 3-7 only, about the heading frame's pitch axis: τ = clip(a·(0.4 − pitch) − 0.2·a·ω_pitch, 0, 2a).
 * 0 = the bare firmware behaviour.
 *
 * ── 703 FsmSquat2Stand (obs_scheme "squat2stand", 100 Hz) ──────────────────────────────────────────────────
 * One 13-DOF net (LS2S 20240924_105814_18000), obs 46 = [gyro_f·0.25, projected gravity, q − default,
 * dq_f·0.05, clip(act, ±2)·action_scale of the previous tick, traj_step_count/1600]; gyro_f / dq_f are EMAs
 * (omega_alpha / jvel_alpha 0.2). Target (sub_429F80) = default + clip(act, ±2)·action_scale, then limited so
 * that kp·(target − q) − kd·dq_f stays within ±joint_tau_limits (target = q + (±τ + kd·dq_f)/kp); kp/kd =
 * the config joint_kp/kd, arms at init_joint_q. traj_step_count is a squat/stand clock (traj_step_max 1600):
 * 1000 = standing (value at entry from 203), 1000→1400 squats down, 1400 = squatting, 200→600 stands up,
 * 600 = standing. The remote Start button jumps 600 → 1000 / 1400 → 200 and runs the clock (+1 per tick) to
 * the next stop. Bench capture probe5/703start: obs replayed to 5e-5, 93 % of lowcmd targets reproduced to 1e-4
 * (the rest is subscriber skew). The pack enters standing at 1000 and presses Start at `squat2stand.presses`.
 */
import { clip, matFromWxyz, matTVec } from "../math";
import type { Command, EvalConfig, RobotSpec } from "../types";
import type { Engine } from "../../sim/engine";
import type { OnnxSession } from "../policy";
import { BaseDriver } from "./base";

type Vec29 = number[];

// ---- 702 constants (policies/faceup_getup/fsm_cfg.yaml, fsm_cfg of 1.5.4) ----
const PA29: number[][] = [
  [0.0, 0.0, 0.0, 0.0, 0, 1.57, 0.15, 0.0, 0.0, 0.0, -0.0, 0.0, 1.57, -0.15],
  [-1.3, 2.8, -0.8, 0.0, 2.1, -0.5, 0.25, -1.3, 2.8, -0.8, -0.0, 2.1, -0.5, -0.25],
  [-1.3, 2.8, -0.8, 0.0, 1.8, 0.6, 0.25, -1.3, 2.8, -0.8, -0.0, 1.8, 0.6, -0.25],
  [-2.25, 2.8, -0.2, 0.0, 1.41, 1.4, 0.1, -2.0, 2.8, -0.2, -0.0, 1.41, 1.4, -0.1],
  [-2.5, 2.8, -0.5, 0.0, 0.15, 1.4, 0.1, -2.5, 2.8, -0.5, -0.0, 0.15, 1.4, -0.1],
  [-2.65, 2.8, -0.5, 0.0, -0.1, 1.4, 0.1, -2.65, 2.8, -0.5, -0.0, -0.1, 1.4, -0.1],
  [-2.7, 2.85, -0.65, 0.0, 0.5, 0.6, 0.15, -2.7, 2.85, -0.65, -0.0, 0.5, 0.6, -0.15],
  [-2.7, 2.85, -0.85, 0.0, 0.5, 0.6, 0.15, -2.7, 2.85, -0.85, -0.0, 0.5, 0.6, -0.15],
];
const PA23: number[][] = [
  [0.0, 0.0, 0.0, 0.0, 0, 1.57, 0.15, 0.0, 0.0, 0.0, -0.0, 0.0, 1.57, -0.15],
  [-1.3, 2.8, -0.8, 0.0, 2.1, -0.5, 0.25, -1.3, 2.8, -0.8, -0.0, 2.1, -0.5, -0.25],
  [-1.3, 2.8, -0.8, 0.0, 1.8, 0.6, 0.25, -1.3, 2.8, -0.8, -0.0, 1.8, 0.6, -0.25],
  [-2.0, 2.8, -0.2, 0.0, 0.9, 1.57, 0.25, -2.0, 2.8, -0.2, -0.0, 0.9, 1.57, -0.25],
  [-2.2, 2.8, -0.5, 0.0, 0.2, 1.57, 0.25, -2.2, 2.8, -0.5, -0.0, 0.2, 1.57, -0.25],
  [-2.45, 2.8, -0.7, 0.0, 0.2, 1.57, 0.25, -2.45, 2.8, -0.7, -0.0, 0.2, 1.57, -0.25],
  [-2.7, 2.85, -0.55, 0.0, 0.5, 0.6, 0.15, -2.7, 2.85, -0.55, -0.0, 0.5, 0.6, -0.15],
  [-2.7, 2.85, -0.85, 0.0, 0.5, 0.6, 0.15, -2.7, 2.85, -0.85, -0.0, 0.5, 0.6, -0.15],
];
const CNT29 = [150, 100, 50, 50, 100, 150, 10];
const CNT23 = [70, 50, 50, 50, 60, 70, 5];
const JORD = [0, 3, 4, 1, 15, 18, 16, 6, 9, 10, 7, 22, 25, 23];
const GINIT: Vec29 = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
  0, 0.15, 0, 1.57, -1.57, 0, 0, 0, -0.15, 0, 1.57, 1.57, 0, 0];
const GKP: Vec29 = [150, 200, 200, 200, 100, 20, 150, 200, 200, 200, 100, 20, 200, 1000, 1000,
  80, 40, 20, 40, 20, 20, 60, 80, 40, 20, 40, 20, 20, 60];
const GKD: Vec29 = [2.5, 2.5, 2.5, 2.5, 2, 0.2, 2.5, 2.5, 2.5, 2.5, 2, 0.2, 2.5, 5, 5,
  1.5, 1, 0.9, 1.2, 1.2, 1.2, 1.2, 1.5, 1, 0.9, 1.2, 1.2, 1.2, 1.2];
const GKP0: Vec29 = [150, 200, 200, 200, 5, 5, 150, 200, 200, 200, 5, 5, 200, 1000, 1000,
  80, 40, 5, 5, 5, 5, 5, 80, 40, 5, 5, 5, 5, 5];
const GKD0: Vec29 = [2.5, 2.5, 2.5, 2.5, 1, 0.2, 2.5, 2.5, 2.5, 2.5, 1, 0.2, 2.5, 5, 5,
  1.5, 1, 0.9, 1.2, 1.2, 1.2, 1.2, 1.5, 1, 0.9, 1.2, 1.2, 1.2, 1.2];
const DEF_T: Vec29 = [-0.3, 0, 0, 0.6, -0.3, 0, -0.3, 0, 0, 0.6, -0.3, 0, 0, 0, 0,
  0.3, 0.3, 0, 0.97, 0, 0, 0, 0.3, -0.3, 0, 0.97, 0, 0, 0];
const KP_T: Vec29 = [40.2, 99.1, 40.2, 99.1, 28.5, 28.5, 40.2, 99.1, 40.2, 99.1, 28.5, 28.5, 40.2, 28.5, 28.5,
  14.3, 14.3, 14.3, 14.3, 14.3, 16.8, 16.8, 14.3, 14.3, 14.3, 14.3, 14.3, 16.8, 16.8];
const KD_T: Vec29 = [2.6, 6.3, 2.6, 6.3, 1.8, 1.8, 2.6, 6.3, 2.6, 6.3, 1.8, 1.8, 2.6, 1.8, 1.8,
  0.9, 0.9, 0.9, 0.9, 0.9, 1.1, 1.1, 0.9, 0.9, 0.9, 0.9, 0.9, 1.1, 1.1];
const ARM_L = [2.67, 0.5, -0.4, -1.05, 0, 0, 0], ARM_R = [2.67, -0.5, 0.4, -1.05, 0, 0, 0];
/** face_down try waypoints (sub_419600), [target, ticks]; the first segment's length depends on the hips */
const FD_MODE1: [Vec29, number][] = [
  [[0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, ...ARM_L, ...ARM_R], 0],
  [[-1.7, 0, 0, 2.88, -0.87, 0, 0, 0, 0, 2.88, -0.87, 0, 0, 0, 0, ...ARM_L, ...ARM_R], 100],
  [[-1.7, 0, 0, 2.88, -0.87, 0, -2.0, 0.3, 0, 2.88, -0.87, 0, 0, 0, 0,
    0, 0, 0.1, -1.05, 0, 0, 0, 0, 0, 0.1, -1.05, 0, 0, 0], 100],
  [[-2.0, 0, 0, 2.88, -0.87, 0, -2.0, -0.3, 0, 2.88, -0.87, 0, 1.2, 0, 0,
    0, 0, -0.1, -1.05, 0, 0, 0, 0, 0, 0.1, -1.05, 0, 0, 0], 50],
  [[-0.3, 0, 0, 0.6, -0.3, 0, -0.3, 0, 0, 0.6, -0.3, 0, 0, 0, 0,
    0.3, 0.15, 0, 0.97, 0.15, 0, 0, 0.3, -0.15, 0, 0.97, -0.15, 0, 0], 100],
];
const CURL = (wy: number): Vec29 => [-2.2, 0, 0, 2.88, -0.87, 0, -2.2, 0, 0, 2.88, -0.87, 0, wy, 0, 0,
  0.3, 0.25, 0, 0.97, -1.57, 0, 0, 0.3, -0.25, 0, 0.97, 1.57, 0, 0];
const FD_MODE2: [Vec29, number][] = [[CURL(0), 150], [CURL(0.3), 30], [CURL(-0.3), 30], [CURL(0), 30]];

const HIST = 10;

/** Parse a latent CSV and L2-normalise every row (as the firmware does with the cmd). */
async function loadLatentRows(url: string): Promise<Float32Array[]> {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`failed to fetch latent ${url}: ${r.status}`);
  const rows: Float32Array[] = [];
  for (const line of (await r.text()).split(/\r?\n/)) {
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

function pitchOf(q: ArrayLike<number>): number {   // wxyz -> ZYX Euler pitch (IMU rpy[1])
  return Math.asin(clip(2 * (q[0] * q[2] - q[3] * q[1]), -1, 1));
}

interface FaceupCfg {
  table?: "29" | "23";      // lay-to-squat table: 29 = EDU (period_angle_newtest_29), 23 = Air
  assist?: number;          // sim-only pelvis pitch assist gain during the script (0 = off)
  decoder_every?: number;   // decoder period in 100 Hz ticks (firmware loop: 1)
  settle_s?: number;        // lie in damping this long before the FSM starts (the robot is entered from 1)
  latent?: string;          // aux_files role of the latent CSV
}

type Stage = "settle" | "check" | "fd" | "fd_hold" | "interp" | "script" | "squat_check" | "decoder" | "end" | "fail";

export class G1FaceupDriver extends BaseDriver {
  private readonly fc: FaceupCfg;
  private readonly pa: number[][];
  private readonly cnt: number[];
  private readonly spawn: string;
  private latent: Float32Array[] = [];
  private ready: Promise<void> | null = null;

  stage: Stage = "settle";
  private k = 0;                 // ticks in the current stage
  private tick = 0;
  private target: Float64Array<ArrayBufferLike> = new Float64Array(29);
  private q0 = new Float64Array(29);
  private ft = 0;                // FSM clock, float32 like the firmware's (a1+964, += control_dt per tick)
  private t0 = 0;                // clock at the start of the interp (a1+948)
  private started = false;
  // face-down try
  private tries = 0;
  private wp: Float64Array[] = [];
  private dur: number[] = [];
  private seg = 0;
  private cntr = 0;
  // script
  private sseg = 1;
  private scnt = 1;
  // decoder
  private hist: Float32Array[] = [];
  private lastRaw = new Float32Array(29);
  private row = 200;
  private ramp = 0;
  private finished = false;
  private endTicks = 0;
  private dk = 0;
  activeNet = "script";

  constructor(cfg: EvalConfig, spec: RobotSpec, eng: Engine, readonly sess: OnnxSession,
              readonly aux: Record<string, OnnxSession>, readonly files: Record<string, string>) {
    super(cfg, spec, eng);
    const g = cfg.g1!;
    this.fc = (g.faceup ?? {}) as FaceupCfg;
    const air = this.fc.table === "23";
    this.pa = air ? PA23 : PA29;
    this.cnt = air ? CNT23 : CNT29;
    this.spawn = g.ground_start ?? "face_up";
    this.default = Float64Array.from(DEF_T);
    this.kp = new Float64Array(29);
    this.kd = Float64Array.from(GKD);
    this.lim = Float64Array.from(g.tau ?? spec.torque_limit ?? Array(29).fill(100));
    this.groundStart = true;
    this.maneuver = true;
    this.lastAction = new Float32Array(29);
    this.actJointNames = [...this.names];
    this.stackDepth = HIST;
    this.frameLayout = [["base_ang_vel", 3], ["projected_gravity", 3], ["joint_pos", 29], ["joint_vel", 29],
      ["last_action", 29]];
  }

  private init(): Promise<void> {
    this.ready ??= (async () => {
      const role = this.fc.latent ?? "latent";
      if (!this.files[role]) throw new Error(`${this.name}: aux_files.${role} (latent csv) missing`);
      this.latent = await loadLatentRows(this.files[role]);
    })();
    return this.ready;
  }

  override reset() {
    const s = Math.SQRT1_2;
    const quat = this.spawn === "face_down" ? [s, 0, s, 0] : [s, 0, -s, 0];
    const all = Array.from({ length: this.eng.model.nbody }, (_, i) => i).filter((i) => i !== 0);
    this.seat(new Float64Array(29), quat, all, 0.02);
    this.stage = (this.fc.settle_s ?? 0.5) > 0 ? "settle" : "check";
    this.k = 0; this.tick = 0; this.tries = 0; this.ft = 0; this.t0 = 0; this.started = false;
    this.kp.fill(0); this.kd.set(GKD);
    this.target = this.q();
    this.hist = []; this.lastRaw = new Float32Array(29); this.lastAction = new Float32Array(29);
    this.row = 0; this.ramp = 0; this.finished = false; this.endTicks = 0; this.dk = 0;
    this.activeNet = "damping";
    this.done = false;
  }

  private q(): Float64Array { return this.readQ()[0]; }

  private gravity(): [number, number, number] {
    return matTVec(matFromWxyz(this.baseQuat()), [0, 0, -1]);
  }

  /** face_up_safe_check + face_down_safe_check (sub_4127E0) at FSM entry and after a face-down try */
  private check() {
    const p = pitchOf(this.baseQuat()), q = this.q();
    if (p < -1.4) { this.startInterp(q); return; }
    const jointsOk = Math.abs(q[0]) <= 1.35 && Math.abs(q[6]) <= 1.35 && Math.abs(q[12]) <= 1.0 && this.tries <= 1;
    const mode = p >= 0.7 ? 1 : (p >= -1.4 && p <= -1.05 ? 2 : 0);
    if (!mode || !jointsOk) { this.fail("face_down_safe_check"); return; }
    this.tries++;
    const wps = mode === 1 ? FD_MODE1 : FD_MODE2;
    this.wp = [Float64Array.from(q), ...wps.map(([w]) => Float64Array.from(w))];
    this.dur = wps.map(([, d]) => d);
    if (mode === 1) this.dur[0] = Math.abs(q[0]) < 1 && Math.abs(q[6]) < 1 ? 100 : 200;
    this.seg = 0; this.cntr = 0;
    this.stage = "fd"; this.k = 0; this.activeNet = `face-down try (mode ${mode})`;
  }

  private startInterp(q: Float64Array) {
    this.q0 = Float64Array.from(q);
    this.t0 = this.ft;
    this.stage = "interp"; this.k = 0; this.activeNet = "interp";
  }

  private fail(why: string) {
    this.stage = "fail"; this.kp.fill(0); this.activeNet = `gave up (${why})`;
  }

  async step(_command: Command): Promise<Float64Array> {
    await this.init();
    this.tick++;
    if (this.stage === "settle") {             // lying in damping (FSM 1) before 702 is entered
      this.kp.fill(0); this.kd.fill(1);
      this.target = this.q();
      if (++this.k < Math.round((this.fc.settle_s ?? 0.5) / 0.01)) return this.target;
      this.stage = "check"; this.k = 0;
    }
    if (this.started) this.ft = Math.fround(this.ft + Math.fround(0.01));
    else { this.started = true; this.ft = 0; }
    if (this.stage === "fd_hold" && ++this.k >= 40) this.stage = "check";
    if (this.stage === "check") { this.kd.set(GKD); this.check(); }
    if (this.stage === "squat_check") {
      const p = pitchOf(this.baseQuat());
      if (p > 0 && p < 1) this.stage = "decoder";
      else this.fail("squat_safe_check");
    }
    switch (this.stage) {
      case "fd": return this.stepFd();
      case "interp": return this.stepInterp();
      case "script": return this.stepScript();
      case "decoder": case "end": return this.stepDecoder();
      default: return this.target;         // fd_hold / fail: hold the last target (fail: kp = 0)
    }
  }

  private stepFd(): Float64Array {
    const s = this.seg, a = this.wp[s], b = this.wp[s + 1];
    this.cntr++;
    const r = this.cntr / this.dur[s];
    const t = new Float64Array(29);
    for (let i = 0; i < 29; i++) t[i] = a[i] + r * (b[i] - a[i]);
    for (let i = 0; i < 29; i++) {
      this.kp[i] = s === 0 ? GKP0[i] + r * (GKP[i] - GKP0[i]) : GKP[i];
      this.kd[i] = s === 0 ? GKD0[i] + r * (GKD[i] - GKD0[i]) : GKD[i];
    }
    this.target = t;
    if (this.cntr >= this.dur[s]) {
      this.seg++; this.cntr = 0;
      if (this.seg >= this.dur.length) { this.stage = "fd_hold"; this.k = 0; }
    }
    return t;
  }

  /** sub_417FB0: runs while t0 + 2 s > t on the float32 FSM clock — 201 ticks when entered at t = 0 */
  private stepInterp(): Float64Array {
    if (!(Math.fround(this.t0 + 2.0) > this.ft)) {
      this.stage = "script"; this.sseg = 1; this.scnt = 1; this.activeNet = "lay-to-squat script";
      return this.stepScript();
    }
    const r = Math.fround(Math.fround(this.ft - this.t0) / 2.0);
    const t = new Float64Array(29);
    for (let i = 0; i < 29; i++) {
      t[i] = this.q0[i] + r * (GINIT[i] - this.q0[i]);
      this.kp[i] = r * GKP[i]; this.kd[i] = GKD[i];
    }
    this.target = t;
    return t;
  }

  private stepScript(): Float64Array {
    const a = this.pa[this.sseg - 1], b = this.pa[this.sseg], n = this.cnt[this.sseg - 1];
    const t = Float64Array.from(this.target);
    for (let j = 0; j < JORD.length; j++) t[JORD[j]] = a[j] + this.scnt * (b[j] - a[j]) / n;
    this.target = t;
    this.scnt++;
    if (this.scnt > n) {
      this.sseg++; this.scnt = 1;
      if (this.sseg > 7) this.stage = "squat_check";
    }
    if (this.sseg > 6) {       // last segment: firmware quirk of sub_4159C0 (LABEL_42)
      for (const i of [0, 1, 2, 3, 4, 5, 11]) this.kp[i] = 0;
      const kd = [2, 10, 10, 10, 10, 10, 2];
      for (let i = 5; i <= 11; i++) this.kd[i] = kd[i - 5];
    }
    return t;
  }

  private observe(): Float32Array {
    const [q, qd] = this.readQ();
    const w = this.baseAngVel(), g = this.gravity();
    const f = new Float32Array(93);
    for (let i = 0; i < 3; i++) { f[i] = w[i] * 0.2; f[3 + i] = g[i]; }
    for (let i = 0; i < 29; i++) {
      f[6 + i] = q[i] - DEF_T[i];
      f[35 + i] = qd[i] * 0.05;
      f[64 + i] = this.lastRaw[i];
    }
    for (let i = 0; i < 93; i++) f[i] = clip(f[i], -100, 100);
    if (!this.hist.length) for (let k = 0; k < HIST; k++) this.hist.push(f);
    else { this.hist.push(f); this.hist.shift(); }
    this.lastFrame = f;
    const p = new Float32Array(HIST * 93);
    for (let k = 0; k < HIST; k++) p.set(this.hist[k], k * 93);
    return p;
  }

  private async stepDecoder(): Promise<Float64Array> {
    const g = this.gravity();
    if (Math.abs(g[0]) >= 0.7 || Math.abs(g[1]) >= 0.7) { this.fail("safe protection"); return this.target; }
    const every = Math.max(1, this.fc.decoder_every ?? 1);
    if (this.dk++ % every !== 0) return this.target;
    // latent row per decoder tick, as captured on the EDU bench (probe5/702assist, 419 steps at 100 Hz):
    // CSV row 0 for the first 121 ticks (kp ramp), then 204, 206 .. 598, 800 .. 898, then 901 for 50 ticks
    const n = this.ramp;
    if (n < 121) this.row = 0;
    else {
      let r = 204 + 2 * (n - 121);
      if (r >= 600) r += 200;
      if (r >= 900) { r = 901; this.finished = true; }
      this.row = r;
    }
    const pObs = this.observe();
    const cmd = this.latent[Math.min(this.row, this.latent.length - 1)];
    const out = await this.sess.run({ p_obs: { data: pObs, dims: [1, HIST, 93] }, cmd: { data: cmd, dims: [1, 64] } });
    const act = Float32Array.from(out, (a) => clip(a, -20, 20));
    this.lastRaw = act; this.lastAction = act;
    const t = new Float64Array(29);
    const s = Math.min(n, 120) / 120;                      // kp ramp over 120 ticks (sub_413C70)
    for (let i = 0; i < 29; i++) { t[i] = DEF_T[i] + act[i]; this.kp[i] = KP_T[i] * s; this.kd[i] = KD_T[i]; }
    this.ramp++;
    if (this.finished && ++this.endTicks >= 50) { this.done = true; this.stage = "end"; }
    this.activeNet = `decoder row ${this.row}`;
    this.target = t;
    return t;
  }

  /** Every physics substep: the sim-only assist (see header), as a pitch torque on the free joint. */
  override holdExtras(qfrc: Float64Array) {
    super.holdExtras(qfrc);
    const a = this.fc.assist ?? 0;
    if (!a || this.stage !== "script" || this.sseg < 3) return;
    const q = this.baseQuat();
    const R = matFromWxyz(q);
    const yaw = Math.atan2(2 * (q[0] * q[3] + q[1] * q[2]), 1 - 2 * (q[2] * q[2] + q[3] * q[3]));
    const ax = [-Math.sin(yaw), Math.cos(yaw), 0];          // pitch axis of the heading frame (world)
    const w = this.baseAngVel();                             // local frame
    const ww = [0, 1, 2].map((r) => R[3 * r] * w[0] + R[3 * r + 1] * w[1] + R[3 * r + 2] * w[2]);
    const rate = ax[0] * ww[0] + ax[1] * ww[1];
    const tau = clip(a * (0.4 - pitchOf(q)) - 0.2 * a * rate, 0, 2 * a);
    // world torque tau·ax -> body frame, the free joint's rotational dofs
    const tl = matTVec(R, [tau * ax[0], tau * ax[1], 0]);
    for (let i = 0; i < 3; i++) qfrc[this.bqv + 3 + i] += tl[i];
  }
}

// ---- 703 constants (policies/squat2stand/fsm_cfg.yaml) ----
const S2S_DEF: Vec29 = [-1.25, 0.5, 0, 1.45, -0.175, 0, -1.25, -0.5, 0, 1.45, -0.175, 0, 0, 0, 0,
  0.381418, 0.4, 0, 0.782123, 0, 0, 0, 0.381418, -0.4, 0, 0.782123, 0, 0, 0];
const S2S_SCALE = [2, 2, 2, 2, 1, 1, 2, 2, 2, 2, 1, 1, 1.5];
const S2S_INIT: Vec29 = [-2.43, 0, 0, 2.73, -0.67, 0, -2.43, 0, 0, 2.73, -0.67, 0, 0, 0, 0,
  0.5, 0.15, 0, 0.6, 0, 0, 0, 0.5, -0.15, 0, 0.6, 0, 0, 0];

interface S2SCfg {
  presses?: number[];       // times (s) of the Start press that starts the next half-cycle
  start_count?: number;     // traj_step_count at entry (bench, entered from 203: 1000 = standing)
  spawn_pitch?: number;     // pelvis pitch of the start pose (0 standing; 0.37 for the deep squat)
  alpha?: number;           // omega_alpha / jvel_alpha
  traj_step_max?: number;
  tau_limits?: number[];    // joint_tau_limits of the 13 joints (target clamp)
}

export class G1Squat2StandDriver extends BaseDriver {
  private readonly sc: S2SCfg;
  private readonly initPose: Float64Array;
  private readonly armPose: Float64Array;
  private readonly nmax: number;
  private readonly standing: boolean;
  private readonly tauLim: number[];
  private count = 1000;
  private running = false;
  private tick = 0;
  private wf = new Float64Array(3);
  private dqf = new Float64Array(13);
  private lastRaw = new Float32Array(13);
  activeNet = "stand";

  constructor(cfg: EvalConfig, spec: RobotSpec, eng: Engine, readonly sess: OnnxSession) {
    super(cfg, spec, eng);
    const g = cfg.g1!;
    this.sc = (g.squat2stand ?? {}) as S2SCfg;
    this.nmax = this.sc.traj_step_max ?? 1600;
    this.default = Float64Array.from(g.default_dof_pos ?? S2S_DEF);
    this.initPose = Float64Array.from(g.init_pose ?? S2S_INIT);
    this.armPose = Float64Array.from((g.arm_pose as number[] | undefined) ?? S2S_INIT);
    this.kp = Float64Array.from(g.kp ?? Array(29).fill(40));
    this.kd = Float64Array.from(g.kd ?? Array(29).fill(1));
    this.lim = Float64Array.from(g.tau ?? spec.torque_limit ?? Array(29).fill(100));
    this.tauLim = this.sc.tau_limits ?? [88, 88, 88, 139, 50, 50, 88, 88, 88, 139, 50, 50, 88];
    this.standing = g.ground_start === "stand";
    this.groundStart = !this.standing;
    this.maneuver = true;
    this.lastAction = new Float32Array(13);
    this.actJointNames = this.names.slice(0, 13);
    this.frameLayout = [["base_ang_vel", 3], ["projected_gravity", 3], ["joint_pos", 13], ["joint_vel", 13],
      ["last_action", 13], ["phase", 1]];
  }

  override reset() {
    const th = this.sc.spawn_pitch ?? (this.standing ? 0 : 0.37);
    this.seat(this.initPose, [Math.cos(th / 2), 0, Math.sin(th / 2), 0], this.feet, 0.002);
    this.count = this.sc.start_count ?? (this.standing ? 1000 : 200);
    this.running = false; this.tick = 0;
    this.wf.fill(0); this.dqf.fill(0); this.lastRaw = new Float32Array(13); this.lastAction = new Float32Array(13);
    this.activeNet = this.label();
    this.done = false;
  }

  private label(): string {
    const c = this.count;
    return c === 600 || c === 1000 ? "stand" : c === 200 || c === 1400 ? "squat"
      : c < 600 ? "squat → stand" : "stand → squat";
  }

  async step(_command: Command): Promise<Float64Array> {
    const t = this.tick * 0.01;
    for (const p of this.sc.presses ?? [3, 9, 15])
      if (Math.abs(t - p) < 0.005) {          // Start button: 600 -> 1000, 1400 -> 200, start the clock
        this.running = true;
        if (this.count === 600) this.count = 1000;
        else if (this.count === this.nmax - 200) this.count = 200;
      }
    const half = this.nmax * 0.5;
    if (this.running && (this.count >= half + 200 || this.count < half - 200)) this.count += 1;
    if (this.count === this.nmax - 200 || this.count === half - 200) this.running = false;
    this.tick++;

    const [q, qd] = this.readQ();
    const w = this.baseAngVel();
    const g = matTVec(matFromWxyz(this.baseQuat()), [0, 0, -1]);
    const a = this.sc.alpha ?? 0.2;
    for (let i = 0; i < 3; i++) this.wf[i] = a * w[i] + (1 - a) * this.wf[i];
    for (let i = 0; i < 13; i++) this.dqf[i] = a * qd[i] + (1 - a) * this.dqf[i];
    const f = new Float32Array(46);
    for (let i = 0; i < 3; i++) { f[i] = this.wf[i] * 0.25; f[3 + i] = g[i]; }
    for (let i = 0; i < 13; i++) {
      f[6 + i] = q[i] - this.default[i];
      f[19 + i] = this.dqf[i] * 0.05;
      f[32 + i] = this.lastRaw[i];
    }
    f[45] = this.count / this.nmax;
    for (let i = 0; i < 46; i++) f[i] = clip(f[i], -100, 100);
    this.lastFrame = f;
    const out = await this.sess.run({ obs: { data: f, dims: [1, 46] } });
    const act = Float32Array.from(out, (x) => clip(x, -2, 2));
    this.lastAction = act;
    this.lastRaw = Float32Array.from(act, (x, i) => x * S2S_SCALE[i]);   // obs slot: clip(act)·action_scale
    const tgt = Float64Array.from(this.armPose);
    for (let i = 0; i < 13; i++) {
      let ti = this.default[i] + act[i] * S2S_SCALE[i];
      const kp = this.kp[i], kd = this.kd[i], tl = this.tauLim[i], v = this.dqf[i];
      const tq = kp * (ti - q[i]) - kd * v;                                  // firmware torque-limit clamp
      if (kp > 0 && tq > tl) ti = q[i] + (tl + kd * v) / kp;
      else if (kp > 0 && tq < -tl) ti = q[i] + (-tl + kd * v) / kp;
      tgt[i] = ti;
    }
    this.activeNet = this.label();
    return tgt;
  }
}
