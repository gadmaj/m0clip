/** Unitree Go2 firmware policies, driven the way the firmware drives them.
 *
 * Source: Go2 OTA 1.1.15 (EDU) runs the "mcf" sport stack (mcf 1.0.0.75, shipped in 1.1.11 and unchanged since):
 * /unitree/module/mcf/module/ai/libgo2_ai_module.so (not stripped, decompiled with IDA) with the plain JSON
 * configs + MNN nets in module/ai/config. Every net was checked against bench MNN-I/O captures (libgo2mnnhook.so,
 * orange_pi_workbench/tools/ai_sport_probe/captures_go2_1115).
 *
 * One driver = a small copy of the firmware's AiController: the pack's home FSM plus the FSMs the firmware always
 * has at hand (1001 Damping, 1002 StandUp, 2006 StandDown, 2004 Recovery, 2005 AutoRecovery, 1003 FreeWalk — the
 * free-walk / auto-recovery nets ride along as aux models). Remote events and sport-API calls switch FSMs exactly
 * as AiController does; a switch to another trick FSM hands over to that FSM's pack (`go2.packs`), like the
 * robot's FSM change (the worker keeps the robot state).
 *
 * Common to the AI FSMs (50 Hz): q/dq in policy order = the web model order FL, FR, RL, RR (the firmware maps the
 * SDK motor order FR, FL, RR, RL with [3,4,5,0,1,2,9,10,11,6,7,8]); gyro = IMU body rate; gravity = R^T·[0,0,-1];
 * obs = clip((raw − ob_mean)·ob_scale, ±clip_obs); target = clip(act, ±clip_act)·act_scale + act_mean; plain PD
 * (config kp/kd, dq = τ = 0) — the configs' torque / velocity limits are never read by the firmware.
 * Sticks: ly → vx, −lx → vy, −rx → wz; dead zone |s| ≥ 0.1, low-pass f = 0.94·f + 0.06·s per 20 ms tick, then ×
 * the speed level's scale (level 1 = "up_*", the default on every FSM entry; double L2 = level 0 "low_*").
 * The web command is stick × the scale the driver publishes in `velRange`, so the driver recovers the stick as
 * command / scale. The worker does not ramp these packs (`go2.firmware`).
 */
import { clip, matFromWxyz, matTVec } from "../math";
import type { Command, EvalConfig, RobotSpec } from "../types";
import type { Engine } from "../../sim/engine";
import { OnnxSession } from "../policy";
import { selectedDriverAssets } from '../driver-assets';
import { HeightMapSampler } from "../lidar";
import { BaseDriver } from "./base";

/** SDK motor order (FR, FL, RR, RL) <-> policy / model order (FL, FR, RL, RR); an involution */
const PERM = [3, 4, 5, 0, 1, 2, 9, 10, 11, 6, 7, 8];
const f32 = Math.fround;
/** a motor-order 12-vector (firmware tables) in model order */
export function m2p(a: ArrayLike<number>): Float64Array {
  const o = new Float64Array(12);
  for (let i = 0; i < 12; i++) o[PERM[i]] = a[i];
  return o;
}
const legs = (hip: number, thigh: number, calf: number): number[] =>
  [hip, thigh, calf, hip, thigh, calf, hip, thigh, calf, hip, thigh, calf];
const dz = (v: number, d: number) => (Math.abs(v) >= d ? v : 0);

export interface Go2Norm {
  ob_mean: number[]; ob_scale: number[]; act_mean: number[]; act_scale: number[];
  kp?: number[]; kd?: number[]; clip_obs?: number; clip_act?: number;
}
export interface Go2FwCfg {
  firmware: true;
  /** FSM id the pack starts in (the firmware id, e.g. 1003 free walk, 2008 free bound) */
  fsm_id: number;
  /** firmware class of the home FSM: free_walk | rage | cross_step | back_stand | bound | jump | avoid | drag |
   *  gait_walk | hand_stand | auto_recovery | forward_flip | back_flip | left_flip | cflip | cflip_x3 */
  scheme: string;
  /** FSM id -> pack name, for switches to FSMs this pack doesn't run itself */
  packs?: Record<string, string>;
  /** normalization / gains per net role (main = the pack's checkpoint; walk / rotate / stair / recovery / zero /
   *  end / base / est / obstacle / zero_planner = aux models of the same role name) */
  norms: Record<string, Go2Norm>;
  /** speed-level stick scales [vx, vy, wz] ("low_*" / "up_*" of the FSM config) */
  low?: number[]; up?: number[];
  /** free walk: payload net in use (the config service's sport_payload_json mass): "light" (0-1 kg, default) or
   *  "heavy" (1-5 / 5-20 kg: the main net always runs, up_vx 1.0, no auto-recovery) */
  payload?: string;
  /** free walk (light) aux net scales */
  walk_low?: number[]; walk_up?: number[];
  flip?: Record<string, unknown>;
  avoid?: Record<string, number>;
  drag?: Record<string, number[]>;
  aux_models?: Record<string, string>;
  models?: string[];
  [k: string]: unknown;
}
export const go2fw = (cfg: EvalConfig): Go2FwCfg => cfg.go2 as unknown as Go2FwCfg;

// ---- firmware FSM ids ---------------------------------------------------------------------------------------
const DAMP = 1001, STANDUP = 1002, FREEWALK = 1003, RECOVERY = 2004, AUTOREC = 2005, STANDDOWN = 2006;
const AVOID = 2007, BOUND = 2008, JUMP = 2009, GAIT = 2010, HANDSTAND = 2011, FFLIP = 2012, BFLIP = 2013,
  LFLIP = 2014, CROSS = 2016, BACKSTAND = 2017, BSEND = 2018, DRAG = 2019, RAGE = 2021;
const CFLIP = 12, CFLIPX3 = 14;                      // ai_sport 1.0.4.x StateMachine states (not mcf FSMs)
const SCHEME_FSM: Record<string, number> = {
  free_walk: FREEWALK, rage: RAGE, cross_step: CROSS, back_stand: BACKSTAND, bound: BOUND, jump: JUMP,
  avoid: AVOID, drag: DRAG, gait_walk: GAIT, hand_stand: HANDSTAND, auto_recovery: AUTOREC,
  forward_flip: FFLIP, back_flip: BFLIP, left_flip: LFLIP, cflip: CFLIP, cflip_x3: CFLIPX3,
};
export const GO2_FSM_NAME: Record<number, string> = {
  [DAMP]: "Damping", [STANDUP]: "StandUp", [FREEWALK]: "FreeWalk", [RECOVERY]: "Recovery",
  [AUTOREC]: "AutoRecovery", [STANDDOWN]: "StandDown", [AVOID]: "FreeAvoid", [BOUND]: "FreeBound",
  [JUMP]: "FreeJump", [GAIT]: "ClassicWalk", [HANDSTAND]: "HandStand", [FFLIP]: "ForwardFlip",
  [BFLIP]: "BackFlip", [LFLIP]: "LeftFlip", [CROSS]: "CrossStep", [BACKSTAND]: "BackStand",
  [BSEND]: "BackStandEnd", [DRAG]: "ForceFollow", [RAGE]: "RageMode", [CFLIP]: "ContinuousFlip",
  [CFLIPX3]: "ContinuousFlipX3",
};

// ---- scripted poses (firmware tables, motor order) -----------------------------------------------------------
const STAND_F0 = [-0.045, 1.26, -2.8, 0.045, 1.26, -2.8, -0.31, 1.295, -2.8, 0.31, 1.295, -2.8];   // crouch
const STAND_POSE = legs(0, 0.67, -1.3);
const FOLD = legs(0, 1.4, -2.7);
const ROLL1 = [-0.6, 2.2, -2.77, 0.8, 3.3, -2.77, -0.6, 2.2, -2.77, 0.8, 3.3, -2.77];
const ROLL2 = [0.8, 2.97, -2.77, -0.8, 1.1, -2.2, 0.8, 2.97, -2.77, -0.8, 1.1, -2.2];
const RECOVERY_OFFSET = [0.1, 2, -2, -0.1, 2, -2, 0.1, 2, -2, -0.1, 2, -2];      // AutoRecovery target offset (policy order, rad)
/** mirror a motor-order leg table left <-> right (swap legs, negate hips) — Recovery RollOver on roll >= 0 */
function mirror(a: number[]): number[] {
  const o = new Array(12);
  for (let i = 0; i < 12; i++) o[PERM[i]] = a[i];
  for (const h of [0, 3, 6, 9]) o[h] = -o[h];
  return o;
}

/** fixed-length history ring of normalized frames */
class Hist {
  private rows: Float32Array[] = [];
  constructor(readonly len: number) {}
  push(f: Float32Array) { this.rows.push(f); if (this.rows.length > this.len) this.rows.shift(); }
  fill(f: Float32Array) { for (let i = 0; i < this.len; i++) this.push(f.slice()); }
  get size() { return this.rows.length; }
  /** newest frame first (concat nets) or oldest first (gait / drag nets) */
  vec(newestFirst: boolean): Float32Array {
    const rows = this.rows.length < this.len
      ? [...Array(this.len - this.rows.length).fill(this.rows[0]), ...this.rows] : this.rows;
    const ord = newestFirst ? [...rows].reverse() : rows;
    const d = ord[0].length, out = new Float32Array(d * ord.length);
    ord.forEach((r, k) => out.set(r, k * d));
    return out;
  }
}

type Target = Float64Array;

export class Go2FwDriver extends BaseDriver {
  readonly g: Go2FwCfg;
  readonly home: number;
  nextPolicy?: string;
  leashCapable = false;

  // firmware state
  fsm = FREEWALK;
  private tick = 0;                         // 20 ms ticks since start (the remote's double-press clock)
  private level = 1;                        // speed level (1 = up / high)
  private stick = [0, 0, 0];                // raw sticks [ly, -lx, -rx] (forward, left, ccw)
  private f = [0, 0, 0];                    // filtered sticks
  private pending: string[] = [];
  private lastPress: Record<string, number> = {};
  private autoRecOn = true;
  /** repeat the pack's flip whenever the robot is back in FreeWalk with the sticks centred (UI toggle) */
  repeat = false;
  private cmd = [0, 0, 0];
  private lastAct = new Float32Array(12);
  private hist = new Hist(6);
  private hist5 = new Hist(5);
  private entry = true;                     // next tick runs the FSM's Init()
  private q0: Float64Array<ArrayBufferLike> = new Float64Array(12);   // pose latched at FSM entry (scripted FSMs)
  private k = 0;                            // FSM-local tick counter
  private tf = 0;                           // FSM-local float32 time (flips)
  private flag = false;                     // FSM-local flag (back stand / hand stand switch, flip latches …)
  private mode = 0;                         // FSM-local mode (bound/jump zero net, hand stand mode, recovery …)
  private t0 = 0;                           // FSM-local tick of the last switch
  private side = 0;
  private phi = 0;                          // gait phase
  private gaitF = 1.4;
  private standing = false; private cnt = 1;
  private v = [0, 0, 0];                    // avoid planner velocity / drag LPF state
  private dragPrev = new Float32Array(3);
  private sampler: HeightMapSampler | null = null;
  lastHmap: Float32Array | null = null;
  get lidarDims(): { nx: number; ny: number } | undefined {
    return this.sampler ? { nx: this.sampler.nx, ny: this.sampler.ny } : undefined;
  }

  constructor(cfg: EvalConfig, spec: RobotSpec, eng: Engine, readonly nets: Record<string, OnnxSession>) {
    super(cfg, spec, eng);
    this.g = go2fw(cfg);
    this.home = SCHEME_FSM[this.g.scheme] ?? this.g.fsm_id;
    this.leashCapable = this.home === DRAG;
    if (this.home === AVOID) this.sampler = new HeightMapSampler({ nx: 41, ny: 21, res: 0.05, mode: "occupancy",
      occ_lo: 0.15, occ_hi: 2.0, dilate: 1, relative_to: "base_foot", order: "xy" });
    const main = this.norm("main");
    this.default = Float64Array.from(main.act_mean);
    this.kp = Float64Array.from(main.kp ?? new Array(12).fill(40));
    this.kd = Float64Array.from(main.kd ?? new Array(12).fill(1));
    this.needsCommand = true;
    this.stackDepth = 6;
    this.frameLayout = [["cmd", 3], ["gyro", 3], ["gravity", 3], ["q", 12], ["dq", 12], ["last_action", 12]];
    this.fsm = this.home;
    this.publishRange();
  }

  private norm(role: string): Go2Norm {
    const n = this.g.norms[role];
    if (!n) throw new Error(`${this.name}: go2.norms.${role} missing`);
    return n;
  }

  override reset() {
    const ground = this.home === AUTOREC;
    // AutoRecovery is shown from a fall: on the back (the firmware enters it from any fall)
    this.seat(ground ? m2p(FOLD) : this.default, ground ? [0, 1, 0, 0] : [1, 0, 0, 0], this.eng.allBodyIds());
    this.fsm = this.home; this.entry = true; this.tick = 0; this.level = 1;
    this.f = [0, 0, 0]; this.pending = []; this.lastPress = {};
    this.lastAct = new Float32Array(12); this.done = false; this.nextPolicy = undefined;
  }

  // ---------------------------------------------------------------- remote / API
  override remoteCombos(): string[] {
    const c = ["Start", "Left+Start", "Right+Start", "L2+A", "L2+B", "L2+X", "L1", "L2", "L1 L1", "L2 L2",
      "A", "B", "X", "Y", "R1", "R2", "A A", "B B", "X X", "Y Y", "R1 R1", "R2 R2",
      "api:1030 forward flip", "api:2043 back flip", "api:2041 left flip", "api:2059 rage on",
      "api:2059 rage off", "api:2056 force follow on", "api:2056 force follow off"];
    if (this.home === CFLIP || this.home === CFLIPX3) c.push("force:flip");
    if ([FFLIP, BFLIP, LFLIP, CFLIP, CFLIPX3].includes(this.home)) c.push("repeat:on", "repeat:off");
    return c;
  }
  override remote(combo: string) { this.pending.push(combo); }

  /** remote key → firmware event (single press; single keys count as a double press within 0.5 s) */
  private event(combo: string) {
    if (combo.startsWith("api:")) {
      const [id, ...rest] = combo.slice(4).split(" ");
      const on = !rest.join(" ").endsWith("off");
      this.api(+id, on); return;
    }
    if (combo === "force:flip") { this.switchTo(this.home); return; }
    if (combo === "repeat:on" || combo === "repeat:off") { this.repeat = combo === "repeat:on"; return; }
    let key = combo, dbl = false;
    if (combo.includes(" ")) { key = combo.split(" ")[0]; dbl = true; }
    else if (!combo.includes("+") && combo !== "Start") {
      const last = this.lastPress[combo] ?? -1e9;
      this.lastPress[combo] = this.tick;
      if (this.tick - last > 25) return;          // first press of a double press
      this.lastPress[combo] = -1e9; dbl = true;
    }
    if (!dbl) {
      switch (combo) {
        case "L2+B": this.switchTo(DAMP); return;
        case "L2+A": this.evStandUpDown(); return;
        case "L2+X": this.evRecovery(); return;
        case "Start": case "Left+Start": this.evFreeWalk(); return;
        case "Right+Start": this.evTrick(GAIT); return;
      }
      return;
    }
    switch (key) {                                   // double presses
      case "L1": this.setLevel(1); return;
      case "L2": this.setLevel(0); return;
      case "A": this.evTrick(AVOID); return;
      case "X": this.evTrick(BOUND); return;
      case "Y": this.evTrick(JUMP); return;
      case "B": this.evTrick(CROSS); return;
      case "R1": this.evTrick(HANDSTAND); return;
      case "R2": this.evTrick(BACKSTAND); return;
    }
  }

  private api(id: number, on: boolean) {
    switch (id) {
      case 1030: this.evTrick(FFLIP); return;
      case 2043: this.evTrick(BFLIP); return;
      case 2041: this.evTrick(LFLIP); return;
      case 2059: if (on) this.evTrick(RAGE); else this.evFreeWalk(); return;
      case 2056: if (on) this.evTrick(DRAG); else this.evFreeWalk(); return;
    }
  }

  private setLevel(l: number) {
    if ([FREEWALK, AVOID, BOUND, JUMP, GAIT, CROSS, BACKSTAND, RAGE].includes(this.fsm)) {
      this.level = l; this.publishRange();
    }
  }
  private sticksCentred(th: number) { return Math.max(...this.stick.map(Math.abs)) < th; }

  /** EventFreeWalk(false) (Start, API BalanceStand / mode=false) */
  private evFreeWalk() {
    const s = this.fsm;
    if (s === STANDUP) { if (this.mode === 3 && !this.tilted90()) this.switchTo(FREEWALK); return; }
    if ([AVOID, BOUND, JUMP, GAIT, CROSS, DRAG, RAGE].includes(s)) { this.switchTo(FREEWALK); return; }
    // ai_sport continuous flips park in state 13 / 15 (only Standing / Damp leave it); the web lets Start go on
    if ((s === CFLIP || s === CFLIPX3) && this.done2) { this.switchTo(FREEWALK); return; }
    if (s === HANDSTAND) { this.flag = false; this.t0 = this.tick; this.mode = 0; this.nextHS = FREEWALK; return; }
    if (s === BACKSTAND) { this.flag = false; return; }
  }
  private nextHS = FREEWALK;

  /** Event<Trick> / trick API: AiController's per-target allowed-source tables (see the docs' transition table) */
  private evTrick(tgt: number) {
    const s = this.fsm;
    if (s === tgt) {
      if (tgt === HANDSTAND || tgt === BACKSTAND) this.evFreeWalk();     // same event again = exit
      return;
    }
    if (s === HANDSTAND && tgt === GAIT) { this.flag = false; this.t0 = this.tick; this.mode = 0; this.nextHS = GAIT; return; }
    const flips = [FFLIP, BFLIP, LFLIP];
    const noJ = !this.stickAny(0.4);
    if (s === STANDUP) { if (this.mode === 3) this.switchTo(tgt); return; }
    if (flips.includes(tgt)) {
      if (!this.sticksCentred(0.1)) return;
      if ([FREEWALK, GAIT, RAGE].includes(s)) this.switchTo(tgt);
      else if ([AVOID, BOUND, JUMP, HANDSTAND, CROSS, BACKSTAND, DRAG].includes(s)) this.viaFreeWalk(tgt);
      return;
    }
    const direct: Record<number, number[]> = {
      [GAIT]: [FREEWALK], [HANDSTAND]: [FREEWALK, GAIT], [BACKSTAND]: [FREEWALK, GAIT], [CROSS]: [FREEWALK],
      [BOUND]: [FREEWALK, AVOID, GAIT, DRAG], [JUMP]: [FREEWALK, AVOID, GAIT], [AVOID]: [FREEWALK, BOUND, JUMP, GAIT,
        CROSS, DRAG, RAGE], [DRAG]: [FREEWALK], [RAGE]: [FREEWALK, AVOID, BOUND, GAIT, CROSS],
    };
    const directNoJ: Record<number, number[]> = {
      [GAIT]: [RAGE], [HANDSTAND]: [RAGE], [BACKSTAND]: [RAGE], [CROSS]: [RAGE], [BOUND]: [JUMP, CROSS, RAGE],
      [JUMP]: [BOUND, CROSS, RAGE], [DRAG]: [RAGE],
    };
    const via: Record<number, number[]> = {
      [GAIT]: [AVOID, BOUND, JUMP, CROSS, BACKSTAND, DRAG], [HANDSTAND]: [AVOID, BOUND, JUMP, CROSS, BACKSTAND, DRAG],
      [BACKSTAND]: [AVOID, BOUND, JUMP, HANDSTAND, CROSS, DRAG], [CROSS]: [AVOID, BOUND, JUMP, GAIT, HANDSTAND,
        BACKSTAND, DRAG], [BOUND]: [HANDSTAND, BACKSTAND], [JUMP]: [HANDSTAND, BACKSTAND], [AVOID]: [HANDSTAND, BACKSTAND],
      [DRAG]: [AVOID, BOUND, JUMP, GAIT, HANDSTAND, CROSS, BACKSTAND], [RAGE]: [HANDSTAND, BACKSTAND],
    };
    if (direct[tgt]?.includes(s)) {
      if ([HANDSTAND, BACKSTAND, GAIT].includes(tgt) && !noJ) return;
      this.switchTo(tgt);
    } else if (directNoJ[tgt]?.includes(s)) { if (noJ) this.switchTo(tgt); }
    else if (via[tgt]?.includes(s)) {
      if ([GAIT, HANDSTAND, BACKSTAND].includes(tgt) && !noJ) return;
      this.viaFreeWalk(tgt);
    }
  }
  private stickAny(th: number) { return Math.max(...this.stick.map(Math.abs)) > th; }
  /** "via FW": EventFreeWalk, then (once in 1003) the target — the web does both at once */
  private viaFreeWalk(tgt: number) { this.switchTo(tgt); }

  /** L2+A (EventStandUpDown) */
  private evStandUpDown() {
    const s = this.fsm;
    if (s === DAMP || s === STANDDOWN) { this.switchTo(STANDUP); this.skipStep0 = false; return; }
    if (s === STANDUP) { this.switchTo(STANDDOWN); return; }
    if ([FREEWALK, AVOID, BOUND, JUMP, GAIT, CROSS, RAGE].includes(s) && this.sticksCentred(0.5)) {
      this.switchTo(STANDUP); this.skipStep0 = true;
    }
  }
  private skipStep0 = false;
  /** L2+X (EventRecovery) */
  private evRecovery() {
    const s = this.fsm;
    if (s === FREEWALK) return;
    if (s === DAMP || s === STANDDOWN) { this.switchTo(RECOVERY); return; }
    if (s === STANDUP) { this.switchTo(this.tilted90() ? RECOVERY : FREEWALK); return; }
    this.evFreeWalk();
  }

  /** SetFsm: FSMs this driver runs itself switch locally; others hand over to their pack */
  private switchTo(id: number) {
    const local = [DAMP, STANDUP, STANDDOWN, RECOVERY, AUTOREC, FREEWALK, BSEND, this.home];
    if (!local.includes(id)) {
      const pack = this.g.packs?.[String(id)];
      if (pack) { this.nextPolicy = pack; this.done = true; }
      return;                                   // not imported / unknown: the worker keeps this pack running
    }
    this.fsm = id; this.entry = true;
    if (id !== this.home || id === FREEWALK) this.publishRange();
    else this.publishRange();
  }

  /** web stick scale per FSM / level (full stick = the firmware's command at stick 1) */
  private publishRange() {
    const s = this.fsm;
    let m = [1, 1, 1];
    const lvl = (lo?: number[], up?: number[]) => ((this.level === 1 ? up : lo) ?? [1, 1, 1]);
    if (s === FREEWALK) m = this.fwScale();
    else if (s === this.home && this.g.low && this.g.up) m = lvl(this.g.low, this.g.up);
    if (s === RAGE) m = [this.level === 1 ? 2.5 : 1.0, 1.0, 5.0];
    if (s === BACKSTAND) m = [0.7, 0.1, this.level === 1 ? 2.5 : 1.0];
    if (s === GAIT) m = this.level === 1 ? [1.2, 0.4, 2.0] : [0.6, 0.4, 1.4];
    if (s === HANDSTAND) m = [0.6, 0.4, 2.0];
    if (s === DRAG) m = [1, 1, 1];
    this.scale = m;
    this.velRange = [-m[0], m[0], -m[1], m[1], -m[2], m[2]];
  }
  private scale = [1, 1, 1];
  private fwScale(): number[] {
    const home = this.home === FREEWALK;
    const lo = (home ? this.g.low : this.g.walk_low) ?? [0.8, 0.7, 2.0];
    const up = [...((home ? this.g.up : this.g.walk_up) ?? [1.3, 1.0, 2.5])];
    if (home && this.g.payload === "heavy") up[0] = 1.0;
    return this.level === 1 ? up : lo;
  }

  // ---------------------------------------------------------------- robot state
  private robot() {
    const [q, dq] = this.readQ();
    const R = matFromWxyz(this.baseQuat());
    const grav = matTVec(R, [0, 0, -1]);
    const gyro = Array.from(this.baseAngVel());
    // IMU rpy (ZYX): roll, pitch
    const pitch = Math.asin(clip(-R[6], -1, 1));
    const roll = Math.atan2(R[7], R[8]);
    return { q, dq, grav, gyro, pitch, roll };
  }
  private tilted90() { return matFromWxyz(this.baseQuat())[8] < 0; }

  private frame(n: Go2Norm, raw: ArrayLike<number>): Float32Array {
    const out = new Float32Array(raw.length), c = n.clip_obs ?? 10;
    for (let i = 0; i < raw.length; i++) out[i] = clip((raw[i] - n.ob_mean[i]) * n.ob_scale[i], -c, c);
    return out;
  }
  private concatRaw(cmd: number[], st: ReturnType<Go2FwDriver["robot"]>, drag = false): number[] {
    const head = drag ? [...st.gyro, ...st.grav, ...cmd] : [...cmd, ...st.gyro, ...st.grav];
    return [...head, ...st.q, ...st.dq, ...this.lastAct];
  }
  private gaitRaw(st: ReturnType<Go2FwDriver["robot"]>): number[] {
    return [...st.gyro, ...st.grav, ...st.q, ...st.dq, ...this.lastAct];
  }
  private async runNet(role: string, feeds: Record<string, { data: Float32Array; dims: number[] }>): Promise<Float32Array> {
    const s = this.nets[role];
    if (!s) throw new Error(`${this.name}: net ${role} missing`);
    this.role = this.role ? `${this.role}+${role}` : role;
    return s.run(feeds);
  }
  private toTarget(n: Go2Norm, act: Float32Array): Target {
    const c = n.clip_act ?? 5, t = new Float64Array(12);
    for (let i = 0; i < 12; i++) {
      const a = clip(act[i], -c, c);
      this.lastAct[i] = a;
      t[i] = a * n.act_scale[i] + n.act_mean[i];
    }
    this.lastAction = this.lastAct.slice();
    return t;
  }
  private gains(n: Go2Norm) { this.kp = Float64Array.from(n.kp ?? []); this.kd = Float64Array.from(n.kd ?? []); }

  /** GetJoystick EMA (dead zone 0.1, α 0.06 unless given) */
  private filter(alpha = [0.06, 0.06, 0.06], dead = 0.1) {
    for (let i = 0; i < 3; i++) this.f[i] = (1 - alpha[i]) * this.f[i] + alpha[i] * dz(this.stick[i], dead);
  }
  private resetSticks() { this.f = [0, 0, 0]; this.cmd = [0, 0, 0]; }

  // ---------------------------------------------------------------- main step
  async step(command: Command): Promise<Float64Array> {
    // web command -> firmware sticks
    for (let i = 0; i < 3; i++) this.stick[i] = clip(command[i] / (this.scale[i] || 1), -1, 1);
    while (this.pending.length) this.event(this.pending.shift()!);
    if (this.repeat && this.fsm === FREEWALK && [FFLIP, BFLIP, LFLIP, CFLIP, CFLIPX3].includes(this.home)
        && this.sticksCentred(0.1) && this.k > 25) this.switchTo(this.home);
    this.tick++;
    const st = this.robot();
    let tgt: Target;
    const fsm = this.fsm, entry = this.entry;
    this.entry = false;
    switch (fsm) {
      case DAMP: tgt = this.damping(); break;
      case STANDUP: tgt = this.standUp(st, entry); break;
      case STANDDOWN: tgt = this.standDown(st, entry); break;
      case RECOVERY: tgt = this.recovery(st, entry); break;
      case AUTOREC: tgt = await this.autoRecovery(st, entry); break;
      case FREEWALK: tgt = await this.freeWalk(st, entry); break;
      case RAGE: case CROSS: tgt = await this.simpleConcat(st, entry); break;
      case BACKSTAND: tgt = await this.backStand(st, entry); break;
      case BSEND: tgt = await this.backStandEnd(st, entry); break;
      case BOUND: case JUMP: tgt = await this.boundJump(st, entry); break;
      case AVOID: tgt = await this.avoid(st, entry); break;
      case DRAG: tgt = await this.drag(st, entry); break;
      case GAIT: case HANDSTAND: tgt = await this.gait(st, entry); break;
      case FFLIP: case BFLIP: case LFLIP: tgt = await this.flip(st, entry); break;
      case CFLIP: case CFLIPX3: tgt = await this.cflip(st, entry); break;
      default: tgt = this.damping();
    }
    this.activeNet = `${fsm} ${GO2_FSM_NAME[fsm] ?? ""}${this.role ? " · " + this.role : ""}`;
    this.role = "";
    return tgt;
  }
  /** firmware FSM + net that ran this tick (inspector "drive") */
  activeNet = "";
  private role = "";

  /** termination → AutoRecovery (auto-recovery on and a light payload) else Damping */
  private terminate(st: ReturnType<Go2FwDriver["robot"]>, th: number, light = true): boolean {
    if (st.grav[2] > th) { this.switchTo(this.autoRecOn && light && this.g.norms.recovery ? AUTOREC : DAMP); return true; }
    return false;
  }

  // ---------------------------------------------------------------- scripted FSMs
  private damping(): Target {
    this.kp = new Float64Array(12);
    this.kd = m2p([3, 3, 3, 3, 3, 3, 1, 1, 1, 1, 1, 1]);
    const [q] = this.readQ();
    return q;
  }
  private blend(r: number, a: ArrayLike<number>, b: ArrayLike<number>): Target {
    const o = new Float64Array(12);
    for (let i = 0; i < 12; i++) o[i] = r * a[i] + (1 - r) * b[i];
    return o;
  }
  /** 1002: Step0 (0.6 s to the crouch, skipped when coming from a gait), Step1 (0.7 s to [0, .67, −1.3]), hold */
  private standUp(st: ReturnType<Go2FwDriver["robot"]>, entry: boolean): Target {
    if (entry) { this.k = this.skipStep0 ? 30 : 0; this.q0 = Float64Array.from(st.q); this.mode = this.skipStep0 ? 1 : 0; this.skipStep0 = false; }
    this.kp.fill(100); this.kd.fill(5);
    const F0 = m2p(STAND_F0), SP = m2p(STAND_POSE);
    let tgt: Target;
    if (this.mode === 0) {
      tgt = this.blend(this.k / 30, F0, this.q0);
      if (this.k >= 30) { this.mode = 1; this.q1 = null; }
    } else if (this.mode === 1) {
      if (!this.q1) this.q1 = Float64Array.from(st.q);
      const t = this.k - 30;
      tgt = this.blend(Math.min(t / 35, 1), SP, this.q1);
      if (t >= 35) this.mode = 3;
    } else tgt = SP;
    this.k++;
    return tgt;
  }
  private q1: Float64Array | null = null;
  /** 2006: 2 s linear blend to the crouch, → Damping at τ > 1.9 (tick 96) */
  private standDown(st: ReturnType<Go2FwDriver["robot"]>, entry: boolean): Target {
    if (entry) { this.tf = 0; this.q0 = Float64Array.from(st.q); }
    this.kp.fill(100); this.kd.fill(5);
    this.tf = f32(this.tf + 0.02);
    const r = Math.min(this.tf / 2.0, 1);
    const tgt = this.blend(r, m2p(STAND_F0), this.q0);
    if (this.tf > 1.9 && st.grav[2] < 0) this.switchTo(DAMP);
    return tgt;
  }
  /** 2004 scripted recovery: FoldLeg1/2 → (|roll| ≥ 1: RollOver1/2) → StandUp1/2 → FreeWalk */
  private recovery(st: ReturnType<Go2FwDriver["robot"]>, entry: boolean): Target {
    const P: Record<number, { T: number; H: number; tgt: () => number[]; kp: number[]; kd: number[] }> = {
      7: { T: 30, H: 0, tgt: () => FOLD, kp: legs(80, 80, 0), kd: legs(1, 1, 0) },
      1: { T: 30, H: 0, tgt: () => FOLD, kp: legs(80, 80, 80), kd: legs(1, 1, 1) },
      2: { T: 60, H: 10, tgt: () => (this.side ? mirror(ROLL1) : ROLL1), kp: legs(80, 80, 80), kd: legs(1, 1, 1) },
      3: { T: 60, H: 10, tgt: () => (this.side ? mirror(ROLL2) : ROLL2), kp: legs(80, 80, 80), kd: legs(1, 1, 1) },
      0: { T: 25, H: 10, tgt: () => STAND_F0, kp: legs(80, 80, 0), kd: legs(1, 1, 0) },
      6: { T: 25, H: 10, tgt: () => STAND_POSE, kp: legs(80, 80, 80), kd: legs(1, 1, 1) },
    };
    if (entry) { this.mode = st.grav[2] > 0.2 ? 7 : 0; this.k = 0; this.q0 = Float64Array.from(st.q); }
    const ph = P[this.mode];
    const tg = m2p(ph.tgt());
    const r = Math.min(this.k / ph.T, 1);
    const out = this.blend(r, tg, this.q0);
    this.kp = m2p(ph.kp); this.kd = m2p(ph.kd);
    if (this.k >= ph.T + ph.H) {
      const nxt = (m: number, q0: ArrayLike<number>) => { this.mode = m; this.k = -1; this.q0 = Float64Array.from(q0); };
      switch (this.mode) {
        case 7: nxt(1, st.q); break;
        case 1: this.side = st.roll >= 0 ? 1 : 0; nxt(Math.abs(st.roll) >= 1.0 ? 2 : 0, tg); break;
        case 2: nxt(3, tg); break;
        case 3: if (Math.abs(st.roll) < 1) nxt(0, tg); else { this.side ^= 1; nxt(1, tg); } break;
        case 0: nxt(6, tg); break;
        case 6: this.switchTo(st.grav[2] > 0.2 ? DAMP : FREEWALK); break;
      }
    }
    this.k++;
    return out;
  }

  // ---------------------------------------------------------------- 1003 FreeWalk
  private async freeWalk(st: ReturnType<Go2FwDriver["robot"]>, entry: boolean): Promise<Target> {
    const home = this.home === FREEWALK;
    const n = home ? this.norm("main") : this.norm("walk");
    if (entry) { this.resetSticks(); this.lastAct.fill(0); this.level = 1; this.publishRange(); this.k = 0; }
    this.filter();
    const s = this.fwScale();
    this.cmd = [clip(this.f[0] * s[0], -1.5, 1.5), clip(this.f[1] * s[1], -1.0, 1.0), clip(this.f[2] * s[2], -3, 3)];
    const fr = this.frame(n, this.concatRaw(this.cmd, st));
    if (entry) this.hist.fill(fr); else this.hist.push(fr);
    const heavy = home && this.g.payload === "heavy";
    const rotate = Math.abs(this.cmd[0]) < 0.05 && this.cmd[1] < 0.05;        // firmware: vy signed
    const role = heavy ? "main" : this.level === 0 ? "stair" : rotate ? "rotate" : home ? "main" : "walk";
    const act = await this.runNet(role, { p_obs: { data: this.hist.vec(true), dims: [1, 270] } });
    const tgt = this.toTarget(n, act);
    this.gains(n); this.lastFrame = fr; this.k++;
    this.terminate(st, 0.2, !heavy);
    return tgt;
  }

  // ---------------------------------------------------------------- 2021 RageMode / 2016 CrossStep
  private async simpleConcat(st: ReturnType<Go2FwDriver["robot"]>, entry: boolean): Promise<Target> {
    const n = this.norm("main");
    if (entry) { this.resetSticks(); this.lastAct.fill(0); this.level = 1; this.publishRange(); }
    if (this.fsm === RAGE) {
      let [ly, lx, rx] = this.stick;
      if (Math.abs(ly) > 0.4) rx = clip(rx, -0.4, 0.4);          // (the |rx| > 0.6 → |ly| ≤ 0.5 branch is dead)
      this.f[1] = 0.94 * this.f[1] + 0.06 * dz(lx, 0.1);
      // ly: accelerate fast (0.4 old / 0.6 new) when same sign and |ly| > |f|, else slow (0.95 / 0.05)
      const fa = (this.f[0] < 0) === (ly < 0) && Math.abs(ly) > Math.abs(this.f[0]);
      this.f[0] = fa ? 0.4 * this.f[0] + 0.6 * dz(ly, 0.05) : 0.95 * this.f[0] + 0.05 * dz(ly, 0.05);
      // rx: the reverse — slow when accelerating in the same direction, fast otherwise
      const wa = (this.f[2] < 0) === (rx < 0) && Math.abs(this.f[2]) < Math.abs(rx);
      this.f[2] = wa ? 0.95 * this.f[2] + 0.05 * dz(rx, 0.05) : 0.4 * this.f[2] + 0.6 * dz(rx, 0.05);
      this.cmd = [clip(this.f[0] * (this.level === 1 ? 2.5 : 1.0), -3, 3), clip(this.f[1], -1, 1),
        clip(this.f[2] * 5.0, -6, 6)];
    } else {
      this.filter();
      const s = this.level === 1 ? this.g.up! : this.g.low!;
      this.cmd = [clip(this.f[0] * s[0], -1.5, 1.5), clip(this.f[1] * s[1], -1, 1), clip(this.f[2] * s[2], -1, 1)];
    }
    const fr = this.frame(n, this.concatRaw(this.cmd, st));
    if (entry) this.hist.fill(fr); else this.hist.push(fr);
    const act = await this.runNet("main", { p_obs: { data: this.hist.vec(true), dims: [1, 270] } });
    const tgt = this.toTarget(n, act);
    this.gains(n); this.lastFrame = fr;
    this.terminate(st, this.fsm === RAGE ? 0.5 : 0.2);
    return tgt;
  }

  // ---------------------------------------------------------------- 2017 BackStand → 2018 BackStandEnd
  private async backStand(st: ReturnType<Go2FwDriver["robot"]>, entry: boolean): Promise<Target> {
    const n = this.norm("main");
    if (entry) { this.resetSticks(); this.lastAct.fill(0); this.level = 1; this.flag = true; this.publishRange(); }
    this.filter();
    if (this.flag) {
      const vx = clip(this.f[0] * 0.7, -1.5, 1.5);
      let wz = clip(this.f[2] * (this.level === 1 ? 2.5 : 1.0), -3, 3);
      if (Math.abs(vx) > 0.3) wz = clip(wz, -1, 1);
      this.cmd = [vx, clip(this.f[1] * 0.1, -1, 1), wz];
    } else this.cmd = [1.5, 0, 0];
    const fr = this.frame(n, this.concatRaw(this.cmd, st));
    if (entry) this.hist.fill(fr); else this.hist.push(fr);
    const act = await this.runNet("main", { p_obs: { data: this.hist.vec(true), dims: [1, 270] } });
    const tgt = this.toTarget(n, act);
    this.gains(n); this.lastFrame = fr;
    if (!this.terminate(st, 0.5) && !this.flag) this.switchTo(BSEND);
    return tgt;
  }
  private async backStandEnd(st: ReturnType<Go2FwDriver["robot"]>, entry: boolean): Promise<Target> {
    const n = this.norm("end");
    if (entry) { this.lastAct.fill(0); this.k = 0; }
    this.cmd = [0, 0, 0];
    const fr = this.frame(n, this.concatRaw(this.cmd, st));
    if (entry) this.hist.fill(fr); else this.hist.push(fr);
    const act = await this.runNet("end", { p_obs: { data: this.hist.vec(true), dims: [1, 270] } });
    const tgt = this.toTarget(n, act);
    this.gains(n); this.lastFrame = fr; this.k++;
    if (!this.terminate(st, 0.5) && this.k > 25) this.switchTo(FREEWALK);
    return tgt;
  }

  // ---------------------------------------------------------------- 2008 FreeBound / 2009 FreeJump (+ zero net)
  private async boundJump(st: ReturnType<Go2FwDriver["robot"]>, entry: boolean): Promise<Target> {
    const bound = this.fsm === BOUND;
    const nm = this.norm("main"), nz = this.norm("zero");
    const alpha = bound ? [0.2, 0.2, 0.1] : [0.06, 0.06, 0.06];
    const cmdFor = (zero: boolean): number[] => {
      const up = this.level === 1, s = up ? this.g.up! : this.g.low!, [fx, fy, fw] = this.f;
      if (bound) {
        if (!zero) return up ? [clip(s[0] * fx, -1.0, 1.5), clip(s[1] * fy, -0.2, 0.2), clip(s[2] * fw, -1, 1)]
          : [clip(s[0] * fx, -3, 4), clip(s[1] * fy, -1.2, 1.2), clip(s[2] * fw, -4, 4)];
        return [clip(s[0] * fx, -3, 4), clip(s[1] * fy, -1.2, 1.2), clip((up ? 3.0 : 2.0) * fw, -4, 4)];
      }
      if (!zero) return [clip(s[0] * fx, -1.5, 1.5), clip(s[1] * fy, -0.4, 0.4), clip(s[2] * fw, -2, 2)];
      return [clip(s[0] * fx, -1.5, 1.5), clip(s[1] * fy, -1.2, 1.2), clip((up ? 3.0 : 2.0) * fw, -3, 3)];
    };
    if (entry) {
      this.resetSticks(); this.lastAct.fill(0); this.level = 1; this.publishRange(); this.mode = 0;   // 0 = bound/jump
      this.filter(alpha);
      this.cmd = cmdFor(false);
      this.hist.fill(this.frame(nm, this.concatRaw(this.cmd, st)));
    } else {
      this.filter(alpha);
      const [fx, fy] = this.f;
      const zero = bound ? (fx < 0.05 && Math.abs(fy) < 0.05) : (Math.abs(fx) < 0.05 && Math.abs(fy) < 0.05);
      if (this.mode === 0 && zero) {
        this.lastAct.fill(0);
        for (let i = 0; i < 6; i++) this.hist.push(this.frame(nz, this.concatRaw(this.cmd, st)));
        this.mode = 1;
      } else if (this.mode === 1 && !zero) {
        this.lastAct.fill(0);
        for (let i = 0; i < 6; i++) this.hist.push(this.frame(nm, this.concatRaw(this.cmd, st)));
        this.mode = 0;
      }
      this.cmd = cmdFor(this.mode === 1);
      this.hist.push(this.frame(this.mode ? nz : nm, this.concatRaw(this.cmd, st)));
    }
    const role = this.mode ? "zero" : "main", n = this.mode ? nz : nm;
    const act = await this.runNet(role, { p_obs: { data: this.hist.vec(true), dims: [1, 270] } });
    const tgt = this.toTarget(n, act);
    this.gains(n);
    this.terminate(st, 0.2);
    return tgt;
  }

  // ---------------------------------------------------------------- 2007 FreeAvoid (planner nets + walker)
  private async avoid(st: ReturnType<Go2FwDriver["robot"]>, entry: boolean): Promise<Target> {
    const n = this.norm("main");
    const A = this.g.avoid ?? {};
    if (entry) { this.resetSticks(); this.lastAct.fill(0); this.level = 1; this.publishRange(); this.v = [0, 0, 0]; }
    // occupancy grid (41 × 21, 5 cm, 0.15 < h < 2 m, 4-neighbour dilation); zero-planner copy masked to the
    // front / centre (rows < back_index, right_index < col < 20 − right_index)
    let vision = new Float32Array(861), vz = new Float32Array(861);
    if (this.sampler) {
      vision = Float32Array.from(this.sampler.sample(this.eng, this.bqp));
      this.lastHmap = vision;
      const back = A.back_index ?? 35, right = A.right_index ?? 4;
      for (let r = 0; r < 41; r++) for (let c = 0; c < 21; c++)
        if (r < back && c > right && c < 20 - right) vz[r * 21 + c] = vision[r * 21 + c];
    }
    this.filter();
    const s = this.level === 1 ? this.g.up! : this.g.low!;
    const u = [clip(this.f[0] * s[0], -1.5, 1.5), clip(this.f[1] * s[1], -0.6, 0.6), clip(this.f[2] * s[2], -2, 2)];
    const pobs = Float32Array.from([...st.gyro.map((x) => x * 0.2), ...st.grav, ...this.v]);
    if (u.some((x) => Math.abs(x) >= 0.01)) {
      const cmd = Float32Array.from(u.map((x) => (Math.abs(x) <= 0.01 ? 0 : x)));
      const o = await this.runNet("obstacle", { p_obs: { data: pobs, dims: [1, 9] }, cmd: { data: cmd, dims: [1, 3] },
        vision: { data: vision, dims: [1, 861] } });
      const k = [A.o_vel_x ?? 1.2, A.o_vel_y ?? 0.6, A.o_vel_w ?? 2.0];
      this.v = [o[0] * k[0], o[1] * k[1], o[2] * k[2]];
    } else {
      const o = await this.runNet("zero_planner", { p_obs: { data: pobs, dims: [1, 9] },
        cmd: { data: new Float32Array(3), dims: [1, 3] }, vision: { data: vz, dims: [1, 861] } });
      const k = [A.z_vel_x ?? 1.5, A.z_vel_y ?? 0.6, A.z_vel_w ?? 2.0], a = A.vel_filter ?? 0.99;
      this.v = [0, 1, 2].map((i) => a * o[i] * k[i] + (1 - a) * this.v[i]);
      if (this.v.every((x) => Math.abs(x) < (A.avoid_min_vel ?? 0.05))) this.v = [0, 0, 0];
    }
    this.cmd = [...this.v];
    const fr = this.frame(n, this.concatRaw(this.cmd, st));
    if (entry) this.hist.fill(fr); else this.hist.push(fr);
    const act = await this.runNet("main", { p_obs: { data: this.hist.vec(true), dims: [1, 270] } });
    const tgt = this.toTarget(n, act);
    this.gains(n); this.lastFrame = fr;
    this.terminate(st, 0.2);
    return tgt;
  }

  // ---------------------------------------------------------------- 2019 ForceFollow (drag)
  private async drag(st: ReturnType<Go2FwDriver["robot"]>, entry: boolean): Promise<Target> {
    const n = this.norm("main");
    const D = this.g.drag ?? {};
    const lim = D.cmd_limits ?? [2, 1, 4], rate = D.cmd_rate ?? [1, 1, 1];
    const alpha = 0.02 / (0.02 + 1 / (2 * Math.PI * (D.filter_params?.[0] ?? 2)));
    if (entry) { this.resetSticks(); this.v = [0, 0, 0]; this.dragPrev = new Float32Array(3); this.hist5 = new Hist(5); }
    this.filter();
    const c = [clip(this.f[0], -0.9, 0.6), clip(this.f[1], -0.5, 0.5), clip(this.f[2], -2, 2)];
    if (c.some((x) => Math.abs(x) > 0.1)) this.cmd = c;
    else {
      const u = [0, 1, 2].map((i) => clip(this.dragPrev[i] / rate[i], -lim[i], lim[i]));
      this.v = [0, 1, 2].map((i) => (1 - alpha) * this.v[i] + alpha * u[i]);
      this.cmd = [...this.v];
    }
    const fr = this.frame(n, this.concatRaw(this.cmd, st, true));
    if (entry) this.hist5.fill(fr); else this.hist5.push(fr);
    const x = this.hist5.vec(false);
    this.dragPrev = Float32Array.from(await this.runNet("est", { input: { data: x, dims: [1, 225] } }));
    const act = await this.runNet("main", { input: { data: x, dims: [1, 225] } });
    const tgt = this.toTarget(n, act);
    this.gains(n); this.lastFrame = fr;
    this.terminate(st, 0.0);
    return tgt;
  }

  // ---------------------------------------------------------------- 2010 ClassicWalk / 2011 HandStand (gait nets)
  private async gait(st: ReturnType<Go2FwDriver["robot"]>, entry: boolean): Promise<Target> {
    const n = this.norm("main");
    const hs = this.fsm === HANDSTAND;
    if (entry) {
      this.resetSticks(); this.lastAct.fill(0); this.phi = 0; this.cnt = 1; this.standing = false;
      if (hs) { this.flag = true; this.mode = 0; this.t0 = this.tick; this.nextHS = FREEWALK; }
      else this.level = 0;
      this.publishRange();
    }
    if (hs && this.flag && this.mode === 0 && this.tick - this.t0 > 25) this.mode = 1;   // EnterHandStand
    this.filter();
    let vx: number, vy: number, wz: number;
    if (hs) {
      this.gaitF = this.mode === 1 ? 1.9 : 1.4;
      vx = clip(this.f[0] * 0.6, -0.9, 0.6); vy = clip(this.f[1] * 0.4, -0.5, 0.5); wz = clip(this.f[2] * 2.0, -2, 2);
    } else {
      const sc = this.level === 1 ? [1.2, 0.4, 2.0] : [0.6, 0.4, 1.4];
      this.gaitF = this.level === 1 ? 1.8 : 1.4;
      vx = clip(this.f[0] * sc[0], -0.9, 1.2); vy = clip(this.f[1] * sc[1], -0.5, 0.5); wz = clip(this.f[2] * sc[2], -2, 2);
      // stand / walk gate (previous tick's phase)
      if (Math.abs(vx) >= 0.1 || Math.abs(vy) >= 0.1 || Math.abs(wz) >= 0.2 || st.grav[2] >= -0.95) {
        this.cnt = 0; this.standing = false;
      } else {
        if (this.phi > 0.96 || this.phi < 0.04) this.cnt++;
        if (this.cnt !== 0) { this.cnt = 1; this.standing = true; }
      }
    }
    const fr = this.frame(n, this.gaitRaw(st));
    if (entry) this.hist5.fill(fr); else this.hist5.push(fr);
    let f = this.gaitF;
    if (hs || !this.standing) this.phi = (this.phi + f * 0.02) % 1;
    else { vx = vy = wz = 0; this.phi = 0; f = 0; }
    if (hs && f > 1.41) { vx = clip(vx + 0.1, -0.6, 0.6); vy = clip(vy, -0.4, 0.4); wz = clip(wz, -2, 2); }
    const db = (v: number) => (Math.abs(v) <= 0.01 ? 0 : v * 0.2);
    const s = this.standing && !hs ? 0 : Math.sin(2 * Math.PI * this.phi);
    const c = this.standing && !hs ? 1 : Math.cos(2 * Math.PI * this.phi);
    const cmd = [s, c, (f - 1.7) * 0.5, db(vx), db(vy), db(wz)];
    if (hs) cmd.push(f > 1.41 ? -1 : 0);
    this.cmd = [vx, vy, wz];
    const act = await this.runNet("main", { p_obs: { data: this.hist5.vec(false), dims: [1, 5, 42] },
      cmd: { data: Float32Array.from(cmd), dims: [1, cmd.length] } });
    const tgt = this.toTarget(n, act);
    this.gains(n); this.lastFrame = fr;
    if (!this.terminate(st, 0.2) && hs && !this.flag && this.mode === 0 && this.tick - this.t0 > 25)
      this.switchTo(this.nextHS);                                                         // OutHandStand
    return tgt;
  }

  // ---------------------------------------------------------------- 2005 AutoRecovery (re_v2)
  private async autoRecovery(st: ReturnType<Go2FwDriver["robot"]>, entry: boolean): Promise<Target> {
    const n = this.norm("recovery");
    if (entry) { this.lastAct.fill(0); this.phi = 0; this.cmd = [0, 0, 0]; }
    const fr = this.frame(n, this.gaitRaw(st));
    if (entry) this.hist5.fill(fr); else this.hist5.push(fr);
    this.phi = (this.phi + 1.4 * 0.02) % 1;
    const cmd = [Math.sin(2 * Math.PI * this.phi), Math.cos(2 * Math.PI * this.phi), (1.4 - 1.7) * 0.5, 0, 0, 0];
    const act = await this.runNet("recovery", { p_obs: { data: this.hist5.vec(false), dims: [1, 5, 42] },
      cmd: { data: Float32Array.from(cmd), dims: [1, 6] } });
    // re_v2: target = clip(act, ±2)·act_scale + OFFSET (the offset replaces act_mean); the last-action obs term is
    // the target minus act_mean in action units (bench capture fflip: exact to 1e-6)
    const tgt = new Float64Array(12);
    for (let i = 0; i < 12; i++) {
      const a = clip(act[i], -(n.clip_act ?? 2), n.clip_act ?? 2);
      tgt[i] = a * n.act_scale[i] + RECOVERY_OFFSET[i];
      this.lastAct[i] = a + (RECOVERY_OFFSET[i] - n.act_mean[i]) / n.act_scale[i];
    }
    this.lastAction = this.lastAct.slice();
    this.gains(n); this.lastFrame = fr;
    // CheckRecovery: upright and the feet at least 0.25 m below the hips
    let h = 0;
    const [q] = this.readQ(), qm = new Float64Array(12);
    for (let i = 0; i < 12; i++) qm[i] = q[PERM[i]];                                      // motor order
    const sgn = [1, -1, 1, -1];
    for (let k = 0; k < 4; k++) {
      const hp = qm[3 * k], t = qm[3 * k + 1], c = qm[3 * k + 2];
      const z = -(sgn[k] * 0.088 * Math.sin(hp) + 0.213 * Math.cos(hp) * Math.cos(t) + 0.213 * Math.cos(hp) * Math.cos(t + c));
      h = Math.max(h, Math.abs(z));
    }
    if (st.grav[2] < -0.7 && h > 0.25) this.switchTo(FREEWALK);
    return tgt;
  }

  // ---------------------------------------------------------------- 2012 / 2013 / 2014 flips (mcf)
  private async flip(st: ReturnType<Go2FwDriver["robot"]>, entry: boolean): Promise<Target> {
    const n = this.norm("main"), F = (this.g.flip ?? {}) as Record<string, number | number[]>;
    const fwd = this.fsm === FFLIP, left = this.fsm === LFLIP;
    const readyT = f32((F.ready_time as number) ?? (fwd ? 0.6 : 0.3));
    if (entry) {
      this.tf = 0; this.k = 0; this.mode = 0; this.flag = false; this.lastAct.fill(0);
      this.q0 = m2p(fwd ? [0, 1.2, -1.8, 0, 1.2, -1.8, 0, 1.27, -1.94, 0, 1.27, -1.94] : legs(0, 0.79, -1.58));
      this.held = this.q0;
    }
    this.tf = f32(this.tf + 0.02);
    if (this.tf < readyT) {                                  // ReadyPhase: step to the ready pose
      this.kp.fill(F.ready_kp as number); this.kd.fill(F.ready_kd as number);
      this.held = this.q0; return this.held;
    }
    if (this.tf < f32(readyT + 0.3)) return this.held;       // 0.3 s hold
    // LocoInfer
    this.k++;
    if (this.k > 4) this.mode = Math.min(this.mode + 1, fwd ? 51 : 40);
    if (fwd && st.pitch > -1.5 && st.pitch < -1.3) this.flag = true;
    const raw = [...st.gyro, ...st.grav, 0, 0, 0, ...st.q, ...st.dq, ...this.lastAct, this.mode, this.k > 4 ? 1 : 0];
    const obs = new Float32Array(47);
    for (let i = 0; i < 47; i++) obs[i] = (raw[i] - n.ob_mean[i]) * n.ob_scale[i];
    this.lastFrame = obs;
    const cp = (i: number) => (F[`control_point${i}`] as number);
    const pose = (i: number) => m2p(F[`control_point${i}_joint_angle`] as number[]);
    const front = (a: number, b: number) => Float64Array.from([a, a, a, a, a, a, b, b, b, b, b, b]);
    const sides = (l: number, r: number) => Float64Array.from([l, l, l, r, r, r, l, l, l, r, r, r]);
    const pd = (kp: Float64Array, kd: Float64Array) => { this.kp = kp; this.kd = kd; };
    if (this.k < cp(1)) {
      const act = await this.runNet("main", { robot_state: { data: obs, dims: [1, 47] } });
      const t = new Float64Array(12);
      for (let i = 0; i < 12; i++) { this.lastAct[i] = act[i]; t[i] = act[i] * n.act_scale[i] + n.act_mean[i]; }
      this.lastAction = this.lastAct.slice();
      if (left) pd(sides(F.policy_l_kp as number, F.policy_r_kp as number), sides(F.policy_l_kd as number, F.policy_r_kd as number));
      else pd(front(F.policy_f_kp as number, F.policy_b_kp as number), front(F.policy_f_kd as number, F.policy_b_kd as number));
      this.held = t;
    } else if (fwd) {
      if (this.k < cp(2)) { this.held = pose(1); pd(front(F.fly_f_kp as number, F.fly_b_kp as number), front(F.fly_f_kd as number, F.fly_b_kd as number)); }
      else if (this.k < cp(3)) {
        const p = pose(2);
        if (!this.flag) { const p1 = pose(1); for (let i = 0; i < 6; i++) p[i] = p1[i]; }
        this.held = p; pd(front(F.fly_f_kp as number, F.fly_b_kp as number), front(F.fly_f_kd as number, F.fly_b_kd as number));
      } else if (this.k < cp(4)) { if (this.flag) { this.held = pose(3); pd(front(50, 50), front(5, 5)); } }
      else if (this.k < cp(5)) { this.held = pose(3); pd(front(100, 100), front(5, 5)); }
      else this.switchTo(FREEWALK);
    } else {
      if (this.k < cp(2)) {
        this.held = pose(1);
        if (left) pd(sides(F.stand_l_kp as number, F.stand_r_kp as number), sides(F.stand_l_kd as number, F.stand_r_kd as number));
        else pd(front(F.stand_f_kp as number, F.stand_b_kp as number), front(F.stand_f_kd as number, F.stand_b_kd as number));
      } else if (this.k < cp(3)) { this.held = pose(2); pd(front(left ? 75 : 100, left ? 75 : 100), front(5, 5)); }
      else this.switchTo(FREEWALK);
    }
    return this.held;
  }
  private held: Float64Array<ArrayBufferLike> = new Float64Array(12);

  // ---------------------------------------------------------------- ai_sport 1.0.4.x ContinuousFlip / X3
  /** Not reachable in any shipped firmware (no API / remote sets StateMachine 12 / 14); forced on the 1.1.4 bench
   *  with gdb (go2_force_state.sh). ready_phase 0.6 s → ready pose (kp 150 kd 2), 1.3 s hold, flip_infer. */
  private async cflip(st: ReturnType<Go2FwDriver["robot"]>, entry: boolean): Promise<Target> {
    const n = this.norm("main"), x3 = this.fsm === CFLIPX3;
    if (entry) { this.tf = 0; this.k = 0; this.mode = 0; this.flag = false; this.done2 = false; this.lastAct.fill(0); this.q0 = Float64Array.from(st.q); this.q1 = null; }
    this.tf = f32(this.tf + 0.02);
    const READY = m2p([0, 1.2, -1.8, 0, 1.2, -1.8, 0, 1.27, -1.94, 0, 1.27, -1.94]);
    const TUCK = m2p([0, 0.79, -1.58, 0, 0.79, -1.58, 0, 3.0, -2.6, 0, 3.0, -2.6]);
    const P692 = m2p(x3 ? [-0.166, 0.2, -0.4, 0.166, 0.2, -0.4, 0, 0.79, -1.58, 0, 0.79, -1.58]
      : [-0.166, 0.5143, -1.0286, 0.166, 0.5143, -1.0286, 0, 3.0, -2.6, 0, 3.0, -2.6]);
    const P740 = m2p(x3 ? legs(0, 0.79, -1.58) : [-0.166, 0.5143, -1.0286, 0.166, 0.5143, -1.0286, 0, 0.79, -1.58, 0, 0.79, -1.58]);
    const REC = m2p(legs(0, 0.79, -1.58));
    const allPD = (kp: number, kd: number) => { this.kp.fill(kp); this.kd.fill(kd); };
    if (this.tf < 0.6) {
      allPD(150, 2.0);
      this.held = this.blend(Math.min(this.tf / 0.6, 1), READY, this.q0); return this.held;
    }
    if (this.tf < 0.6 + 1.3) return this.held;
    if (this.done2) return this.held;
    this.k++;
    if (this.k > 4) this.mode = Math.min(this.mode + 1, x3 ? 96 : 86);
    if (st.pitch > -1.5 && st.pitch < -1.3) this.flag = true;
    const raw = [...st.gyro, ...st.grav, 0, 0, 0, ...st.q, ...st.dq, ...this.lastAct, this.mode, this.k > 4 ? 1 : 0];
    const obs = new Float32Array(47);
    for (let i = 0; i < 47; i++) obs[i] = (raw[i] - n.ob_mean[i]) * n.ob_scale[i];
    this.lastFrame = obs;
    const nn = async (kp: number, kd: number) => {
      const act = await this.runNet("main", { robot_state: { data: obs, dims: [1, 47] } });
      const t = new Float64Array(12);
      for (let i = 0; i < 12; i++) { this.lastAct[i] = act[i]; t[i] = act[i] * n.act_scale[i] + n.act_mean[i]; }
      this.lastAction = this.lastAct.slice();
      allPD(kp, kd);
      // per-joint torque clamp (hip / thigh 23.7, calf 45 N·m): move the target so kp(q*−q) − kd·dq stays inside
      for (let i = 0; i < 12; i++) {
        const lim = i % 3 === 2 ? 45 : 23.7, tau = kp * (t[i] - st.q[i]) - kd * st.dq[i];
        if (tau > lim) t[i] = st.q[i] + (kd * st.dq[i] + lim) / kp;
        else if (tau < -lim) t[i] = st.q[i] + (kd * st.dq[i] - lim) / kp;
      }
      this.held = t;
    };
    const recover = (from: number, len: number, tgt: Float64Array) => {
      if (!this.q1) this.q1 = Float64Array.from(st.q);
      this.held = this.blend(Math.min((this.k - from) / len, 1), tgt, this.q1); allPD(100, 5);
    };
    if (!x3) {
      if (this.k < 53) await nn(20, 1.4);
      else if (this.k < 62) { this.held = TUCK; allPD(50, 5); }
      else if (this.k < 80) { if (this.flag) { this.held = P740; allPD(50, 5); } }
      else if (this.k < 105) recover(80, 25, REC);
      else this.done2 = true;
    } else {
      if (this.k < 54) await nn(20, 1.2);
      else if (this.k < 82) await nn(25, 1.1);
      else if (this.k < 92) { this.held = TUCK; allPD(50, 5); }
      else if (this.k < 115) { this.held = P692; this.kp = Float64Array.from([50, 50, 50, 50, 50, 50, 15, 15, 15, 15, 15, 15]); this.kd.fill(5); }
      else if (this.k < 140) recover(115, 25, P740);
      else this.done2 = true;
    }
    // "Continuous Flip finished": the state machine parks in 13 / 15 holding this command (the web: Start → FreeWalk)
    return this.held;
  }
  private done2 = false;
}

/** Build the driver: the pack's checkpoint is role "main", `go2.aux_models` the other roles. */
export async function makeGo2FwDriver(cfg: EvalConfig, spec: RobotSpec, eng: Engine): Promise<BaseDriver> {
  const assets = selectedDriverAssets(cfg);
  const nets: Record<string, OnnxSession> = { main: await OnnxSession.load(assets.policy) };
  for (const [role, url] of Object.entries(assets.models))
    nets[role] = await OnnxSession.load(url);
  return new Go2FwDriver(cfg, spec, eng, nets);
}
