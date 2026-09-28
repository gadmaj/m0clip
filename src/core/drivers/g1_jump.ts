/** ai_sport 1.5.4 walk-jump mimics, FSM 813 FsmCpyWalkJump and FSM 900 FsmZjxWalkJump.
 *
 * Decoded from fsm_cpy_walk_jump.cpp.o / fsm_zjx_walk_jump.cpp.o (the 1.4.5 ai_sport build tree ships
 * them with symbols) and checked against the 1.5.4 binary (identical Run / UpdateRlState). Both play
 * the same JUMP_002_YY reference (a run-up and a ~2.3 m forward leap) and are only entered from 802;
 * when the clip counter passes `end` the FSM sets its done flag and the robot goes back to 802.
 *
 * Per 50 Hz tick: counter += 1 (it starts at `start`), then obs -> net -> target = default + a × 0.25.
 * On entry (InitRlState) the firmware builds one obs frame from the entry state (last action 0, counter
 * = start) and fills the whole history with it; the history is oldest first and ends with the current frame.
 *
 * 813 cpy (CpyMotionTrackingNet, 3 inputs):
 *   proprioception 93 = [raw gyro, projected gravity, q, raw dq, last raw action]   (motor order, q absolute)
 *   memory 5 × 93
 *   future_states 5 × 67: clip rows min(counter + 5 i, rows − 1), i = 0..4, each
 *     [projected gravity of the row's quat (xyzw), q 29, row[36:39], row[39:42], dq 29]  (clip = 71-col csv)
 *
 * 900 zjx (ZjxMotionTrackingNet, obs 3 × 201): frame 201 =
 *   [raw gyro, projected gravity,
 *    3 × (com_z, com_v 3, projected gravity of the ref quat, ref q − default 29)   rows counter .. counter+2,
 *    q − default 29, raw dq 29, last raw action 29]
 * with every 29-vector in IsaacLab order: slot i = motor client_joint_idx[i]; action i drives motor
 * client_joint_idx[i]. The clip csv here is [frames_gen_q 36 (pos, quat xyzw, q), frames_com_p 3, frames_com_v 3].
 */
import { concatF32, matFromWxyz, matTVec } from "../math";
import type { EvalConfig, RobotSpec } from "../types";
import type { Engine } from "../../sim/engine";
import { OnnxSession } from "../policy";
import { BaseDriver } from "./base";

interface JumpCfg {
  clip_start?: number;
  clip_end?: number;
  future_num?: number;
  future_interval?: number;
  client_joint_idx?: number[];
  /** joint pose the robot is seated in when the pack is picked (802's stance: the FSM is entered from 802) */
  init_pose?: number[];
}

/** projected gravity of an xyzw quaternion: R^T (0, 0, -1) */
function gravXyzw(x: number, y: number, z: number, w: number): [number, number, number] {
  return [-2 * (x * z - w * y), -2 * (y * z + w * x), -(1 - 2 * (x * x + y * y))];
}

export class G1JumpDriver extends BaseDriver {
  needsCommand = false;
  clipDriven = true;

  private readonly zjx: boolean;
  private readonly aScale: number;
  private readonly mem: number;
  private readonly start: number;
  private readonly end: number;
  private readonly nFut: number;
  private readonly itv: number;
  private readonly ci: Int32Array;         // net slot i <-> motor ci[i]
  private readonly initPose: Float64Array;
  private readonly nRows: number;

  private counter = 0;
  private last: Float32Array;
  private hist: Float32Array[] = [];

  constructor(cfg: EvalConfig, spec: RobotSpec, eng: Engine, readonly sess: OnnxSession,
              readonly clipData: Float32Array, readonly nCols: number) {
    super(cfg, spec, eng);
    const g = cfg.g1!;
    const j = g as unknown as JumpCfg;
    this.zjx = g.obs_scheme === "zjx_jump";
    this.default = Float64Array.from(g.default_dof_pos);
    this.aScale = typeof g.action_scale === "number" ? g.action_scale : (g.action_scale as number[])[0];
    this.mem = g.memory_size;
    this.start = j.clip_start ?? 0;
    this.nRows = Math.floor(clipData.length / nCols);
    this.end = j.clip_end ?? this.nRows - 1;
    this.nFut = j.future_num ?? 5;
    this.itv = j.future_interval ?? 5;
    this.ci = Int32Array.from(j.client_joint_idx ?? Array.from({ length: this.n }, (_, i) => i));
    this.initPose = Float64Array.from(j.init_pose ?? g.default_dof_pos);
    this.kp = Float64Array.from(g.kp!);
    this.kd = Float64Array.from(g.kd!);
    this.lim = Float64Array.from(g.tau ?? spec.torque_limit ?? Array(this.n).fill(100.0));
    this.actJointNames = Array.from(this.ci, (m) => this.names[m]);
    this.stackDepth = this.mem;
    this.last = new Float32Array(this.n);
    this.frameLayout = this.zjx
      ? [["base_ang_vel", 3], ["projected_gravity", 3], ["ref_frames", 108],
         ["joint_pos_rel", this.n], ["joint_vel", this.n], ["last_action", this.n]]
      : [["base_ang_vel", 3], ["projected_gravity", 3], ["joint_pos", this.n],
         ["joint_vel", this.n], ["last_action", this.n]];
  }

  override reset() {
    this.seat(this.initPose, [1, 0, 0, 0], this.feet, 0.001);
    this.hist = [];
    this.counter = this.start;
    this.done = false;
    this.last = new Float32Array(this.n);
    this.lastAction = new Float32Array(this.n);
  }

  private row(r: number): Float32Array {
    const k = Math.min(r, this.nRows - 1);
    return this.clipData.subarray(k * this.nCols, (k + 1) * this.nCols);
  }

  /** one obs frame at the current counter (proprioception for 813, the 201-dim frame for 900) */
  private frame(): Float32Array {
    const [q, qd] = this.readQ();
    const w = this.baseAngVel();
    const R = matFromWxyz(this.baseQuat());
    const g = matTVec(R, [0, 0, -1.0]);
    const n = this.n;
    if (!this.zjx) {
      const f = new Float32Array(6 + 3 * n);
      f.set(w, 0); f.set(g, 3);
      for (let i = 0; i < n; i++) { f[6 + i] = q[i]; f[6 + n + i] = qd[i]; f[6 + 2 * n + i] = this.last[i]; }
      return f;
    }
    const f = new Float32Array(6 + 3 * (7 + n) + 3 * n);
    f.set(w, 0); f.set(g, 3);
    let o = 6;
    for (let k = 0; k < 3; k++) {
      const r = this.row(this.counter + k);        // [gen_q 36, com_p 3, com_v 3]
      f[o++] = r[36 + 2];
      f[o++] = r[39]; f[o++] = r[40]; f[o++] = r[41];
      const rg = gravXyzw(r[3], r[4], r[5], r[6]);
      f[o++] = rg[0]; f[o++] = rg[1]; f[o++] = rg[2];
      for (let i = 0; i < n; i++) { const m = this.ci[i]; f[o++] = r[7 + m] - this.default[m]; }
    }
    for (let i = 0; i < n; i++) { const m = this.ci[i]; f[o + i] = q[m] - this.default[m]; }
    o += n;
    for (let i = 0; i < n; i++) f[o + i] = qd[this.ci[i]];
    o += n;
    f.set(this.last, o);
    return f;
  }

  /** 813 future_states: 5 × [ref gravity, q, row[36:42], dq] from rows counter + 5 i */
  private future(): Float32Array {
    const out = new Float32Array(this.nFut * 67);
    for (let i = 0; i < this.nFut; i++) {
      const r = this.row(this.counter + i * this.itv);
      const g = gravXyzw(r[3], r[4], r[5], r[6]);
      const o = i * 67;
      out[o] = g[0]; out[o + 1] = g[1]; out[o + 2] = g[2];
      out.set(r.subarray(7, 36), o + 3);
      out.set(r.subarray(36, 71), o + 32);
    }
    return out;
  }

  async step(): Promise<Float64Array> {
    if (!this.hist.length) {
      // InitRlState: the entry frame (counter = start, last action 0) fills the history
      const f0 = this.frame();
      this.hist = Array(this.mem).fill(f0);
    }
    this.counter++;
    const f = this.frame();
    this.hist = [...this.hist.slice(1), f];
    const memory = concatF32(this.hist);

    const act = this.zjx
      ? await this.sess.run({ obs: { data: memory, dims: [1, memory.length] } })
      : await this.sess.run({
          proprioception: { data: f, dims: [1, f.length] },
          memory: { data: memory, dims: [1, memory.length] },
          future_states: { data: this.future(), dims: [1, this.nFut * 67] },
        });
    this.last = Float32Array.from(act);
    this.lastFrame = f;
    this.lastAction = act;
    if (this.counter > this.end) this.done = true;

    const target = Float64Array.from(this.default);
    for (let i = 0; i < this.n; i++) {
      const m = this.ci[i];
      target[m] = this.default[m] + act[i] * this.aScale;
    }
    return target;
  }
}
