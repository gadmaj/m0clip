/** ai_sport 1.5.4 FSM 1001 "WjcGetup" — BeyondMimic-style get-up tracker (tangqi_{faceup,facedown}_23dof).
 *
 * Measured on the EDU bench (MNN I/O + rt/lowstate/lowcmd capture of 1001 from damping on the floor,
 * captures_154/probe2/1001.*); the policy output was replayed from the reconstructed obs to 3e-5.
 *
 * Sequence (50 Hz ticks):
 *  1. interp  — `start_frames` (300) ticks: target = q_now + s·(ref0 − q_now), s = n/300, where ref0 is the
 *               first row of the reference csv (joints the net does not drive → default = 0). Then
 *               `hold_frames` (50) ticks holding ref0. Same kp/kd as the policy. No network runs.
 *  2. policy  — row r = 0,1,2,… of the reference csv (one row per tick). obs 121 =
 *               [ref joint_pos(23), ref joint_vel(23), projected_gravity(3), base_ang_vel(3, raw),
 *                q − default(23), dq(23, raw), last_action(23, raw)], all joint terms in the net's
 *               (IsaacLab) order `action_joint_idx`. target[action_joint_idx] = default + a·action_scale,
 *               no clipping; the 6 undriven joints (waist roll/pitch, wrist pitch/yaw) sit at default (0).
 *               The firmware feeds only the obs input (time_step is left unset; the actions do not depend
 *               on it — the csv rows are the net's embedded motion); we feed the row anyway.
 *  3. stand   — the firmware hands over to FSM 802 once r passes len − `end_frames` (30). The web has no
 *               hand-over inside one driver: we keep running the policy with the reference frozen on its
 *               last row (standing, zero velocity) — holding the last PD target alone falls in ~1 s.
 *
 * Face-up vs face-down: picked from the projected gravity when the FSM starts (x < 0 → lying on the back →
 * faceup net). The facedown net is `aux.facedown`; the two csvs come in `files`
 * (faceup_motion / facedown_motion — roles must differ from the aux net roles: the pack importer merges both maps).
 * csv columns: [root quat wxyz(4), joint_pos(23), joint_vel(23), root pos(3)].
 */
import { matFromWxyz, matTVec } from "../math";
import type { Command, EvalConfig, RobotSpec } from "../types";
import type { Engine } from "../../sim/engine";
import type { OnnxSession } from "../policy";
import { BaseDriver } from "./base";
import { fetchAsset } from '../prepared-assets';

/** Firmware `action_joint_idx_23dof`: net slot i drives Unitree joint AJ[i]. */
const AJ_23 = [0, 6, 12, 1, 7, 15, 22, 2, 8, 16, 23, 3, 9, 17, 24, 4, 10, 18, 25, 5, 11, 19, 26];

async function loadMotion(url: string, na: number): Promise<Float32Array[]> {
  const txt = await fetchAsset(url).then((r) => {
    if (!r.ok) throw new Error(`failed to fetch ${url}: ${r.status}`);
    return r.text();
  });
  const rows = txt.split(/\r?\n/).filter((l) => l.trim().length)
    .map((l) => Float32Array.from(l.split(",").map(Number)));
  if (!rows.length || rows[0].length < 4 + 2 * na) throw new Error(`bad motion csv ${url}`);
  return rows;
}

export class G1GetupDriver extends BaseDriver {
  private readonly aj: Int32Array;
  private readonly aScale: Float64Array;       // per net slot
  private readonly startFrames: number;
  private readonly holdFrames: number;
  private readonly endFrames: number;
  private readonly spawnMode: string;
  private readonly initPose: Float64Array;
  private readonly motions: Partial<Record<string, Promise<Float32Array[]>>> = {};

  private tick = 0;
  private row = 0;
  private side: "faceup" | "facedown" | null = null;
  private lastRaw: Float32Array;
  /** interp | policy | stand — for the UI / test harness */
  phase = "interp";

  constructor(cfg: EvalConfig, spec: RobotSpec, eng: Engine, readonly sess: OnnxSession,
              readonly aux: Record<string, OnnxSession>, readonly files: Record<string, string>) {
    super(cfg, spec, eng);
    const g = cfg.g1!;
    this.aj = Int32Array.from(g.action_joint_idx ?? AJ_23);
    const na = this.aj.length;
    this.default = Float64Array.from(g.default_dof_pos);
    const asc = g.action_scale;
    this.aScale = new Float64Array(na);
    for (let i = 0; i < na; i++) {
      if (typeof asc === "number") this.aScale[i] = asc;
      else this.aScale[i] = asc.length === na ? asc[i] : asc[this.aj[i]];
    }
    this.kp = Float64Array.from(g.kp ?? Array(this.n).fill(40));
    this.kd = Float64Array.from(g.kd ?? Array(this.n).fill(2));
    this.lim = Float64Array.from(g.tau ?? spec.torque_limit ?? Array(this.n).fill(100));
    this.startFrames = g.start_frames ?? 300;
    this.holdFrames = g.hold_frames ?? 50;
    this.endFrames = g.end_frames ?? 30;
    this.spawnMode = g.ground_start ?? "face_up";
    this.initPose = Float64Array.from(g.init_pose ?? g.default_dof_pos);
    this.groundStart = true;
    this.maneuver = true;
    this.needsCommand = false;
    this.lastRaw = new Float32Array(na);
    this.lastAction = new Float32Array(na);
    this.actJointNames = Array.from(this.aj, (i) => this.names[i]);
    this.frameLayout = [
      ["ref_joint_pos", na], ["ref_joint_vel", na], ["projected_gravity", 3], ["base_ang_vel", 3],
      ["joint_pos", na], ["joint_vel", na], ["last_action", na],
    ];
    this.lastFrame = new Float32Array(5 * na + 6);
    for (const side of ["faceup", "facedown"]) {
      const url = files[`${side}_motion`];
      if (!url) continue;
      this.motions[side] = loadMotion(url, na);
      this.motions[side]!.catch(() => undefined);   // surfaced on first use
    }
  }

  async prepare(): Promise<void> {
    // Both sides start downloading in the constructor; the chosen side still
    // surfaces its own error on first use, as before.
    await Promise.allSettled(Object.values(this.motions));
  }

  override reset() {
    const s = Math.SQRT1_2;
    // face_up: the attitude the bench G1 settled in after being dropped in damping (lowstate at 1001 entry)
    const quat = this.spawnMode === "face_down" ? [s, 0, s, 0] : [0.479, 0, -0.878, 0];
    const nq = Math.hypot(...quat);
    const all = Array.from({ length: this.eng.model.nbody }, (_, i) => i).filter((i) => i !== 0);
    this.seat(this.initPose, quat.map((v) => v / nq), all, 0.02);
    this.tick = 0;
    this.row = 0;
    this.side = null;
    this.phase = "interp";
    this.done = false;
    this.lastRaw = new Float32Array(this.aj.length);
    this.lastAction = new Float32Array(this.aj.length);
  }

  private gravity(): [number, number, number] {
    return matTVec(matFromWxyz(this.baseQuat()), [0, 0, -1]);
  }

  async step(_command: Command): Promise<Float64Array> {
    if (!this.side) {
      const want = this.gravity()[0] < 0 ? "faceup" : "facedown";
      // fall back to the face-up net if the pack lacks the face-down one
      this.side = want === "facedown" && this.aux.facedown && this.motions.facedown ? "facedown" : "faceup";
    }
    const side = this.side;
    const pending = this.motions[side];
    if (!pending) throw new Error(`${this.name}: missing ${side} motion csv (g1.aux_files.${side}_motion)`);
    const rows = await pending;
    const na = this.aj.length;
    const [q, dq] = this.readQ();
    const target = Float64Array.from(this.default);
    const t = this.tick++;

    if (t < this.startFrames + this.holdFrames) {
      // 1. move from wherever the robot lies to the first reference frame
      this.phase = "interp";
      const ref0 = Float64Array.from(this.default);
      for (let i = 0; i < na; i++) ref0[this.aj[i]] = rows[0][4 + i];
      const s = Math.min(1, (t + 1) / this.startFrames);
      for (let i = 0; i < this.n; i++) target[i] = q[i] + s * (ref0[i] - q[i]);
      return target;
    }

    // 2. track the reference; 3. frozen on its last row past the firmware's hand-over point
    const r = Math.min(this.row, rows.length - 1);
    this.phase = this.row <= rows.length - this.endFrames ? "policy" : "stand";
    // the firmware hands over to g1.next_policy (802) here; the worker does it if that pack is imported,
    // otherwise this driver keeps standing on the frozen last row
    if (this.phase === "stand") this.done = true;
    const ref = rows[r];
    const g = this.gravity();
    const w = this.baseAngVel();
    const obs = new Float32Array(5 * na + 6);
    let o = 0;
    for (let i = 0; i < na; i++) obs[o++] = ref[4 + i];
    for (let i = 0; i < na; i++) obs[o++] = ref[4 + na + i];
    for (let i = 0; i < 3; i++) obs[o++] = g[i];
    for (let i = 0; i < 3; i++) obs[o++] = w[i];
    for (let i = 0; i < na; i++) obs[o++] = q[this.aj[i]] - this.default[this.aj[i]];
    for (let i = 0; i < na; i++) obs[o++] = dq[this.aj[i]];
    for (let i = 0; i < na; i++) obs[o++] = this.lastRaw[i];

    const net = side === "facedown" ? this.aux.facedown : this.sess;
    const act = await net.run({
      obs: { data: obs, dims: [1, obs.length] },
      time_step: { data: new Float32Array([r]), dims: [1, 1] },
    });
    this.lastRaw = Float32Array.from(act.subarray(0, na));
    this.lastFrame = obs;
    this.lastAction = this.lastRaw;
    for (let i = 0; i < na; i++) target[this.aj[i]] = this.default[this.aj[i]] + act[i] * this.aScale[i];
    this.row++;
    return target;
  }
}
