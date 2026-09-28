/** Unitree R1 firmware policies (ai_sport 1.0.2.154 `r1_controller`, OTA 1.4.2.8), each driven the way the
 * firmware drives it. Decoded from the virbox-decrypted in-memory image of r1_controller (IDA) and checked
 * against bench ONNX-I/O captures (orange_pi_workbench/tools/ai_sport_probe/orthook.c + r1_probe.py,
 * captures in captures_r1_142/; notes docs/HANDOFF_R1_POLICIES.md there).
 *
 * The firmware sticks are the RF remote record (lowstate.wireless_remote): ly, lx, rx in [-1, 1]. The web
 * command is stick × the axis maximum the driver publishes in `velRange` (symmetric), so the driver recovers the
 * stick as command / max and then applies the firmware's own stick → command path (dead zones, speed profile,
 * slew limits). The worker does NOT ramp these packs (config `r1.firmware: true`).
 *
 * obs schemes (config r1.obs_scheme):
 *  amp_loco   811 AmpLocomotion (EDU 24-DOF). frame 81 = [gyro, projected gravity, cmd, q−default, dq,
 *             last raw action] in IsaacLab joint order, 10 frames oldest first (filled with the entry frame).
 *             Three nets on one history: turn (|vx|,|vy| ≤ 0.3, |wz| ≥ 1), run (vx ≥ 1.5), else default,
 *             chosen from the slewed command (inclusive bounds, turn first). Stick → cmd (sub_404418):
 *             vx = ly·vmax (0.9 low / 2.3 high profile), backwards only ly·0.9 ≤ −0.3 → ly·1.0; vy = −lx·0.6;
 *             |·| < 0.05 → 0; |vy| > 0.48 → vx = 0, else |vx| > 0.8·vlim → vy = 0; wz = −rx·(1.0 moving /
 *             2.5 in place). Slew (sub_404784) per axis and sign, then wz clamped to the in-place/moving limit.
 *             target = default + act·scale (isaac → dof via action_idx). R2+Up / R2+Down = high / low profile.
 *  amp_motion 812 AmpMotion / 815 AmpMotion22Dof (EDU). memory 5 × P + commands 3 + proprioception P,
 *             P = [gyro, gravity, q (absolute), dq, last raw action] over dof_activated_idx. cmd: stick ×
 *             max (vx 1.0, or 2.5 after R2+Up), backwards ≤ −0.3 → the raw stick; slew (backwards speeds up
 *             at vx_up/2); |vx|,|vy| < 0.2 and |wz| < 0.3 → 0 (stance); walk-slow in-place turn → wz ×2.
 *             815 runs its stance net until the first step, then the walk net. target = default +
 *             act·scale on the activated joints, arm limits clipped.
 *  gait       830 Locomotion20Dofs (Air), 832 LocomotionGait, 833 LocomotionArmsdkGait (Air + EDU, 20
 *             policy joints; the EDU waist / wrist roll are held). frame = [gyro, gravity, cmd, q−default,
 *             dq, last raw action] (+ 832/833: sin(2π φ_L,R), cos(2π φ_L,R), air ratio ×2, φ_R = φ_L + 0.5).
 *             Sticks: dead band, vx = ly·vx_limit (back |ly|·vel_range[0]), vy, wz with angular coupling
 *             1 − c·min(1, |v|/|v_max|), slew (up when |new| > |old|). R2+Up = vel_range vx max.
 *             833: Start toggles the random-arm demo (targets resampled every arm_resample_s in the soft
 *             limits, 0.1·policy + 0.9·random, clipped), Start again returns the arms to the policy.
 *  track      dances 601-608 (+ gunfanqishen / qishen1), 701 Qishen (get up), 702 Tangxia (lie down) — motion
 *             tracking, see R1TrackDriver (dances: DanceCore up-z safety → Damping).
 *  mimic      804 MimicActor / 805 MimicPunch (fight) — VQ-latent clips + twist net, see R1MimicDriver.
 *  simple     SimpleMotion "hello" — reconstructed (no firmware build implements it), see R1SimpleDriver.
 * Variants on the same classes: 811 with `raw_max` = the 1.0.2.223 AmpLocomotion (sticks × max, one net); 811 with
 * `control` = 816 ArmSdkLocomotion (14 leg/waist actions, command 0, arms held by an emulated arm SDK client);
 * amp_motion with `frame: loco24` = 813 / 814 Locomotion24Dof; gait with `zero_cmd` / legs-only `action_joint_idx`
 * = 831 LocomotionArmsdk. Everything not reachable on the shipping 1.0.2.154 is decoded from the unprotected
 * 1.0.2.181 / 1.0.2.223 builds (IDA, DWARF); see docs/R1_FIRMWARE_POLICIES.md.
 */
import { clip, matFromWxyz, matTVec } from "../math";
import type { Command, EvalConfig, RobotSpec } from "../types";
import type { Engine } from "../../sim/engine";
import { OnnxSession } from "../policy";
import { assetUrl, loadTraj } from "../assets";
import { BaseDriver } from "./base";

type Range = [number, number];
interface ModelRange { vx: Range[]; vy: Range[]; wz: Range[] }

export interface R1FwCfg {
  firmware?: boolean;
  obs_scheme: string;
  fsm_id?: number;
  models?: string[];
  next_policy?: string;
  /** remote combo -> policy name the firmware switches to (e.g. dances from 811) */
  switch_combos?: Record<string, string>;
  /** policy joint names, in the policy's dof order (firmware `dof_idx` order) */
  joint_names: string[];
  aux_models?: Record<string, string>;
  aux_files?: Record<string, string>;
  memory?: number;
  [k: string]: unknown;
}

export const r1fw = (cfg: EvalConfig): R1FwCfg => cfg.r1 as unknown as R1FwCfg;

/** firmware slew (sub_404784 / AmpMotion): per sign of the previous value */
function slewAxis(n: number, p: number, upPos: number, dnPos: number, upNeg: number, dnNeg: number): number {
  if (p >= 0) {
    const d = n - p;
    if (d >= 0) { if (d > upPos) n = p + upPos; } else if (d < -dnPos) n = p - dnPos;
  }
  if (p <= 0) {
    const d = n - p;
    if (d >= 0) { if (d > dnNeg) n = p + dnNeg; } else if (d < -upNeg) n = p - upNeg;
  }
  return n;
}
const f32 = Math.fround;
const inR = (v: number, rs: Range[]) => rs.some(([a, b]) => v >= a && v <= b);

/** Common plumbing: policy joints by name → spec slots, gyro / gravity, PD defaults. */
abstract class R1FwBase extends BaseDriver {
  readonly r: R1FwCfg;
  readonly map: Int32Array;           // policy dof → spec joint index
  readonly nd: number;
  readonly combos: Record<string, string>;
  /** set by a switch combo: the worker hands over to it (like the firmware's state change) */
  nextPolicy?: string;

  constructor(cfg: EvalConfig, spec: RobotSpec, eng: Engine) {
    super(cfg, spec, eng);
    this.r = r1fw(cfg);
    this.map = Int32Array.from(this.r.joint_names.map((n) => {
      const i = this.names.indexOf(n);
      if (i < 0) throw new Error(`${cfg.name}: joint ${n} not in the ${spec.robot} model`);
      return i;
    }));
    this.nd = this.map.length;
    this.combos = this.r.switch_combos ?? {};
    this.actJointNames = [...this.r.joint_names];
  }

  /** q, dq of the policy joints (dof order) */
  protected polQ(): [Float32Array, Float32Array] {
    const [q, qd] = this.readQ();
    const a = new Float32Array(this.nd), b = new Float32Array(this.nd);
    for (let i = 0; i < this.nd; i++) { a[i] = q[this.map[i]]; b[i] = qd[this.map[i]]; }
    return [a, b];
  }
  protected gravity(): number[] { return matTVec(matFromWxyz(this.baseQuat()), [0, 0, -1]); }
  protected gyro(): number[] { return Array.from(this.baseAngVel()); }

  /** full-width default / kp / kd from dof-order arrays. Model joints the policy doesn't command keep the
   * config's `hold_joints` {name: [q, kp, kd]} — what rt/lowcmd still holds from the previous state on the robot
   * (e.g. the EDU waist / wrist roll under the Air-trained get-up nets: Stance's command) — else 0 / 0 / 0. */
  protected setGains(def: number[], kp: number[], kd: number[]) {
    for (let i = 0; i < this.nd; i++) {
      this.default[this.map[i]] = def[i]; this.kp[this.map[i]] = kp[i]; this.kd[this.map[i]] = kd[i];
    }
    const hold = (this.r as { hold_joints?: Record<string, number[]> }).hold_joints ?? {};
    for (const [n, [q, p, d]] of Object.entries(hold)) {
      const j = this.names.indexOf(n);
      if (j >= 0 && !this.map.includes(j)) { this.default[j] = q; this.kp[j] = p; this.kd[j] = d; }
    }
  }

  override remoteCombos(): string[] { return Object.keys(this.combos); }
  override remote(combo: string) {
    const to = this.combos[combo];
    if (to) { this.nextPolicy = to; this.done = true; }
  }
}

// ---------------------------------------------------------------------------------------------- 811
interface AmpLocoCmd {
  low: number; high: number; rev: number; vy: number; pure_wz: number; loco_wz: number;
  lat_ratio: number; lon_ratio: number;
  yaw_up: number; yaw_down: number; fwd_up: number; fwd_down: number; rev_up: number; rev_down: number;
  vy_up: number; vy_down: number;
}

export class R1AmpLocoDriver extends R1FwBase {
  needsCommand = true;
  private readonly aidx: Int32Array;          // dof → isaac
  private readonly defI: Float32Array;        // isaac-order default / scale
  private readonly scaleI: Float32Array;
  private readonly c: AmpLocoCmd;
  private readonly runR?: ModelRange;
  private readonly turnR?: ModelRange;
  private readonly mem: number;
  private hist: Float32Array[] = [];
  private last: Float32Array;
  private cmd = new Float32Array(3);
  private high = false;
  /** 1.0.2.223 AmpLocomotion: cmd = sticks × raw_max, nothing else (no dead zone / slew / profiles / run+turn) */
  private readonly rawMax?: number[];
  /** 816 ArmSdkLocomotion: the net drives ctrl.dof (policy dofs) from isaac slots ctrl.act; cmd forced to 0 */
  private readonly ctrl?: { dof: number[]; act: number[]; cmd_scale?: number[] };
  private readonly nAct: number;
  model = "default";

  constructor(cfg: EvalConfig, spec: RobotSpec, eng: Engine, readonly net: OnnxSession,
              readonly aux: Record<string, OnnxSession>) {
    super(cfg, spec, eng);
    const r = this.r as R1FwCfg & { action_idx: number[]; default_joint_pos: number[]; action_scale: number[];
      stiffness: number[]; damping: number[]; cmd: AmpLocoCmd; run_model?: ModelRange; turn_model?: ModelRange };
    this.aidx = Int32Array.from(r.action_idx);
    this.defI = Float32Array.from(r.default_joint_pos);
    this.scaleI = Float32Array.from(r.action_scale);
    const dofDef = this.r.joint_names.map((_, d) => r.default_joint_pos[this.aidx[d]]);
    this.setGains(dofDef, this.r.joint_names.map((_, d) => r.stiffness[this.aidx[d]]),
                  this.r.joint_names.map((_, d) => r.damping[this.aidx[d]]));
    this.c = r.cmd; this.runR = r.run_model; this.turnR = r.turn_model;
    this.rawMax = (r as { raw_max?: number[] }).raw_max;
    this.ctrl = (r as { control?: { dof: number[]; act: number[]; cmd_scale?: number[] } }).control;
    this.nAct = this.ctrl ? this.ctrl.act.length : this.nd;
    this.mem = r.memory ?? 10;
    this.last = new Float32Array(this.nAct);
    this.stackDepth = this.mem;
    this.frameLayout = [["gyro", 3], ["projected_gravity", 3], ["cmd", 3], ["q-default (isaac)", this.nd],
      ["dq (isaac)", this.nd], ["last_action", this.nAct]];
    this.actJointNames = this.ctrl ? this.ctrl.dof.map((d) => this.r.joint_names[d])
      : Array.from({ length: this.nd }, (_, i) => this.r.joint_names[Array.from(this.aidx).indexOf(i)]);
    // 816 (1.0.2.181 / .154): the command is zeroed (bench t816stick); 1.0.2.223: sticks × cmd_scale
    if (this.ctrl && !this.ctrl.cmd_scale) this.needsCommand = false;
    this.setProfile(false);
  }

  private setProfile(high: boolean) {
    this.high = high;
    const cs = this.ctrl?.cmd_scale;
    if (cs) { this.velRange = [-cs[0], cs[0], -cs[1], cs[1], -cs[2], cs[2]]; return; }
    if (this.rawMax) { const m = this.rawMax; this.velRange = [-m[0], m[0], -m[1], m[1], -m[2], m[2]]; return; }
    const vmax = high ? this.c.high : this.c.low;
    this.velRange = [-vmax, vmax, -this.c.vy, this.c.vy, -this.c.pure_wz, this.c.pure_wz];
  }

  override remoteCombos(): string[] {
    return this.rawMax || this.ctrl ? Object.keys(this.combos) : ["R2+Up", "R2+Down", ...Object.keys(this.combos)];
  }
  override remote(combo: string) {
    if (combo === "R2+Up") this.setProfile(true);
    else if (combo === "R2+Down") this.setProfile(false);
    else super.remote(combo);
  }

  override reset() {
    super.reset();
    this.cmd.fill(0); this.last.fill(0); this.model = "default";
    this.hist = Array(this.mem).fill(this.frame());
  }

  private frame(): Float32Array {
    const [q, dq] = this.polQ();
    const f = new Float32Array(9 + 2 * this.nd + this.nAct);
    f.set(this.gyro(), 0); f.set(this.gravity(), 3); f.set(this.cmd, 6);
    for (let d = 0; d < this.nd; d++) {
      const i = this.aidx[d];
      f[9 + i] = q[d] - this.defI[i];
      f[9 + this.nd + i] = dq[d];
    }
    f.set(this.last, 9 + 2 * this.nd);
    return f;
  }

  private rawCmd(ly: number, lx: number, rx: number): [number, number, number] {
    const c = this.c, vmax = this.high ? c.high : c.low;
    let vx = f32(ly * vmax), vy = f32(-lx * c.vy);
    if (Math.abs(vx) < 0.05) vx = 0;
    if (Math.abs(vy) < 0.05) vy = 0;
    if (vx < 0) vx = vx <= -0.3 ? f32(c.rev * ly) : 0;
    const vlim = vx < 0 ? c.rev : vmax;
    if (Math.abs(vy) <= f32(c.lat_ratio * c.vy)) {
      if (vlim > 1e-6 && Math.abs(vx) > f32(c.lon_ratio * vlim)) vy = 0;
    } else vx = 0;
    const wl = (Math.abs(vx) > 1e-4 || Math.abs(vy) > 1e-4) ? c.loco_wz : c.pure_wz;
    let wz = f32(-rx * wl);
    if (Math.abs(wz) < 0.05) wz = 0;
    return [vx, vy, wz];
  }

  async step(command: Command): Promise<Float64Array> {
    if (this.rawMax || this.ctrl) return this.stepPlain(command);
    const c = this.c, vmax = this.high ? c.high : c.low;
    const ly = clip(command[0] / vmax, -1, 1), lx = clip(-command[1] / c.vy, -1, 1), rx = clip(-command[2] / c.pure_wz, -1, 1);
    const raw = this.rawCmd(ly, lx, rx), p = this.cmd;
    const n = [
      slewAxis(raw[0], p[0], c.fwd_up, c.fwd_down, c.rev_up, c.rev_down),
      slewAxis(raw[1], p[1], c.vy_up, c.vy_down, c.vy_up, c.vy_down),
      slewAxis(raw[2], p[2], c.yaw_up, c.yaw_down, c.yaw_up, c.yaw_down)];
    const wl = (Math.abs(n[0]) > 1e-4 || Math.abs(n[1]) > 1e-4) ? c.loco_wz : c.pure_wz;
    n[2] = clip(n[2], -wl, wl);
    this.cmd = Float32Array.from(n);
    // actor selection on the slewed command: turn first, then run
    const sel = (m?: ModelRange) => !!m && inR(this.cmd[0], m.vx) && inR(this.cmd[1], m.vy) && inR(this.cmd[2], m.wz);
    this.model = sel(this.turnR) && this.aux.turn ? "turn" : sel(this.runR) && this.aux.run ? "run" : "default";
    const f = this.frame();
    this.hist.push(f); if (this.hist.length > this.mem) this.hist.shift();
    const obs = new Float32Array(this.mem * f.length);
    this.hist.forEach((h, k) => obs.set(h, k * f.length));
    const sess = this.model === "default" ? this.net : this.aux[this.model];
    const act = await sess.run({ obs: { data: obs, dims: [1, obs.length] } });
    this.last = Float32Array.from(act.subarray(0, this.nd));
    this.lastFrame = f; this.lastAction = this.last;
    const target = Float64Array.from(this.default);
    for (let d = 0; d < this.nd; d++) {
      const i = this.aidx[d];
      target[this.map[d]] = f32(this.defI[i] + f32(this.last[i] * this.scaleI[i]));
    }
    return target;
  }

  /** 223 AmpLocomotion: cmd = sticks × raw_max straight into the obs; 816: cmd = 0 and only `control` joints
   * follow the net (target[dof] = default + a·scale at the isaac slot), the rest hold the default pose — what an
   * rt/arm_sdk client holding the arms does (without one the firmware returns to 811 after 1 s). */
  private async stepPlain(command: Command): Promise<Float64Array> {
    const m = this.rawMax ?? this.ctrl?.cmd_scale;
    if (m) {
      this.cmd = Float32Array.from([f32(clip(command[0] / m[0], -1, 1) * m[0]), f32(clip(command[1] / m[1], -1, 1) * m[1]),
                                    f32(clip(command[2] / m[2], -1, 1) * m[2])]);
    } else this.cmd.fill(0);
    const f = this.frame();
    this.hist.push(f); if (this.hist.length > this.mem) this.hist.shift();
    const obs = new Float32Array(this.mem * f.length);
    this.hist.forEach((h, k) => obs.set(h, k * f.length));
    const act = await this.net.run({ obs: { data: obs, dims: [1, obs.length] } });
    this.last = Float32Array.from(act.subarray(0, this.nAct));
    this.lastFrame = f; this.lastAction = this.last;
    const target = Float64Array.from(this.default);
    if (this.ctrl) {
      this.ctrl.dof.forEach((d, k) => {
        const i = this.ctrl!.act[k];
        target[this.map[d]] = f32(this.defI[i] + f32(this.last[k] * this.scaleI[i]));
      });
    } else {
      for (let d = 0; d < this.nd; d++) {
        const i = this.aidx[d];
        target[this.map[d]] = f32(this.defI[i] + f32(this.last[i] * this.scaleI[i]));
      }
    }
    return target;
  }
}

// ---------------------------------------------------------------------------------------------- 812 / 815
interface AmpMotionCmd { max: number[]; high_vx: number; yaw_up: number; yaw_down: number; vx_up: number;
  vx_down: number; vy_up: number; vy_down: number }

export class R1AmpMotionDriver extends R1FwBase {
  needsCommand = true;
  private readonly dai: Int32Array;           // activated policy dofs
  private readonly def: Float32Array;         // dof-order default
  private readonly scale: Float32Array;       // per policy dof (AmpMotion: one scalar)
  private readonly lo: Float32Array; private readonly hi: Float32Array; private readonly limIdx: Int32Array;
  private readonly c: AmpMotionCmd;
  /** 813 / 814 Locomotion24Dof: frame [gyro, rep6d, q, dq, last action (scaled)], R1/R2 + arrows step the maxima */
  private readonly loco24: boolean;
  private readonly maxNow: number[];
  private readonly mem: number;
  private hist: Float32Array[] = [];
  private last: Float32Array;
  private prev = new Float32Array(3);
  private state = 0;
  private walkModel = false;
  private highProfile = false;

  constructor(cfg: EvalConfig, spec: RobotSpec, eng: Engine, readonly net: OnnxSession,
              readonly aux: Record<string, OnnxSession>) {
    super(cfg, spec, eng);
    const r = this.r as R1FwCfg & { dof_activated_idx: number[]; default_dof_pos: number[]; action_scale: number | number[];
      kp: number[]; kd: number[]; limits_joint_idx: number[]; dof_lower_limits: number[]; dof_upper_limits: number[];
      cmd: AmpMotionCmd };
    this.dai = Int32Array.from(r.dof_activated_idx);
    this.def = Float32Array.from(r.default_dof_pos);
    this.scale = typeof r.action_scale === "number" ? new Float32Array(this.nd).fill(r.action_scale)
      : Float32Array.from(r.action_scale);
    this.loco24 = (r as { frame?: string }).frame === "loco24";
    this.setGains(r.default_dof_pos, r.kp, r.kd);
    this.limIdx = Int32Array.from(r.limits_joint_idx ?? []);
    this.lo = Float32Array.from(r.dof_lower_limits ?? []); this.hi = Float32Array.from(r.dof_upper_limits ?? []);
    this.c = r.cmd; this.mem = r.memory ?? 5;
    this.maxNow = [...this.c.max];
    this.last = new Float32Array(this.dai.length);
    this.stackDepth = this.mem;
    this.frameLayout = [["gyro", 3], this.loco24 ? ["rep6d", 6] : ["projected_gravity", 3], ["q (abs)", this.dai.length],
      ["dq", this.dai.length], [this.loco24 ? "last_action (scaled)" : "last_action", this.dai.length]];
    this.actJointNames = Array.from(this.dai, (d) => this.r.joint_names[d]);
    this.setProfile(false);
  }

  private vxMax() { return this.loco24 ? this.maxNow[0] : this.highProfile ? this.c.high_vx : this.c.max[0]; }
  private setProfile(high: boolean) {
    this.highProfile = high;
    const m = [this.vxMax(), this.maxNow[1], this.maxNow[2]];
    this.velRange = [-m[0], m[0], -m[1], m[1], -m[2], m[2]];
  }
  private static readonly L24: Record<string, [number, number]> =
    { "R1+Up": [0, 0.5], "R1+Down": [0, -0.5], "R1+Left": [1, 0.3], "R1+Right": [1, -0.3], "R2+Up": [2, 0.5], "R2+Down": [2, -0.5] };
  override remoteCombos(): string[] {
    return [...(this.loco24 ? Object.keys(R1AmpMotionDriver.L24) : ["R2+Up", "R2+Down"]), ...Object.keys(this.combos)];
  }
  override remote(combo: string) {
    const l = this.loco24 ? R1AmpMotionDriver.L24[combo] : undefined;
    if (l) { this.maxNow[l[0]] = Math.max(0, this.maxNow[l[0]] + l[1]); this.setProfile(false); }   // x/y/yaw_cmd_max_gamepad
    else if (combo === "R2+Up") this.setProfile(true);
    else if (combo === "R2+Down") this.setProfile(false);
    else super.remote(combo);
  }

  override reset() {
    super.reset();
    this.prev.fill(0); this.last.fill(0); this.state = 0; this.walkModel = false;
    this.maxNow.splice(0, 3, ...this.c.max); this.setProfile(false);
    this.hist = Array(this.mem).fill(this.prop());
  }

  private prop(): Float32Array {
    const [q, dq] = this.polQ();
    const na = this.dai.length, o = this.loco24 ? 9 : 6, f = new Float32Array(o + 3 * na);
    f.set(this.gyro(), 0);
    if (this.loco24) { const M = matFromWxyz(this.baseQuat()); f.set([M[0], M[1], M[3], M[4], M[6], M[7]], 3); }
    else f.set(this.gravity(), 3);
    for (let i = 0; i < na; i++) { f[o + i] = q[this.dai[i]]; f[o + na + i] = dq[this.dai[i]]; }
    f.set(this.last, o + 2 * na);
    return f;
  }

  private command(ly: number, lx: number, rx: number): Float32Array {
    const c = this.c, m = [this.vxMax(), this.maxNow[1], this.maxNow[2]], s = [ly, -lx, -rx];
    const raw = s.map((v, i) => { const o = f32(v * m[i]); return Math.abs(o) < 0.05 ? 0 : o; });
    if (raw[0] < 0) raw[0] = raw[0] <= -0.3 ? (m[0] > 1e-6 ? f32(raw[0] / m[0]) : raw[0]) : 0;
    const p = this.prev;
    const o = Float32Array.from([
      slewAxis(raw[0], p[0], c.vx_up, c.vx_down, f32(c.vx_up * 0.5), c.vx_down),
      slewAxis(raw[1], p[1], c.vy_up, c.vy_down, c.vy_up, c.vy_down),
      slewAxis(raw[2], p[2], c.yaw_up, c.yaw_down, c.yaw_up, c.yaw_down)]);
    this.prev = Float32Array.from(o);
    const still = Math.abs(o[0]) < 0.2 && Math.abs(o[1]) < 0.2 && Math.abs(o[2]) < 0.3;
    if (still) o.fill(0);                               // stance_cmd_offset = 0
    switch (this.state) {
      case 3: if (o[0] < 1.5) this.state = 2; break;
      case 2:
        if (o[0] < 0.6) this.state = 1; else if (o[0] > 1.5) this.state = 3;
        if (still) this.state = 0;
        break;
      case 1:
        if (o[0] > 0.6) this.state = 2;
        if (still) this.state = 0;
        if (Math.abs(o[0]) < 0.2 && Math.abs(o[1]) < 0.2 && Math.abs(o[2]) > 0.3) o[2] = f32(o[2] * 2);
        break;
      default: if (!still) this.state = 1;
    }
    if (this.state !== 0) this.walkModel = true;       // the stance net only runs until the first step
    return o;
  }

  async step(command: Command): Promise<Float64Array> {
    const d = (v: number, m: number) => (m > 1e-6 ? clip(v / m, -1, 1) : 0);
    const cmd = this.command(d(command[0], this.vxMax()), d(-command[1], this.maxNow[1]), d(-command[2], this.maxNow[2]));
    const p = this.prop();
    this.hist.push(p); if (this.hist.length > this.mem) this.hist.shift();
    const memory = new Float32Array(this.mem * p.length);
    this.hist.forEach((h, k) => memory.set(h, k * p.length));
    const sess = !this.walkModel && this.aux.stance ? this.aux.stance : this.net;
    const act = await sess.run({
      memory: { data: memory, dims: [1, memory.length] },
      commands: { data: cmd, dims: [1, 3] },
      proprioception: { data: p, dims: [1, p.length] } });
    const na = this.dai.length;
    const raw = act.subarray(0, na);
    // 813 / 814 keep the SCALED action as last action (Locomotion24DofCore), AmpMotion the raw one
    this.last = Float32Array.from(raw, (v, i) => this.loco24 ? f32(v * this.scale[this.dai[i]]) : v);
    this.lastFrame = p; this.lastAction = this.last;
    const tgt = Float32Array.from(this.def);
    for (let i = 0; i < na; i++) tgt[this.dai[i]] = f32(this.def[this.dai[i]] + f32(raw[i] * this.scale[this.dai[i]]));
    for (const j of this.limIdx) tgt[j] = Math.min(Math.max(tgt[j], this.lo[j]), this.hi[j]);
    const target = Float64Array.from(this.default);
    for (let d = 0; d < this.nd; d++) target[this.map[d]] = tgt[d];
    return target;
  }
}

// ---------------------------------------------------------------------------------------------- 830 / 832 / 833
interface GaitCfg {
  walk_air_ratio: number; run_air_ratio: number; walk_cycle: number; run_cycle: number;
  transition_speed_min: number; transition_speed_max: number;
}
interface ArmsCfg {
  arm_dof_idx: number[]; arm_low_limit: number[]; arm_high_limit: number[]; arm_resample_s: number;
  arm_soft_limit: number; arm_policy_ratio: number; arm_random_ratio: number; arm_return_s?: number;
}

export class R1GaitDriver extends R1FwBase {
  needsCommand = true;
  private readonly perm: Int32Array;           // obs/action slot k ↔ policy dof perm[k]
  /** action k drives policy dof actIdx[k] (= perm unless a legs-only net: 831 12-action nets) */
  private readonly actIdx: Int32Array;
  /** 831 alljoint (1.0.2.181 / .154 core): the stick command is computed then overwritten with 0 */
  private readonly zeroCmd: boolean;
  private readonly def: Float32Array;
  private readonly scale: number;
  private readonly vr: number[];
  private readonly g?: GaitCfg;
  private readonly arms?: ArmsCfg;
  private readonly mem: number;
  private readonly db: number; private readonly coup: number; private readonly vxDefault: number;
  private readonly acc: number[];
  private vxLimit: number;
  private hist: Float32Array[] = [];
  private last: Float32Array;
  private cmd = new Float32Array(3);
  private phase = 0;
  // 833 random arms
  private armMode = 0;                         // 0 policy, 1 random, 2 returning
  private armT = 0; private armA = 0;
  private armFrom!: Float32Array; private armTo!: Float32Array; private armLast!: Float32Array;
  private rng = 1;

  constructor(cfg: EvalConfig, spec: RobotSpec, eng: Engine, readonly net: OnnxSession) {
    super(cfg, spec, eng);
    const r = this.r as R1FwCfg & { action_joint_idx?: number[]; default_dof_pos: number[]; action_scale: number;
      kp: number[]; kd: number[]; vel_range: number[]; default_vx_forward_limit: number; angular_coupling_strength: number;
      joystick_deadband?: number; acc?: number[]; gait?: GaitCfg; arms?: ArmsCfg };
    this.perm = Int32Array.from((r as { obs_joint_idx?: number[] }).obs_joint_idx ?? r.action_joint_idx
      ?? this.r.joint_names.map((_, i) => i));
    this.actIdx = Int32Array.from(r.action_joint_idx ?? this.perm);
    this.zeroCmd = !!(r as { zero_cmd?: boolean }).zero_cmd;
    this.def = Float32Array.from(r.default_dof_pos);
    this.scale = r.action_scale;
    this.setGains(r.default_dof_pos, r.kp, r.kd);
    this.vr = r.vel_range; this.vxDefault = r.default_vx_forward_limit; this.vxLimit = this.vxDefault;
    this.coup = r.angular_coupling_strength; this.db = r.joystick_deadband ?? 0.08;
    // [vx_up, vx_down, vy_up, vy_down, wz_up, wz_down] (firmware defaults 0.03 0.06 0.03 0.06 0.05 0.13)
    this.acc = r.acc ?? [0.03, 0.06, 0.03, 0.06, 0.05, 0.13];
    this.g = r.gait; this.arms = r.arms;
    this.mem = r.memory ?? 10;
    this.last = new Float32Array(this.actIdx.length);
    this.stackDepth = this.mem;
    this.frameLayout = [["gyro", 3], ["projected_gravity", 3], ["cmd", 3], ["q-default", this.nd], ["dq", this.nd],
      ["last_action", this.actIdx.length]];
    if (this.g) this.frameLayout.push(["sin 2πφ", 2], ["cos 2πφ", 2], ["air ratio", 2]);
    this.actJointNames = Array.from(this.actIdx, (d) => this.r.joint_names[d]);
    if (this.zeroCmd) this.needsCommand = false;
    this.pubRange();
  }

  private pubRange() {
    const m = [this.vxLimit, Math.max(Math.abs(this.vr[2]), Math.abs(this.vr[3])),
               Math.max(Math.abs(this.vr[4]), Math.abs(this.vr[5]))];
    this.velRange = [-m[0], m[0], -m[1], m[1], -m[2], m[2]];
  }
  override remoteCombos(): string[] {
    return ["R2+Up", "R2+Down", ...(this.arms ? ["Start"] : []), ...Object.keys(this.combos)];
  }
  override remote(combo: string) {
    if (combo === "R2+Up") { this.vxLimit = this.vr[1]; this.pubRange(); }
    else if (combo === "R2+Down") { this.vxLimit = this.vxDefault; this.pubRange(); }
    else if (combo === "Start" && this.arms) this.toggleArms();
    else super.remote(combo);
  }

  override reset() {
    super.reset();
    this.cmd.fill(0); this.last.fill(0); this.phase = 0; this.armMode = 0;
    if (this.arms) this.armLast = Float32Array.from(this.arms.arm_dof_idx, (d) => this.def[d]);
    this.vxLimit = this.vxDefault; this.pubRange();
    this.hist = Array(this.mem).fill(this.frame());      // entry frame (advances the clock once)
  }

  private frame(): Float32Array {
    const [q, dq] = this.polQ();
    const n = this.nd, na = this.actIdx.length, f = new Float32Array(9 + 2 * n + na + (this.g ? 6 : 0));
    f.set(this.gyro(), 0); f.set(this.gravity(), 3); f.set(this.cmd, 6);
    for (let k = 0; k < n; k++) {
      const d = this.perm[k];
      f[9 + k] = q[d] - this.def[d]; f[9 + n + k] = dq[d];
    }
    f.set(this.last, 9 + 2 * n);
    if (this.g) {
      const g = this.g, sp = Math.hypot(this.cmd[0], this.cmd[1]);
      const t = clip((sp - g.transition_speed_min) / Math.max(g.transition_speed_max - g.transition_speed_min, 1e-6), 0, 1);
      const air = f32(g.walk_air_ratio + (g.run_air_ratio - g.walk_air_ratio) * t);
      const cyc = Math.max(g.walk_cycle + (g.run_cycle - g.walk_cycle) * t, 1e-6);
      const fr = (x: number) => { const y = x % 1; return y < 0 ? y + 1 : y; };
      this.phase = fr(this.phase + 0.02 / cyc);
      const pL = fr(this.phase + air), pR = fr(this.phase + air + 0.5);
      const o = 9 + 2 * n + na;
      f[o] = Math.sin(pL * 6.2832); f[o + 1] = Math.sin(pR * 6.2832);
      f[o + 2] = Math.cos(pL * 6.2832); f[o + 3] = Math.cos(pR * 6.2832);
      f[o + 4] = air; f[o + 5] = air;
    }
    return f;
  }

  private command(ly: number, lx: number, rx: number) {
    const db = (v: number) => (Math.abs(v) >= this.db ? v : 0);
    const sx = db(ly), sy = db(-lx), sw = db(-rx), vr = this.vr;
    const vx = sx >= 0 ? this.vxLimit * sx : Math.abs(sx) * vr[0];
    const vy = sy >= 0 ? vr[3] * sy : Math.abs(sy) * vr[2];
    const nrm = Math.min(Math.hypot(vx, vy) / Math.hypot(this.vxLimit, vr[3]), 1);
    const k = 1 - this.coup * nrm;
    const wz = sw >= 0 ? sw * vr[5] * k : Math.abs(sw) * vr[4] * k;
    const a = this.acc, p = this.cmd;
    const ramp = (n: number, o: number, up: number, dn: number) => {
      const lim = Math.abs(n) > Math.abs(o) ? up : dn, d = n - o;
      return o + (d <= 0 ? Math.max(d, -lim) : Math.min(d, lim));
    };
    this.cmd = Float32Array.from([ramp(vx, p[0], a[0], a[1]), ramp(vy, p[1], a[2], a[3]), ramp(wz, p[2], a[4], a[5])]);
    if (this.zeroCmd) this.cmd.fill(0);
  }

  // ---- 833 random-arm demo ----
  private rand() { this.rng = (this.rng * 1103515245 + 12345) & 0x7fffffff; return this.rng / 2147483648; }
  private sampleArm() {
    const A = this.arms!;
    this.armFrom = Float32Array.from(this.armTo ?? this.armLast);
    this.armTo = Float32Array.from(A.arm_dof_idx, (_, i) => {
      const lo = A.arm_low_limit[i] * A.arm_soft_limit, hi = A.arm_high_limit[i] * A.arm_soft_limit;
      return (hi - lo) * this.rand() + lo;
    });
    this.armT = 0; this.armA = 0;
  }
  private toggleArms() {
    if (this.armMode === 0) { this.armMode = 1; this.armTo = Float32Array.from(this.armLast); this.sampleArm(); }
    else { this.armMode = 2; this.armFrom = Float32Array.from(this.armLast); this.armT = 0; }
  }

  async step(command: Command): Promise<Float64Array> {
    const m = [this.vxLimit, this.velRange![3], this.velRange![5]];
    this.command(clip(command[0] / m[0], -1, 1), clip(-command[1] / m[1], -1, 1), clip(-command[2] / m[2], -1, 1));
    const f = this.frame();
    this.hist.push(f); if (this.hist.length > this.mem) this.hist.shift();
    const obs = new Float32Array(this.mem * f.length);
    this.hist.forEach((h, k) => obs.set(h, k * f.length));
    const act = await this.net.run({ obs: { data: obs, dims: [1, obs.length] } });
    this.last = Float32Array.from(act.subarray(0, this.actIdx.length));
    this.lastFrame = f; this.lastAction = this.last;
    const tgt = Float32Array.from(this.def);
    this.actIdx.forEach((d, k) => { tgt[d] = f32(this.def[d] + f32(this.last[k] * this.scale)); });
    if (this.arms) this.armTargets(tgt);
    const target = Float64Array.from(this.default);
    for (let d = 0; d < this.nd; d++) target[this.map[d]] = tgt[d];
    return target;
  }

  private armTargets(tgt: Float32Array) {
    const A = this.arms!, idx = A.arm_dof_idx, pol = Float32Array.from(idx, (d) => tgt[d]);
    if (this.armMode === 1) {
      this.armT += 0.02;
      if (this.armT >= A.arm_resample_s) this.sampleArm();
      this.armA = Math.min(this.armT / A.arm_resample_s, 1);
      const out = Float32Array.from(idx, (_, i) => {
        const r = (1 - this.armA) * this.armFrom[i] + this.armA * this.armTo[i];
        return clip(A.arm_policy_ratio * pol[i] + A.arm_random_ratio * r, A.arm_low_limit[i], A.arm_high_limit[i]);
      });
      idx.forEach((d, i) => { tgt[d] = out[i]; });
      this.armLast = out;
    } else if (this.armMode === 2) {
      this.armT += 0.02;
      const a = Math.min(this.armT / (A.arm_return_s ?? A.arm_resample_s), 1);
      const out = Float32Array.from(idx, (_, i) => (1 - a) * this.armFrom[i] + a * pol[i]);
      idx.forEach((d, i) => { tgt[d] = out[i]; });
      if (a >= 0.999999) this.armMode = 0;
      this.armLast = out;
    } else this.armLast = pol;
  }
}

// ---------------------------------------------------------------------------------------------- tracking
interface TrackSeg {
  motion: string;          // aux_files role of the CSV (cols: pos 3 | quat xyzw 4 | joints)
  net?: string;            // aux_models role (default: the pack's main net)
  fps: number; start: number; end: number;
  stiffness?: number[]; damping?: number[]; action_scale?: number[];
  /** Qishen face-down: elapsed time at which the firmware switches to the next segment (face-up) */
  switch_at?: number;
}

/** Motion-tracking cores: DanceCore (602-608, obs 129 EDU / 109 Air), QishenCore (701), TangxiaCore (702).
 * frame = [ref joint pos (net order), ref joint vel, anchor term, gyro, q − default, dq, last action], one
 * frame, no history. Reference at t = start + k·dt, linearly interpolated between CSV rows (fps), velocity =
 * forward difference × fps. Anchor term: dances = the first two columns (row-major 3×2) of
 * R(q_torso⁻¹ · q_off · q_ref_torso(t)), torso = root · Rx(waist_roll) · Rz(waist_yaw) for the robot (IMU quat +
 * measured waist) and the reference (CSV root quat + CSV waist; Air: pelvis / root), q_off = yaw(q_torso) ·
 * yaw(q_ref_root(start))⁻¹ at entry (bench dance602b: median 0.002, max 0.023 = sampling skew);
 * Qishen / Tangxia = projected gravity. action clipped (±10 dance, ±100 get-up), target = act·scale + offset;
 * get-ups blend from the entry pose over the first 0.5 s. Qishen picks face-down (gravity x ≥ 0) or face-up,
 * face-down switches to the face-up net + clip at `switch_at`. Safety: tilt of the robot vs the reference
 * > 1 rad (get-ups) → damping. At the clip end the firmware returns to AmpLocomotion (`next_policy`). */
export class R1TrackDriver extends R1FwBase {
  clipDriven = true;
  private readonly segs: TrackSeg[];
  private seg = 0;
  private readonly csvPerm?: Int32Array;      // net i reads CSV joint csvPerm[i] (dances: joint_ids_map)
  private readonly def: Float32Array; private readonly off: Float32Array;
  private scale: Float32Array;
  private readonly clipA: number;
  private readonly anchor: string;
  private readonly blend: number;
  private readonly safety: number;
  private t = 0;
  private last: Float32Array;
  private qOff: number[] = [1, 0, 0, 0];
  private damped = false;
  private fresh = true;
  /** DanceCore::check_safety (1.0.2.181 = .154): |up_z(robot torso) − up_z(q_off·ref torso)| > thr for `frames`
   * consecutive ticks → Damping (dances.yaml safety_fail_frame_threshold 3, threshold 0.8) */
  private readonly upz?: [number, number];
  private upzFail = 0;
  private motions: Record<string, { data: Float32Array; nRows: number; nCols: number }>;

  constructor(cfg: EvalConfig, spec: RobotSpec, eng: Engine, readonly net: OnnxSession,
              readonly aux: Record<string, OnnxSession>,
              motions: Record<string, { data: Float32Array; nRows: number; nCols: number }>) {
    super(cfg, spec, eng);
    const r = this.r as R1FwCfg & { segments: TrackSeg[]; csv_joint_perm?: number[]; default_joint_pos: number[];
      action_offset?: number[]; action_scale: number[]; stiffness: number[]; damping: number[]; action_clip?: number;
      anchor: string; blend_s?: number; safety_rad?: number; faceup_first?: boolean };
    this.motions = motions;
    this.segs = r.segments;
    this.csvPerm = r.csv_joint_perm ? Int32Array.from(r.csv_joint_perm) : undefined;
    this.def = Float32Array.from(r.default_joint_pos);
    this.off = Float32Array.from(r.action_offset ?? r.default_joint_pos);
    this.scale = Float32Array.from(r.action_scale);
    this.setGains(r.default_joint_pos, r.stiffness, r.damping);
    this.clipA = r.action_clip ?? 10; this.anchor = r.anchor; this.blend = r.blend_s ?? 0;
    this.safety = r.safety_rad ?? 0;
    this.upz = (r as { upz_safety?: [number, number] }).upz_safety;
    this.last = new Float32Array(this.nd);
    this.frameLayout = [["ref q", this.nd], ["ref dq", this.nd], [this.anchor === "ori6" ? "anchor ori6" : "gravity",
      this.anchor === "ori6" ? 6 : 3], ["gyro", 3], ["q-default", this.nd], ["dq", this.nd], ["last_action", this.nd]];
  }

  /** reference anchor: CSV root quat, on EDU dances composed with the CSV waist roll / yaw (torso) */
  private refAnchor(x: number, root: number[]): number[] {
    const w = (this.r as { ref_waist?: number[] }).ref_waist;
    if (!w) return root;
    const m = this.motions[this.segs[this.seg].motion], nc = m.nCols, i = Math.min(Math.floor(x), m.nRows - 2), a = x - i;
    const col = (c: number) => (1 - a) * m.data[i * nc + 7 + c] + a * m.data[(i + 1) * nc + 7 + c];
    const r = col(w[0]), y = col(w[1]);
    return qmul(qmul(root, [Math.cos(r / 2), Math.sin(r / 2), 0, 0]), [Math.cos(y / 2), 0, 0, Math.sin(y / 2)]);
  }

  private sample(x: number): { q: Float32Array; dq: Float32Array; quat: number[] } {
    const m = this.motions[this.segs[this.seg].motion], fps = this.segs[this.seg].fps, nc = m.nCols;
    const row = (i: number) => m.data.subarray(Math.min(Math.max(i, 0), m.nRows - 1) * nc,
                                               Math.min(Math.max(i, 0), m.nRows - 1) * nc + nc);
    const i = Math.floor(x), a = x - i, r0 = row(i), r1 = row(i + 1), r2 = row(i + 2);
    const q = new Float32Array(this.nd), dq = new Float32Array(this.nd);
    for (let k = 0; k < this.nd; k++) {
      const c = 7 + (this.csvPerm ? this.csvPerm[k] : k);
      q[k] = (1 - a) * r0[c] + a * r1[c];
      dq[k] = ((1 - a) * (r1[c] - r0[c]) + a * (r2[c] - r1[c])) * fps;
    }
    // quaternion (xyzw in the CSV) → nlerp (wxyz)
    let w0 = r0[6], w1 = r1[6]; const dot = r0[3] * r1[3] + r0[4] * r1[4] + r0[5] * r1[5] + w0 * w1;
    const s = dot < 0 ? -1 : 1; w1 *= s;
    const qq = [(1 - a) * w0 + a * w1, (1 - a) * r0[3] + a * s * r1[3], (1 - a) * r0[4] + a * s * r1[4], (1 - a) * r0[5] + a * s * r1[5]];
    const n = Math.hypot(...qq);
    return { q, dq, quat: qq.map((v) => v / n) };
  }

  /** robot anchor quaternion (wxyz): IMU (pelvis) · Rx(waist_roll) · Rz(waist_yaw) where those joints exist */
  private anchorQuat(): number[] {
    let q = Array.from(this.baseQuat());
    const [qq] = this.readQ();
    const wr = this.names.indexOf("waist_roll_joint"), wy = this.names.indexOf("waist_yaw_joint");
    if (wr >= 0 && this.qadr[wr] >= 0) q = qmul(q, [Math.cos(qq[wr] / 2), Math.sin(qq[wr] / 2), 0, 0]);
    if (wy >= 0 && this.qadr[wy] >= 0) q = qmul(q, [Math.cos(qq[wy] / 2), 0, 0, Math.sin(qq[wy] / 2)]);
    return q;
  }

  private enterSeg(k: number) {
    this.seg = k; const s = this.segs[k];
    this.t = s.start;
    if (s.stiffness) for (let i = 0; i < this.nd; i++) { this.kp[this.map[i]] = s.stiffness[i]; this.kd[this.map[i]] = s.damping![i]; }
    if (s.action_scale) this.scale = Float32Array.from(s.action_scale);
    // heading alignment: yaw(robot anchor) · yaw(ref ROOT at start)⁻¹ (bench: the root, not the ref torso)
    const ref = this.sample(s.start * s.fps).quat, rob = this.anchorQuat();
    this.qOff = qmul(yawQ(rob), qconj(yawQ(ref)));
  }

  override reset() {
    const pose = (this.r as { start_pose?: string }).start_pose;
    if (pose) {
      // get-up packs start lying (face-down / face-up), joints at the default pose
      this.groundStart = true;
      const s = Math.SQRT1_2, quat = pose === "facedown" ? [s, 0, s, 0] : [s, 0, -s, 0];
      const all = Array.from({ length: this.eng.model.nbody }, (_, i) => i).filter((i) => i !== 0);
      this.seat(this.default, quat, all, 0.02);
    } else super.reset();
    this.last.fill(0); this.damped = false; this.upzFail = 0;
    this.fresh = true;       // clip choice + heading alignment happen on the first tick: after a hand-over the
                             // worker puts the robot back where it was AFTER reset()
  }

  async step(): Promise<Float64Array> {
    if (this.fresh) {
      this.fresh = false;
      // Qishen: face-down clip when lying on the front (projected gravity x ≥ 0)
      this.enterSeg(this.segs[0].switch_at !== undefined ? (this.gravity()[0] >= 0 ? 0 : 1) : 0);
    }
    const s = this.segs[this.seg];
    if (this.damped) {
      const [q] = this.readQ(); for (let i = 0; i < this.n; i++) this.kp[i] = 0;
      return Float64Array.from(q);
    }
    const ref = this.sample(this.t * s.fps);
    const [q, dq] = this.polQ();
    const f = new Float32Array(2 * this.nd + (this.anchor === "ori6" ? 6 : 3) + 3 + 3 * this.nd);
    f.set(ref.q, 0); f.set(ref.dq, this.nd);
    let o = 2 * this.nd;
    const rob = this.anchorQuat();
    if (this.anchor === "ori6") {
      const M = quatMat(qmul(qconj(rob), qmul(this.qOff, this.refAnchor(this.t * s.fps, ref.quat))));
      f.set([M[0], M[1], M[3], M[4], M[6], M[7]], o); o += 6;
    } else { f.set(this.gravity(), o); o += 3; }
    f.set(this.gyro(), o); o += 3;
    for (let i = 0; i < this.nd; i++) { f[o + i] = q[i] - this.def[i]; f[o + this.nd + i] = dq[i]; }
    f.set(this.last, o + 2 * this.nd);
    const out = await (s.net ? this.aux[s.net] : this.net).run({ obs: { data: f, dims: [1, f.length] } });
    this.last = Float32Array.from(out.subarray(0, this.nd), (v) => clip(v, -this.clipA, this.clipA));
    this.lastFrame = f; this.lastAction = this.last;
    const el = this.t - s.start;
    const b = this.blend > 0 && el < this.blend ? clip(el / this.blend, 0, 1) : 1;
    const target = Float64Array.from(this.default);
    for (let i = 0; i < this.nd; i++) {
      const tg = f32(this.last[i] * this.scale[i] + this.off[i]);
      target[this.map[i]] = (1 - b) * q[i] + b * tg;
    }
    // safety (get-ups): tilt between the robot's and the reference's up axes
    if (this.safety > 0) {
      const gr = matTVec(matFromWxyz(rob), [0, 0, 1]), gm = matTVec(matFromWxyz(qmul(this.qOff, ref.quat)), [0, 0, 1]);
      const ang = Math.acos(clip(gr[2] * gm[2] + Math.hypot(gr[0], gr[1]) * Math.hypot(gm[0], gm[1]), -1, 1));
      if (ang > this.safety && el > 0.04) this.damped = true;
    }
    if (this.upz) {
      const zr = matFromWxyz(rob)[8], zm = matFromWxyz(qmul(this.qOff, this.refAnchor(this.t * s.fps, ref.quat)))[8];
      this.upzFail = Math.abs(zr - zm) > this.upz[0] ? this.upzFail + 1 : 0;
      if (this.upzFail >= this.upz[1]) this.damped = true;
    }
    this.t += 0.02;
    if (s.switch_at !== undefined && this.t - s.start >= s.switch_at && this.seg + 1 < this.segs.length) {
      this.enterSeg(this.seg + 1);
    } else if (this.t - s.start > s.end - s.start) {
      this.t = s.end;
      // Tangxia ends lying down → Damping (on_end: damping); dances / Qishen → the loco FSM (next_policy)
      if ((this.r as { on_end?: string }).on_end === "damping") this.damped = true; else this.done = true;
    }
    return target;
  }
}

// ---------------------------------------------------------------------------------------------- 804 / 805 mimic
interface MimicClip { file: string; rot_detect: number; cool: number; api?: number }
interface MimicCfg {
  mimic_name: string;                       // "punch" | "actor"
  default_dof_pos: number[]; kp: number[]; kd: number[]; action_scale: number;
  limits_joint_idx: number[]; dof_lower_limits: number[]; dof_upper_limits: number[];
  obs_scale: [number, number, number, number, number];   // gyro, gravity, q, dq, last action
  twist: { scale: number[]; offset: number[]; min: number[]; decay: number; fc: number; fs: number };
  clips: Record<string, MimicClip>;         // name (file stem) -> clip, in yaml order
  default_traj: string; front_get_up?: string; back_get_up?: string;
  fall_down_length: number; front_down_jpos: number[]; back_down_jpos: number[]; transit_length: number;
  /** remote combo -> clip name ("get_up" = the fall-side get-up); single keys = double press on the robot */
  buttons: Record<string, string>;
  /** L2-normalise the latent before the net (checkpoints exported without the in-graph normalisation) */
  cmd_norm?: boolean;
}

/** MimicCore (MimicPunch 805 / MimicActor 804), decoded from the unprotected r1_controller builds 1.0.2.181 /
 * 1.0.2.223 (identical cores; the shipping 1.0.2.154 carries the configs + nets but never registers the states, so
 * nothing here can be checked on the bench). Per 50 Hz tick:
 *  1. frame 78 = clamp([gyro·0.2, gravity, q − default, dq·0.05, last action] , ±100); p_obs = 10 frames oldest
 *     first (entry: the entry frame ×10, last action 0).
 *  2. twist (sticks): (ly, −lx, −rx)·twist_scale → 1st-order low-pass (fc, fs 50; first sample passes) →
 *     vx ≥ −0.8 → TwistDecay on x / y (step 0.025, min_twist dead band, decays through 0) , z dead band.
 *  3. TrackOfflineCommand: a playing clip feeds its row (64-d VQ latent, one row per tick, rows 0..N−1);
 *     START double = stop: blend the last row into the default clip's last row over transit_length. Fall
 *     check when idle or in a rot_detect clip: projected gravity z > −0.5 → the policy is ignored, targets
 *     interpolate from the fall pose to front/back_down_jpos over fall_down_length (side from gravity x),
 *     last action 0, until "get_up" (after ≥ fall_down_length) plays the side's get-up clip.
 *  4. punch: a clip plays on net[1] (cmd = row), idle on net[0] with cmd = rot(+5°)·twist (+ vx 0.2 when turning
 *     in place) + twist_offset; actor: always net[0], idle cmd = last row of the default clip, and after the first
 *     triggered clip ends the FSM returns to the walker (next_policy).
 *  5. target = default + clamp(out, ±10)·action_scale, arms (limits_joint_idx) clamped.
 * Buttons: a combo fires its clip only when idle or within the last 10 rows of the playing clip (chaining);
 * "api:<id>" actions (SetMotion 7108, the app) queue and play in order under the same rule. */
export class R1MimicDriver extends R1FwBase {
  private readonly m: MimicCfg;
  private readonly def: Float32Array;
  private readonly clips: Record<string, { rows: Float32Array[]; p: MimicClip }> = {};
  private readonly apiMap: Record<number, string> = {};
  private hist: Float32Array[] = [];
  private last: Float32Array;
  private netAct: Float32Array;
  // twist
  private lpf: number[] | null = null;
  private tw = [0, 0, 0];
  private readonly alpha: number;
  // clip state
  private track = "";
  private frame = -1;
  private transit = 0;
  private lastTgt: Float32Array = new Float32Array(64);
  private next: Float32Array = new Float32Array(64);
  private fallT = 0;
  private fallState = 2;                 // 0 Front (lying on the back: g.x < −0.1), 1 Back, 2 None
  private fallStart: Float32Array;
  private fallDes: Float32Array;
  private cooling: Record<string, number> = {};
  private used = 0;
  private queue: number[] = [];
  private pending: string[] = [];

  constructor(cfg: EvalConfig, spec: RobotSpec, eng: Engine, readonly net: OnnxSession,
              readonly aux: Record<string, OnnxSession>,
              files: Record<string, { data: Float32Array; nRows: number; nCols: number }>) {
    super(cfg, spec, eng);
    this.m = (this.r as unknown as { mimic: MimicCfg }).mimic;
    const m = this.m;
    this.def = Float32Array.from(m.default_dof_pos);
    this.setGains(m.default_dof_pos, m.kp, m.kd);
    for (const [name, p] of Object.entries(m.clips)) {
      const t = files[p.file];
      const rows: Float32Array[] = [];
      for (let i = 0; i < t.nRows; i++) rows.push(t.data.slice(i * t.nCols, (i + 1) * t.nCols));
      this.clips[name] = { rows, p };
      if (p.api !== undefined) this.apiMap[p.api] = name;
    }
    const dt = 1 / m.twist.fs, rc = 1 / (m.twist.fc * 6.28318548);
    this.alpha = dt / (dt + rc);
    this.last = new Float32Array(this.nd); this.netAct = new Float32Array(this.nd);
    this.fallStart = new Float32Array(this.nd); this.fallDes = new Float32Array(this.nd);
    this.stackDepth = 10;
    this.frameLayout = [["gyro·0.2", 3], ["projected_gravity", 3], ["q-default", this.nd], ["dq·0.05", this.nd],
      ["last_action", this.nd]];
    this.needsCommand = m.mimic_name === "punch";
    const ts = m.twist.scale;
    this.velRange = [-1 * ts[0], 1 * ts[0], -1 * ts[1], 1 * ts[1], -1 * ts[2], 1 * ts[2]];
  }

  override remoteCombos(): string[] {
    // (the SetMotion API ids are accepted by remote("api:<id>") but not listed: every one has a button)
    return [...Object.keys(this.m.buttons), "Start", ...Object.keys(this.combos)];
  }
  override remote(combo: string) {
    if (this.combos[combo]) return super.remote(combo);
    this.pending.push(combo);            // handled at the next tick (the firmware's 1 kHz update())
  }

  override reset() {
    super.reset();
    this.lpf = null; this.tw = [0, 0, 0];
    this.frame = 0; this.track = this.m.default_traj; this.transit = 0;
    this.fallT = 0; this.fallState = 2; this.cooling = {}; this.used = 0; this.queue = []; this.pending = [];
    this.last.fill(0); this.netAct.fill(0);
    this.next = this.row(this.track, 0);
    const f = this.obsFrame();
    this.hist = Array(10).fill(f);        // init_state: the entry frame in all 10 rows
  }

  private row(name: string, k: number): Float32Array {
    const r = this.clips[name].rows;
    return r[Math.min(Math.max(k, 0), r.length - 1)];
  }
  private nRows(name: string) { return this.clips[name]?.rows.length ?? 0; }

  private obsFrame(): Float32Array {
    const [q, dq] = this.polQ(), n = this.nd, sc = this.m.obs_scale;
    const f = new Float32Array(6 + 3 * n);
    const w = this.gyro(), g = this.gravity();
    for (let i = 0; i < 3; i++) { f[i] = w[i] * sc[0]; f[3 + i] = g[i] * sc[1]; }
    for (let i = 0; i < n; i++) {
      f[6 + i] = (q[i] - this.def[i]) * sc[2]; f[6 + n + i] = dq[i] * sc[3]; f[6 + 2 * n + i] = this.last[i] * sc[4];
    }
    for (let i = 0; i < f.length; i++) f[i] = clip(f[i], -100, 100);
    return f;
  }

  private twistDecay(c: number, t: number, min: number): number {
    const step = this.m.twist.decay;
    if ((Math.abs(c) < Math.abs(t) && t * c >= 0) || t * c < 0) return f32(t - (t < 0 ? -1 : 1) * step);
    if (Math.abs(c) > Math.abs(t) && t * c >= 0) return min > Math.abs(c) ? t : c;
    return c;
  }

  private updateTwist(command: Command) {
    const tw = this.m.twist, vr = this.velRange!;
    const ly = clip(command[0] / vr[1], -1, 1), lx = clip(-command[1] / vr[3], -1, 1), rx = clip(-command[2] / vr[5], -1, 1);
    const inp = [ly * tw.scale[0], -lx * tw.scale[1], -rx * tw.scale[2]];
    this.lpf = this.lpf ? this.lpf.map((o, i) => this.alpha * inp[i] + (1 - this.alpha) * o) : inp;
    const c = [...this.lpf]; c[0] = Math.max(c[0], -0.8);
    this.tw[0] = this.twistDecay(c[0], this.tw[0], tw.min[0]);
    this.tw[1] = this.twistDecay(c[1], this.tw[1], tw.min[1]);
    this.tw[2] = Math.abs(c[2]) < tw.min[2] ? 0 : c[2];
  }

  private setMotion(name: string) {
    if (name === "get_up") {
      if (this.fallT < this.m.fall_down_length) return;
      const g = this.fallState === 0 ? this.m.front_get_up : this.fallState === 1 ? this.m.back_get_up : undefined;
      if (g && this.clips[g]) { this.track = g; this.frame = 0; this.transit = 0; }
      return;
    }
    if (this.fallState !== 2 || !this.clips[name]) return;
    this.track = name; this.frame = 0; this.transit = 0;
    this.cooling[name] = Math.round(this.clips[name].p.cool / 0.02);
    this.used++;
  }
  private canFire() { return this.frame === -1 || this.frame >= this.nRows(this.track) - 10; }

  private buttons() {
    for (const c of this.pending.splice(0)) {
      if (c === "Start") {                  // START double click: stop the clip, blend to the default clip
        if (this.frame >= 0) {
          this.frame = this.nRows(this.track); this.transit = this.m.transit_length; this.lastTgt = this.next;
        }
        this.queue = [];
      } else if (c.startsWith("api:")) {
        const id = Number(c.slice(4));
        this.queue.push(Math.min(Math.max(Math.trunc(id), 0), 1000));
      } else {
        const name = this.m.buttons[c];
        if (name && (this.cooling[name] ?? 0) <= 0 && this.canFire()) { this.setMotion(name); this.queue = []; }
      }
    }
    if (this.queue.length && this.canFire()) {
      const name = this.apiMap[this.queue.shift()!];
      if (name) this.setMotion(name);
    }
  }

  private trackOffline() {
    if (this.frame >= 0) {
      const N = this.nRows(this.track);
      if (this.transit === 0) this.next = this.row(this.track, this.frame);
      else {
        const r = clip(this.transit / this.m.transit_length, 0, 1);
        const d = this.row(this.m.default_traj, 1 << 30);
        this.next = Float32Array.from(d, (v, i) => f32((1 - r) * v + r * this.lastTgt[i]));
      }
      if (this.frame >= N && this.transit === 0) this.frame = -1;
      else { this.frame = Math.min(this.frame + 1, 100000); this.transit = clip(this.transit - 0.02, 0, this.m.transit_length); }
    }
    const check = this.frame === -1 || (this.clips[this.track]?.p.rot_detect ?? 1) === 1;
    const g = this.gravity();
    if (check && (this.fallT > 0 || g[2] > -0.5)) {
      if (this.fallT === 0) { this.fallStart = Float32Array.from(this.polQ()[0]); this.frame = -1; }
      const a = clip(this.fallT / this.m.fall_down_length, 0, 1);
      this.fallState = g[0] >= -0.1 ? 1 : 0;
      const down = this.fallState === 0 ? this.m.front_down_jpos : this.m.back_down_jpos;
      this.fallDes = Float32Array.from(this.fallStart, (v, i) => f32((1 - a) * v + a * down[i]));
      this.fallT = Math.min(this.fallT + 0.02, 10000);
    } else { this.fallT = 0; this.fallState = 2; }
    for (const k of Object.keys(this.cooling)) this.cooling[k] = Math.max(this.cooling[k] - 1, 0);
  }

  async step(command: Command): Promise<Float64Array> {
    const m = this.m;
    this.buttons();
    // update_state: frame + history + twist
    const f = this.obsFrame();
    this.hist.push(f); if (this.hist.length > 10) this.hist.shift();
    const pObs = new Float32Array(10 * f.length);
    this.hist.forEach((h, k) => pObs.set(h, k * f.length));
    this.updateTwist(command);
    // infer
    this.trackOffline();
    let out: Float32Array;
    const run = (sess: OnnxSession, cmd: Float32Array) => {
      // earlier checkpoints without the in-graph ReduceL2/Div of the latent: normalise here (config cmd_norm)
      if (m.cmd_norm && cmd.length > 3) {
        const n = Math.max(Math.hypot(...cmd), 1e-12); cmd = Float32Array.from(cmd, (v) => v / n);
      }
      return sess.run({ p_obs: { data: pObs, dims: [1, 10, f.length] }, cmd: { data: cmd, dims: [1, cmd.length] } });
    };
    if (m.mimic_name === "punch") {
      if (this.frame >= 0) out = await run(this.aux.clip ?? this.net, this.next);
      else {
        const d = 0.087266, t = this.tw;
        let x = f32(t[0] * Math.cos(d) - t[1] * Math.sin(d));
        const y = f32(t[0] * Math.sin(d) + t[1] * Math.cos(d)), z = t[2];
        if (Math.abs(x) < 0.2 && Math.abs(z) > 0.4) x = 0.2;
        out = await run(this.net, Float32Array.from([x + m.twist.offset[0], y + m.twist.offset[1], z + m.twist.offset[2]]));
      }
    } else {
      if (this.frame < 0) {
        this.next = this.row(m.default_traj, 1 << 30);
        if (this.used > 0 && this.r.next_policy) { this.nextPolicy = this.r.next_policy; this.done = true; }
      }
      out = await run(this.net, this.next);
    }
    this.netAct = Float32Array.from(out.subarray(0, this.nd), (v) => f32(clip(v, -10, 10) * m.action_scale));
    const tgt = Float32Array.from(this.def, (v, i) => f32(v + this.netAct[i]));
    for (const j of m.limits_joint_idx) tgt[j] = Math.min(Math.max(tgt[j], m.dof_lower_limits[j]), m.dof_upper_limits[j]);
    this.last = Float32Array.from(this.netAct);
    if (this.fallState !== 2) { tgt.set(this.fallDes); this.last.fill(0); }
    this.lastFrame = f; this.lastAction = this.netAct;
    const target = Float64Array.from(this.default);
    for (let d = 0; d < this.nd; d++) target[this.map[d]] = tgt[d];
    return target;
  }

  /** the clip currently playing (inspector) */
  get activeNet(): string {
    return this.fallState !== 2 ? "fall pose" : this.frame >= 0 ? `clip ${this.track} ${this.frame}/${this.nRows(this.track)}` : "idle";
  }
}

// ---------------------------------------------------------------------------------------------- SimpleMotion
/** SimpleMotion ("hello" wave, simple_motion.yaml): no build of r1_controller implements it (1.0.2.223 only has
 * the enum 806). Reconstructed from the net's first-layer weights + a MuJoCo layout sweep (every other layout
 * falls): input 451 = 5 frames oldest first [gyro·0.25, gravity, q − default, dq·0.05, raw last action]
 * (start: the entry frame ×5) + the clip row k verbatim (61: pos, quat xyzw, q, lin vel, ang vel, dq), k = tick
 * (rows lower_index..upper_index, then the last row is held — it is the default pose); target = default + 0.25·out.
 * Left-arm tracking RMS 0.049 rad in the offline check. */
export class R1SimpleDriver extends R1FwBase {
  clipDriven = true;
  private readonly def: Float32Array;
  private readonly rows: Float32Array[] = [];
  private hist: Float32Array[] = [];
  private last: Float32Array;
  private k = 0;
  private readonly sc: { ang: number; dq: number; act: number; lo: number; hi: number; mem: number };

  constructor(cfg: EvalConfig, spec: RobotSpec, eng: Engine, readonly net: OnnxSession,
              files: Record<string, { data: Float32Array; nRows: number; nCols: number }>) {
    super(cfg, spec, eng);
    const r = this.r as R1FwCfg & { default_dof_pos: number[]; kp: number[]; kd: number[]; ang_vel_scale: number;
      dof_vel_scale: number; action_scale: number; lower_index: number; upper_index: number; memory?: number };
    this.def = Float32Array.from(r.default_dof_pos);
    this.setGains(r.default_dof_pos, r.kp, r.kd);
    const t = files.motion;
    for (let i = 0; i < t.nRows; i++) this.rows.push(t.data.slice(i * t.nCols, (i + 1) * t.nCols));
    this.sc = { ang: r.ang_vel_scale, dq: r.dof_vel_scale, act: r.action_scale, lo: r.lower_index,
                hi: Math.min(r.upper_index, this.rows.length - 1), mem: r.memory ?? 5 };
    this.last = new Float32Array(this.nd);
    this.stackDepth = this.sc.mem;
    this.frameLayout = [["gyro·0.25", 3], ["projected_gravity", 3], ["q-default", this.nd], ["dq·0.05", this.nd],
      ["last_action", this.nd]];
  }

  override reset() {
    super.reset();
    this.k = this.sc.lo; this.last.fill(0);
    this.hist = Array(this.sc.mem).fill(this.frame());
  }

  private frame(): Float32Array {
    const [q, dq] = this.polQ(), n = this.nd, f = new Float32Array(6 + 3 * n);
    const w = this.gyro();
    for (let i = 0; i < 3; i++) f[i] = w[i] * this.sc.ang;
    f.set(this.gravity(), 3);
    for (let i = 0; i < n; i++) { f[6 + i] = q[i] - this.def[i]; f[6 + n + i] = dq[i] * this.sc.dq; }
    f.set(this.last, 6 + 2 * n);
    return f;
  }

  async step(): Promise<Float64Array> {
    const f = this.frame();
    this.hist.push(f); if (this.hist.length > this.sc.mem) this.hist.shift();
    const row = this.rows[Math.min(this.k, this.sc.hi)];
    const x = new Float32Array(this.sc.mem * f.length + row.length);
    this.hist.forEach((h, i) => x.set(h, i * f.length));
    x.set(row, this.sc.mem * f.length);
    const out = await this.net.run({ input: { data: x, dims: [1, x.length] } });
    this.last = Float32Array.from(out.subarray(0, this.nd));
    this.lastFrame = f; this.lastAction = this.last;
    const target = Float64Array.from(this.default);
    for (let d = 0; d < this.nd; d++) target[this.map[d]] = f32(this.def[d] + this.last[d] * this.sc.act);
    if (this.k > this.sc.hi && this.r.next_policy) { this.nextPolicy = this.r.next_policy; this.done = true; }
    this.k++;
    return target;
  }
}

function qmul(a: number[], b: number[]): number[] {
  return [a[0] * b[0] - a[1] * b[1] - a[2] * b[2] - a[3] * b[3],
          a[0] * b[1] + a[1] * b[0] + a[2] * b[3] - a[3] * b[2],
          a[0] * b[2] - a[1] * b[3] + a[2] * b[0] + a[3] * b[1],
          a[0] * b[3] + a[1] * b[2] - a[2] * b[1] + a[3] * b[0]];
}
const qconj = (q: number[]) => [q[0], -q[1], -q[2], -q[3]];
function yawQ(q: number[]): number[] {
  const [w, x, y, z] = q, yaw = Math.atan2(2 * (w * z + x * y), 1 - 2 * (y * y + z * z));
  return [Math.cos(yaw / 2), 0, 0, Math.sin(yaw / 2)];
}
function quatMat(q: number[]): number[] { return Array.from(matFromWxyz(q)); }

/** Driver factory for packs with an `r1:` block and `firmware: true` (called from makeDriver). */
export async function makeR1FwDriver(cfg: EvalConfig, spec: RobotSpec, eng: Engine): Promise<BaseDriver> {
  const r = r1fw(cfg);
  const url = (p: string) => assetUrl(p).replace(/\.mnn$/, ".onnx");
  const net = await OnnxSession.load(url(cfg.policy.path));
  const aux: Record<string, OnnxSession> = {};
  for (const [role, p] of Object.entries(r.aux_models ?? {})) if (p) aux[role] = await OnnxSession.load(url(p));
  switch (r.obs_scheme) {
    case "amp_loco": return new R1AmpLocoDriver(cfg, spec, eng, net, aux);
    case "amp_motion": return new R1AmpMotionDriver(cfg, spec, eng, net, aux);
    case "gait": return new R1GaitDriver(cfg, spec, eng, net);
    case "mimic": case "simple": {
      const files: Record<string, { data: Float32Array; nRows: number; nCols: number }> = {};
      for (const [role, p] of Object.entries(r.aux_files ?? {})) if (p) files[role] = await loadTraj(p);
      return r.obs_scheme === "mimic" ? new R1MimicDriver(cfg, spec, eng, net, aux, files)
        : new R1SimpleDriver(cfg, spec, eng, net, files);
    }
    case "track": {
      const motions: Record<string, { data: Float32Array; nRows: number; nCols: number }> = {};
      for (const [role, p] of Object.entries(r.aux_files ?? {})) if (p) motions[role] = await loadTraj(p);
      return new R1TrackDriver(cfg, spec, eng, net, aux, motions);
    }
  }
  throw new Error(`${cfg.name}: unknown r1 obs_scheme '${r.obs_scheme}'`);
}
