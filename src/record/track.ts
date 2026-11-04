/** Shared recorded-take tracks: the viewport camera, export ranges and the shot recipe. Robot and
 * Player takes both use them. */
import { Quaternion } from 'three';
import type { Shot } from './shot';

/** Non-destructive export bounds in original take seconds. */
export type TakeRange = [number, number];
export function validTakeRange(value: unknown, duration: number): value is TakeRange {
  return Array.isArray(value) && value.length === 2
    && typeof value[0] === 'number' && Number.isFinite(value[0])
    && typeof value[1] === 'number' && Number.isFinite(value[1])
    && Number.isFinite(duration) && 0 <= value[0] && value[0] < value[1] && value[1] <= duration;
}

/** The optional export-camera recipe is separate from immutable recorded camera tracks. */
export function validShotCamera(value:unknown):value is Shot {
  if(!value||typeof value!=='object'||Array.isArray(value))return false;
  const shot=value as Record<string,unknown>;
  if(!['viewport','follow','orbit','fixed'].includes(shot.mode as string))return false;
  for(const key of ['focal','sensor','distance','azimuth','elevation','height','orbitPeriod','smooth'])
    if(typeof shot[key]!=='number'||!Number.isFinite(shot[key]))return false;
  return (shot.focal as number)>=4&&(shot.sensor as number)>0&&(shot.distance as number)>0
    &&(shot.orbitPeriod as number)!==0&&(shot.smooth as number)>=0;
}

/** Per-frame layout of the camera track: position, look-at target, vertical fov (deg). */
export const CAM_STRIDE = 7;

export interface CamPose { pos: [number, number, number]; target: [number, number, number]; fov: number; orientation?:[number,number,number,number] }
export function cameraOrientationAt(track:ArrayLike<number>,i:number,j:number,f:number):[number,number,number,number] {
  return new Quaternion().fromArray(track,i*4).normalize().slerp(new Quaternion().fromArray(track,j*4).normalize(),f).toArray();
}

/** Bracketing frame and blend on a strictly increasing clock: t[i] ≤ time < t[i+1], f in [0, 1). */
export function locateTime(t: Float64Array, time: number): [number, number] {
  const n = t.length;
  if (n < 2 || time <= t[0]) return [0, 0];
  if (time >= t[n - 1]) return [n - 1, 0];
  let lo = 0, hi = n - 1;
  while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (t[mid] <= time) lo = mid; else hi = mid; }
  return [lo, (time - t[lo]) / (t[hi] - t[lo])];
}

/** Interpolated viewport camera from CAM_STRIDE and optional xyzw orientation tracks. */
export function cameraAt(t: Float64Array, cam: Float32Array, orientation: Float32Array | undefined, time: number): CamPose {
  const [i, f] = locateTime(t, time), j = Math.min(i + 1, t.length - 1);
  const a = i * CAM_STRIDE, b = j * CAM_STRIDE;
  const l = (k: number) => cam[a + k] + (cam[b + k] - cam[a + k]) * f;
  return { pos: [l(0), l(1), l(2)], target: [l(3), l(4), l(5)], fov: l(6),
    ...(orientation ? { orientation: cameraOrientationAt(orientation, i, j, f) } : {}) };
}
