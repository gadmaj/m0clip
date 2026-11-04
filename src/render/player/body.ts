/** Contract shared by the third-person player bodies (GoldSrc and Source Studio). A body is driven
 * from the worker's PlayerSimFrame by a live controller (`advance`), which writes the displayed
 * sequence/cycle/pose parameters into `pose`; `apply` then poses the bones from a presentation
 * alone, so review and export replay exactly what was shown. */
import * as THREE from 'three';
import type { PlayerAnimationPose, PlayerPresentation, PlayerSimFrame, PlayerTool, SourceFrame } from '../../player/types';
import { INCH, sourceToAppPoint } from '../../player/source-frame';
import { GMOD_MOVE_PROFILE } from '../../player/movement';

export const DEG = Math.PI / 180;

export interface PlayerBodyRig {
  readonly kind: 'goldsrc' | 'studio';
  /** Pmodel id or canonical Source model path. */
  readonly path: string;
  /** Placed in app space (metres, Z-up); added to the scene by the owner. */
  readonly object: THREE.Group;
  readonly limitations: readonly string[];
  /** Meaning of each recorded body pose parameter. */
  readonly poseParameterNames: readonly string[];
  /** Live controller output; `layers` and `poseParameters` are owned by the rig. */
  readonly pose: PlayerAnimationPose;
  bodyYaw: number;
  /** Advances the live controller by `dt` simulated seconds and writes `pose` / `bodyYaw`. */
  advance(frame: PlayerSimFrame, dt: number): void;
  /** Starts the body's authentic attack gesture for the current tool, if the model has one. */
  attack(tool: PlayerTool): void;
  /** Poses bones and places `object` from a recorded or live presentation. Pure. */
  apply(frame: PlayerSimFrame, presentation: PlayerPresentation, clock: number, sourceFrame: SourceFrame): void;
  /** Bones in export order with stable names, and a geometry-sharing copy for glTF (null when the
   * body comes from local game files, which are never re-exported). */
  exportCopy(): { root: THREE.Object3D; bones: THREE.Bone[]; source: THREE.Bone[] } | null;
  reset(): void;
  dispose(): void;
}

/** Upward speed (in/s) above which leaving the ground counts as a jump rather than walking off a
 * ledge: half the Sandbox jump impulse. */
const JUMP_TAKEOFF = GMOD_MOVE_PROFILE.jumpImpulse * 0.5;

/** Source player animation keeps the jump (hop) activity from takeoff until landing. */
export class HopTracker {
  private grounded = true;
  hopping = false;
  update(frame: PlayerSimFrame): boolean {
    if (this.grounded && !frame.grounded && frame.velocity[2] > JUMP_TAKEOFF) this.hopping = true;
    if (frame.grounded) this.hopping = false;
    this.grounded = frame.grounded;
    return this.hopping;
  }
  reset() { this.grounded = true; this.hopping = false; }
}

const scratch = new Float64Array(3);

/** Places a body node at the player's Source origin plus `lift` inches, facing Source yaw `yaw`. */
export function placeBody(object: THREE.Object3D, origin: ArrayLike<number>, frame: SourceFrame, yaw: number, lift: number): void {
  sourceToAppPoint(frame, origin, scratch);
  object.position.set(scratch[0], scratch[1], scratch[2] + lift * INCH);
  object.rotation.set(0, 0, (yaw - frame.yawDeg) * DEG);
  object.updateMatrix();
}

/** Signed difference a − b in degrees, wrapped to [−180, 180). */
export function angleDiff(a: number, b: number): number {
  const d = (a - b) % 360;
  return d >= 180 ? d - 360 : d < -180 ? d + 360 : d;
}
