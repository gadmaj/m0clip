/** Small math helpers shared by the drivers.
 * The rot6d convention
 * and quat orders are load-bearing; a policy falls in ~0.5 s if they're wrong.
 * Matrices are number[9], row-major.
 */

export type Vec3 = [number, number, number];

/** 3x3 rotation (row-major, length 9) from an xyzw quaternion. */
export function quatToMatXyzw(q: ArrayLike<number>): Float64Array {
  const n = Math.hypot(q[0], q[1], q[2], q[3]) || 1;
  const x = q[0] / n, y = q[1] / n, z = q[2] / n, w = q[3] / n;
  return new Float64Array([
    1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w),
    2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w),
    2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y),
  ]);
}

/** 3x3 rotation from a wxyz quaternion (MuJoCo order). */
export function matFromWxyz(q: ArrayLike<number>): Float64Array {
  return quatToMatXyzw([q[1], q[2], q[3], q[0]]);
}

/** xyzw (trajectory CSV order) -> wxyz (MuJoCo order). */
export function wxyz(qXyzw: ArrayLike<number>): [number, number, number, number] {
  return [qXyzw[3], qXyzw[0], qXyzw[1], qXyzw[2]];
}

/** R^T @ v for row-major R. */
export function matTVec(R: ArrayLike<number>, v: ArrayLike<number>): Vec3 {
  return [
    R[0] * v[0] + R[3] * v[1] + R[6] * v[2],
    R[1] * v[0] + R[4] * v[1] + R[7] * v[2],
    R[2] * v[0] + R[5] * v[1] + R[8] * v[2],
  ];
}

/** First two columns, ROW-interleaved [m00,m01,m10,m11,m20,m21] — the
 * IsaacLab / BeyondMimic convention (NOT column-major flattening). */
export function rot6d(R: ArrayLike<number>): Float64Array {
  return new Float64Array([R[0], R[1], R[3], R[4], R[6], R[7]]);
}

/** Linear-interpolate a reference-motion row at time t; renormalize the quat.
 * Row layout: [base_pos(3), base_quat_xyzw(4), joint_pos(nCols-7)].
 * traj is a flat Float32Array of shape [nRows, nCols]. */
export function sampleTraj(traj: Float32Array, nRows: number, nCols: number,
                           t: number, fps: number): Float64Array {
  const f = t * fps;
  const i0 = Math.min(Math.floor(f), nRows - 1);
  const i1 = Math.min(i0 + 1, nRows - 1);
  const a = f - i0;
  const row = new Float64Array(nCols);
  for (let c = 0; c < nCols; c++)
    row[c] = (1 - a) * traj[i0 * nCols + c] + a * traj[i1 * nCols + c];
  const qn = Math.hypot(row[3], row[4], row[5], row[6]) || 1;
  row[3] /= qn; row[4] /= qn; row[5] /= qn; row[6] /= qn;
  return row;
}

export function clip(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/** Concatenate float arrays into one Float32Array. */
export function concatF32(parts: ArrayLike<number>[]): Float32Array {
  let n = 0;
  for (const p of parts) n += p.length;
  const out = new Float32Array(n);
  let o = 0;
  for (const p of parts) { out.set(p as Float32Array, o); o += p.length; }
  return out;
}
