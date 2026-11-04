/** Player view camera. First person sits at the eye (origin + view offset). Holding third person
 * follows Source's in_camera (SDK 2013 defaults: cam_idealdist 150, c_mindistance 30,
 * cam_ideallag 4, cam_collision 1): the offset starts at the minimum distance, eases toward the
 * ideal distance, its angles lag the view angles, and a collision trace from the eye shortens it
 * so the camera never passes through the world; releasing returns to first person immediately.
 * Source applies the easing once per client frame; m0clip normalises it to 60 frames per second
 * so it doesn't depend on the display rate. The 14-unit collision hull is approximated by five
 * parallel rays (centre and hull corners) against the rendered static world, minus the hull
 * half-size. Independent implementation of the documented behaviour. */
import * as THREE from 'three';
import type { PlayerSimFrame, SourceFrame } from '../../player/types';
import { INCH, sourceToAppDirection, sourceToAppPoint } from '../../player/source-frame';
import { angleDiff, DEG } from './body';
import type { WorldRayGrid } from './trace';

/** Garry's Mod default fov_desired: horizontal degrees at 4:3, widened hor+ for other aspects. */
export const PLAYER_WORLD_FOV = 75;
/** Source SDK viewmodel_fov, horizontal degrees at 4:3, hor+. */
export const PLAYER_VIEWMODEL_FOV = 54;

const IDEAL_DIST = 150, MIN_DIST = 30, IDEAL_LAG = 4, HULL = 14, SNAP = 2, FRAME_RATE = 60;

/** Vertical FOV (degrees) of a Source horizontal-at-4:3 FOV under hor+ scaling. */
export function horPlusVerticalFov(fov4x3: number): number {
  return 2 * Math.atan(Math.tan(fov4x3 * DEG / 2) * 0.75) / DEG;
}

export class PlayerCamera {
  private third = false;
  private dist = MIN_DIST;
  private yaw = 0;
  private pitch = 0;
  private readonly eye = new Float64Array(3);
  private readonly src = new Float64Array(3);
  private readonly dir = new Float64Array(3);
  private readonly right = new Float64Array(3);
  private readonly up = new Float64Array(3);
  private readonly target = new THREE.Vector3();

  update(camera: THREE.PerspectiveCamera, frame: PlayerSimFrame, source: SourceFrame, look: { yaw: number; pitch: number },
         thirdPerson: boolean, dt: number, world: WorldRayGrid | null): void {
    const fov = horPlusVerticalFov(PLAYER_WORLD_FOV);
    if (camera.fov !== fov) { camera.fov = fov; camera.updateProjectionMatrix(); }
    this.src[0] = frame.origin[0]; this.src[1] = frame.origin[1]; this.src[2] = frame.origin[2] + frame.eyeHeight;
    sourceToAppPoint(source, this.src, this.eye);
    if (!thirdPerson) {
      this.third = false;
      this.aim(camera, source, look.yaw, look.pitch, 0);
      return;
    }
    if (!this.third) { this.third = true; this.dist = MIN_DIST; this.yaw = look.yaw; this.pitch = look.pitch; }
    const frames = Math.max(0, dt) * FRAME_RATE;
    const lag = 1 - (1 - 1 / (1 + IDEAL_LAG)) ** frames;
    this.yaw = angleDiff(this.yaw + angleDiff(look.yaw, this.yaw) * lag, 0);
    this.pitch += (look.pitch - this.pitch) * lag;
    if (Math.abs(IDEAL_DIST - this.dist) < SNAP) this.dist = IDEAL_DIST;
    else this.dist += (IDEAL_DIST - this.dist) * (1 - 0.75 ** frames);
    if (world) {
      const cy = Math.cos(this.yaw * DEG), sy = Math.sin(this.yaw * DEG), cp = Math.cos(this.pitch * DEG), sp = Math.sin(this.pitch * DEG);
      this.src[0] = -cp * cy; this.src[1] = -cp * sy; this.src[2] = sp;
      sourceToAppDirection(source, this.src, this.dir);
      this.src[0] = sy; this.src[1] = -cy; this.src[2] = 0;
      sourceToAppDirection(source, this.src, this.right);
      this.src[0] = sp * cy; this.src[1] = sp * sy; this.src[2] = cp;
      sourceToAppDirection(source, this.src, this.up);
      const reach = (this.dist + HULL) * INCH, h = HULL * INCH, e = this.eye, d = this.dir;
      let hit = world.cast(e[0], e[1], e[2], d[0], d[1], d[2], reach);
      for (let k = 0; k < 4; k++) {
        const a = k & 1 ? h : -h, b = k & 2 ? h : -h;
        hit = Math.min(hit, world.cast(e[0] + this.right[0] * a + this.up[0] * b, e[1] + this.right[1] * a + this.up[1] * b,
          e[2] + this.right[2] * a + this.up[2] * b, d[0], d[1], d[2], reach));
      }
      if (hit !== Infinity) this.dist = Math.min(this.dist, Math.max(0, hit / INCH - HULL));
    }
    this.aim(camera, source, this.yaw, this.pitch, this.dist);
  }

  /** Places the camera `back` inches behind the eye, looking along Source angles. */
  private aim(camera: THREE.PerspectiveCamera, source: SourceFrame, yaw: number, pitch: number, back: number) {
    const cy = Math.cos(yaw * DEG), sy = Math.sin(yaw * DEG), cp = Math.cos(pitch * DEG), sp = Math.sin(pitch * DEG);
    this.src[0] = cp * cy; this.src[1] = cp * sy; this.src[2] = -sp;
    sourceToAppDirection(source, this.src, this.dir);
    const d = this.dir, e = this.eye, m = back * INCH;
    camera.up.set(0, 0, 1);
    camera.position.set(e[0] - d[0] * m, e[1] - d[1] * m, e[2] - d[2] * m);
    camera.lookAt(this.target.set(camera.position.x + d[0], camera.position.y + d[1], camera.position.z + d[2]));
    camera.updateMatrixWorld();
  }

  reset(): void { this.third = false; this.dist = MIN_DIST; }
}
