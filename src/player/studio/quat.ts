/** Quaternion helpers with Source mathlib semantics (alignment before blending, the scaled-angle
 * QuaternionScale, the perpendicular fallback of slerp). Quaternions are (x, y, z, w) at an offset
 * in a flat array; every helper writes its result into `out` at `o` and allocates nothing. Inputs
 * are read before `out` is written, so `out` may alias either input. */

type Quats = Float32Array | Float64Array;

/** Writes q, or -q when -q is closer to p (QuaternionAlign). */
export function quatAlign(out: Quats, o: number, p: Quats, pi: number, q: Quats, qi: number): void {
  const px = p[pi], py = p[pi + 1], pz = p[pi + 2], pw = p[pi + 3];
  const qx = q[qi], qy = q[qi + 1], qz = q[qi + 2], qw = q[qi + 3];
  const a = (px - qx)**2 + (py - qy)**2 + (pz - qz)**2 + (pw - qw)**2;
  const b = (px + qx)**2 + (py + qy)**2 + (pz + qz)**2 + (pw + qw)**2;
  const sign = a > b ? -1 : 1;
  out[o] = qx*sign; out[o + 1] = qy*sign; out[o + 2] = qz*sign; out[o + 3] = qw*sign;
}

export function quatNormalize(q: Quats, o: number): void {
  const len = Math.hypot(q[o], q[o + 1], q[o + 2], q[o + 3]);
  if (len === 0) return;
  const inv = 1/len;
  q[o] *= inv; q[o + 1] *= inv; q[o + 2] *= inv; q[o + 3] *= inv;
}

/** Normalized linear blend from p (t = 0) to q (t = 1); `align` false skips aligning q to p
 * (QuaternionBlend / QuaternionBlendNoAlign). */
export function quatBlend(out: Quats, o: number, p: Quats, pi: number, q: Quats, qi: number, t: number, align: boolean): void {
  const px = p[pi], py = p[pi + 1], pz = p[pi + 2], pw = p[pi + 3];
  let qx = q[qi], qy = q[qi + 1], qz = q[qi + 2], qw = q[qi + 3];
  if (align && (px - qx)**2 + (py - qy)**2 + (pz - qz)**2 + (pw - qw)**2 > (px + qx)**2 + (py + qy)**2 + (pz + qz)**2 + (pw + qw)**2) {
    qx = -qx; qy = -qy; qz = -qz; qw = -qw;
  }
  const sp = 1 - t;
  out[o] = sp*px + t*qx; out[o + 1] = sp*py + t*qy; out[o + 2] = sp*pz + t*qz; out[o + 3] = sp*pw + t*qw;
  quatNormalize(out, o);
}

/** Spherical blend from p to q (QuaternionSlerp, or QuaternionSlerpNoAlign when align is false). */
export function quatSlerp(out: Quats, o: number, p: Quats, pi: number, q: Quats, qi: number, t: number, align: boolean): void {
  const px = p[pi], py = p[pi + 1], pz = p[pi + 2], pw = p[pi + 3];
  let qx = q[qi], qy = q[qi + 1], qz = q[qi + 2], qw = q[qi + 3];
  if (align && (px - qx)**2 + (py - qy)**2 + (pz - qz)**2 + (pw - qw)**2 > (px + qx)**2 + (py + qy)**2 + (pz + qz)**2 + (pw + qw)**2) {
    qx = -qx; qy = -qy; qz = -qz; qw = -qw;
  }
  const cos = px*qx + py*qy + pz*qz + pw*qw;
  if (1 + cos > 1e-6) {
    let sp: number, sq: number;
    if (1 - cos > 1e-6) {
      const omega = Math.acos(cos), sin = Math.sin(omega);
      sp = Math.sin((1 - t)*omega)/sin;
      sq = Math.sin(t*omega)/sin;
    } else {
      sp = 1 - t;
      sq = t;
    }
    out[o] = sp*px + sq*qx; out[o + 1] = sp*py + sq*qy; out[o + 2] = sp*pz + sq*qz; out[o + 3] = sp*pw + sq*qw;
  } else {
    // Opposite rotations: Source swings through the perpendicular (-q.y, q.x, -q.w, q.z).
    const sp = Math.sin((1 - t)*Math.PI*0.5), sq = Math.sin(t*Math.PI*0.5);
    out[o] = sp*px - sq*qy; out[o + 1] = sp*py + sq*qx; out[o + 2] = sp*pz - sq*qw; out[o + 3] = qz;
  }
}

/** Hamilton product p*q with q first aligned to p (QuaternionMult). */
export function quatMultiply(out: Quats, o: number, p: Quats, pi: number, q: Quats, qi: number): void {
  const px = p[pi], py = p[pi + 1], pz = p[pi + 2], pw = p[pi + 3];
  let qx = q[qi], qy = q[qi + 1], qz = q[qi + 2], qw = q[qi + 3];
  if ((px - qx)**2 + (py - qy)**2 + (pz - qz)**2 + (pw - qw)**2 > (px + qx)**2 + (py + qy)**2 + (pz + qz)**2 + (pw + qw)**2) {
    qx = -qx; qy = -qy; qz = -qz; qw = -qw;
  }
  out[o] = px*qw + py*qz - pz*qy + pw*qx;
  out[o + 1] = -px*qz + py*qw + pz*qx + pw*qy;
  out[o + 2] = px*qy - py*qx + pz*qw + pw*qz;
  out[o + 3] = -px*qx - py*qy - pz*qz + pw*qw;
}

/** Rotation angle scaled by t, axis kept (QuaternionScale). */
export function quatScale(out: Quats, o: number, p: Quats, pi: number, t: number): void {
  const px = p[pi], py = p[pi + 1], pz = p[pi + 2], pw = p[pi + 3];
  const sinHalf = Math.min(Math.hypot(px, py, pz), 1);
  const sinScaled = Math.sin(Math.asin(sinHalf)*t);
  const k = sinScaled/(sinHalf + 1.1920928955078125e-7);
  const w = Math.sqrt(Math.max(0, 1 - sinScaled*sinScaled));
  out[o] = px*k; out[o + 1] = py*k; out[o + 2] = pz*k; out[o + 3] = pw < 0 ? -w : w;
}

const scaled = new Float64Array(4);

/** (s*p)*q, normalized (QuaternionSM). */
export function quatScaleMultiply(out: Quats, o: number, s: number, p: Quats, pi: number, q: Quats, qi: number): void {
  quatScale(scaled, 0, p, pi, s);
  quatMultiply(out, o, scaled, 0, q, qi);
  quatNormalize(out, o);
}

/** p*(s*q), normalized (QuaternionMA). */
export function quatMultiplyScaled(out: Quats, o: number, p: Quats, pi: number, s: number, q: Quats, qi: number): void {
  quatScale(scaled, 0, q, qi, s);
  quatMultiply(out, o, p, pi, scaled, 0);
  quatNormalize(out, o);
}

/** Moves p toward identity by t (QuaternionIdentityBlend). */
export function quatIdentityBlend(out: Quats, o: number, p: Quats, pi: number, t: number): void {
  const k = 1 - t, pw = p[pi + 3];
  out[o] = p[pi]*k; out[o + 1] = p[pi + 1]*k; out[o + 2] = p[pi + 2]*k;
  out[o + 3] = pw < 0 ? pw*k - t : pw*k + t;
  quatNormalize(out, o);
}

/** RadianEuler (roll about X, pitch about Y, yaw about Z) to quaternion (AngleQuaternion). The
 * formula matches the MIT noclip Studio reader (LICENSE.noclip). */
export function quatFromRadianEuler(out: Quats, o: number, roll: number, pitch: number, yaw: number): void {
  const sr = Math.sin(roll*0.5), cr = Math.cos(roll*0.5);
  const sp = Math.sin(pitch*0.5), cp = Math.cos(pitch*0.5);
  const sy = Math.sin(yaw*0.5), cy = Math.cos(yaw*0.5);
  out[o] = sr*cp*cy - cr*sp*sy;
  out[o + 1] = cr*sp*cy + sr*cp*sy;
  out[o + 2] = cr*cp*sy - sr*sp*cy;
  out[o + 3] = cr*cp*cy + sr*sp*sy;
}
