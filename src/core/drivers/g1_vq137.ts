/** 137-dim cmd of the ai_sport 1.5.4 "task" VQ decoders (FSM 503 on G1 Air, FSM 550 HumanMimicGlobal),
 * decoded from the `humanoid` binary (fsm_human_mimic.cpp sub_4C68B0 / sub_4BBBE0 / sub_4BB8D0 / sub_4C45C0,
 * fsm_human_mimic_global.cpp sub_4E16C0 / sub_4D4E50 / sub_4DFC10):
 *
 *   cmd = [latent(128), e_x, e_y, e_z, rot6d(6)]
 *
 * The motion CSVs have 135 columns: latent(128) | root pos xyz (3) | root quat wxyz (4); rows are fed raw
 * (the decoder adds its residual to the latent and L2-normalises internally).
 *  - At the start of a motion the reference is aligned to the robot: origin = robot xy, p0 = ref pos,
 *    q_off = yaw-only part of q_robot * q_ref^-1.
 *  - e = Rz(-yaw_robot) (q_off (p_ref - p0) + origin - p_robot), z zeroed, clipped to +-max_root_pos_error,
 *    zeroed when both |e_x|, |e_y| <= min_root_pos_error (550) or when the motion masks the root position
 *    (mask_root_pos / mask_root_pos_error - every Air dance and most 550 motions).
 *  - rot6d = [R00, R01, R10, R11, R20, R21] of q_off q_ref q_robot^-1 (w >= 0). Verified on the Air 503 bench
 *    capture (503air_d1: mean |err| 0.009 over the dance; stance aligned at FSM entry: 0.004).
 *  - 550 takes its robot pose from DDS rt/state_estimator/fusion_odom (state_estimator: learned leg odometry fused
 *    with the lidar SLAM pose). On the bench there is no SLAM, fusion_odom is never published ("No Odometry Data
 *    Recieved") and the captured task terms are ~identity (root pos error 0, rot6d within ~0.03 of identity).
 *    The sim uses its ground-truth base pose as the odometry (`motion_task: odom`, the 550 default); in the MuJoCo
 *    reference this cuts the mean yaw error vs the aligned reference from 7-87 deg to 1-4 deg with no extra falls.
 *    `motion_task: identity` reproduces the bench behaviour without SLAM.
 *    Bench-validated with a fake SLAM pose (plant truth -> rt/unitree_slam/high_rate_odometry + the app's 1004
 *    initial-pose command, workbench tools/ai_sport_probe/fake_slam): with fusion_odom live, rot6d with
 *    q_robot = fusion_odom matches the captured cmd to median 0.007-0.012 (vs 0.15-0.25 with the IMU quaternion).
 * Motions play CSV rows [time_start * fps, time_end * fps] one per 50 Hz tick (no resampling, bench-verified for
 * 25 and 50 fps); the Air then blends the whole 135-col row back to the stance row over transit_length (25 ticks,
 * a = 1 - k/25) and exits to 801; 550 exits to 802 right after the last row.
 */

export type Quat = [number, number, number, number];   // wxyz

export function qmul(a: ArrayLike<number>, b: ArrayLike<number>): Quat {
  const [w1, x1, y1, z1] = [a[0], a[1], a[2], a[3]], [w2, x2, y2, z2] = [b[0], b[1], b[2], b[3]];
  return [w1 * w2 - x1 * x2 - y1 * y2 - z1 * z2, w1 * x2 + x1 * w2 + y1 * z2 - z1 * y2,
          w1 * y2 - x1 * z2 + y1 * w2 + z1 * x2, w1 * z2 + x1 * y2 - y1 * x2 + z1 * w2];
}
export function qconj(q: ArrayLike<number>): Quat { return [q[0], -q[1], -q[2], -q[3]]; }
export function qnorm(q: ArrayLike<number>): Quat {
  const n = Math.hypot(q[0], q[1], q[2], q[3]) || 1;
  return [q[0] / n, q[1] / n, q[2] / n, q[3] / n];
}
export function qyaw(q: ArrayLike<number>): number {
  const [w, x, y, z] = [q[0], q[1], q[2], q[3]];
  return Math.atan2(2 * (w * z + x * y), 1 - 2 * (y * y + z * z));
}
export function yawQuat(a: number): Quat { return [Math.cos(a / 2), 0, 0, Math.sin(a / 2)]; }
export function qrot(q: ArrayLike<number>, v: ArrayLike<number>): [number, number, number] {
  const r = qmul(qmul(q, [0, v[0], v[1], v[2]]), qconj(q));
  return [r[1], r[2], r[3]];
}

export interface Task137Opts {
  maxErr: number;      // max_root_pos_error
  minErr: number;      // min_root_pos_error (dead zone, 550 only)
  latentDim?: number;  // 128 (503 Air / 550) or 64 (505 punch: cmd 73)
}

/** Reference-to-robot alignment + the 9-dim task part of the cmd. */
export class Task137 {
  origin = [0, 0];
  p0 = [0, 0, 0];
  qoff: Quat = [1, 0, 0, 0];
  readonly L: number;
  constructor(readonly o: Task137Opts) { this.L = o.latentDim ?? 128; }

  align(pRobot: ArrayLike<number>, qRobot: ArrayLike<number>, row: ArrayLike<number>) {
    const L = this.L;
    this.origin = [pRobot[0], pRobot[1]];
    this.p0 = [row[L], row[L + 1], row[L + 2]];
    const qref = qnorm([row[L + 3], row[L + 4], row[L + 5], row[L + 6]]);
    this.qoff = yawQuat(qyaw(qmul(qRobot, qconj(qref))));
  }

  /** writes the 9 task values at out[off..off+9) */
  fill(out: Float32Array, off: number, pRobot: ArrayLike<number>, qRobot: ArrayLike<number>,
       row: ArrayLike<number> | null, maskPos: boolean) {
    if (!row) { out.set([0, 0, 0, 1, 0, 0, 1, 0, 0], off); return; }
    const L = this.L;
    let ex = 0, ey = 0;
    if (!maskPos) {
      const d = qrot(this.qoff, [row[L] - this.p0[0], row[L + 1] - this.p0[1], row[L + 2] - this.p0[2]]);
      const px = d[0] + this.origin[0] - pRobot[0], py = d[1] + this.origin[1] - pRobot[1];
      const y = qyaw(qRobot), c = Math.cos(y), s = Math.sin(y);
      const m = this.o.maxErr;
      ex = Math.max(-m, Math.min(m, c * px + s * py));
      ey = Math.max(-m, Math.min(m, -s * px + c * py));
      if (Math.abs(ex) <= this.o.minErr && Math.abs(ey) <= this.o.minErr) { ex = 0; ey = 0; }
    }
    const qref = qnorm([row[L + 3], row[L + 4], row[L + 5], row[L + 6]]);
    let q = qnorm(qmul(qmul(this.qoff, qref), qconj(qRobot)));
    if (q[0] < 0) q = [-q[0], -q[1], -q[2], -q[3]];
    const [w, x, y, z] = q;
    out.set([ex, ey, 0,
             1 - 2 * (y * y + z * z), 2 * (x * y - w * z),
             2 * (x * y + w * z), 1 - 2 * (x * x + z * z),
             2 * (x * z - w * y), 2 * (y * z + w * x)], off);
  }
}

/** Parse a CSV into raw rows (no normalisation). */
export async function loadRows(url: string): Promise<Float32Array[]> {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`failed to fetch ${url}: ${r.status}`);
  const rows: Float32Array[] = [];
  for (const line of (await r.text()).split("\n")) {
    if (!line.trim()) continue;
    rows.push(Float32Array.from(line.split(",").map(Number)));
  }
  return rows;
}

/** Rows of one motion: CSV rows round(start * fps) .. round(end * fps) inclusive (end <= 0: to the last row),
 * one row per 50 Hz tick whatever the motion fps (bench: a 25 fps motion plays its rows at 50 Hz). */
export function resample(rows: Float32Array[], start: number, end: number, fps: number): Float32Array[] {
  const last = rows.length - 1;
  const i0 = Math.max(0, Math.min(last, Math.round(start * fps)));
  const i1 = end > 0 ? Math.max(i0, Math.min(last, Math.round(end * fps))) : last;
  return rows.slice(i0, i1 + 1);
}
