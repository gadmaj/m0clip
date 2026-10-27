/** ai_sport 1.5.4 "legacy" (2024) G1 locomotion FSMs, decoded from bench MNN captures:
 *   200 hybrid_run     single net   input.1[400] = 10 x 40 frame
 *   201 blind_terrain  encoder [1500] = 50 x 30 proprio -> latent[80] (of 96); actor [480] = 400 + 80
 *   202 plane_encoder  encoder [1500] -> latent[24] (of 44);            actor [424] = 400 + 24
 *   203 waist_control  encoder [1500] -> latent[24] (of 44);            actor [444] = 10 x 42 + 24
 *   210 shot (kick)    single net   [420] = 10 x 42, one gait period from 200 standing, then back to 200
 *
 * The robot runs them at 100 Hz (control_dt 0.01). Frame (history oldest first, refilled with the first
 * frame on every FSM entry, when all filters restart from 0):
 *   [0:3]   gyro (pelvis) low-passed (omega_alpha) x 0.25
 *   [3:6]   (projected_gravity + [0,0,1]) x 3
 *   [6:9]   command [vx x 2, vy x 2, wz x 0.25], low-passed per tick (cmd_alpha)
 *   [9:21]  (q - default) / action_scale, legs; ankle pitch/roll low-passed at 10 Hz
 *   [21:33] dq low-passed (jvel_alpha 0.2) x 0.05, legs
 *   [33:37] cos thL, cos thR, sin thL, sin thR  (gait clock, duty-remapped, units of pi)
 *   [37:40] stand-height slot, (duty - duty_mean) / duty_scale, a per-policy constant
 *   [40:42] 203: q waist pitch, -q waist roll;  210: cos thR, sin thR
 * Encoder proprio frame = frame[0:6] ++ frame[9:33], 50 ticks oldest first; its first num_latent outputs
 * are appended to the actor input. Actions (12 legs) are clipped at 10; target = default + a x scale. */
import { clip, matFromWxyz, matTVec } from "../math";
import type { Command, EvalConfig, RobotSpec } from "../types";
import type { Engine } from "../../sim/engine";
import type { OnnxSession } from "../policy";
import { BaseDriver } from "./base";

const LEG_SCALE = [0.6, 0.4, 0.4, 1.4, 0.4, 0.2, 0.6, 0.4, 0.4, 1.4, 0.4, 0.2];
const ANKLES = [4, 5, 10, 11];
const DT = 0.01;
const HIST = 10;
const ENC_STEPS = 50;
const INIT_LEGS = [-0.32, 0, 0, 0.65, -0.33, 0, -0.32, 0, 0, 0.65, -0.33, 0];

/** hybrid_run (200) values; each FSM's pack config overrides what differs. */
const BASE = {
  kp: [100, 100, 100, 200, 40, 20, 100, 100, 100, 200, 40, 20, 100, 800, 800,
    90, 75, 20, 60, 4, 4, 4, 90, 75, 20, 60, 4, 4, 4],
  kd: [4, 4, 4, 8, 0.3, 0.1, 4, 4, 4, 8, 0.3, 0.1, 10, 5, 5,
    2, 1, 0.4, 1, 0.2, 0.2, 0.2, 2, 1, 0.4, 1, 0.2, 0.2, 0.2],
  default_dof_pos: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
    0.3, 0.25, 0, 0.97, 0.15, 0, 0, 0.3, -0.25, 0, 0.97, -0.15, 0, 0],
  tau: [88, 88, 88, 139, 50, 50, 88, 88, 88, 139, 50, 50, 88, 60, 60,
    20, 20, 20, 20, 20, 20, 20, 20, 20, 20, 20, 20, 20, 20],
  frame_dim: 40, num_latent: 0, omega_alpha: 0.6, jvel_alpha: 0.2, ankle_lpf_hz: 10, cmd_alpha: 0.03,
  vx_max: 1.0, delta_phi: [0, 1] as [number, number], velocity_points: [0.8, 2.0],
  duty_factor_points: [0.5, 0.3], period_points: [0.7, 0.5], duty_mean: 0.4, duty_scale: 0.2,
  obs_tail: [0, 0.2] as [number, number], stand_phase: 0.5, swing: "clock", rules: true,
  stand_kd_mult: 1.1, waist_obs: false, kick: false, kick_upper: [] as number[][],
  kick_delay: 2.0, kick_repeat: 0,
};
type Mode = typeof BASE;

function interp(x: number, xs: number[], ys: number[]): number {
  if (x <= xs[0]) return ys[0];
  for (let i = 1; i < xs.length; i++)
    if (x <= xs[i]) return ys[i - 1] + (ys[i] - ys[i - 1]) * (x - xs[i - 1]) / (xs[i] - xs[i - 1]);
  return ys[ys.length - 1];
}

/** raw gait phase (cycles) -> leg angle in units of pi, stance half stretched to the duty factor */
function theta(p: number, duty: number): number {
  p = ((p % 1) + 1) % 1;
  return p < duty ? p / duty : 1 + (p - duty) / (1 - duty);
}

/** Per-entry FSM state: everything the firmware re-creates when the FSM is (re)entered. */
class Runtime {
  hist: Float32Array[] = [];
  ehist: Float32Array[] = [];
  wf = new Float64Array(3);
  dqf = new Float64Array(12);
  qaf = new Float64Array(4);
  cmd = new Float64Array(3);
  vf = 0;
  p: number;
  walking = false;
  ticks = 0;
  constructor(readonly m: Mode) { this.p = m.stand_phase; }
}

export class G1LegacyDriver extends BaseDriver {
  private readonly main: Mode;
  private readonly walkMode: Mode | null;       // shot: the hybrid_run FSM it enters from / returns to
  private readonly walkSess: OnnxSession | null;
  private rt: Runtime;
  private t = 0;
  private nextKick = Infinity;
  activeNet = "main";

  constructor(cfg: EvalConfig, spec: RobotSpec, eng: Engine, readonly sess: OnnxSession,
              readonly aux: Record<string, OnnxSession>, readonly files: Record<string, string>) {
    super(cfg, spec, eng);
    const g = cfg.g1!;
    const { walk, ...own } = g.legacy ?? {};
    this.main = {
      ...BASE,
      kp: g.kp ?? BASE.kp, kd: g.kd ?? BASE.kd, tau: g.tau ?? BASE.tau,
      default_dof_pos: g.default_dof_pos ?? BASE.default_dof_pos,
      ...(own as Partial<Mode>),
    };
    this.walkMode = this.main.kick ? { ...BASE, ...((walk ?? {}) as Partial<Mode>) } : null;
    this.walkSess = this.main.kick ? (aux.walk ?? null) : null;
    if (this.main.kick && !this.walkSess) throw new Error(`${cfg.name}: shot needs aux_models.walk (hybrid_run)`);
    if (this.main.num_latent > 0 && !aux.encoder) throw new Error(`${cfg.name}: needs aux_models.encoder`);

    this.needsCommand = true;
    const vx = (this.walkMode ?? this.main).vx_max;
    this.velRange = g.vel_range ?? [-vx, vx, -0.5, 0.5, -1.0, 1.0];
    this.actJointNames = this.names.slice(0, 12);
    this.stackDepth = HIST;
    this.rt = new Runtime(this.walkMode ?? this.main);
    this.applyGains(this.rt.m);
  }

  private applyGains(m: Mode) {
    this.kp = Float64Array.from(m.kp);
    this.kd = Float64Array.from(m.kd);
    this.default = Float64Array.from(m.default_dof_pos);
    this.lim = Float64Array.from(m.tau);
    this.frameLayout = [["gyro_x0.25", 3], ["gravity+z_x3", 3], ["command", 3], ["q/action_scale", 12],
      ["dq_x0.05", 12], ["gait_clock", 4], ["gait_params", 3]];
    if (m.frame_dim > 40) this.frameLayout.push([m.kick ? "kick_clock" : "waist_pitch_roll", 2]);
    this.activeNet = m.kick ? "shot" : "main";
  }

  /** (re)enter an FSM: fresh filters, history and gait clock, its own gains */
  private enter(m: Mode) {
    this.rt = new Runtime(m);
    this.applyGains(m);
  }

  override reset() {
    const home = this.walkMode ?? this.main;
    const pose = Float64Array.from(home.default_dof_pos);
    for (let i = 0; i < 12; i++) pose[i] = INIT_LEGS[i];
    this.seat(pose, [1, 0, 0, 0], this.feet, 0.002);
    this.enter(home);
    this.t = 0;
    this.nextKick = this.main.kick ? this.main.kick_delay : Infinity;
    this.lastAction = new Float32Array(12);
  }

  private gait(m: Mode, v: number): [number, number] {
    return [interp(v, m.velocity_points, m.duty_factor_points), interp(v, m.velocity_points, m.period_points)];
  }

  async step(command: Command): Promise<Float64Array> {
    // shot (210): entered from a standing hybrid_run, runs one gait period, then hands back to hybrid_run
    if (this.walkMode) {
      const cur = this.rt;
      const idle = cur.m === this.walkMode && !cur.walking && Math.hypot(command[0], command[1], command[2]) < 0.05;
      if (idle && this.t >= this.nextKick) this.enter(this.main);
      else if (cur.m === this.main && cur.ticks >= Math.round(this.gait(this.main, 0)[1] / DT) + 1) {
        this.enter(this.walkMode);
        this.nextKick = this.main.kick_repeat > 0 ? this.t + this.main.kick_repeat : Infinity;
      }
    }
    const r = this.rt, m = r.m;
    const net = m === this.walkMode ? this.walkSess! : this.sess;
    this.t += DT;
    r.ticks++;

    // ---- sensors + per-tick filters
    const [q, dq] = this.readQ();
    const w = this.baseAngVel();
    const R = matFromWxyz(this.baseQuat());
    const grav = matTVec(R, [0, 0, -1]);
    const vw = this.eng.qvel;
    const vb = matTVec(R, [vw[this.bqv], vw[this.bqv + 1], vw[this.bqv + 2]]);
    for (let i = 0; i < 3; i++) r.wf[i] = m.omega_alpha * w[i] + (1 - m.omega_alpha) * r.wf[i];
    for (let i = 0; i < 12; i++) r.dqf[i] = m.jvel_alpha * dq[i] + (1 - m.jvel_alpha) * r.dqf[i];
    const aA = DT / (DT + 1 / (2 * Math.PI * m.ankle_lpf_hz));
    for (let i = 0; i < 4; i++) r.qaf[i] = aA * q[ANKLES[i]] + (1 - aA) * r.qaf[i];
    r.vf += 0.1 * (Math.hypot(vb[0], vb[1]) - r.vf);   // stand-in for the firmware's speed estimate

    // ---- remote command (the kick ignores the stick)
    const vr = this.velRange!;
    const want = m.kick ? [0, 0, 0]
      : [clip(command[0], vr[0], vr[1]), clip(command[1], vr[2], vr[3]), clip(command[2], vr[4], vr[5])];
    for (let i = 0; i < 3; i++) r.cmd[i] += m.cmd_alpha * (want[i] - r.cmd[i]);

    // ---- frame
    const k = m.frame_dim;
    const [duty] = this.gait(m, r.vf);
    const tl = theta(r.p + m.delta_phi[0] / 2, duty) * Math.PI;
    const tr = theta(r.p + m.delta_phi[1] / 2, duty) * Math.PI;
    const f = new Float32Array(k);
    for (let i = 0; i < 3; i++) f[i] = r.wf[i] * 0.25;
    f[3] = grav[0] * 3; f[4] = grav[1] * 3; f[5] = (grav[2] + 1) * 3;
    f[6] = r.cmd[0] * 2; f[7] = r.cmd[1] * 2; f[8] = r.cmd[2] * 0.25;
    for (let i = 0; i < 12; i++) {
      const a = ANKLES.indexOf(i);
      f[9 + i] = ((a >= 0 ? r.qaf[a] : q[i]) - m.default_dof_pos[i]) / LEG_SCALE[i];
      f[21 + i] = r.dqf[i] * 0.05;
    }
    f[33] = Math.cos(tl); f[34] = Math.cos(tr); f[35] = Math.sin(tl); f[36] = Math.sin(tr);
    f[37] = m.obs_tail[0];
    f[38] = (duty - m.duty_mean) / m.duty_scale;
    f[39] = m.obs_tail[1];
    if (k > 40) {
      if (m.kick) { f[40] = Math.cos(tr); f[41] = Math.sin(tr); }
      else if (m.waist_obs) { f[40] = q[14]; f[41] = -q[13]; }
    }
    for (let i = 0; i < k; i++) f[i] = clip(f[i], -100, 100);

    if (!r.hist.length) r.hist = Array(HIST).fill(f);
    else { r.hist.shift(); r.hist.push(f); }
    const nl = m.num_latent;
    const x = new Float32Array(HIST * k + nl);
    r.hist.forEach((h, i) => x.set(h, i * k));
    if (nl > 0) {
      const e = new Float32Array(30);
      e.set(f.subarray(0, 6), 0); e.set(f.subarray(9, 33), 6);
      if (!r.ehist.length) r.ehist = Array(ENC_STEPS).fill(e);
      else { r.ehist.shift(); r.ehist.push(e); }
      const ein = new Float32Array(ENC_STEPS * 30);
      r.ehist.forEach((h, i) => ein.set(h, i * 30));
      const enc = this.aux.encoder;
      const lat = await enc.run({ [enc.inputNames[0]]: { data: ein, dims: [ein.length] } });
      x.set(lat.subarray(0, nl), HIST * k);
    }
    const out = await net.run({ [net.inputNames[0]]: { data: x, dims: [x.length] } });
    const act = new Float32Array(12);
    for (let i = 0; i < 12; i++) act[i] = clip(out[i], -10, 10);

    // ---- gait scheduler for the next tick: step while commanded (or while the rules fire),
    //      stop on the next half-cycle boundary once the command has died away
    let active = m.kick || Math.abs(r.cmd[0]) > 0.1 || Math.abs(r.cmd[1]) > 0.1 || Math.abs(r.cmd[2]) > 0.1;
    if (m.rules) {
      const roll = Math.atan2(-grav[1], -grav[2]), pitch = Math.asin(clip(grav[0], -1, 1));
      active ||= Math.abs(r.wf[0]) > 0.6 || Math.abs(r.wf[1]) > 0.6 || Math.abs(roll) > 0.06 || Math.abs(pitch) > 0.06;
    }
    if (active) r.walking = true;
    if (r.walking) {
      const p0 = r.p, p1 = r.p + DT / this.gait(m, r.vf)[1];
      r.p = p1 % 1;
      if (!active && Math.floor(p0 * 2) !== Math.floor(p1 * 2)) r.walking = false;
    }

    // ---- targets: legs from the net; waist/arms at default + arm swing (or the kick's upper body)
    const tgt = Float64Array.from(m.default_dof_pos);
    for (let i = 0; i < 12; i++) tgt[i] = m.default_dof_pos[i] + act[i] * LEG_SCALE[i];
    if (m.swing === "clock") {
      // arm clock swing: shoulder pitch = default + 0.4 * vx * cos(same-side leg angle)
      const [d2] = this.gait(m, r.vf);
      tgt[15] += 0.4 * r.cmd[0] * Math.cos(theta(r.p + m.delta_phi[0] / 2, d2) * Math.PI);
      tgt[22] += 0.4 * r.cmd[0] * Math.cos(theta(r.p + m.delta_phi[1] / 2, d2) * Math.PI);
    } else if (m.swing === "leg") {
      // arm swing from the opposite hip pitch (x1.2 when swinging back); the elbow follows at x2
      for (const [sh, el, opp] of [[15, 18, 6], [22, 25, 0]]) {
        let s = 0.35 * (q[opp] + 0.35);
        if (s > 0) s *= 1.2;
        tgt[sh] += s; tgt[el] += 2 * s;
      }
    }
    if (m.kick && m.kick_upper.length) {
      const ku = m.kick_upper, tk = r.ticks - 1;
      const col = (c: number) => interp(tk, ku.map((row) => row[0]), ku.map((row) => row[c]));
      const wr = col(1), wy = col(2);
      tgt[13] = wr; tgt[16] += 2 * wr; tgt[21] = wy; tgt[18] += 0.5 * wy;
    }
    for (let i = 0; i < 12; i++) this.kd[i] = m.kd[i] * (r.walking ? 1 : m.stand_kd_mult);

    this.lastFrame = f;
    this.lastAction = act;
    return tgt;
  }
}
