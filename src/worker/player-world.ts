/** The authoritative Player world: a generated MuJoCo world (or a converted map) with no robot of
 * its own, a Source-style player hull moved by PlayerMover in Source inches, and any robots the
 * player spawns, each attached under its own prefix with its own policy driver and FSM.
 *
 * One simulation clock drives everything. The player ticks every TICK simulated seconds; MuJoCo
 * substeps at the shared timestep fill the time between ticks, and each robot runs its own policy
 * control period on the same clock. Real time feeds an accumulator that is capped per wake; time
 * beyond the cap is counted and reported as lost, never silently dropped or used to shift clocks.
 *
 * The player's hull reaches the physics through a mocap box on the world. Its contact type is a
 * bit that only robot geoms accept (set at runtime here, Player scenes only), so it pushes robots
 * without touching the map; the hull's own map trace (collision.ts) never sees mocap bodies. */
import type { IntBuffer } from 'mujoco';
import { makeDriver, type BaseDriver } from '../core/drivers';
import { releasePolicySessions, withPolicySessionGroup } from '../core/policy';
import type { Command, EvalConfig, PolicyEntry, RobotSpec } from '../core/types';
import { Engine, type ExtraBundle, type PreparedScene, type SceneSpec } from '../sim/engine';
import type { EntityEngine, SceneEntity } from '../sim/entities';
import { SimFSM } from '../sim/fsm';
import { copyMovingGeometry, createFrameGeometryLayout, type FrameGeometryLayout } from '../sim/geometry-frames';
import type { FromWorker, SceneIdentity } from '../sim/protocol';
import { renderModelFromEngine } from '../sim/render-model';
import { mapId, terrainTransform, type TerrainName } from '../sim/terrain';
import type { MapSource } from '../maps/source';
import { getSpec, SPECS } from '../robots';
import { collisionFromEngine } from '../player/collision';
import { createPlayerMoveState, GMOD_MOVE_PROFILE, PlayerMover } from '../player/movement';
import { INCH, sourceToAppDirection, sourceToAppPoint } from '../player/source-frame';
import {
  PLAYER_BUTTON,
  type PlayerCollisionWorld, type PlayerEntityState, type PlayerGrabState, type PlayerInputFrame,
  type PlayerKnifeTiming, type PlayerMoveCommand, type PlayerMoveEvents, type PlayerMoveState,
  type PlayerSimFrame, type PlayerTool, type PlayerTrace, type SourceFrame,
} from '../player/types';
import { selectRobotPolicy, specFor } from './robot-policy';

const P = GMOD_MOVE_PROFILE;
/** Player tick, simulated seconds (Source default tick interval). */
const TICK = P.tickInterval;
/** Real time folded into one wake at most; the rest is reported as lost. */
const MAX_CATCHUP = 0.1;
/** Lost-time status posts at most this often (ms). */
const LOST_STATUS_MS = 500;
const DEG = Math.PI / 180;
const EPS = 1e-9;

/** Contact type of the player collider; only robot geoms get it in their conaffinity. */
const PLAYER_CONTACT_BIT = 1 << 30;
/** Hidden from the renderer (group >= 3) and from LIDAR (groups 0/1 only). */
const SHADOW_GROUP = 4;
const SHADOW_BODY = 'm0clip_player';
const SHADOW_GEOM = 'm0clip_player_hull';

/** Source places a spawning player 1 unit above its spawn origin and lets it settle. */
const SPAWN_LIFT = 1;
/** How far below a spawn or spawn-gun target a walkable floor is searched for (inches). */
const GROUND_SEARCH = 1024;
/** Spawn gun: horizontal distance ahead of the player, inches. */
const ROBOT_SPAWN_DISTANCE = 96;
/** Spawn gun: pull-back from an obstacle and the nearest allowed placement, inches. */
const ROBOT_SPAWN_BACKOFF = 24;
const ROBOT_SPAWN_MIN_DISTANCE = 40;
const ROBOT_PROBE = 12;
/** Metres the lowest robot geom is seated above the traced surface. */
const ROBOT_SEAT_CLEARANCE = 0.02;
const MAX_ROBOTS = 4;
const DEFAULT_SPAWN_ROBOT = 'r1';
/** A knife hit count that turns the robot into a zero-torque ragdoll. */
const KNIFE_RAGDOLL_HITS = 4;

/** Garry's Mod physgun server defaults (ConVars: physgun_maxSpeed, physgun_maxSpeedDamping,
 * physgun_maxAngular, physgun_maxAngularDamping, physgun_timeToArriveRagdoll, physgun_maxrange,
 * physgun_wheelspeed), converted from Source units/degrees. Robots are articulated, so they use
 * the ragdoll arrival time. The damping limits cap the per-step acceleration. */
const PHYSGUN_MAX_SPEED = 5000 * INCH;              // m/s
const PHYSGUN_MAX_ACCEL = 10000 * INCH;             // m/s²
const PHYSGUN_MAX_ANGULAR = 5000 * DEG;             // rad/s
const PHYSGUN_MAX_ANGULAR_ACCEL = 10000 * DEG;      // rad/s²
const PHYSGUN_ARRIVE = 0.1;                         // s
const PHYSGUN_RANGE = 4096;                         // inches
const PHYSGUN_WHEEL = 10;                           // inches per wheel notch
const PHYSGUN_MIN_DISTANCE = 32;                    // inches: outside the player's own hull

const ALL_GROUPS = [1, 1, 1, 1, 1, 1];
const IDENTITY_FRAME: SourceFrame = Object.freeze({ origin: Object.freeze([0, 0, 0]) as readonly [number, number, number], yawDeg: 0 });

export interface PlayerWorldHost {
  post(message: FromWorker, transfer?: Transferable[]): void;
  /** Every imported policy entry. */
  entries(): PolicyEntry[];
  /** Resolve (and cache) an entry's evaluation config. */
  config(entry: PolicyEntry): Promise<EvalConfig>;
}

/** Metadata for a Player world, read before compiling (and before the startup gate). */
export interface PlayerScenePlan {
  readonly terrain: TerrainName;
  readonly source: MapSource | null;
  readonly mount: string;
  readonly extra: ExtraBundle | undefined;
  readonly spec: SceneSpec;
  readonly prepared: PreparedScene;
  readonly frame: SourceFrame;
}

export interface PlayerToolConfig {
  readonly tools?: readonly PlayerTool[];
  readonly knifeTiming?: PlayerKnifeTiming;
}

interface PlayerScene {
  readonly engine: Engine;
  readonly terrain: TerrainName;
  readonly frame: SourceFrame;
  readonly extra: ExtraBundle | undefined;
  readonly transform: (name: string, xml: string) => string;
  readonly collision: PlayerCollisionWorld;
  readonly mover: PlayerMover;
  readonly shadowBody: number;
  readonly shadowMocap: number;
  readonly shadowGeom: number;
  readonly movingGeomIds: Uint32Array;
  readonly geometry: FrameGeometryLayout;
  readonly ray: IntBuffer;
  /** The compiled world's timestep, used while no robot is present. */
  readonly baseTimestep: number;
  readonly gravity: Float64Array;
}

interface EntityRuntime {
  readonly id: string;
  readonly spec: RobotSpec;
  readonly entry: PolicyEntry;
  readonly cfg: EvalConfig;
  readonly scope: EntityEngine;
  readonly fsm: SimFSM;
  readonly driver: BaseDriver | null;
  readonly status: PlayerEntityState;
  readonly stepDt: number;
  /** Command latency in substeps at the current shared timestep (config control.cmd_delay). */
  delay: number;
  nextControl: number;
  target: Float64Array | null;
  sub: number;
  hasPrev: boolean;
  readonly prevTarget: Float64Array;
  readonly prevKp: Float64Array;
  readonly prevKd: Float64Array;
}

/** One robot of the next composed scene. `prior` carries an existing robot's runtime state over. */
interface PlannedEntity {
  readonly id: string;
  readonly spec: RobotSpec;
  readonly entry: PolicyEntry;
  readonly cfg: EvalConfig;
  readonly prior?: EntityRuntime;
  /** New robot: app-space surface point and yaw (rad) to seat it at. */
  readonly place?: { readonly point: Float64Array; readonly yaw: number };
}

interface Grab {
  readonly runtime: EntityRuntime;
  readonly body: number;
  readonly local: Float64Array;
  /** Body orientation relative to the player's app yaw at grab time (wxyz). */
  readonly relative: Float64Array;
  distance: number;
  remaining: number;
  readonly applied: Float64Array;
  readonly view: PlayerGrabState;
}

type PendingAction =
  | { kind: 'spawn' }
  | { kind: 'remove'; id: string }
  | { kind: 'handover'; id: string; next: string };

interface StateSnapshot { readonly qpos: Float64Array; readonly qvel: Float64Array }

function finiteVector(value: unknown, length: number): value is number[] {
  return Array.isArray(value) && value.length === length && value.every(v => typeof v === 'number' && Number.isFinite(v));
}

/** The map importer's spawn frame (manifest spawn_source / spawn_yaw); identity for built-ins. */
function sourceFrameFor(terrain: TerrainName, prepared: PreparedScene): SourceFrame {
  const id = mapId(terrain);
  if (!id) return IDENTITY_FRAME;
  const manifest: unknown = prepared.base === null ? prepared.extra?.manifest : prepared.base.extra?.manifest;
  if (!manifest || typeof manifest !== 'object') throw new Error(`Map ${id} has no physics manifest.`);
  const origin: unknown = Reflect.get(manifest, 'spawn_source'), yaw: unknown = Reflect.get(manifest, 'spawn_yaw');
  if (!finiteVector(origin, 3) || typeof yaw !== 'number' || !Number.isFinite(yaw))
    throw new Error(`Map ${id} manifest has no valid spawn_source/spawn_yaw; reconvert it to play it in Player mode.`);
  return Object.freeze({ origin: Object.freeze([origin[0], origin[1], origin[2]]) as readonly [number, number, number], yawDeg: yaw });
}

function validKnifeTiming(timing: PlayerKnifeTiming | undefined): PlayerKnifeTiming | null {
  if (!timing) return null;
  const { primaryRange, primaryCycle, primaryHitDelay } = timing;
  if (!(primaryRange > 0) || !Number.isFinite(primaryRange) || !(primaryCycle > 0) || !Number.isFinite(primaryCycle)
      || !(primaryHitDelay >= 0) || !(primaryHitDelay <= primaryCycle))
    throw new Error('The supplied knife timing is invalid.');
  return Object.freeze({ primaryRange, primaryCycle, primaryHitDelay });
}

function snapshot(engine: Engine, entity: SceneEntity): StateSnapshot {
  return { qpos: engine.qpos.slice(entity.qposStart, entity.qposEnd), qvel: engine.qvel.slice(entity.dofStart, entity.dofEnd) };
}

function restore(engine: Engine, entity: SceneEntity, state: StateSnapshot) {
  if (entity.qposEnd - entity.qposStart !== state.qpos.length || entity.dofEnd - entity.dofStart !== state.qvel.length)
    throw new Error(`Scene entity ${entity.id} changed shape while recompiling.`);
  engine.qpos.set(state.qpos, entity.qposStart);
  engine.qvel.set(state.qvel, entity.dofStart);
}

function clampMagnitude(v: Float64Array, max: number) {
  const n = Math.hypot(v[0], v[1], v[2]);
  if (n > max) { const k = max / n; v[0] *= k; v[1] *= k; v[2] *= k; }
}

export class PlayerWorld {
  private scene: PlayerScene | null = null;
  private runtimes: EntityRuntime[] = [];
  private entityStates: PlayerEntityState[] = [];
  private spawnCounter = 0;

  private move: PlayerMoveState = createPlayerMoveState();
  private readonly cmd: PlayerMoveCommand = { yaw: 0, forward: 0, side: 0, buttons: 0 };
  private readonly events: PlayerMoveEvents = { jumped: false, landed: false, stepHeight: 0 };
  private yaw = 0;
  private pitch = 0;
  private forward = 0;
  private side = 0;
  private held = 0;
  private prevHeld = 0;
  private pulse = 0;
  private wheelJump = false;
  private thirdPerson = false;

  private available: PlayerTool[] = [];
  private tool: PlayerTool = 'none';
  private knife: PlayerKnifeTiming | null = null;
  private spawnRobot = DEFAULT_SPAWN_ROBOT in SPECS ? DEFAULT_SPAWN_ROBOT : Object.keys(SPECS)[0];
  private nextKnife = 0;
  private knifeHitAt = -1;
  private grab: Grab | null = null;
  private pending: PendingAction | null = null;

  /** Simulated seconds of physics on this world's clock. */
  private simTime = 0;
  /** Absolute physics deadline of the latest Player tick: substep rounding never accumulates. */
  private tickEnd = 0;
  /** Recorded frame clock: advances only by simulated ticks, monotonic across scene changes. */
  private clock = 0;
  private acc = 0;
  private lastWake = -1;
  private lost = 0;
  private lostPosted = 0;
  private lostPostedAt = -Infinity;

  /** Reused for every posted frame (postMessage clones it); rebuilt when the scene changes. */
  private simFrame: PlayerSimFrame;
  private readonly zeroCommand: Command = [0, 0, 0];
  private readonly tr: PlayerTrace = { fraction: 1, end: new Float64Array(3), normal: new Float64Array(3), startSolid: false, allSolid: false, geom: -1 };
  private readonly standMins = Float64Array.of(-P.halfWidth, -P.halfWidth, 0);
  private readonly standMaxs = Float64Array.of(P.halfWidth, P.halfWidth, P.standHeight);
  private readonly probeMins = Float64Array.of(-ROBOT_PROBE, -ROBOT_PROBE, 0);
  private readonly probeMaxs = Float64Array.of(ROBOT_PROBE, ROBOT_PROBE, ROBOT_PROBE);
  private readonly a = new Float64Array(3);
  private readonly b = new Float64Array(3);
  private readonly c = new Float64Array(3);
  private readonly eyeApp = new Float64Array(3);
  private readonly dirApp = new Float64Array(3);
  private readonly lin = new Float64Array(3);
  private readonly ang = new Float64Array(3);
  private readonly quat = new Float64Array(4);
  private readonly wrench = new Float64Array(6);

  constructor(private readonly host: PlayerWorldHost) {
    this.simFrame = this.makeSimFrame();
  }

  get loaded(): boolean { return this.scene !== null; }

  // ---- scene lifetime ------------------------------------------------

  /** Read the world's manifests and spawn frame without compiling. */
  async prepare(terrain: TerrainName, source: MapSource | null,
      fetchMetadata?: (url: string) => Promise<Response>): Promise<PlayerScenePlan> {
    if ((source?.id ?? null) !== mapId(terrain)) throw new Error('The selected map source does not match the requested terrain.');
    const mount = source?.identity ? `/work/maps/${source.identity.fingerprint}` : '/work/map';
    const extra: ExtraBundle | undefined = source ? { source, mount } : undefined;
    const spec: SceneSpec = extra ? { slots: [], extra } : { slots: [] };
    const prepared = await Engine.prepareScene(spec, fetchMetadata);
    return { terrain, source, mount, extra, spec, prepared, frame: sourceFrameFor(terrain, prepared) };
  }

  /** Compile the plan's world and spawn the player at the map's spawn. The current world keeps
   * running unless the new one compiles and has a valid spawn. Returns false if cancelled. */
  async load(plan: PlayerScenePlan, tools: PlayerToolConfig, current: () => boolean): Promise<boolean> {
    const knife = validKnifeTiming(tools.knifeTiming);
    const transform = playerWorldTransform(plan.terrain, plan.mount, plan.frame);
    const engine = await Engine.createScene(plan.spec, transform, plan.prepared);
    if (!current()) { engine.dispose(); return false; }
    let scene: PlayerScene | undefined, spawn: Float64Array;
    try {
      if (engine.entities.length) throw new Error('A new Player world must not contain robots.');
      scene = this.bindScene(engine, plan.terrain, plan.frame, plan.extra, transform, engine.timestep);
      spawn = this.findSpawn(scene);
    } catch (error) { scene?.ray.delete(); engine.dispose(); throw error; }
    this.releaseGrab();
    this.pending = null;
    const hadRobots = this.runtimes.length > 0;
    this.disposeScene();
    this.runtimes = [];
    this.entityStates = [];
    this.scene = scene;
    if (hadRobots) await releasePolicySessions();
    this.move = createPlayerMoveState(spawn);
    this.yaw = plan.frame.yawDeg;
    this.pitch = 0;
    this.clearInput();
    this.knife = knife;
    const requested: readonly PlayerTool[] = tools.tools ?? ['physgun', 'spawn', 'knife'];
    this.available = [...new Set(requested)].filter(t => t === 'physgun' || t === 'spawn' || (t === 'knife' && knife !== null));
    if (!this.available.includes(this.tool)) this.tool = 'none';
    this.nextKnife = this.simTime;
    this.knifeHitAt = -1;
    this.simFrame = this.makeSimFrame();
    this.updateShadow();
    engine.forward();
    this.postModel();
    this.resetWakeClock();
    return true;
  }

  private bindScene(engine: Engine, terrain: TerrainName, frame: SourceFrame, extra: ExtraBundle | undefined,
      transform: (name: string, xml: string) => string, baseTimestep: number): PlayerScene {
    const mj = engine.mj, model = engine.model;
    const shadowBody = mj.mj_name2id(model, mj.mjtObj.mjOBJ_BODY.value, SHADOW_BODY);
    const shadowGeom = mj.mj_name2id(model, mj.mjtObj.mjOBJ_GEOM.value, SHADOW_GEOM);
    const shadowMocap = shadowBody >= 0 ? engine.bodyMocapId[shadowBody] : -1;
    if (shadowBody <= 0 || shadowGeom < 0 || shadowMocap < 0 || engine.geomBodyId[shadowGeom] !== shadowBody)
      throw new Error('The compiled Player world has no player collider.');
    // The collider touches robots only: their collision geoms accept its contact bit.
    const contype = engine.geomContype, conaffinity = engine.geomConaffinity;
    for (const entity of engine.entities)
      for (let g = entity.geomStart; g < entity.geomEnd; g++)
        if ((contype[g] | conaffinity[g]) !== 0) conaffinity[g] |= PLAYER_CONTACT_BIT;
    const yaw = -frame.yawDeg * DEG, mq = engine.mocapQuat, m4 = 4 * shadowMocap;
    mq[m4] = Math.cos(yaw / 2); mq[m4 + 1] = 0; mq[m4 + 2] = 0; mq[m4 + 3] = Math.sin(yaw / 2);
    const bodyIds: unknown = Reflect.get(model, 'geom_bodyid');
    if (!(bodyIds instanceof Int32Array)) throw new Error('The compiled model has no geometry body IDs.');
    engine.forward();
    const geometry = createFrameGeometryLayout(bodyIds, engine.geomXpos, engine.geomXmat);
    const collision = collisionFromEngine(engine, frame);
    const gravity = Float64Array.from(model.opt.gravity);
    if (!finiteVector(Array.from(gravity), 3)) throw new Error('The compiled model has no gravity vector.');
    const ray = new mj.IntBuffer(1);
    return { engine, terrain, frame, extra, transform, collision, mover: new PlayerMover(collision, P),
      shadowBody, shadowMocap, shadowGeom, movingGeomIds: geometry.movingIds, geometry: geometry.layout, ray, baseTimestep, gravity };
  }

  private disposeScene() {
    const scene = this.scene;
    if (!scene) return;
    scene.ray.delete();
    scene.engine.dispose();
    this.scene = null;
  }

  /** Source: spawn origin + 1 unit, then down onto the floor with the standing hull. */
  private findSpawn(scene: PlayerScene): Float64Array {
    const o = scene.frame.origin, a = this.a, b = this.b, tr = this.tr;
    a[0] = o[0]; a[1] = o[1]; a[2] = o[2] + SPAWN_LIFT;
    b[0] = a[0]; b[1] = a[1]; b[2] = a[2] - GROUND_SEARCH;
    scene.collision.traceHull(a, b, this.standMins, this.standMaxs, tr);
    if (tr.startSolid || tr.allSolid) throw new Error('The map spawn point is inside solid geometry, so the player cannot spawn.');
    if (tr.fraction >= 1) throw new Error('There is no floor under the map spawn point, so the player cannot spawn.');
    if (tr.normal[2] < P.walkableNormal) throw new Error('The floor under the map spawn point is too steep to stand on.');
    return Float64Array.from(tr.end);
  }

  // ---- messages --------------------------------------------------------

  input(frame: PlayerInputFrame) {
    const { yaw, pitch, forward, side, held, pressed } = frame;
    if (![yaw, pitch, forward, side].every(Number.isFinite) || !Number.isInteger(held) || !Number.isInteger(pressed))
      throw new Error('Invalid player input frame.');
    this.yaw = yaw;
    this.pitch = Math.max(-89, Math.min(89, pitch));
    this.forward = Math.max(-1, Math.min(1, forward));
    this.side = Math.max(-1, Math.min(1, side));
    this.held = held;
    this.pulse |= pressed;
    if (frame.wheelJump && this.tool === 'knife') this.wheelJump = true;
    this.thirdPerson = frame.thirdPerson;
  }

  selectTool(tool: PlayerTool) {
    if (tool !== 'none' && !this.available.includes(tool)) {
      this.host.post({ t: 'error', msg: `The ${tool} is not available in this Player world.` });
      this.postStatus();
      return;
    }
    if (tool !== this.tool) {
      this.releaseGrab();
      this.knifeHitAt = -1;
      this.wheelJump = false;
      this.pulse &= ~(PLAYER_BUTTON.attack | PLAYER_BUTTON.attack2);
      this.tool = tool;
    }
    this.postStatus();
  }

  selectSpawnRobot(robot: string) {
    if (!(robot in SPECS)) throw new Error(`Unknown robot ${robot}.`);
    this.spawnRobot = robot;
    this.postStatus();
  }

  wheel(direction: number) {
    if (!Number.isFinite(direction)) throw new Error('Invalid physics gun wheel direction.');
    const grab = this.grab;
    if (!grab) return;
    // Signed wheel clicks: the main thread counts clicks Chrome merged into one event.
    const notches = Math.trunc(direction);
    grab.distance = Math.max(PHYSGUN_MIN_DISTANCE, Math.min(PHYSGUN_RANGE, grab.distance + notches * PHYSGUN_WHEEL));
  }

  /** Focus, lock, modal or review: release everything the player is holding. Momentum stays. */
  stop() {
    this.releaseGrab();
    this.clearInput();
    this.knifeHitAt = -1;
    this.postStatus();
  }

  setPaused(paused: boolean) {
    if (paused) { this.releaseGrab(); this.clearInput(); this.knifeHitAt = -1; }
    this.resetWakeClock();
  }

  async undo() {
    const last = this.runtimes[this.runtimes.length - 1];
    if (!last) { this.postStatus(); return; }
    await this.runAction({ kind: 'remove', id: last.id });
  }

  private clearInput() {
    this.forward = this.side = this.held = this.prevHeld = this.pulse = 0;
    this.wheelJump = false;
  }

  postStatus() {
    const spawnRobots = this.spawnableRobots();
    // The spawn target is always one the person can see and pick; without any, spawning reports why.
    if (spawnRobots.length && !spawnRobots.includes(this.spawnRobot)) this.spawnRobot = spawnRobots[0];
    this.host.post({ t: 'playerStatus', tool: this.tool, availableTools: [...this.available], spawnRobot: this.spawnRobot,
      robotCount: this.runtimes.length, maxRobots: MAX_ROBOTS, lostTime: this.lost, spawnRobots });
    this.lostPosted = this.lost;
    this.lostPostedAt = performance.now();
  }

  /** Variants with a runnable imported policy; a robot with none cannot be spawned. */
  private spawnableRobots(): string[] {
    const entries = this.host.entries();
    return Object.keys(SPECS).filter(robot => {
      try { return selectRobotPolicy(robot, entries, undefined, true).index >= 0; } catch { return false; }
    });
  }

  // ---- simulation --------------------------------------------------------

  private resetWakeClock() { this.lastWake = -1; this.acc = 0; }

  /** One control-loop wake: advance whole ticks covering the real time since the last wake.
   * Returns the delay (ms) until the next tick is due. */
  async wake(now: number, paused: boolean): Promise<number> {
    const scene = this.scene;
    if (!scene || paused) { this.resetWakeClock(); return 50; }
    if (this.lastWake < 0) this.lastWake = now;
    this.acc += (now - this.lastWake) / 1000;
    this.lastWake = now;
    if (this.acc > MAX_CATCHUP) { this.lost += this.acc - MAX_CATCHUP; this.acc = MAX_CATCHUP; }
    let ticks = 0;
    try {
      while (this.acc >= TICK - EPS && !this.pending) {
        await this.tick(scene);
        this.acc -= TICK;
        ticks++;
      }
    } catch (error) {
      console.error(error);
      this.host.post({ t: 'error', msg: `Player simulation step failed: ${error}` });
    }
    if (ticks) this.postFrame(ticks * TICK);
    const action = this.pending;
    if (action) {
      this.pending = null;
      await this.runAction(action);
    }
    if (this.lost > this.lostPosted && now - this.lostPostedAt >= LOST_STATUS_MS) this.postStatus();
    return Math.max(0, (TICK - this.acc) * 1000);
  }

  /** A scene recompile is a deliberate pause, not lost time: the clock restarts after it. */
  private async runAction(action: PendingAction) {
    try {
      if (action.kind === 'spawn') await this.spawn();
      else if (action.kind === 'remove') await this.remove(action.id);
      else await this.handover(action.id, action.next);
    } catch (error) {
      console.error(error);
      this.host.post({ t: 'error', msg: error instanceof Error ? error.message : String(error) });
    } finally {
      this.resetWakeClock();
      this.postStatus();
    }
  }

  private async tick(scene: PlayerScene) {
    const pulse = this.pulse, held = this.held;
    let buttons = held | pulse;
    const pressed = pulse | (held & ~this.prevHeld);
    if (this.wheelJump && this.tool === 'knife') buttons |= PLAYER_BUTTON.jump;
    this.pulse = 0;
    this.wheelJump = false;
    this.prevHeld = held;

    const cmd = this.cmd;
    cmd.yaw = this.yaw; cmd.forward = this.forward; cmd.side = this.side; cmd.buttons = buttons;
    scene.mover.step(this.move, cmd, TICK, this.events);
    this.updateShadow();
    this.eye(scene);
    this.tools(scene, buttons, pressed);

    this.tickEnd += TICK;
    const engine = scene.engine, end = this.tickEnd;
    for (;;) {
      const dt = engine.timestep;
      if (this.simTime + 0.5 * dt > end) break;
      for (const e of this.runtimes) if (this.simTime >= e.nextControl - EPS) await this.control(e);
      this.applyGrab(scene, dt);
      for (const e of this.runtimes) this.substep(e);
      engine.step();
      this.simTime += dt;
    }
  }

  private async control(e: EntityRuntime) {
    const drv = e.driver;
    if (drv && e.status.state === 'alive') {
      if (drv.done) this.queueHandover(e, drv);
      if (e.delay > 0 && e.target) {
        e.prevTarget.set(e.target); e.prevKp.set(drv.kp); e.prevKd.set(drv.kd);
        e.hasPrev = true;
      } else e.hasPrev = false;
      try {
        this.zeroCommand.fill(0);
        e.target = await e.fsm.infer(drv, this.zeroCommand);
      } catch (error) {
        console.error(error);
        this.host.post({ t: 'error', msg: `${e.id}: policy step failed: ${error}` });
        e.fsm.enter('damping');
        e.target = null;
      }
    } else { e.target = null; e.hasPrev = false; }
    e.sub = 0;
    e.nextControl += e.stepDt;
  }

  /** The previous target and gains stay on the motors for the first `delay` substeps (cmd_delay). */
  private substep(e: EntityRuntime) {
    const drv = e.driver;
    if (drv && e.hasPrev && e.sub < e.delay) {
      const kp = drv.kp, kd = drv.kd;
      drv.kp = e.prevKp; drv.kd = e.prevKd;
      e.fsm.substepTorque(drv, e.prevTarget);
      drv.kp = kp; drv.kd = kd;
    } else e.fsm.substepTorque(drv, e.target);
    e.sub++;
  }

  /** Mocap collider: the Source hull (axis-aligned in Source space) in app metres. */
  private updateShadow() {
    const scene = this.scene!, s = this.move, h = s.ducked ? P.duckHeight : P.standHeight, c = this.c;
    c[0] = s.origin[0]; c[1] = s.origin[1]; c[2] = s.origin[2] + h / 2;
    sourceToAppPoint(scene.frame, c, c);
    const mp = scene.engine.mocapPos, m3 = 3 * scene.shadowMocap;
    mp[m3] = c[0]; mp[m3 + 1] = c[1]; mp[m3 + 2] = c[2];
    scene.engine.geomSize[3 * scene.shadowGeom + 2] = h / 2 * INCH;
  }

  /** Eye point and view direction in app space. */
  private eye(scene: PlayerScene) {
    const s = this.move, e = this.eyeApp, d = this.dirApp;
    e[0] = s.origin[0]; e[1] = s.origin[1]; e[2] = s.origin[2] + s.eyeHeight;
    sourceToAppPoint(scene.frame, e, e);
    const y = this.yaw * DEG, p = this.pitch * DEG, cp = Math.cos(p);
    d[0] = cp * Math.cos(y); d[1] = cp * Math.sin(y); d[2] = -Math.sin(p);
    sourceToAppDirection(scene.frame, d, d);
  }

  private tools(scene: PlayerScene, buttons: number, pressed: number) {
    const attack = PLAYER_BUTTON.attack, attack2 = PLAYER_BUTTON.attack2;
    if (this.tool === 'physgun') {
      if (buttons & attack) {
        if (!this.grab && (pressed & attack)) this.tryGrab(scene);
      } else this.releaseGrab();
      const grab = this.grab;
      if (grab) {
        const t = grab.view.target, e = this.eyeApp, d = this.dirApp, r = grab.distance * INCH;
        t[0] = e[0] + d[0] * r; t[1] = e[1] + d[1] * r; t[2] = e[2] + d[2] * r;
        grab.remaining = PHYSGUN_ARRIVE;
      }
    } else if (this.tool === 'spawn') {
      if (!this.pending && (pressed & attack)) this.pending = { kind: 'spawn' };
      else if (!this.pending && (pressed & attack2)) {
        const hit = this.pick(scene, PHYSGUN_RANGE * INCH);
        const runtime = hit ? this.runtimeOfGeom(hit.geom) : null;
        if (runtime) this.pending = { kind: 'remove', id: runtime.id };
      }
    } else if (this.tool === 'knife' && this.knife) {
      const knife = this.knife;
      if (this.knifeHitAt >= 0 && this.simTime >= this.knifeHitAt - EPS) {
        this.knifeHitAt = -1;
        this.knifeHit(scene, knife);
      }
      if ((buttons & attack) && this.simTime >= this.nextKnife - EPS) {
        this.nextKnife = this.simTime + knife.primaryCycle;
        this.knifeHitAt = this.simTime + knife.primaryHitDelay;
        if (knife.primaryHitDelay === 0) { this.knifeHitAt = -1; this.knifeHit(scene, knife); }
      }
    }
  }

  /** One trace per attack: at most one alive robot gains one hit. */
  private knifeHit(scene: PlayerScene, knife: PlayerKnifeTiming) {
    const hit = this.pick(scene, knife.primaryRange * INCH);
    const e = hit ? this.runtimeOfGeom(hit.geom) : null;
    if (!e || e.status.state !== 'alive') return;
    e.status.hits++;
    if (e.status.hits >= KNIFE_RAGDOLL_HITS) {
      e.status.state = 'ragdoll';
      e.fsm.enter('zero_torque');
      e.target = null;
      e.hasPrev = false;
    }
  }

  /** First geom along the view ray that is either robot-owned (visual or collision: the robot the
   * player sees under the crosshair) or a world collision geom. World visual-only geoms are stepped
   * past and the player collider's body is excluded. */
  private pick(scene: PlayerScene, maxDist: number): { geom: number; dist: number } | null {
    const engine = scene.engine, mj = engine.mj;
    const contype = engine.geomContype, conaffinity = engine.geomConaffinity;
    const e = this.eyeApp, d = this.dirApp;
    const start = [e[0], e[1], e[2]], dir = [d[0], d[1], d[2]];
    let travelled = 0;
    for (let i = 0; i < 16; i++) {
      const dist = mj.mj_ray(engine.model, engine.data, start, dir, ALL_GROUPS, 1, scene.shadowBody, scene.ray, null);
      const geom: number = scene.ray.GetView()[0];
      if (dist < 0 || geom < 0) return null;
      travelled += dist;
      if (travelled > maxDist) return null;
      if ((contype[geom] | conaffinity[geom]) !== 0 || this.runtimeOfGeom(geom)) return { geom, dist: travelled };
      const step = dist + 1e-4;
      travelled += 1e-4;
      for (let k = 0; k < 3; k++) start[k] += dir[k] * step;
    }
    return null;
  }

  private runtimeOfGeom(geom: number): EntityRuntime | null {
    for (const e of this.runtimes) if (geom >= e.scope.entity.geomStart && geom < e.scope.entity.geomEnd) return e;
    return null;
  }

  // ---- physics gun -------------------------------------------------------

  private tryGrab(scene: PlayerScene) {
    const hit = this.pick(scene, PHYSGUN_RANGE * INCH);
    if (!hit) return;
    const runtime = this.runtimeOfGeom(hit.geom);
    if (!runtime) return;
    const engine = scene.engine, body = engine.geomBodyId[hit.geom];
    const e = this.eyeApp, d = this.dirApp, x = engine.xpos, R = engine.xmat, q = engine.xquat;
    const px = e[0] + d[0] * hit.dist, py = e[1] + d[1] * hit.dist, pz = e[2] + d[2] * hit.dist;
    const rx = px - x[3 * body], ry = py - x[3 * body + 1], rz = pz - x[3 * body + 2], m = 9 * body;
    const local = Float64Array.of(R[m] * rx + R[m + 3] * ry + R[m + 6] * rz,
      R[m + 1] * rx + R[m + 4] * ry + R[m + 7] * rz, R[m + 2] * rx + R[m + 5] * ry + R[m + 8] * rz);
    const relative = new Float64Array(4);
    yawCompose(-this.appYaw(scene), q[4 * body], q[4 * body + 1], q[4 * body + 2], q[4 * body + 3], relative);
    const point = Float64Array.of(px, py, pz), target = Float64Array.of(px, py, pz);
    this.grab = { runtime, body, local, relative, distance: Math.max(PHYSGUN_MIN_DISTANCE, hit.dist / INCH),
      remaining: PHYSGUN_ARRIVE, applied: new Float64Array(6),
      view: { entity: runtime.id, body, point, target } };
  }

  private releaseGrab() {
    const grab = this.grab;
    if (!grab) return;
    this.grab = null;
    const scene = this.scene;
    if (!scene || grab.runtime.scope.engine !== scene.engine) return;
    const xf = scene.engine.xfrcApplied, o = 6 * grab.body;
    for (let i = 0; i < 6; i++) xf[o + i] -= grab.applied[i];
  }

  private appYaw(scene: PlayerScene): number { return (this.yaw - scene.frame.yawDeg) * DEG; }

  /** Point controller: velocity that arrives at the target within the arrival time (capped at the
   * max speed), reached with acceleration capped at the damping limit, applied at the body's COM
   * with the body's own weight carried; orientation follows the player's yaw the same way. Its
   * wrench is added to xfrc_applied, replacing only its own previous contribution. */
  private applyGrab(scene: PlayerScene, dt: number) {
    const grab = this.grab;
    if (!grab) return;
    const engine = scene.engine, b = grab.body;
    const cvel: Float64Array = engine.data.cvel, com: Float64Array = engine.data.subtree_com, Ri: Float64Array = engine.data.ximat;
    const x = engine.xpos, R = engine.xmat, q = engine.xquat;
    const mass: Float64Array = engine.model.body_mass, inertia: Float64Array = engine.model.body_inertia;
    const l = grab.local, m9 = 9 * b, b3 = 3 * b, root = 3 * engine.bodyRootId[b];
    const point = grab.view.point, target = grab.view.target;
    point[0] = x[b3] + R[m9] * l[0] + R[m9 + 1] * l[1] + R[m9 + 2] * l[2];
    point[1] = x[b3 + 1] + R[m9 + 3] * l[0] + R[m9 + 4] * l[1] + R[m9 + 5] * l[2];
    point[2] = x[b3 + 2] + R[m9 + 6] * l[0] + R[m9 + 7] * l[1] + R[m9 + 8] * l[2];
    const c6 = 6 * b, wx = cvel[c6], wy = cvel[c6 + 1], wz = cvel[c6 + 2];
    const rx = point[0] - com[root], ry = point[1] - com[root + 1], rz = point[2] - com[root + 2];
    const vx = cvel[c6 + 3] + wy * rz - wz * ry, vy = cvel[c6 + 4] + wz * rx - wx * rz, vz = cvel[c6 + 5] + wx * ry - wy * rx;
    const remain = Math.max(grab.remaining, dt);
    grab.remaining = Math.max(0, grab.remaining - dt);

    const lin = this.lin;
    lin[0] = (target[0] - point[0]) / remain; lin[1] = (target[1] - point[1]) / remain; lin[2] = (target[2] - point[2]) / remain;
    clampMagnitude(lin, PHYSGUN_MAX_SPEED);
    lin[0] = (lin[0] - vx) / dt; lin[1] = (lin[1] - vy) / dt; lin[2] = (lin[2] - vz) / dt;
    clampMagnitude(lin, PHYSGUN_MAX_ACCEL);
    const m = mass[b], g = scene.gravity, w = this.wrench;
    w[0] = m * (lin[0] - g[0]); w[1] = m * (lin[1] - g[1]); w[2] = m * (lin[2] - g[2]);

    // Orientation error to the yaw-following target, as a rotation vector.
    const t = this.quat, rel = grab.relative, q4 = 4 * b;
    yawCompose(this.appYaw(scene), rel[0], rel[1], rel[2], rel[3], t);
    const bw = q[q4], bx = -q[q4 + 1], by = -q[q4 + 2], bz = -q[q4 + 3];
    let ew = t[0] * bw - t[1] * bx - t[2] * by - t[3] * bz;
    let ex = t[0] * bx + t[1] * bw + t[2] * bz - t[3] * by;
    let ey = t[0] * by - t[1] * bz + t[2] * bw + t[3] * bx;
    let ez = t[0] * bz + t[1] * by - t[2] * bx + t[3] * bw;
    if (ew < 0) { ew = -ew; ex = -ex; ey = -ey; ez = -ez; }
    const sn = Math.hypot(ex, ey, ez), angle = 2 * Math.atan2(sn, ew), k = sn > 1e-12 ? angle / sn : 2;
    const ang = this.ang;
    ang[0] = ex * k / remain; ang[1] = ey * k / remain; ang[2] = ez * k / remain;
    clampMagnitude(ang, PHYSGUN_MAX_ANGULAR);
    ang[0] = (ang[0] - wx) / dt; ang[1] = (ang[1] - wy) / dt; ang[2] = (ang[2] - wz) / dt;
    clampMagnitude(ang, PHYSGUN_MAX_ANGULAR_ACCEL);
    // τ = R·diag(I)·Rᵀ·α in the body's principal inertia frame.
    const a0 = Ri[m9] * ang[0] + Ri[m9 + 3] * ang[1] + Ri[m9 + 6] * ang[2];
    const a1 = Ri[m9 + 1] * ang[0] + Ri[m9 + 4] * ang[1] + Ri[m9 + 7] * ang[2];
    const a2 = Ri[m9 + 2] * ang[0] + Ri[m9 + 5] * ang[1] + Ri[m9 + 8] * ang[2];
    const i0 = inertia[b3] * a0, i1 = inertia[b3 + 1] * a1, i2 = inertia[b3 + 2] * a2;
    w[3] = Ri[m9] * i0 + Ri[m9 + 1] * i1 + Ri[m9 + 2] * i2;
    w[4] = Ri[m9 + 3] * i0 + Ri[m9 + 4] * i1 + Ri[m9 + 5] * i2;
    w[5] = Ri[m9 + 6] * i0 + Ri[m9 + 7] * i1 + Ri[m9 + 8] * i2;

    const xf = engine.xfrcApplied, o = 6 * b, applied = grab.applied;
    for (let i = 0; i < 6; i++) { xf[o + i] += w[i] - applied[i]; applied[i] = w[i]; }
  }

  // ---- robots --------------------------------------------------------------

  private queueHandover(e: EntityRuntime, drv: BaseDriver) {
    drv.done = false;                                     // only try once per completion
    // A driver may name the policy itself (R1 firmware remote switch, r1_fw.ts), else the config's next_policy.
    let want: string | undefined;
    if ('nextPolicy' in drv) {
      if (typeof drv.nextPolicy === 'string') want = drv.nextPolicy;
      drv.nextPolicy = undefined;
    }
    const r1Next = e.cfg.r1?.next_policy;
    const next = want ?? e.cfg.g1?.next_policy ?? (typeof r1Next === 'string' ? r1Next : undefined);
    if (next && !this.pending) this.pending = { kind: 'handover', id: e.id, next };
  }

  private async handover(id: string, next: string) {
    const e = this.runtimes.find(r => r.id === id);
    if (!e) return;
    const entry = this.host.entries().find(p => p.name === next);
    // The next policy must run on this entity's compiled robot; otherwise this one keeps running.
    if (!entry || specFor(entry, e.spec.robot, true) !== e.spec.robot) return;
    const cfg = await this.host.config(entry);
    await this.compose(this.runtimes.map(r => r === e
      ? { id: r.id, spec: r.spec, entry, cfg, prior: r }
      : { id: r.id, spec: r.spec, entry: r.entry, cfg: r.cfg, prior: r }), false);
  }

  private async spawn() {
    const scene = this.scene;
    if (!scene) throw new Error('The Player world is not loaded.');
    if (this.runtimes.length >= MAX_ROBOTS) throw new Error(`At most ${MAX_ROBOTS} robots can be spawned.`);
    const selection = selectRobotPolicy(this.spawnRobot, this.host.entries(), undefined, true);
    const entry = selection.policies[selection.index];
    if (!entry) throw new Error(`No imported policy pack runs ${this.spawnRobot}. Import one to spawn it.`);
    const spec = getSpec(selection.robot);
    const point = this.robotPlacement(scene);
    const cfg = await this.host.config(entry);
    const id = `robot${this.spawnCounter + 1}`;
    await this.compose([
      ...this.runtimes.map(r => ({ id: r.id, spec: r.spec, entry: r.entry, cfg: r.cfg, prior: r })),
      { id, spec, entry, cfg, place: { point, yaw: this.appYaw(scene) + Math.PI } },
    ], true);
    this.spawnCounter++;
  }

  private async remove(id: string) {
    if (!this.runtimes.some(r => r.id === id)) return;
    await this.compose(this.runtimes.filter(r => r.id !== id)
      .map(r => ({ id: r.id, spec: r.spec, entry: r.entry, cfg: r.cfg, prior: r })), true);
  }

  /** A walkable surface ahead of the player, clear of walls, in app metres. */
  private robotPlacement(scene: PlayerScene): Float64Array {
    const s = this.move, a = this.a, b = this.b, c = this.c, tr = this.tr;
    const y = this.yaw * DEG, fx = Math.cos(y), fy = Math.sin(y);
    a[0] = s.origin[0]; a[1] = s.origin[1]; a[2] = s.origin[2] + P.stepHeight + 1;
    b[0] = a[0] + fx * ROBOT_SPAWN_DISTANCE; b[1] = a[1] + fy * ROBOT_SPAWN_DISTANCE; b[2] = a[2];
    scene.collision.traceHull(a, b, this.probeMins, this.probeMaxs, tr);
    if (tr.startSolid) throw new Error('There is no room in front of you to spawn a robot.');
    let reach = tr.fraction * ROBOT_SPAWN_DISTANCE;
    if (tr.fraction < 1) reach -= ROBOT_SPAWN_BACKOFF;
    if (reach < ROBOT_SPAWN_MIN_DISTANCE) throw new Error('There is no room in front of you to spawn a robot.');
    c[0] = a[0] + fx * reach; c[1] = a[1] + fy * reach; c[2] = a[2];
    b[0] = c[0]; b[1] = c[1]; b[2] = c[2] - GROUND_SEARCH;
    scene.collision.traceHull(c, b, this.probeMins, this.probeMaxs, tr);
    if (tr.startSolid || tr.fraction >= 1 || tr.normal[2] < P.walkableNormal)
      throw new Error('There is no walkable surface in front of you to spawn a robot.');
    return sourceToAppPoint(scene.frame, tr.end, new Float64Array(3));
  }

  /** Build the next robot set. `recompile` composes a new native scene with every planned slot
   * (existing robots keep qpos/qvel, FSM state and hits; new ones are seated); otherwise the
   * drivers are rebuilt on the current engine. Either way every driver is created in one policy
   * session group, so no robot's networks are released by another's load. On failure the
   * current world, its drivers and sessions are unchanged. */
  private async compose(planned: PlannedEntity[], recompile: boolean) {
    const scene = this.scene;
    if (!scene) throw new Error('The Player world is not loaded.');
    this.releaseGrab();
    const old = scene.engine;
    const saved = planned.map(p => p.prior ? snapshot(old, p.prior.scope.entity) : null);
    let engine = old, next = scene;
    if (recompile) {
      const spec: SceneSpec = {
        slots: planned.map(p => ({ id: p.id, robot: p.spec })),
        ...(scene.extra ? { extra: scene.extra } : {}),
      };
      const prepared = await Engine.prepareScene(spec);
      engine = await Engine.createScene(spec, scene.transform, prepared);
    }
    let runtimes: EntityRuntime[];
    try {
      if (engine.entities.length !== planned.length || engine.entities.some((entity, i) => entity.id !== planned[i].id))
        throw new Error('The composed Player scene does not contain the planned robots.');
      if (recompile) next = this.bindScene(engine, scene.terrain, scene.frame, scene.extra, scene.transform, scene.baseTimestep);
      const dt = this.sharedTimestep(planned, next.baseTimestep);
      runtimes = await withPolicySessionGroup(async () => {
        const out: EntityRuntime[] = [];
        for (let i = 0; i < planned.length; i++) out.push(await this.makeRuntime(engine, planned[i], saved[i], dt));
        return out;
      });
      for (let i = 0; i < planned.length; i++) {
        const state = saved[i], runtime = runtimes[i], p = planned[i];
        if (state) restore(engine, runtime.scope.entity, state);
        else if (p.place) this.seat(runtime, p.place.point, p.place.yaw);
      }
      engine.forward();
      for (let i = 0; i < planned.length; i++) runtimes[i].fsm.enter(planned[i].prior?.fsm.state ?? 'policy');
      engine.timestep = dt;
    } catch (error) {
      if (recompile) {
        if (next !== scene) next.ray.delete();
        engine.dispose();
      } else {
        // Driver resets re-seated robots on the live engine: put every one back.
        for (let i = 0; i < planned.length; i++) {
          const state = saved[i], prior = planned[i].prior;
          if (state && prior) restore(old, prior.scope.entity, state);
        }
        old.forward();
      }
      throw error;
    }
    if (recompile) { scene.ray.delete(); old.dispose(); this.scene = next; }
    this.runtimes = runtimes;
    this.entityStates = runtimes.map(r => r.status);
    this.simFrame = this.makeSimFrame();
    this.updateShadow();
    engine.forward();
    if (recompile) this.postModel();
  }

  private sharedTimestep(planned: readonly PlannedEntity[], base: number): number {
    if (!planned.length) return base;
    let dt = Infinity;
    for (const p of planned) dt = Math.min(dt, p.spec.sim_dt, p.cfg.control.sim_dt ?? Infinity);
    return dt;
  }

  private async makeRuntime(engine: Engine, p: PlannedEntity, state: StateSnapshot | null, dt: number): Promise<EntityRuntime> {
    const scope = engine.scope(p.id), entity = scope.entity;
    const status: PlayerEntityState = p.prior?.status ?? { id: p.id, state: 'alive', hits: 0 };
    const driver = status.state === 'alive' ? await makeDriver(p.cfg, p.spec, scope) : null;
    if (driver) {
      const base = entity.rootQpos - entity.qposStart;
      if (state) driver.homeXY = [state.qpos[base], state.qpos[base + 1]];
      else if (p.place) driver.homeXY = [p.place.point[0], p.place.point[1]];
      else throw new Error(`Robot ${p.id} has neither a prior state nor a placement.`);
      driver.reset();
    }
    const n = driver?.kp.length ?? 0;
    return {
      id: p.id, spec: p.spec, entry: p.entry, cfg: p.cfg, scope, fsm: new SimFSM(scope), driver, status,
      stepDt: p.cfg.control.step_dt ?? 0.02, delay: driver ? Math.round((p.cfg.control.cmd_delay ?? 0) / dt) : 0,
      nextControl: this.simTime, target: null, sub: 0, hasPrev: false,
      prevTarget: new Float64Array(n), prevKp: new Float64Array(n), prevKd: new Float64Array(n),
    };
  }

  /** Turn the driver-seated robot to `yaw` about +Z and drop it onto the traced surface. */
  private seat(runtime: EntityRuntime, point: Float64Array, yaw: number) {
    const scope = runtime.scope, q = scope.qpos, b = scope.entity.rootQpos;
    q[b] = point[0]; q[b + 1] = point[1];
    const w = q[b + 3], x = q[b + 4], y = q[b + 5], z = q[b + 6];
    const cy = Math.cos(yaw / 2), sy = Math.sin(yaw / 2);
    q[b + 3] = cy * w - sy * z; q[b + 4] = cy * x - sy * y; q[b + 5] = cy * y + sy * x; q[b + 6] = cy * z + sy * w;
    scope.forward();
    const floor = scope.minGeomZ(scope.allBodyIds());
    q[b + 2] += point[2] + ROBOT_SEAT_CLEARANCE - floor;
    scope.clearVelocity();
    scope.forward();
    if (runtime.driver) runtime.driver.homeXY = [point[0], point[1]];
  }

  // ---- posting -------------------------------------------------------------

  private postModel() {
    const scene = this.scene!, engine = scene.engine, hinges = engine.hinges();
    const identity: SceneIdentity = {
      mode: 'player', robot: null, terrain: scene.terrain, ngeom: engine.model.ngeom, nq: engine.model.nq, baseQadr: -1,
      hinges: hinges.names.map((name, i) => ({ name, qadr: hinges.qadr[i] })),
      entities: engine.entities, sourceFrame: scene.frame,
    };
    this.host.post({ t: 'model', desc: renderModelFromEngine(engine, identity), geometry: scene.geometry });
  }

  private makeSimFrame(): PlayerSimFrame {
    return { origin: this.move.origin, velocity: this.move.velocity, yaw: 0, pitch: 0, grounded: false, groundGeom: -1,
      ducked: false, duckFraction: 0, eyeHeight: P.standEye, colliderBody: -1, thirdPerson: false, tool: 'none',
      grab: null, entities: this.entityStates };
  }

  private postFrame(dt: number) {
    const scene = this.scene!, engine = scene.engine, ids = scene.movingGeomIds;
    this.clock += dt;
    const xpos = new Float32Array(ids.length * 3), xmat = new Float32Array(ids.length * 9);
    copyMovingGeometry(ids, engine.geomXpos, engine.geomXmat, xpos, xmat);
    const qpos = Float64Array.from(engine.qpos);
    const s = this.move, f = this.simFrame;
    f.yaw = this.yaw; f.pitch = this.pitch; f.grounded = s.grounded; f.groundGeom = s.groundGeom;
    f.ducked = s.ducked; f.duckFraction = s.duckFraction; f.eyeHeight = s.eyeHeight;
    f.colliderBody = scene.shadowBody; f.thirdPerson = this.thirdPerson; f.tool = this.tool;
    f.grab = this.grab?.view ?? null;
    const mp = engine.mocapPos, m3 = 3 * scene.shadowMocap;
    this.host.post({ t: 'frame', xpos, xmat, baseX: mp[m3], baseY: mp[m3 + 1], hoistAnchor: null,
      clock: this.clock, qpos, player: f }, [xpos.buffer, xmat.buffer, qpos.buffer]);
  }
}

/** q_out = Rz(yaw) ⊗ (w, x, y, z), all wxyz. */
function yawCompose(yaw: number, w: number, x: number, y: number, z: number, out: Float64Array) {
  const c = Math.cos(yaw / 2), s = Math.sin(yaw / 2);
  out[0] = c * w - s * z; out[1] = c * x - s * y; out[2] = c * y + s * x; out[3] = c * z + s * w;
}

/** The world transform: the terrain/map edit, then the player's mocap collider. */
function playerWorldTransform(terrain: TerrainName, mount: string, frame: SourceFrame): (name: string, xml: string) => string {
  const terrainXml = terrainTransform(terrain, {}, mount);
  const yaw = -frame.yawDeg * DEG, hw = P.halfWidth * INCH, hh = P.standHeight / 2 * INCH;
  const collider = `  <worldbody>\n    <body name="${SHADOW_BODY}" mocap="true" quat="${Math.cos(yaw / 2)} 0 0 ${Math.sin(yaw / 2)}">\n`
    + `      <geom name="${SHADOW_GEOM}" type="box" size="${hw} ${hw} ${hh}" contype="${PLAYER_CONTACT_BIT}" conaffinity="0"`
    + ` group="${SHADOW_GROUP}" rgba="0 0 0 0"/>\n    </body>\n  </worldbody>\n`;
  return (name, xml) => {
    const out = terrainXml(name, xml);
    if (name !== 'scene.xml') return out;
    if (!/<\/mujoco>\s*$/.test(out)) throw new Error('The Player world cannot host the player collider.');
    return out.replace(/<\/mujoco>\s*$/, `${collider}</mujoco>\n`);
  };
}
