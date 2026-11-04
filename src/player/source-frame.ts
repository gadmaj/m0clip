/** Conversion between the app's MuJoCo frame (metres, map turned by -spawn_yaw about +Z around the
 * spawn) and Source world space (inches, original map axes). Matches scripts/import_source_bsp.py:
 * app = Rz(-yaw)·(source - origin)·INCH, so source = Rz(+yaw)·app/INCH + origin. */
import type { SourceFrame } from './types';

/** Metres per Source unit. */
export const INCH = 0.0254;

type Vec3Out = { [index: number]: number };

let cachedFrame: SourceFrame | null = null, cachedCos = 1, cachedSin = 0;

/** Frames are immutable; cache the last one's yaw so per-tick conversions skip trig. */
function rotation(frame: SourceFrame): void {
  if (frame === cachedFrame) return;
  const yaw = frame.yawDeg*Math.PI/180;
  cachedCos = Math.cos(yaw);
  cachedSin = Math.sin(yaw);
  cachedFrame = frame;
}

/** App point (metres) to Source point (inches). `out` may alias `p`. */
export function appToSourcePoint<T extends Vec3Out>(frame: SourceFrame, p: ArrayLike<number>, out: T): T {
  rotation(frame);
  const x = p[0]/INCH, y = p[1]/INCH, z = p[2]/INCH, o = frame.origin;
  out[0] = cachedCos*x - cachedSin*y + o[0];
  out[1] = cachedSin*x + cachedCos*y + o[1];
  out[2] = z + o[2];
  return out;
}

/** Source point (inches) to app point (metres). `out` may alias `p`. */
export function sourceToAppPoint<T extends Vec3Out>(frame: SourceFrame, p: ArrayLike<number>, out: T): T {
  rotation(frame);
  const o = frame.origin, x = p[0] - o[0], y = p[1] - o[1], z = p[2] - o[2];
  out[0] = (cachedCos*x + cachedSin*y)*INCH;
  out[1] = (cachedCos*y - cachedSin*x)*INCH;
  out[2] = z*INCH;
  return out;
}

/** App direction to Source direction: rotation only, no unit scaling. `out` may alias `v`. */
export function appToSourceDirection<T extends Vec3Out>(frame: SourceFrame, v: ArrayLike<number>, out: T): T {
  rotation(frame);
  const x = v[0], y = v[1];
  out[0] = cachedCos*x - cachedSin*y;
  out[1] = cachedSin*x + cachedCos*y;
  out[2] = v[2];
  return out;
}

/** Source direction to app direction: rotation only, no unit scaling. `out` may alias `v`. */
export function sourceToAppDirection<T extends Vec3Out>(frame: SourceFrame, v: ArrayLike<number>, out: T): T {
  rotation(frame);
  const x = v[0], y = v[1];
  out[0] = cachedCos*x + cachedSin*y;
  out[1] = cachedCos*y - cachedSin*x;
  out[2] = v[2];
  return out;
}
