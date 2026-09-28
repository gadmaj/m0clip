/** Unified per-step policy drivers for the interactive sim — TS port of the
 * reference Python implementation.
 *
 * A Driver wraps ONE policy so the FSM can run it, switch to it live, and
 * inspect its obs/action:
 *
 *     const drv = await makeDriver(cfg, spec, engine);
 *     drv.reset();                          // set the initial pose
 *     const target = await drv.step(cmd);   // -> model-order PD target
 *
 * The FSM applies a uniform PD law with drv.kp/kd (model order, full width);
 * joints the policy doesn't drive are held at drv.default. `step` is async
 * because onnxruntime-web inference is async.
 */
import type { Engine } from "../../sim/engine";
import type { Command, EvalConfig, RobotSpec, RemoteActionGroup } from "../types";

export abstract class BaseDriver {
  groundStart = false;      // starts lying on the floor (recovery / get-up)
  needsCommand = false;     // consumes the [vx,vy,wz] command
  clipDriven = false;       // plays a fixed reference clip
  maneuver = false;         // single-shot maneuver (jump, get-up, squat)
  /** Set when the robot's FSM would leave this policy (end of a clip / get-up). The worker then hands
   * over, keeping the robot's current state, to the config's `g1.next_policy` if that pack is imported
   * (ai_sport auto-switches e.g. 810/811/1001/706 -> 802). */
  done = false;
  /** The policy's own command clamp, [vx-,vx+,vy-,vy+,wz-,wz+] (config
   * `vel_range`). Set by command-driven drivers; the UI reads it through the
   * status message so the input limits can follow the policy — several packs
   * train well past ±1 m/s and a fixed stick scale would never reach them. */
  velRange?: number[];

  readonly name: string;
  readonly n: number;
  readonly names: string[];
  readonly bqp: number;     // base qpos address
  readonly bqv: number;     // base dof address
  readonly qadr: Int32Array;
  readonly vadr: Int32Array;
  lim: Float64Array;
  readonly exq: Int32Array; // hinges NOT in joint_names (held at neutral)
  readonly exv: Int32Array;
  readonly exKp: number;
  readonly exKd: number;
  readonly feet: number[];

  // inspector state (filled by step)
  frameLayout: [string, number][] = [];
  lastFrame: Float32Array = new Float32Array(0);
  lastAction: Float32Array;
  actJointNames: string[];
  stackDepth = 1;

  // PD gains + default, model order, full width — set by subclasses
  kp: Float64Array;
  kd: Float64Array;
  default: Float64Array;

  homeXY: [number, number] = [0, 0];

  constructor(readonly cfg: EvalConfig, readonly spec: RobotSpec, readonly eng: Engine) {
    this.name = cfg.name;
    this.names = spec.joint_names;
    this.n = this.names.length;
    this.bqp = eng.jointQposAdr(spec.floating_base_joint);
    this.bqv = eng.jointDofAdr(spec.floating_base_joint);
    // A spec slot whose joint the compiled model lacks (G1 Air: waist roll/pitch, wrist pitch/yaw on the
    // 23-DOF plant, while drivers keep the 29-slot G1 order) is left unbound: address -1, read as 0 (what
    // an absent motor reports), never written — see readQ / seat and the FSM's PD loop.
    const hinges = eng.hinges();
    const inModel = new Set(hinges.names);
    this.qadr = Int32Array.from(this.names.map((x) => (inModel.has(x) ? eng.jointQposAdr(x) : -1)));
    this.vadr = Int32Array.from(this.names.map((x) => (inModel.has(x) ? eng.jointDofAdr(x) : -1)));
    this.lim = spec.torque_limit
      ? Float64Array.from(spec.torque_limit)
      : Float64Array.from(this.names.map((x) => eng.actuatorLim(x)));
    const inSpec = new Set(this.names);
    const exq: number[] = [], exv: number[] = [];
    hinges.names.forEach((nm, i) => {
      if (!inSpec.has(nm)) { exq.push(hinges.qadr[i]); exv.push(hinges.vadr[i]); }
    });
    this.exq = Int32Array.from(exq); this.exv = Int32Array.from(exv);
    this.exKp = spec.extra_kp ?? 20.0;
    this.exKd = spec.extra_kd ?? 1.0;
    this.feet = spec.foot_bodies.map((b) => eng.bodyId(b));
    this.lastAction = new Float32Array(this.n);
    this.actJointNames = [...this.names];
    this.kp = new Float64Array(this.n);
    this.kd = new Float64Array(this.n);
    this.default = new Float64Array(this.n);
    this.pairs = (spec.ankle_pairs ?? []).flatMap(({ joints, m }) => {
      const a = this.names.indexOf(joints[0]), b = this.names.indexOf(joints[1]);
      if (a < 0 || b < 0 || this.vadr[a] < 0 || this.vadr[b] < 0) return [];
      const det = m[0] * m[3] - m[1] * m[2];
      return [{ a, b, m, mi: [m[3] / det, -m[1] / det, -m[2] / det, m[0] / det] }];
    });
  }

  /** motor-space ankle pairs (spec.ankle_pairs) resolved to slots; mi = m⁻¹ row-major (motor = mi · joint) */
  readonly pairs: { a: number; b: number; m: number[]; mi: number[] }[];

  /** PD torque of slots a, b of an ankle pair: joint-space stiffness, motor-space damping (RobotSpec.ankle_pairs).
   * Writes qfrc for both joints (clipped). */
  pairPD(qfrc: Float64Array, target: Float64Array) {
    const { eng } = this;
    for (const { a, b, m, mi } of this.pairs) {
      const va = this.vadr[a], vb = this.vadr[b];
      const kdA = this.kd[a] * m[0] * m[0] + this.kd[b] * m[2] * m[2];
      const kdB = this.kd[a] * m[1] * m[1] + this.kd[b] * m[3] * m[3];
      const dA = mi[0] * eng.qvel[va] + mi[1] * eng.qvel[vb], dB = mi[2] * eng.qvel[va] + mi[3] * eng.qvel[vb];
      const tA = kdA * dA, tB = kdB * dB;              // motor damping torques → joints via m⁻ᵀ
      const ta = this.kp[a] * (target[a] - eng.qpos[this.qadr[a]]) - (mi[0] * tA + mi[2] * tB);
      const tb = this.kp[b] * (target[b] - eng.qpos[this.qadr[b]]) - (mi[1] * tA + mi[3] * tB);
      qfrc[va] = Math.max(-this.lim[a], Math.min(this.lim[a], ta));
      qfrc[vb] = Math.max(-this.lim[b], Math.min(this.lim[b], tb));
    }
  }

  /** Place the base at home, set joints/quat, drop until the lowest geom of
   * `dropBodies` sits dropClearance above z=0, zero velocity. */
  protected seat(qposJoints: ArrayLike<number>, quatWxyz: ArrayLike<number>,
                 dropBodies: Iterable<number>, dropClearance = 0.02) {
    const { eng } = this;
    eng.qpos[this.bqp] = this.homeXY[0];
    eng.qpos[this.bqp + 1] = this.homeXY[1];
    for (let i = 0; i < this.n; i++) if (this.qadr[i] >= 0) eng.qpos[this.qadr[i]] = qposJoints[i];
    for (let i = 0; i < 4; i++) eng.qpos[this.bqp + 3 + i] = quatWxyz[i];
    eng.forward();
    const zmin = eng.minGeomZ(dropBodies);
    eng.qpos[this.bqp + 2] += dropClearance - zmin;
    eng.qvel.fill(0);
    eng.forward();
  }

  /** Default: seat standing at the default pose, feet on the floor. */
  reset() { this.seat(this.default, [1, 0, 0, 0], this.feet); }

  /** Teleport just the base back home, keep pose + policy running. */
  recenter() {
    const { eng } = this;
    eng.qpos[this.bqp] = this.homeXY[0];
    eng.qpos[this.bqp + 1] = this.homeXY[1];
    eng.qvel[this.bqv] = 0; eng.qvel[this.bqv + 1] = 0;
    eng.forward();
  }

  /** Hold uncontrolled hinges (Air's absent waist/wrists) near neutral. */
  holdExtras(qfrc: Float64Array) {
    const { eng } = this;
    for (let i = 0; i < this.exv.length; i++)
      qfrc[this.exv[i]] =
        this.exKp * (0 - eng.qpos[this.exq[i]]) - this.exKd * eng.qvel[this.exv[i]];
  }

  /** Read current joint pos/vel (model order). */
  protected readQ(): [Float64Array, Float64Array] {
    const q = new Float64Array(this.n), qd = new Float64Array(this.n);
    for (let i = 0; i < this.n; i++) {
      if (this.qadr[i] < 0) continue;              // joint absent from the model: reads 0
      q[i] = this.eng.qpos[this.qadr[i]];
      qd[i] = this.eng.qvel[this.vadr[i]];
    }
    return [q, qd];
  }

  protected baseQuat(): Float64Array {
    return this.eng.qpos.slice(this.bqp + 3, this.bqp + 7);
  }

  protected baseAngVel(): Float64Array {
    return this.eng.qvel.slice(this.bqv + 3, this.bqv + 6);
  }

  /** Remote-controller combos the policy reacts to (e.g. "R1+Up"), for the UI's trigger buttons and the
   * gamepad pass-through; empty for most policies. */
  remoteCombos(): string[] { return []; }

  /** Named, grouped controls for the running policy (config control_ui.actions), shown as panel buttons. */
  remoteActions(): RemoteActionGroup[] {
    // Only the controls a pack names in control_ui.actions: they act on the running policy. Switching to another
    // policy is done from the policy list, so raw firmware switch combos are not surfaced as buttons.
    const combos = this.remoteCombos();
    if (!combos.length) return [];
    return (this.cfg.control_ui?.actions ?? [])
      .map((g) => ({ group: g.group, items: g.items.filter((i) => combos.includes(i.combo)) }))
      .filter((g) => g.items.length);
  }

  /** A remote combo was pressed (see remoteCombos). */
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  remote(_combo: string): void {}

  /** Once per control step: inference → PD target (model order, full width). */
  abstract step(command: Command): Promise<Float64Array>;
}

