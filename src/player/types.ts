export type SceneMode = 'robot' | 'player';
export type PlayerTool = 'none' | 'physgun' | 'spawn' | 'knife';

export interface PlayerInputFrame {
  sequence: number;
  yaw: number;
  pitch: number;
  forward: number;
  side: number;
  held: number;
  pressed: number;
  /** Release frame: the worker also drops presses it has not simulated yet. */
  reset: boolean;
  thirdPerson: boolean;
}

/** Source-space player simulation. Positions and speeds use inches; +Z is up. */
export interface SourceFrame {
  readonly origin: readonly [number, number, number];
  readonly yawDeg: number;
}

export interface PlayerTrace {
  fraction: number;
  readonly end: Float64Array;
  readonly normal: Float64Array;
  startSolid: boolean;
  allSolid: boolean;
  geom: number;
}

/** Sweeps an axis-aligned Source player hull against the map's collision geometry. */
export interface PlayerCollisionWorld {
  traceHull(start: ArrayLike<number>, end: ArrayLike<number>,
    mins: ArrayLike<number>, maxs: ArrayLike<number>, out: PlayerTrace): void;
}

export const PLAYER_BUTTON = {
  attack: 1,
  jump: 2,
  duck: 4,
  use: 32,
  attack2: 2048,
  run: 131072,
} as const;

export interface PlayerMoveCommand {
  /** Source yaw: zero faces +X; positive turns toward +Y. */
  yaw: number;
  /** Normalized forward and right input. */
  forward: number;
  side: number;
  /** Held buttons and single-tick impulses, already combined by the worker. */
  buttons: number;
}

export interface PlayerMoveState {
  readonly origin: Float64Array;
  readonly velocity: Float64Array;
  grounded: boolean;
  groundGeom: number;
  ducked: boolean;
  duckFraction: number;
  eyeHeight: number;
  oldButtons: number;
}

export interface PlayerMoveProfile {
  readonly tickInterval: number;
  readonly gravity: number;
  readonly friction: number;
  readonly stopSpeed: number;
  readonly groundAccelerate: number;
  readonly airAccelerate: number;
  readonly airWishCap: number;
  readonly jumpImpulse: number;
  readonly walkSpeed: number;
  readonly runSpeed: number;
  readonly duckSpeedScale: number;
  readonly stepHeight: number;
  readonly walkableNormal: number;
  readonly maxVelocity: number;
  readonly skin: number;
  readonly halfWidth: number;
  readonly standHeight: number;
  readonly duckHeight: number;
  readonly standEye: number;
  readonly duckEye: number;
  readonly duckSeconds: number;
}

export interface PlayerMoveEvents {
  jumped: boolean;
  landed: boolean;
  stepHeight: number;
}

export interface PlayerEntityState {
  id: string;
  state: 'alive' | 'ragdoll';
  hits: number;
}

export interface PlayerGrabState {
  entity: string;
  body: number;
  /** App-space metres, unlike the Source-space movement fields below. */
  readonly point: Float64Array;
  readonly target: Float64Array;
}

/** Authoritative worker state; camera offsets never change origin or the collision hull. */
export interface PlayerSimFrame {
  readonly origin: Float64Array;
  readonly velocity: Float64Array;
  yaw: number;
  pitch: number;
  grounded: boolean;
  groundGeom: number;
  ducked: boolean;
  duckFraction: number;
  eyeHeight: number;
  colliderBody: number;
  thirdPerson: boolean;
  tool: PlayerTool;
  grab: PlayerGrabState | null;
  readonly entities: readonly PlayerEntityState[];
}

export interface PlayerAnimationLayer {
  sequence: number;
  cycle: number;
  weight: number;
}

export interface PlayerAnimationPose {
  sequence: number;
  cycle: number;
  readonly poseParameters: Float32Array;
  readonly layers: readonly PlayerAnimationLayer[];
}

/** Actual displayed animation/camera state, sampled with the recorded worker frame. */
export interface PlayerPresentation {
  thirdPerson: boolean;
  bodyYaw: number;
  body: PlayerAnimationPose;
  viewModel?: PlayerAnimationPose;
  viewModelPosition?: readonly [number, number, number];
  viewModelOrientation?: readonly [number, number, number, number];
  viewModelFov?: number;
}

/** Weapon behavior verified from the supplied game, separate from animation duration. */
export interface PlayerKnifeTiming {
  primaryRange: number;
  primaryCycle: number;
  primaryHitDelay: number;
}
