/** Shot cameras for rendering a take: where the camera sits over time and what lens it has.
 *
 *   viewport  the camera the user drove while recording, replayed
 *   follow    a fixed offset (distance / azimuth / elevation) from the robot, tracking it
 *   orbit     follow, with the azimuth turning once per `orbitPeriod` seconds
 *   fixed     the follow offset frozen where the robot stood at the range start
 *
 * Azimuth is degrees counter-clockwise from +x seen from above (0 = in front of a robot facing +x,
 * which is how every robot spawns); elevation is degrees above the horizon. The lens is a focal
 * length on a sensor whose width spans the frame's longer side — Blender's "Auto" sensor fit and
 * three.js's filmGauge — so a 35 mm / 36 mm shot here frames like 35 mm in Blender. */
import * as THREE from "three";
import {cameraOrientationAt,type Take} from "./take";

export type ShotMode = "viewport" | "follow" | "orbit" | "fixed";

export interface Shot {
  mode: ShotMode;
  focal: number;        // mm
  sensor: number;       // mm, covers the frame's longer side
  distance: number;     // m, camera to look-at point
  azimuth: number;      // deg
  elevation: number;    // deg
  height: number;       // m, look-at height above the robot's starting ground
  orbitPeriod: number;  // s per turn (orbit); negative turns clockwise
  smooth: number;       // s, zero-phase smoothing of the camera path (0 = rigid)
}

export const SENSORS: { label: string; mm: number }[] = [
  { label: "Full frame · 36 mm", mm: 36 },
  { label: "Super 35 · 24.9 mm", mm: 24.89 },
  { label: "APS-C · 23.5 mm", mm: 23.5 },
  { label: "Micro Four Thirds · 17.3 mm", mm: 17.3 },
  { label: "1-inch · 13.2 mm", mm: 13.2 },
  { label: "Phone main camera · 9.8 mm", mm: 9.8 },
];

export const FOCALS = [14, 18, 24, 35, 50, 85, 135];

/** Framing presets: azimuth / elevation pairs. */
export const PRESETS: { label: string; azimuth: number; elevation: number }[] = [
  { label: "Front", azimuth: 0, elevation: 6 },
  { label: "¾", azimuth: -40, elevation: 12 },
  { label: "Side", azimuth: -90, elevation: 4 },
  { label: "Back", azimuth: 180, elevation: 10 },
  { label: "High", azimuth: -35, elevation: 55 },
];

export function defaultShot(lookZ: number): Shot {
  return { mode: "follow", focal: 35, sensor: 36, distance: lookZ < 0.5 ? 2.0 : 3.4,
           azimuth: -40, elevation: 10, height: lookZ, orbitPeriod: 12, smooth: 0.4 };
}

const D2R = Math.PI / 180;

/** Vertical field of view (deg) of `focal` on `sensor` for a frame of the given aspect (w / h). */
export function vfov(focal: number, sensor: number, aspect: number): number {
  const filmH = aspect >= 1 ? sensor / aspect : sensor;
  return 2 * Math.atan(filmH / (2 * focal)) / D2R;
}

/** Horizontal field of view (deg). */
export function hfov(focal: number, sensor: number, aspect: number): number {
  const filmW = aspect >= 1 ? sensor : sensor * aspect;
  return 2 * Math.atan(filmW / (2 * focal)) / D2R;
}

/** Zero-phase exponential smoothing (forward then backward pass) of an n·3 track, in place. */
function smooth3(a: Float64Array, n: number, dt: number, tau: number) {
  if (tau <= 0 || n < 2) return;
  const k = 1 - Math.exp(-dt / tau);
  for (let c = 0; c < 3; c++) {
    for (let i = 1; i < n; i++) a[3 * i + c] = a[3 * (i - 1) + c] + k * (a[3 * i + c] - a[3 * (i - 1) + c]);
    for (let i = n - 2; i >= 0; i--) a[3 * i + c] = a[3 * (i + 1) + c] + k * (a[3 * i + c] - a[3 * (i + 1) + c]);
  }
}

export interface CamAt { pos: THREE.Vector3; target: THREE.Vector3 }

/** Reproduce real viewport framing without requiring a recording. */
export function grabShotView(camPos: THREE.Vector3, target: THREE.Vector3, baseZOffset = 0):
    Pick<Shot, "distance" | "azimuth" | "elevation" | "height"> {
  const x = camPos.x - target.x, y = camPos.y - target.y, z = camPos.z - target.z;
  const r = Math.hypot(x, y, z) || 1;
  return {
    distance: +r.toFixed(2),
    azimuth: Math.round(Math.atan2(y, x) / D2R),
    elevation: Math.round(Math.asin(Math.max(-1, Math.min(1, z / r))) / D2R),
    height: +(target.z - baseZOffset).toFixed(2),
  };
}

function offsetPosition(shot: Shot, target: THREE.Vector3, pos: THREE.Vector3, phase: number) {
  const az = (shot.azimuth + phase) * D2R, el = shot.elevation * D2R;
  pos.set(target.x + shot.distance * Math.cos(el) * Math.cos(az),
          target.y + shot.distance * Math.cos(el) * Math.sin(az),
          target.z + shot.distance * Math.sin(el));
}

function applyShotLens(cam: THREE.PerspectiveCamera, shot: Shot, aspect: number) {
  cam.aspect = aspect;
  cam.fov = vfov(shot.focal, shot.sensor, aspect);
  cam.updateProjectionMatrix();
  cam.updateMatrixWorld();
}

/** Preview the current scene, not an invented take or a moving camera track.
 * Offset modes use the live base position at phase zero; viewport mode copies the real camera. */
export function applyStaticShot(cam: THREE.PerspectiveCamera, shot: Shot,
                                base: readonly [number, number, number], aspect: number,
                                viewportCamera?: THREE.PerspectiveCamera): void {
  if (shot.mode === "viewport") {
    if (viewportCamera) {
      cam.position.copy(viewportCamera.position);
      cam.quaternion.copy(viewportCamera.quaternion);
      cam.up.copy(viewportCamera.up);
    }
  } else {
    cam.up.set(0, 0, 1);
    // Reuse the camera position as scratch storage; no per-frame temporary vectors.
    cam.position.set(base[0], base[1], shot.height);
    offsetPosition(shot, cam.position, cam.position, 0);
    cam.lookAt(base[0], base[1], shot.height);
  }
  applyShotLens(cam, shot, aspect);
}

/** The camera path of one shot over one take, precomputed per take frame and interpolated. */
export class ShotPath {
  private target: Float64Array;          // n·3 look-at point per frame
  private pos: Float64Array | null;      // n·3 camera position per frame (viewport mode)
  private orientation:Float64Array|null=null;
  private readonly z0: number;

  constructor(readonly take: Take, readonly shot: Shot, readonly t0 = 0) {
    const n = take.n;
    this.z0 = take.basePosAt(0)[2];
    this.target = new Float64Array(3 * n);
    this.pos = null;
    if (shot.mode === "viewport") {
      this.pos = new Float64Array(3 * n);
      for (let i = 0; i < n; i++)
        for (let k = 0; k < 3; k++) {
          this.pos[3 * i + k] = take.cam[7 * i + k];
          this.target[3 * i + k] = take.cam[7 * i + 3 + k];
        }
      smooth3(this.pos, n, take.dt, shot.smooth);
      if(take.camOrientation){
        this.orientation=Float64Array.from(take.camOrientation);
        for(let i=0;i<n;i++)new THREE.Quaternion().fromArray(this.orientation,4*i).normalize().toArray(this.orientation,4*i);
        if(shot.smooth>0&&n>1){
          const weight=1-Math.exp(-take.dt/shot.smooth),q=new THREE.Quaternion(),next=new THREE.Quaternion();
          for(let i=1;i<n;i++)q.fromArray(this.orientation,4*(i-1)).slerp(next.fromArray(this.orientation,4*i),weight).normalize().toArray(this.orientation,4*i);
          for(let i=n-2;i>=0;i--)q.fromArray(this.orientation,4*(i+1)).slerp(next.fromArray(this.orientation,4*i),weight).normalize().toArray(this.orientation,4*i);
        }
      }
    } else if (shot.mode === "fixed") {
      const b = take.basePosAt(t0);
      for (let i = 0; i < n; i++) this.target.set([b[0], b[1], shot.height + b[2] - this.z0], 3 * i);
    } else {
      const nq = take.meta.nq, bq = take.meta.baseQadr;
      for (let i = 0; i < n; i++) {
        const o = i * nq + bq;
        this.target.set(bq >= 0 ? [take.qpos[o], take.qpos[o + 1], shot.height + take.qpos[o + 2] - this.z0]
                                : [0, 0, shot.height], 3 * i);
      }
    }
    smooth3(this.target, n, take.dt, shot.smooth);
  }

  /** Camera position + look-at point at take time `time`. */
  at(time: number, out?: CamAt): CamAt {
    const o = out ?? { pos: new THREE.Vector3(), target: new THREE.Vector3() };
    const [i, f] = this.take.locate(time);
    const j = Math.min(i + 1, this.take.n - 1);
    const lerp = (a: Float64Array, v: THREE.Vector3) =>
      v.set(a[3 * i] + (a[3 * j] - a[3 * i]) * f, a[3 * i + 1] + (a[3 * j + 1] - a[3 * i + 1]) * f,
            a[3 * i + 2] + (a[3 * j + 2] - a[3 * i + 2]) * f);
    lerp(this.target, o.target);
    if (this.pos) { lerp(this.pos, o.pos); return o; }
    const s = this.shot;
    offsetPosition(s, o.target, o.pos,
      s.mode === "orbit" && s.orbitPeriod ? 360 * (time - this.t0) / s.orbitPeriod : 0);
    return o;
  }

  /** Point `cam` along the path at `time`, with the shot's lens for a frame of `aspect`. */
  apply(cam: THREE.PerspectiveCamera, time: number, aspect: number) {
    const p = this.at(time);
    cam.up.set(0, 0, 1);
    cam.position.copy(p.pos);
    cam.lookAt(p.target);
    if(this.orientation){const[i,f]=this.take.locate(time);cam.quaternion.fromArray(cameraOrientationAt(this.orientation,i,Math.min(i+1,this.take.n-1),f));}
    applyShotLens(cam, this.shot, aspect);
  }

  /** Framing that reproduces a viewport camera at `time`: distance / azimuth / elevation / height. */
  static grab(take: Take, time: number, camPos: THREE.Vector3, target: THREE.Vector3):
      Pick<Shot, "distance" | "azimuth" | "elevation" | "height"> {
    return grabShotView(camPos, target, take.basePosAt(time)[2] - take.basePosAt(0)[2]);
  }
}
