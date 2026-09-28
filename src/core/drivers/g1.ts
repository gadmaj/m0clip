/** Unitree G1 humanoid policy drivers.
 *
 * Implements:
 * 1. G1LocoDriver:
 *    - Split-input locomotion (walk_29dofs, cpy_run_29dofs, cpy_stair_loco)
 *    - Concat-input locomotion (normal_walk)
 *    - Get-up / Jump maneuvers (any2squat, facedown_getup, faceup_getup, squat2stand, jump_17dofs, ...)
 *    - Phase-driven mimics (mimic_test)
 * 2. G1MimicDriver:
 *    - 4-input motion mimic tracking a reference choreography clip (cpy_dance, cpy_fight)
 */
import { clip, concatF32, matFromWxyz, matTVec, rot6d } from "../math";
import type { Command, EvalConfig, G1SpeedModes, RemoteActionGroup, RobotSpec } from "../types";
import type { Engine } from "../../sim/engine";
import { OnnxPolicy, OnnxSession } from "../policy";
import { BaseDriver } from "./base";

function stackFrames(hist: Float32Array[], depth: number): Float32Array[] {
  if (hist.length >= depth) return hist.slice(-depth);
  const pad = Array(depth - hist.length).fill(hist[0]);
  return [...pad, ...hist];
}

function remapPhase(phi: number, d = 0.65): number {
  const p = ((phi % 1.0) + 1.0) % 1.0;
  return p < d ? (p / d) * 0.5 : 0.5 + ((p - d) / (1.0 - d)) * 0.5;
}

/** ai_sport FsmHumanLoco gait/command parameters. Defaults are what the
 * firmware does for the `blind` net (g1_b_l_ankle_track / g1_b29_no_yaw_ctrl),
 * measured from the MNN I/O of KVisionLoco (FSM 500) on the bench:
 *  - the command goes through a 1st-order low-pass (fc 0.18 Hz);
 *  - the gait starts when |cmd| > 0.1 with the base phase reset to 0.5, and
 *    stops only once the phase comes back round to 0.5 with |cmd| < 0.1;
 *  - leg phases are phi and phi+0.5, remapped by the 0.65 duty factor;
 *  - standing feeds frequency 0 (cmd[4] = (f-1.2)*0.5) and both legs at `stand_phase`:
 *    0 for the 12-DOF net (FSM 500 -> [0,0,1,1]), 0.25 for the 29-DOF WBC net
 *    g1_b29_no_yaw_ctrl (FSM 501 -> [1,1,0,0], measured on the EDU bench).
 * `arm_swing` is the open-loop arm clock swing applied while walking. */
interface HumanGait {
  freq: number; base_freq: number; duty: number; freq_scale: number;
  cutoff_hz: number; start_thres: number; lin_scale: number; ang_scale: number;
  stand_phase: number;
  arm_swing: { shoulder_pitch: number; elbow: number; shoulder_roll: number };
}

const HUMAN_GAIT: HumanGait = {
  freq: 1.0, base_freq: 1.2, duty: 0.65, freq_scale: 0.5,
  cutoff_hz: 0.18, start_thres: 0.1, lin_scale: 0.2, ang_scale: 0.2, stand_phase: 0.0,
  arm_swing: { shoulder_pitch: 0.056, elbow: 0.014, shoulder_roll: 0.05 },
};

function clampCmd(c: Command, vr: number[]): Float32Array {
  return new Float32Array([
    clip(c[0], vr[0], vr[1]),
    clip(c[1], vr[2], vr[3]),
    clip(c[2], vr[4], vr[5]),
  ]);
}

export class G1LocoDriver extends BaseDriver {
  private readonly ctrl: Int32Array;
  private readonly aScale: Float64Array;
  private readonly aClip: number;
  private readonly oClip: number;
  private readonly angScale: number;
  private readonly dposScale: number;
  private readonly dvelScale: number;
  private readonly split: boolean;
  private readonly isHumanLoco: boolean;
  private readonly orient6d: boolean;
  private readonly dofPosRel: boolean;
  private readonly hasPhase: boolean;
  private readonly cmdInObs: boolean;
  private readonly groundStartMode: string | null;
  private readonly spawnPitch: number;
  private readonly initPose: Float64Array;
  private readonly mem: number;
  private readonly cadence: number;
  private readonly stepDt: number;
  private vr: number[];
  private readonly vrBase: number[];
  private readonly stanceOffset: Float32Array;

  private phase = 0.0;
  private t = 0.0;
  private lastActionRaw: Float32Array;
  private hist: Float32Array[] = [];
  private curCmd = new Float32Array(3);
  private filtAng = new Float32Array(3);
  private filtJvel: Float32Array;

  // human_loco gait state (phase = base gait phase phi)
  private readonly gait: HumanGait;
  private walking = false;
  private atHalf = false;

  // Cpy* locomotion (801/802/812): extra networks + firmware command shaping
  private readonly lastScaled: boolean;
  private readonly runSwitch: [number, number];
  private readonly cmdRamp: { up: number[]; down: number[]; start: number[]; snap: number[] } | null;
  private running = false;
  activeNet = "main";

  // remote speed levels (g1.speed): current level and full-stick forward limit
  private readonly speed: G1SpeedModes | null;
  private speedLevel = "";
  private vxLimit = 0;

  constructor(
    cfg: EvalConfig,
    spec: RobotSpec,
    eng: Engine,
    readonly sess: OnnxSession | OnnxPolicy,
    readonly aux: Record<string, OnnxSession> = {},
  ) {
    super(cfg, spec, eng);
    const g = cfg.g1!;
    this.ctrl = Int32Array.from(g.control_joints);
    this.default = Float64Array.from(g.default_dof_pos);
    this.filtJvel = new Float32Array(this.ctrl.length);
    const asc = g.action_scale;
    if (typeof asc === "number") {
      this.aScale = new Float64Array(this.ctrl.length).fill(asc);
    } else {
      const arr = asc as number[];
      if (arr.length === this.ctrl.length) {
        this.aScale = Float64Array.from(arr);
      } else {
        this.aScale = new Float64Array(this.ctrl.length);
        for (let i = 0; i < this.ctrl.length; i++) {
          this.aScale[i] = arr[this.ctrl[i]];
        }
      }
    }
    this.split = g.obs_scheme === "split";
    this.isHumanLoco = g.obs_scheme === "human_loco";
    this.aClip = g.action_clip ?? (this.isHumanLoco ? 2.0 : 100.0);
    this.oClip = g.obs_clip ?? 100.0;
    this.angScale = g.ang_vel_scale ?? (this.split ? 1.0 : (this.isHumanLoco ? 0.2 : 0.25));
    this.dposScale = g.dof_pos_scale ?? 1.0;
    this.dvelScale = g.dof_vel_scale ?? (this.split ? 1.0 : 0.05);
    this.orient6d = g.orient === "6d";
    this.dofPosRel = g.dof_pos_rel ?? (!this.split);
    this.hasPhase = !!g.has_phase;
    this.cmdInObs = g.cmd_in_obs ?? (!this.split && !this.isHumanLoco);
    this.maneuver = !!g.maneuver;
    this.groundStartMode = g.ground_start ?? null;
    this.groundStart = !!this.groundStartMode;
    this.spawnPitch = g.spawn_pitch_deg ?? 0.0;
    this.initPose = Float64Array.from(g.init_pose ?? g.default_dof_pos);
    this.mem = g.memory_size ?? 1;
    this.cadence = g.maneuver_period ?? 1.0;
    this.kp = Float64Array.from(g.kp ?? Array(this.n).fill(60.0));
    this.kd = Float64Array.from(g.kd ?? Array(this.n).fill(2.0));
    this.lim = Float64Array.from(g.tau ?? spec.torque_limit ?? Array(this.n).fill(100.0));
    this.vr = g.vel_range ?? [-1.0, 1.5, -0.6, 0.6, -1.0, 1.0];
    this.vrBase = [...this.vr];
    this.velRange = this.vr;
    this.stanceOffset = Float32Array.from(
      g.stance_cmd_offset ?? (this.split ? [-0.05, 0, 0] : [0, 0, 0]),
    );
    this.stepDt = cfg.control.step_dt ?? 0.02;
    const gcfg = (g.gait ?? {}) as Partial<HumanGait>;
    // the 29-DOF WBC net (legs + waist roll/pitch = 14 actions) stands at phase 0.25 unless the pack says otherwise
    this.gait = { ...HUMAN_GAIT, stand_phase: this.ctrl.length === 14 ? 0.25 : 0.0, ...gcfg,
                  arm_swing: { ...HUMAN_GAIT.arm_swing, ...(gcfg.arm_swing ?? {}) } };
    this.lastScaled = !!g.last_action_scaled;
    this.runSwitch = g.run_switch ?? [0.6, 0.5];
    this.cmdRamp = g.cmd_ramp ?? null;
    this.speed = g.speed ?? null;
    if (this.speed) this.setSpeedLevel(this.speed.initial);
    this.needsCommand = !this.maneuver;
    this.actJointNames = Array.from(this.ctrl, (i) => this.names[i]);
    this.stackDepth = this.mem;
    this.lastActionRaw = new Float32Array(this.ctrl.length);

    this.frameLayout = this.isHumanLoco
      ? [
          ["base_ang_vel", 3],
          ["projected_gravity", 3],
          ["joint_pos", this.ctrl.length],
          ["joint_vel", this.ctrl.length],
          ["last_action", this.ctrl.length],
        ]
      : [
          ["base_ang_vel", 3],
          [this.orient6d ? "orient6d" : "projected_gravity", this.orient6d ? 6 : 3],
          ...(this.cmdInObs ? ([["commands", 3]] as [string, number][]) : []),
          ["joint_pos", this.ctrl.length],
          ["joint_vel", this.ctrl.length],
          ["last_action", this.ctrl.length],
          ...(this.hasPhase && !this.split ? ([["phase", 1]] as [string, number][]) : []),
        ];
  }

  /** Enter a speed level of g1.speed: full-stick vx (and vy / wz, gait frequency / duty for FsmHumanLoco). */
  private setSpeedLevel(name: string) {
    const L = this.speed?.levels[name];
    if (!L) return;
    this.speedLevel = name;
    this.vxLimit = L.vx;
    if (L.freq !== undefined) this.gait.freq = L.freq;
    if (L.duty !== undefined) this.gait.duty = L.duty;
    const b = this.vrBase;
    this.vr = [b[0], L.vx, L.vy !== undefined ? -L.vy : b[2], L.vy ?? b[3],
               L.wz !== undefined ? -L.wz : b[4], L.wz ?? b[5]];
    this.velRange = this.vr;
  }

  override remoteCombos(): string[] { return this.speed ? Object.keys(this.speed.combos) : []; }

  /** Speed combos: a level (802/801 R2+Up / R2+Down, FsmHumanLoco L1 / L2) or a +-0.1 m/s step of the forward
   * limit (802/801 R2+Right / R2+Left, as fsm_cpy_walk_run_29dofs.cpp "command speed limit"). */
  override remote(combo: string) {
    const a = this.speed?.combos[combo];
    if (a === undefined) return;
    if (typeof a === "string") { this.setSpeedLevel(a); return; }
    const cap = this.speed!.vx_cap ?? Infinity;
    const vx = Math.round(Math.min(cap, Math.max(0.1, this.vxLimit + a)) * 100) / 100;
    this.vxLimit = vx;
    this.vr = [this.vr[0], vx, ...this.vr.slice(2)];
    this.velRange = this.vr;
  }

  /** The panel's speed group title shows the level in force and the full-stick forward speed. */
  override remoteActions(): RemoteActionGroup[] {
    const lvl = this.speed?.levels[this.speedLevel];
    const now = lvl && Math.abs(lvl.vx - this.vxLimit) < 1e-6 ? this.speedLevel : "custom";
    return super.remoteActions().map((g) => (g.group === "Speed"
      ? { ...g, group: `Speed: ${now}, full stick ${this.vxLimit.toFixed(1)} m/s` } : g));
  }

  override reset() {
    const s = Math.sqrt(0.5);
    const th = ((this.spawnPitch * Math.PI) / 180.0) / 2.0;
    const quat =
      this.groundStartMode === "face_up"
        ? [s, 0, -s, 0]
        : this.groundStartMode === "face_down"
        ? [s, 0, s, 0]
        : [Math.cos(th), 0, Math.sin(th), 0];

    const spawn = this.maneuver ? this.initPose : this.default;
    const isManeuver = this.maneuver || !!this.groundStartMode;
    const drop = isManeuver
      ? Array.from({ length: this.eng.model.nbody }, (_, i) => i).filter((i) => i !== 0)
      : this.feet;

    const dropClearance = this.groundStartMode ? 0.02 : 0.002;
    this.seat(spawn, quat, drop, dropClearance);
    this.hist = [];
    this.phase = 0.0;
    this.t = 0.0;
    this.curCmd.fill(0);
    this.filtAng.fill(0);
    this.filtJvel.fill(0);
    this.walking = false;
    this.atHalf = false;
    this.running = false;
    this.activeNet = "main";
    this.lastActionRaw = new Float32Array(this.ctrl.length);
    this.lastAction = new Float32Array(this.ctrl.length);
  }

  async step(command: Command): Promise<Float64Array> {
    const vr = this.vr;
    if (this.speed?.back_stick && command[0] < 0) {
      // Cpy* FSMs: vx = stick x limit, but backwards the raw stick (-1 m/s at full) and 0 above -0.3 m/s;
      // the UI scales the stick by the forward limit, so stick = command / limit
      command = [command[0] <= -0.3 ? command[0] / this.vxLimit : 0, command[1], command[2]];
    }
    const targetCmd = clampCmd(command, vr);

    if (this.isHumanLoco) {
      // FsmHumanLoco: 1st-order low-pass on the remote command
      const rc = 1.0 / (2.0 * Math.PI * this.gait.cutoff_hz);
      const a = this.stepDt / (rc + this.stepDt);
      for (let i = 0; i < 3; i++) this.curCmd[i] += a * (targetCmd[i] - this.curCmd[i]);
    } else if (this.cmdRamp) {
      // Cpy* FSMs (measured on 802/812): leave standstill with a jump to `start`, ramp by up/down per
      // tick, and snap to 0 once both the command and the target are under `snap` (the stance net takes over)
      const r = this.cmdRamp;
      for (let i = 0; i < 3; i++) {
        const want = targetCmd[i];
        let have = this.curCmd[i];
        if (have === 0 && Math.abs(want) >= r.snap[i]) {
          have = Math.sign(want) * Math.min(Math.abs(want), r.start[i]);
        } else if (have !== 0) {
          const accelerating = Math.sign(want) === Math.sign(have) && Math.abs(want) > Math.abs(have);
          const d = accelerating ? r.up[i] : r.down[i];
          const step = want - have;
          have = Math.abs(step) <= d ? want : have + Math.sign(step) * d;
          if (Math.abs(have) < r.snap[i] && Math.abs(want) < r.snap[i]) have = 0;
        }
        this.curCmd[i] = have;
      }
    } else {
      // Command slew-rate limiter: [up, down] per axis
      const slewLimits: [number, number][] = [[0.02, 0.05], [0.02, 0.01], [0.04, 0.05]];
      for (let i = 0; i < 3; i++) {
        const want = targetCmd[i], have = this.curCmd[i];
        const [up, down] = slewLimits[i];
        const accelerating = (Math.sign(want) === Math.sign(have) || have === 0) && Math.abs(want) > Math.abs(have);
        const d = accelerating ? up : down;
        const step = want - have;
        this.curCmd[i] = Math.abs(step) <= d ? want : have + Math.sign(step) * d;
      }
    }
    const cmd = this.curCmd;

    const [q, qd] = this.readQ();
    const rawAng = this.baseAngVel();
    for (let i = 0; i < 3; i++) {
      this.filtAng[i] = 0.2 * rawAng[i] + 0.8 * this.filtAng[i];
    }
    const isNormalWalk = this.cfg.name.includes("normal_walk");
    const isStandup = this.cfg.name.includes("squat2stand") || this.cfg.name.includes("getup");
    const useFiltAng = isNormalWalk || isStandup;
    const ang = new Float32Array(3);
    for (let i = 0; i < 3; i++) {
      ang[i] = (useFiltAng ? this.filtAng[i] : rawAng[i]) * this.angScale;
    }

    const bQuat = this.baseQuat();
    const R = matFromWxyz(bQuat);
    const grav = matTVec(R, [0, 0, -1.0]);
    const base = this.orient6d ? concatF32([ang, rot6d(R)]) : concatF32([ang, grav]);

    const qc = new Float32Array(this.ctrl.length);
    const qdc = new Float32Array(this.ctrl.length);
    for (let i = 0; i < this.ctrl.length; i++) {
      const j = this.ctrl[i];
      qc[i] = ((this.dofPosRel ? q[j] - this.default[j] : q[j])) * this.dposScale;
      this.filtJvel[i] = 0.25 * qd[j] + 0.75 * this.filtJvel[i];
      const vel = isNormalWalk ? this.filtJvel[i] : qd[j];
      qdc[i] = vel * this.dvelScale;
    }

    if (!this.isHumanLoco) {
      this.phase = (this.phase + this.stepDt / this.cadence) % 1.0;
    }
    this.t += this.stepDt;

    let act: Float32Array;
    let frame: Float32Array;
    if (this.isHumanLoco) {
      // Gait clock: start at phi=0.5 once the command is live; stop only when
      // phi is back at 0.5 (both feet down) and the command has died away.
      const gt = this.gait;
      const active = Math.hypot(cmd[0], cmd[1], cmd[2]) > gt.start_thres;
      if (this.walking && this.atHalf && !active) this.walking = false;
      else if (!this.walking && active) { this.walking = true; this.phase = 0.5; }
      this.atHalf = false;
      if (this.walking) {
        const prev = this.phase;
        this.phase = (this.phase + gt.freq * this.stepDt) % 1.0;
        this.atHalf = prev < 0.5 - 1e-6 && this.phase >= 0.5 - 1e-6;
      }
      const f = this.walking ? gt.freq : 0.0;
      const r0 = this.walking ? remapPhase(this.phase, gt.duty) : gt.stand_phase;
      const r1 = this.walking ? remapPhase(this.phase + 0.5, gt.duty) : gt.stand_phase;
      const cmd8 = new Float32Array([
        Math.sin(2 * Math.PI * r0),
        Math.sin(2 * Math.PI * r1),
        Math.cos(2 * Math.PI * r0),
        Math.cos(2 * Math.PI * r1),
        (f - gt.base_freq) * gt.freq_scale,
        cmd[0] * gt.lin_scale,
        cmd[1] * gt.lin_scale,
        cmd[2] * gt.ang_scale,
      ]);

      // last_action is the scaled joint offset (clip(a) * action_scale), as the firmware feeds it
      frame = concatF32([ang, grav, qc, qdc, this.lastActionRaw]);
      for (let i = 0; i < frame.length; i++) {
        frame[i] = clip(frame[i], -this.oClip, this.oClip);
      }
      this.hist.push(frame);
      const memory = concatF32(stackFrames(this.hist, this.mem));
      if (this.hist.length > this.mem) this.hist = this.hist.slice(-this.mem);

      const out = await (this.sess as OnnxSession).run({
        p_obs: { data: memory, dims: [1, memory.length] },
        cmd: { data: cmd8, dims: [1, 8] },
      });
      act = out;
    } else if (this.split) {
      const spd = Math.hypot(cmd[0], cmd[1]);
      const wz = Math.abs(cmd[2]);
      const effCmd = new Float32Array(3);
      if (this.cmdRamp) {
        effCmd.set(cmd);                       // firmware feeds the shaped command as-is (0 at rest)
      } else {
        const blend = (spd < 0.1 && wz < 0.1) ? Math.min(spd / 0.1, 1.0) : 1.0;
        for (let i = 0; i < 3; i++) {
          effCmd[i] = (1.0 - blend) * this.stanceOffset[i] + blend * cmd[i];
        }
      }
      // network choice (one shared obs history, as on the robot): stance with no translation command,
      // run from runSwitch[0] m/s forward until the command drops to runSwitch[1], walk otherwise
      if (this.aux.run) {
        if (!this.running && cmd[0] >= this.runSwitch[0]) this.running = true;
        else if (this.running && cmd[0] <= this.runSwitch[1]) this.running = false;
      }
      const net = this.aux.stance && spd === 0 ? "stance" : this.running ? "run" : "main";
      this.activeNet = net;
      const sessNow = net === "main" ? (this.sess as OnnxSession) : this.aux[net];
      const prop = concatF32([base, qc, qdc, this.lastActionRaw]);
      for (let i = 0; i < prop.length; i++) {
        prop[i] = clip(prop[i], -this.oClip, this.oClip);
      }
      this.hist.push(prop);
      const memory = concatF32(stackFrames(this.hist, this.mem));
      if (this.hist.length > this.mem) this.hist = this.hist.slice(-this.mem);

      const out = await sessNow.run({
        proprioception: { data: prop, dims: [1, prop.length] },
        commands: { data: effCmd, dims: [1, 3] },
        memory: { data: memory, dims: [1, memory.length] },
      });
      act = out;
      frame = prop;
    } else {
      const segs: ArrayLike<number>[] = [ang, grav];
      if (this.cmdInObs) segs.push(cmd);
      segs.push(qc, qdc, this.lastActionRaw);
      if (this.hasPhase) {
        let phVal: number;
        if (this.maneuver) {
          phVal = Math.min(this.t / this.cadence, 1.0);
        } else if (isNormalWalk) {
          phVal = (this.phase % 1.0);
        } else {
          phVal = Math.sin(2 * Math.PI * this.phase);
        }
        segs.push(new Float32Array([phVal]));
      }

      frame = concatF32(segs);
      for (let i = 0; i < frame.length; i++) {
        frame[i] = clip(frame[i], -this.oClip, this.oClip);
      }
      this.hist.push(frame);
      const stacked = concatF32(stackFrames(this.hist, this.mem));
      if (this.hist.length > this.mem) this.hist = this.hist.slice(-this.mem);

      if (this.sess instanceof OnnxPolicy) {
        act = await this.sess.run(stacked);
      } else {
        act = await (this.sess as OnnxSession).run({
          obs: { data: stacked, dims: [1, stacked.length] },
        });
      }
    }

    for (let i = 0; i < act.length; i++) {
      act[i] = clip(act[i], -this.aClip, this.aClip);
    }
    if (this.isHumanLoco || this.lastScaled) {
      for (let i = 0; i < act.length; i++) this.lastActionRaw[i] = act[i] * this.aScale[i];
    } else {
      this.lastActionRaw.set(act);
    }
    this.lastFrame = frame;
    this.lastAction = act;

    const target = Float64Array.from(isStandup ? this.default : (this.maneuver ? this.initPose : this.default));
    for (let i = 0; i < this.ctrl.length; i++) {
      const j = this.ctrl[i];
      target[j] = this.default[j] + act[i] * this.aScale[i];
    }
    if (this.isHumanLoco && this.walking) {
      // arm clock swing, opposite to the same-side leg (arms sit at default while standing)
      const sw = this.gait.arm_swing;
      const c = Math.cos(2 * Math.PI * this.phase);
      target[15] = this.default[15] + sw.shoulder_pitch * c;
      target[22] = this.default[22] - sw.shoulder_pitch * c;
      target[18] = this.default[18] + sw.elbow * c;
      target[25] = this.default[25] - sw.elbow * c;
      target[16] = this.default[16] + sw.shoulder_roll;
      target[23] = this.default[23] - sw.shoulder_roll;
    }
    return target;
  }
}

export class G1MimicDriver extends BaseDriver {
  needsCommand = false;
  clipDriven = true;

  private readonly ctrl: Int32Array;
  private readonly aScale: Float64Array;
  private readonly aClip: number;
  private readonly oClip: number;
  private readonly angScale: number;
  private readonly dposScale: number;
  private readonly dvelScale: number;
  private readonly dofPosRel: boolean;
  private readonly quatOrder: string;
  private readonly rootRel: string;
  private readonly loop: boolean;
  private readonly yawRelQuat: boolean;
  private readonly clipOffset: number;
  private readonly exitFrac: number;
  private yaw0 = 0;
  private readonly mem: number;

  private k = 0;
  private lastActionRaw: Float32Array;
  private hist: Float32Array[] = [];

  constructor(
    cfg: EvalConfig,
    spec: RobotSpec,
    eng: Engine,
    readonly sess: OnnxSession,
    readonly clipData: Float32Array,
    readonly nCols: number,
  ) {
    super(cfg, spec, eng);
    const g = cfg.g1!;
    this.ctrl = Int32Array.from(g.control_joints);
    this.default = Float64Array.from(g.default_dof_pos);
    const asc = g.action_scale;
    if (typeof asc === "number") {
      this.aScale = new Float64Array(this.ctrl.length).fill(asc);
    } else {
      const arr = asc as number[];
      if (arr.length === this.ctrl.length) {
        this.aScale = Float64Array.from(arr);
      } else {
        this.aScale = new Float64Array(this.ctrl.length);
        for (let i = 0; i < this.ctrl.length; i++) {
          this.aScale[i] = arr[this.ctrl[i]];
        }
      }
    }
    this.aClip = g.action_clip ?? 100.0;
    this.oClip = g.obs_clip ?? 100.0;
    this.angScale = g.ang_vel_scale ?? 0.25;
    this.dposScale = g.dof_pos_scale ?? 1.0;
    this.dvelScale = g.dof_vel_scale ?? 0.05;
    this.dofPosRel = !!g.dof_pos_rel;
    this.quatOrder = g.quat_order ?? "xyzw";
    this.rootRel = g.root_rel ?? "xy";
    this.loop = !!g.clip_loop;
    // ai_sport Cpy mimic FSMs (810/811, decompiled sub_524660): the quaternion input is the base orientation
    // relative to the heading at FSM entry (w >= 0), and step k tracks clip row k + 1
    this.yawRelQuat = g.quat_frame === "entry_yaw";
    this.clipOffset = g.clip_offset ?? 0;
    this.exitFrac = g.exit_after_frac ?? 0;
    this.mem = g.memory_size ?? 5;
    this.kp = Float64Array.from(g.kp ?? Array(this.n).fill(60.0));
    this.kd = Float64Array.from(g.kd ?? Array(this.n).fill(2.0));
    this.lim = Float64Array.from(g.tau ?? spec.torque_limit ?? Array(this.n).fill(100.0));
    this.actJointNames = Array.from(this.ctrl, (i) => this.names[i]);
    this.stackDepth = this.mem;
    this.lastActionRaw = new Float32Array(this.ctrl.length);

    this.frameLayout = [
      ["base_ang_vel", 3],
      ["projected_gravity", 3],
      ["joint_pos", this.ctrl.length],
      ["joint_vel", this.ctrl.length],
      ["last_action", this.ctrl.length],
    ];
  }

  get nFrames(): number {
    return Math.floor(this.clipData.length / this.nCols);
  }

  override reset() {
    const f0 = this.clipData.subarray(0, this.nCols);
    const spawn = f0.subarray(7, 7 + this.n);
    // clip xyzw -> mujoco wxyz
    const quat = [f0[6], f0[3], f0[4], f0[5]];
    this.seat(spawn, quat, this.feet, 0.001);
    this.hist = [];
    this.k = 0;
    this.done = false;
    const [w, x, y, z] = this.baseQuat();
    this.yaw0 = Math.atan2(2 * (w * z + x * y), 1 - 2 * (y * y + z * z));
    this.lastActionRaw = new Float32Array(this.ctrl.length);
    this.lastAction = new Float32Array(this.ctrl.length);
  }

  async step(): Promise<Float64Array> {
    const nF = this.nFrames;
    const kk = this.k + this.clipOffset;
    const idx = this.loop ? kk % nF : Math.min(kk, nF - 1);
    const fRow = this.clipData.subarray(idx * this.nCols, (idx + 1) * this.nCols);
    const targetState = new Float32Array(Math.min(71, fRow.length));
    targetState.set(fRow.subarray(0, targetState.length));

    if (this.rootRel !== "none") {
      const nc = this.rootRel === "xyz" ? 3 : 2;
      // clip root is relative to where this policy was spawned (homeXY): the worker keeps the robot's
      // position across policy switches, so subtracting the raw world xy blew up the root error
      for (let c = 0; c < nc; c++) {
        targetState[c] -= this.eng.qpos[this.bqp + c] - (c < 2 ? this.homeXY[c] : 0);
      }
    }

    const [q, qd] = this.readQ();
    const ang = new Float32Array(3);
    const rawAng = this.baseAngVel();
    for (let i = 0; i < 3; i++) ang[i] = rawAng[i] * this.angScale;

    const bQuat = this.baseQuat();
    const R = matFromWxyz(bQuat);
    const grav = matTVec(R, [0, 0, -1.0]);

    // quaternion for policy (optionally relative to the heading at entry, w >= 0)
    let qb: ArrayLike<number> = bQuat;
    if (this.yawRelQuat) {
      const c = Math.cos(this.yaw0 / 2), sn = Math.sin(this.yaw0 / 2);
      const [w, x, y, z] = bQuat;
      let r = [c * w + sn * z, c * x + sn * y, c * y - sn * x, c * z - sn * w];
      if (r[0] < 0) r = r.map((v) => -v);
      qb = r;
    }
    const quat =
      this.quatOrder === "xyzw"
        ? new Float32Array([qb[1], qb[2], qb[3], qb[0]])
        : Float32Array.from(qb);

    const qc = new Float32Array(this.ctrl.length);
    const qdc = new Float32Array(this.ctrl.length);
    for (let i = 0; i < this.ctrl.length; i++) {
      const j = this.ctrl[i];
      qc[i] = ((this.dofPosRel ? q[j] - this.default[j] : q[j])) * this.dposScale;
      qdc[i] = qd[j] * this.dvelScale;
    }

    const prop = concatF32([ang, grav, qc, qdc, this.lastActionRaw]);
    for (let i = 0; i < prop.length; i++) {
      prop[i] = clip(prop[i], -this.oClip, this.oClip);
    }
    this.hist.push(prop);
    const memory = concatF32(stackFrames(this.hist, this.mem));
    if (this.hist.length > this.mem) this.hist = this.hist.slice(-this.mem);

    const out = await this.sess.run({
      proprioception: { data: prop, dims: [1, prop.length] },
      memory: { data: memory, dims: [1, memory.length] },
      quaternion: { data: quat, dims: [1, 4] },
      target_state: { data: targetState, dims: [1, targetState.length] },
    });

    const act = out;
    for (let i = 0; i < act.length; i++) {
      act[i] = clip(act[i], -this.aClip, this.aClip);
    }
    this.lastActionRaw.set(act);
    this.lastFrame = prop;
    this.lastAction = act;
    this.k++;
    if (this.exitFrac > 0 && this.k > this.exitFrac * nF) this.done = true;

    const target = Float64Array.from(this.default);
    for (let i = 0; i < this.ctrl.length; i++) {
      const j = this.ctrl[i];
      target[j] = this.default[j] + act[i] * this.aScale[i];
    }
    return target;
  }
}
