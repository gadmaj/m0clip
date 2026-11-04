/** One fixed tick of Source-style walking movement, in Source inches with +Z up.
 *
 * Independent implementation of the documented Source game-movement behavior:
 * split gravity, jump check before friction, ground friction and acceleration,
 * the capped air wish speed that allows strafing, a four-bump multi-plane slide,
 * the up/down step selection, sticking to the ground on the way down, walkable
 * normals and ceiling-safe ducking. The worker owns scheduling and button
 * combination; this module only advances one state by one tick. */
import {
  PLAYER_BUTTON,
  type PlayerCollisionWorld,
  type PlayerMoveCommand,
  type PlayerMoveEvents,
  type PlayerMoveProfile,
  type PlayerMoveState,
  type PlayerTrace,
} from "./types";

/** Garry's Mod Sandbox player defaults on the Source SDK movement rules.
 * Walk/run speeds and duck/unduck time are from Facepunch `player_sandbox.lua`; jump power and
 * crouch scale from its base `player_default.lua`; gravity 600 and friction 8 from the server
 * settings menu (`utilities_menu.lua`); the rest are Source SDK convars (`movevars_shared.cpp`),
 * hulls and view heights (`gamerules.cpp`), `DIST_EPSILON` and the default tick interval. */
export const GMOD_MOVE_PROFILE: PlayerMoveProfile = Object.freeze({
  tickInterval: 0.015,
  gravity: 600,
  friction: 8,
  // Garry's Mod sv_stopspeed is 10 (wiki.facepunch.com/gmod/ConVars_In_Garrysmod), not the SDK's 100.
  // With sv_friction 8, the SDK value outweighs crouch acceleration and pins crouch-walking near 9 u/s.
  stopSpeed: 10,
  groundAccelerate: 10,
  airAccelerate: 10,
  airWishCap: 30,
  jumpImpulse: 200,
  walkSpeed: 200,
  runSpeed: 400,
  duckSpeedScale: 0.3,
  stepHeight: 18,
  walkableNormal: 0.7,
  maxVelocity: 3500,
  skin: 1 / 32,
  halfWidth: 16,
  standHeight: 72,
  duckHeight: 36,
  standEye: 64,
  duckEye: 28,
  duckSeconds: 0.1,
});

/** Upward speed above which the ground probe is skipped: the player is leaving the ground. */
const NON_JUMP_VELOCITY = 140;
/** How far below the feet the ground probe looks. */
const GROUND_PROBE = 2;
/** Surface friction while rising without ground under the feet (scales air acceleration). */
const RISING_SURFACE_FRICTION = 0.25;
const MAX_BUMPS = 4;
const MAX_CLIP_PLANES = 5;
/** Ground snaps shorter than half a coordinate step are ignored. */
const MIN_GROUND_SNAP = 0.5 / 32;
const DEG = Math.PI / 180;

export function createPlayerMoveState(origin?: ArrayLike<number>): PlayerMoveState {
  const o = new Float64Array(3);
  if (origin !== undefined) {
    if (origin.length < 3) throw new RangeError("player origin needs three components");
    for (let i = 0; i < 3; i++) {
      const v = origin[i];
      if (!Number.isFinite(v)) throw new RangeError("player origin must be finite");
      o[i] = v;
    }
  }
  return {
    origin: o,
    velocity: new Float64Array(3),
    grounded: false,
    groundGeom: -1,
    ducked: false,
    duckFraction: 0,
    eyeHeight: GMOD_MOVE_PROFILE.standEye,
    oldButtons: 0,
  };
}

function copyTrace(from: PlayerTrace, to: PlayerTrace): void {
  to.fraction = from.fraction;
  to.end.set(from.end);
  to.normal.set(from.normal);
  to.startSolid = from.startSolid;
  to.allSolid = from.allSolid;
  to.geom = from.geom;
}

function checkProfile(p: PlayerMoveProfile): void {
  const positive: (keyof PlayerMoveProfile)[] = [
    "tickInterval", "walkSpeed", "runSpeed", "maxVelocity", "halfWidth", "standHeight", "duckHeight", "standEye", "duckEye",
  ];
  for (const k of positive) if (!(p[k] > 0) || !Number.isFinite(p[k])) throw new RangeError(`move profile ${k} must be positive`);
  const nonNegative: (keyof PlayerMoveProfile)[] = [
    "gravity", "friction", "stopSpeed", "groundAccelerate", "airAccelerate", "airWishCap", "jumpImpulse",
    "duckSpeedScale", "stepHeight", "skin", "duckSeconds",
  ];
  for (const k of nonNegative) if (!(p[k] >= 0) || !Number.isFinite(p[k])) throw new RangeError(`move profile ${k} must be non-negative`);
  if (!(p.walkableNormal > 0 && p.walkableNormal <= 1)) throw new RangeError("move profile walkableNormal must be in (0, 1]");
  if (p.duckHeight > p.standHeight) throw new RangeError("move profile duckHeight exceeds standHeight");
}

export class PlayerMover {
  private readonly standMins: Float64Array;
  private readonly standMaxs: Float64Array;
  private readonly duckMaxs: Float64Array;
  private readonly tr: PlayerTrace = { fraction: 1, end: new Float64Array(3), normal: new Float64Array(3), startSolid: false, allSolid: false, geom: -1 };
  /** The direct walk trace, handed to the first bump of the step move's ground slide. */
  private readonly walkTr: PlayerTrace = { fraction: 1, end: new Float64Array(3), normal: new Float64Array(3), startSolid: false, allSolid: false, geom: -1 };
  /** Zero-length position tests; only startSolid/allSolid are read from them. */
  private readonly probeTr: PlayerTrace = { fraction: 1, end: new Float64Array(3), normal: new Float64Array(3), startSolid: false, allSolid: false, geom: -1 };
  private readonly start = new Float64Array(3);
  private readonly end = new Float64Array(3);
  private readonly planes = new Float64Array(3 * MAX_CLIP_PLANES);
  private readonly primal = new Float64Array(3);
  private readonly original = new Float64Array(3);
  private readonly stepPos = new Float64Array(3);
  private readonly stepVel = new Float64Array(3);
  private readonly downPos = new Float64Array(3);
  private readonly downVel = new Float64Array(3);

  // Per-tick values, valid only inside step().
  private s!: PlayerMoveState;
  private dt = 0;
  private surfaceFriction = 1;
  private touchedGround = false;
  private events!: PlayerMoveEvents;

  constructor(private readonly world: PlayerCollisionWorld, private readonly profile: PlayerMoveProfile = GMOD_MOVE_PROFILE) {
    checkProfile(profile);
    const w = profile.halfWidth;
    this.standMins = Float64Array.of(-w, -w, 0);
    this.standMaxs = Float64Array.of(w, w, profile.standHeight);
    this.duckMaxs = Float64Array.of(w, w, profile.duckHeight);
  }

  /** Advance one tick. `cmd.buttons` already holds this tick's held buttons and pulses;
   * `events` is overwritten with what happened during this tick. */
  step(state: PlayerMoveState, cmd: PlayerMoveCommand, dt: number, events: PlayerMoveEvents): void {
    if (!(dt > 0) || !Number.isFinite(dt)) throw new RangeError("player tick dt must be positive");
    if (!Number.isFinite(cmd.yaw) || !Number.isFinite(cmd.forward) || !Number.isFinite(cmd.side)) {
      throw new RangeError("player command must be finite");
    }
    const o = state.origin;
    if (!Number.isFinite(o[0]) || !Number.isFinite(o[1]) || !Number.isFinite(o[2])) throw new RangeError("player origin must be finite");

    const p = this.profile;
    const v = state.velocity;
    this.s = state;
    this.dt = dt;
    this.events = events;
    events.jumped = false;
    events.landed = false;
    events.stepHeight = 0;
    this.touchedGround = false;
    const wasGrounded = state.grounded;
    const buttons = cmd.buttons | 0;

    // Wish speed: run applies unless fully ducked; the stick magnitude is capped at max speed.
    const fullyDucked = state.ducked && state.duckFraction >= 1;
    const maxSpeed = (buttons & PLAYER_BUTTON.run) !== 0 && !fullyDucked ? p.runSpeed : p.walkSpeed;
    let fmove = cmd.forward * maxSpeed;
    let smove = cmd.side * maxSpeed;
    const mag = Math.hypot(fmove, smove);
    if (mag > maxSpeed) {
      const k = maxSpeed / mag;
      fmove *= k;
      smove *= k;
    }

    this.categorize();
    this.duck(buttons);
    if (state.ducked && state.grounded) {
      fmove *= p.duckSpeedScale;
      smove *= p.duckSpeedScale;
    }

    // First half of gravity, so the move happens at the tick's average vertical speed.
    v[2] -= p.gravity * 0.5 * dt;
    this.checkVelocity();

    if ((buttons & PLAYER_BUTTON.jump) !== 0) this.checkJump(buttons);

    if (state.grounded) {
      v[2] = 0;
      this.friction();
    }
    this.checkVelocity();

    // Source yaw: forward (cos, sin); right is forward turned clockwise, -Y at yaw 0.
    const yaw = cmd.yaw * DEG;
    const fx = Math.cos(yaw), fy = Math.sin(yaw);
    let wx = fx * fmove + fy * smove;
    let wy = fy * fmove - fx * smove;
    let wishSpeed = Math.hypot(wx, wy);
    if (wishSpeed > 0) {
      wx /= wishSpeed;
      wy /= wishSpeed;
    }
    if (wishSpeed > maxSpeed) wishSpeed = maxSpeed;

    if (state.grounded) this.walkMove(wx, wy, wishSpeed);
    else this.airMove(wx, wy, wishSpeed);

    this.categorize();
    this.checkVelocity();
    v[2] -= p.gravity * 0.5 * dt;
    this.checkVelocity();
    if (state.grounded) v[2] = 0;

    // Smoothstep ease (3x² − 2x³) of the linear duck progress.
    const f = state.duckFraction;
    state.eyeHeight = p.standEye + (p.duckEye - p.standEye) * f * f * (3 - 2 * f);
    state.oldButtons = buttons;
    events.landed = !wasGrounded && this.touchedGround;
  }

  private trace(start: ArrayLike<number>, end: ArrayLike<number>, out: PlayerTrace): void {
    this.world.traceHull(start, end, this.standMins, this.s.ducked ? this.duckMaxs : this.standMaxs, out);
  }

  /** Ground probe: sets ground state, snaps onto walkable ground, and refreshes surface friction. */
  private categorize(): void {
    const s = this.s;
    const o = s.origin;
    const vz = s.velocity[2];
    this.surfaceFriction = 1;
    if (vz > NON_JUMP_VELOCITY) {
      s.grounded = false;
      s.groundGeom = -1;
      return;
    }
    const end = this.end;
    end[0] = o[0];
    end[1] = o[1];
    end[2] = o[2] - GROUND_PROBE;
    const tr = this.tr;
    this.trace(o, end, tr);
    if (!tr.allSolid && tr.fraction < 1 && tr.normal[2] >= this.profile.walkableNormal) {
      s.grounded = true;
      s.groundGeom = tr.geom;
      this.touchedGround = true;
      if (!tr.startSolid && tr.fraction > 0) o.set(tr.end);
    } else {
      s.grounded = false;
      s.groundGeom = -1;
      if (vz > 0) this.surfaceFriction = RISING_SURFACE_FRICTION;
    }
  }

  /** Whether the standing hull fits when swept from the current origin to height `z`
   * (a position test when `z` is the current height). */
  private canStandAt(z: number): boolean {
    const o = this.s.origin;
    const end = this.end;
    end[0] = o[0];
    end[1] = o[1];
    end[2] = z;
    const tr = this.tr;
    this.world.traceHull(o, end, this.standMins, this.standMaxs, tr);
    return !tr.startSolid && !tr.allSolid && (z === o[2] || tr.fraction >= 1);
  }

  /** Duck transition. On the ground the eye eases down over `duckSeconds` before the hull
   * shrinks; in the air the hull shrinks at once by lifting the feet so the head stays put.
   * Standing up needs room for the standing hull, otherwise the player stays ducked. */
  private duck(buttons: number): void {
    const s = this.s;
    const p = this.profile;
    const rate = p.duckSeconds > 0 ? this.dt / p.duckSeconds : Infinity;
    const lift = p.standHeight - p.duckHeight;
    if ((buttons & PLAYER_BUTTON.duck) !== 0) {
      if (!s.ducked) {
        if (!s.grounded) {
          // The ducked hull now covers the top of the old standing hull, which was clear.
          s.origin[2] += lift;
          s.ducked = true;
          s.duckFraction = 1;
          this.categorize();
        } else {
          s.duckFraction = Math.min(1, s.duckFraction + rate);
          if (s.duckFraction >= 1) {
            s.ducked = true;
            this.categorize();
          }
        }
      } else if (s.duckFraction < 1) {
        s.duckFraction = Math.min(1, s.duckFraction + rate);
      }
      return;
    }
    if (s.ducked) {
      if (!s.grounded) {
        if (this.canStandAt(s.origin[2] - lift)) {
          s.origin[2] -= lift;
          s.ducked = false;
          s.duckFraction = 0;
          this.categorize();
        }
      } else if (this.canStandAt(s.origin[2])) {
        s.duckFraction = Math.max(0, s.duckFraction - rate);
        if (s.duckFraction <= 0) {
          s.ducked = false;
          this.categorize();
        }
      } else {
        // Still under something: stay fully ducked until there is headroom.
        s.duckFraction = 1;
      }
    } else if (s.duckFraction > 0) {
      s.duckFraction = Math.max(0, s.duckFraction - rate);
    }
  }

  /** Jumps only from the ground on the tick the button goes down; never while standing up. */
  private checkJump(buttons: number): void {
    const s = this.s;
    if (!s.grounded) return;
    if ((s.oldButtons & PLAYER_BUTTON.jump) !== 0) return;
    if (s.ducked && s.duckFraction < 1 && (buttons & PLAYER_BUTTON.duck) === 0) return;
    const p = this.profile;
    const v = s.velocity;
    s.grounded = false;
    s.groundGeom = -1;
    if (s.ducked || s.duckFraction > 0) v[2] = p.jumpImpulse;
    else v[2] += p.jumpImpulse;
    v[2] -= p.gravity * 0.5 * this.dt;
    this.checkVelocity();
    this.events.jumped = true;
  }

  private friction(): void {
    const v = this.s.velocity;
    const speed = Math.hypot(v[0], v[1], v[2]);
    if (speed < 0.1) return;
    const p = this.profile;
    const control = speed < p.stopSpeed ? p.stopSpeed : speed;
    const drop = control * p.friction * this.surfaceFriction * this.dt;
    const scale = Math.max(speed - drop, 0) / speed;
    v[0] *= scale;
    v[1] *= scale;
    v[2] *= scale;
  }

  private checkVelocity(): void {
    const v = this.s.velocity;
    const max = this.profile.maxVelocity;
    for (let i = 0; i < 3; i++) {
      const x = v[i];
      if (Number.isNaN(x)) v[i] = 0;
      else if (x > max) v[i] = max;
      else if (x < -max) v[i] = -max;
    }
  }

  private accelerate(wx: number, wy: number, wishSpeed: number, accel: number, addCap: number): void {
    const v = this.s.velocity;
    const add = addCap - (v[0] * wx + v[1] * wy);
    if (add <= 0) return;
    let speed = accel * this.dt * wishSpeed * this.surfaceFriction;
    if (speed > add) speed = add;
    v[0] += speed * wx;
    v[1] += speed * wy;
  }

  private walkMove(wx: number, wy: number, wishSpeed: number): void {
    const s = this.s;
    const o = s.origin;
    const v = s.velocity;
    v[2] = 0;
    this.accelerate(wx, wy, wishSpeed, this.profile.groundAccelerate, wishSpeed);
    v[2] = 0;
    if (Math.hypot(v[0], v[1]) < 1) {
      v[0] = 0;
      v[1] = 0;
      return;
    }
    const dest = this.end;
    dest[0] = o[0] + v[0] * this.dt;
    dest[1] = o[1] + v[1] * this.dt;
    dest[2] = o[2];
    const tr = this.walkTr;
    this.trace(o, dest, tr);
    if (tr.fraction >= 1 && !tr.startSolid) {
      o.set(tr.end);
      this.stayOnGround();
      return;
    }
    this.stepMove();
    this.stayOnGround();
  }

  private airMove(wx: number, wy: number, wishSpeed: number): void {
    const p = this.profile;
    // The add term is capped at the air wish cap; the acceleration term keeps the full wish speed.
    this.accelerate(wx, wy, wishSpeed, p.airAccelerate, Math.min(wishSpeed, p.airWishCap));
    this.tryPlayerMove(false);
  }

  /** Slides along the ground and over a raised step, then keeps whichever went farther. */
  private stepMove(): void {
    const s = this.s;
    const o = s.origin;
    const v = s.velocity;
    const p = this.profile;
    const stepPos = this.stepPos, stepVel = this.stepVel, downPos = this.downPos, downVel = this.downVel;
    stepPos.set(o);
    stepVel.set(v);

    this.tryPlayerMove(true);
    downPos.set(o);
    downVel.set(v);

    o.set(stepPos);
    v.set(stepVel);
    const reach = p.stepHeight + p.skin;
    const end = this.end;
    const tr = this.tr;
    end[0] = o[0];
    end[1] = o[1];
    end[2] = o[2] + reach;
    this.trace(o, end, tr);
    if (!tr.startSolid && !tr.allSolid) o.set(tr.end);

    this.tryPlayerMove(false);

    end[0] = o[0];
    end[1] = o[1];
    end[2] = o[2] - reach;
    this.trace(o, end, tr);
    if (tr.startSolid || tr.allSolid || tr.fraction >= 1 || tr.normal[2] < p.walkableNormal) {
      o.set(downPos);
      v.set(downVel);
      this.events.stepHeight += Math.max(0, o[2] - stepPos[2]);
      return;
    }
    o.set(tr.end);
    const downDist = (downPos[0] - stepPos[0]) ** 2 + (downPos[1] - stepPos[1]) ** 2;
    const upDist = (o[0] - stepPos[0]) ** 2 + (o[1] - stepPos[1]) ** 2;
    if (downDist > upDist) {
      o.set(downPos);
      v.set(downVel);
    } else {
      v[2] = downVel[2];
    }
    this.events.stepHeight += Math.max(0, o[2] - stepPos[2]);
  }

  /** Keeps a walking player on stairs and slopes going down, up to one step below. */
  private stayOnGround(): void {
    const o = this.s.origin;
    const p = this.profile;
    const start = this.start;
    const end = this.end;
    const tr = this.tr;
    end[0] = o[0];
    end[1] = o[1];
    end[2] = o[2] + GROUND_PROBE;
    this.trace(o, end, tr);
    if (tr.startSolid || tr.allSolid) return;
    start.set(tr.end);
    end[2] = o[2] - p.stepHeight;
    this.trace(start, end, tr);
    if (tr.fraction > 0 && tr.fraction < 1 && !tr.startSolid && !tr.allSolid && tr.normal[2] >= p.walkableNormal
      && Math.abs(o[2] - tr.end[2]) > MIN_GROUND_SNAP) {
      o.set(tr.end);
    }
  }

  /** Moves along the velocity for the rest of the tick, clipping against up to five planes
   * over four bumps. `reuseWalkTrace` takes the first bump from the direct walk trace. */
  private tryPlayerMove(reuseWalkTrace: boolean): void {
    const s = this.s;
    const o = s.origin;
    const v = s.velocity;
    const planes = this.planes;
    const primal = this.primal;
    const original = this.original;
    const end = this.end;
    const tr = this.tr;
    primal.set(v);
    original.set(v);
    let numPlanes = 0;
    let allFraction = 0;
    let timeLeft = this.dt;

    for (let bump = 0; bump < MAX_BUMPS; bump++) {
      if (v[0] === 0 && v[1] === 0 && v[2] === 0) break;
      if (bump === 0 && reuseWalkTrace) {
        copyTrace(this.walkTr, tr);
      } else {
        end[0] = o[0] + timeLeft * v[0];
        end[1] = o[1] + timeLeft * v[1];
        end[2] = o[2] + timeLeft * v[2];
        this.trace(o, end, tr);
      }
      allFraction += tr.fraction;
      if (tr.allSolid) {
        v.fill(0);
        return;
      }
      if (tr.fraction > 0) {
        if (tr.fraction >= 1) {
          // A swept hull can finish embedded; never accept an end position that is stuck.
          const probe = this.probeTr;
          this.trace(tr.end, tr.end, probe);
          if (probe.startSolid || probe.allSolid) {
            v.fill(0);
            break;
          }
        }
        o.set(tr.end);
        original.set(v);
        numPlanes = 0;
      }
      if (tr.fraction >= 1) break;

      timeLeft -= timeLeft * tr.fraction;
      if (numPlanes >= MAX_CLIP_PLANES) {
        v.fill(0);
        break;
      }
      planes.set(tr.normal, numPlanes * 3);
      numPlanes++;

      if (numPlanes === 1 && !s.grounded) {
        clipVelocity(original, planes, 0, v);
        original.set(v);
        continue;
      }
      let i = 0;
      for (; i < numPlanes; i++) {
        clipVelocity(original, planes, i * 3, v);
        let j = 0;
        for (; j < numPlanes; j++) {
          if (j !== i && v[0] * planes[j * 3] + v[1] * planes[j * 3 + 1] + v[2] * planes[j * 3 + 2] < 0) break;
        }
        if (j === numPlanes) break;
      }
      if (i === numPlanes) {
        // Wedged between planes: only a two-plane crease can still be followed.
        if (numPlanes !== 2) {
          v.fill(0);
          break;
        }
        let cx = planes[1] * planes[5] - planes[2] * planes[4];
        let cy = planes[2] * planes[3] - planes[0] * planes[5];
        let cz = planes[0] * planes[4] - planes[1] * planes[3];
        const len = Math.hypot(cx, cy, cz);
        if (len === 0) {
          v.fill(0);
          break;
        }
        cx /= len;
        cy /= len;
        cz /= len;
        const d = cx * v[0] + cy * v[1] + cz * v[2];
        v[0] = cx * d;
        v[1] = cy * d;
        v[2] = cz * d;
      }
      // Turned back against the original direction: stop instead of jittering in a corner.
      if (v[0] * primal[0] + v[1] * primal[1] + v[2] * primal[2] <= 0) {
        v.fill(0);
        break;
      }
    }
    if (allFraction === 0) v.fill(0);
  }
}

/** Removes the into-plane component of `input`, with a second pass against rounding. */
function clipVelocity(input: Float64Array, planes: Float64Array, at: number, out: Float64Array): void {
  const nx = planes[at], ny = planes[at + 1], nz = planes[at + 2];
  const back = input[0] * nx + input[1] * ny + input[2] * nz;
  out[0] = input[0] - nx * back;
  out[1] = input[1] - ny * back;
  out[2] = input[2] - nz * back;
  const adjust = out[0] * nx + out[1] * ny + out[2] * nz;
  if (adjust < 0) {
    out[0] -= nx * adjust;
    out[1] -= ny * adjust;
    out[2] -= nz * adjust;
  }
}
