/** Source/Garry's Mod movement parity for the real PlayerMover, without a browser or MuJoCo.
 * A small box world stands in for the map: each solid is an axis-aligned box, and hull traces
 * stop DIST_EPSILON in front of the entered face, as Source's brush traces do. Expected speeds
 * come from the Source game-movement rules (friction, acceleration, air wish cap) and Garry's Mod
 * Sandbox's jump boost, written out here rather than read back from the mover. */
import assert from 'node:assert/strict';
import buildFixture from './build-fixture.cjs';
import { rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const root = process.cwd();
const fixture = resolve(root, `.player-movement-test-${process.pid}.mjs`);
const { code } = await buildFixture({ root, platform: 'node', format: 'es', externalPackages: true, source:
  "export {PlayerMover,createPlayerMoveState,GMOD_MOVE_PROFILE} from './src/player/movement';" +
  "export {PLAYER_BUTTON} from './src/player/types';" });
await writeFile(fixture, code);

const EPS = 1 / 32;
const close = (actual, expected, label, tol = 1e-9) =>
  assert.ok(Math.abs(actual - expected) <= tol, `${label}: expected ${expected}, got ${actual}`);

/** Solid boxes `{min: [x,y,z], max: [x,y,z]}`; a hull at origin o spans o+mins..o+maxs. */
function boxWorld(boxes) {
  return {
    traceHull(start, end, mins, maxs, out) {
      out.fraction = 1; out.startSolid = false; out.allSolid = false; out.geom = -1; out.normal.fill(0);
      boxes.forEach((b, geom) => {
        let enter = -1, leave = 1, startOut = false, getOut = false, axis = -1, sign = 0;
        for (let a = 0; a < 3; a++) for (const s of [1, -1]) {
          // Face of the box grown by the hull, outward normal s along axis a.
          const dist = s > 0 ? b.max[a] - mins[a] : maxs[a] - b.min[a];
          const d1 = s * start[a] - dist, d2 = s * end[a] - dist;
          if (d2 > 0) getOut = true;
          if (d1 > 0) startOut = true;
          if (d1 > 0 && (d2 >= EPS || d2 >= d1)) return; // never reaches this box
          if (d1 <= 0 && d2 <= 0) continue;
          if (d1 > d2) {
            const f = (d1 - EPS) / (d1 - d2);
            if (f > enter) { enter = f; axis = a; sign = s; }
          } else leave = Math.min(leave, (d1 + EPS) / (d1 - d2));
        }
        if (!startOut) {
          out.startSolid = true;
          if (!getOut) { out.allSolid = true; out.fraction = 0; out.geom = geom; }
          return;
        }
        if (enter < leave && enter > -1 && enter < out.fraction) {
          out.fraction = Math.max(0, enter);
          out.normal.fill(0);
          out.normal[axis] = sign;
          out.geom = geom;
        }
      });
      for (let i = 0; i < 3; i++) out.end[i] = start[i] + out.fraction * (end[i] - start[i]);
    },
  };
}

const FLOOR = { min: [-1e4, -1e4, -64], max: [1e4, 1e4, 0] };

try {
  const { PlayerMover, createPlayerMoveState, GMOD_MOVE_PROFILE: P, PLAYER_BUTTON: B } = await import(pathToFileURL(fixture));
  const dt = P.tickInterval;
  const events = { jumped: false, landed: false, stepHeight: 0 };

  function player(boxes = [FLOOR], origin = [0, 0, EPS], grounded = true) {
    const mover = new PlayerMover(boxWorld(boxes), P);
    const state = createPlayerMoveState(origin);
    const cmd = { yaw: 0, forward: 0, side: 0, buttons: 0 };
    const tick = (n = 1) => { for (let i = 0; i < n; i++) mover.step(state, cmd, dt, events); };
    tick(); // settle onto the floor
    assert.equal(state.grounded, grounded, grounded ? 'the player starts on the floor' : 'the player starts in the air');
    return { state, cmd, tick };
  }
  const speed2d = s => Math.hypot(s.velocity[0], s.velocity[1]);

  /** Ground speed after one tick of Source friction then Accelerate along the velocity. */
  function groundTick(v, wish) {
    if (v >= 0.1) v = Math.max(v - Math.max(v, P.stopSpeed) * P.friction * dt, 0);
    const add = wish - v;
    if (add > 0) v += Math.min(P.groundAccelerate * dt * wish, add);
    return v < 1 ? 0 : v;
  }

  let failed = 0;
  async function run(name, fn) {
    try { await fn(); console.log(`ok - ${name}`); }
    catch (error) { failed++; console.log(`not ok - ${name}`); console.log(error); }
  }

  await run('ground walking settles at walk speed under GMod friction and acceleration', () => {
    const { state, cmd, tick } = player();
    cmd.forward = 1;
    let v = 0;
    for (let i = 0; i < 40; i++) { tick(); v = groundTick(v, P.walkSpeed); close(speed2d(state), v, `tick ${i}`, 1e-6); }
    tick(200);
    close(speed2d(state), P.walkSpeed, 'steady walk', 1e-6);
  });

  await run('slow ground speeds bleed at least sv_stopspeed (10 in GMod)', () => {
    const { state, tick } = player();
    state.velocity[0] = 5;
    tick();
    close(state.velocity[0], 5 - P.stopSpeed * P.friction * dt, 'stopspeed control');
  });

  await run('air acceleration adds at most the 30 u/s wish cap, so strafing gains speed', () => {
    const { state, cmd, tick } = player([FLOOR], [0, 0, 500], false);
    state.velocity.set([300, 0, 0]);
    cmd.side = -1; // yaw 0 faces +X, so moving left is +Y, square to the velocity
    tick();
    close(state.velocity[1], P.airWishCap, 'one tick of air acceleration');
    close(speed2d(state), Math.hypot(300, P.airWishCap), 'strafe speed gain');
  });

  await run('walking climbs an 18 unit step and stops at a 20 unit one', () => {
    for (const [h, climbs] of [[18, true], [20, false]]) {
      const { state, cmd, tick } = player([FLOOR, { min: [40, -1e4, -64], max: [1e4, 1e4, h] }]);
      cmd.forward = 1;
      tick(60);
      if (climbs) {
        close(state.origin[2], h + EPS, 'stands on the step', 1e-6);
        assert.ok(state.origin[0] > 40, 'walked onto the step');
      } else {
        close(state.origin[2], EPS, 'stays on the floor', 1e-6);
        close(state.origin[0], 40 - P.halfWidth - EPS, 'blocked by the riser', 1e-6);
      }
    }
  });

  // Source Duck() crops the move by the ducked state from before this tick's duck transition
  // (HandleDuckingSpeedCrop runs before FinishDuck/FinishUnDuck).
  await run('the tick that completes a ground duck still moves at full wish speed', () => {
    const { state, cmd, tick } = player();
    cmd.forward = 1;
    cmd.buttons = B.duck;
    const ticksToDuck = Math.ceil(P.duckSeconds / dt - 1e-9);
    let v = 0;
    for (let i = 1; i <= ticksToDuck + 2; i++) {
      tick();
      v = groundTick(v, i <= ticksToDuck ? P.walkSpeed : P.walkSpeed * P.duckSpeedScale);
      close(speed2d(state), v, `duck tick ${i}`, 1e-6);
    }
    assert.equal(state.ducked, true);
  });

  await run('the tick that completes a ground unduck is still cropped', () => {
    const { state, cmd, tick } = player();
    cmd.forward = 1;
    cmd.buttons = B.duck;
    tick(300);
    const crouch = P.walkSpeed * P.duckSpeedScale;
    close(speed2d(state), crouch, 'steady crouch walk', 1e-6);
    cmd.buttons = 0;
    const ticksToStand = Math.ceil(P.duckSeconds / dt - 1e-9);
    let v = crouch;
    for (let i = 1; i <= ticksToStand + 1; i++) {
      tick();
      v = groundTick(v, i <= ticksToStand ? crouch : P.walkSpeed);
      close(speed2d(state), v, `unduck tick ${i}`, 1e-6);
    }
    assert.equal(state.ducked, false);
  });

  // Garry's Mod Sandbox (player_sandbox.lua StartMove/FinishMove): a jump pressed on the ground
  // adds half the forward move (a tenth while crouched) along the flat view direction, with the
  // horizontal speed clamped to 1.5x (1.1x) max speed and the boost reversed when moving backward.
  await run('a GMod Sandbox jump adds half the forward move along the view', () => {
    const { state, cmd, tick } = player();
    cmd.forward = 1;
    tick(200);
    close(speed2d(state), P.walkSpeed, 'steady walk');
    cmd.buttons = B.jump;
    tick();
    assert.equal(events.jumped, true);
    close(state.velocity[0], P.walkSpeed * 1.5, 'boosted forward speed');
    close(state.velocity[1], 0, 'no sideways boost');
  });

  await run('the GMod jump boost is reversed when moving backward', () => {
    const { state, cmd, tick } = player();
    cmd.yaw = 90;
    cmd.forward = -1;
    tick(200);
    close(state.velocity[1], -P.walkSpeed, 'steady backpedal', 1e-6);
    cmd.buttons = B.jump;
    tick();
    close(state.velocity[1], -P.walkSpeed * 1.5, 'boosted backward speed', 1e-6);
  });

  await run('the GMod jump boost clamps horizontal speed to 1.5x max speed', () => {
    const { state, cmd, tick } = player();
    state.velocity.set([350, 0, 0]);
    cmd.forward = 1;
    cmd.buttons = B.jump;
    tick();
    assert.equal(events.jumped, true);
    close(state.velocity[0], P.walkSpeed * 1.5, 'clamped jump speed');
  });

  await run('a crouched GMod jump adds a tenth of the cropped forward move', () => {
    const { state, cmd, tick } = player();
    cmd.forward = 1;
    cmd.buttons = B.duck;
    tick(300);
    const crouch = P.walkSpeed * P.duckSpeedScale;
    close(speed2d(state), crouch, 'steady crouch walk', 1e-6);
    cmd.buttons = B.duck | B.jump;
    tick();
    assert.equal(events.jumped, true);
    close(state.velocity[0], crouch * 1.1, 'crouched boost', 1e-6);
  });

  await run('holding jump does not boost again in the air or on landing', () => {
    const { state, cmd, tick } = player();
    cmd.forward = 1;
    tick(200);
    cmd.buttons = B.jump;
    tick();
    close(state.velocity[0], P.walkSpeed * 1.5, 'first boost');
    tick();
    close(state.velocity[0], P.walkSpeed * 1.5, 'no boost while airborne');
    for (let i = 0; i < 200 && !state.grounded; i++) tick();
    assert.equal(state.grounded, true, 'landed');
    assert.ok(speed2d(state) <= P.walkSpeed * 1.5 + 1e-9, 'no boost on landing while jump is held');
  });

  // GMod's formula alone lets a hop square to the view gain speed on every jump; m0clip caps it.
  await run('repeated side hops above the boost limit never gain speed', () => {
    const { state, cmd, tick } = player();
    state.velocity.set([0, 700, 0]);
    cmd.yaw = 0; // facing +X, moving +Y: square to the view
    let previous = Infinity;
    for (let hop = 0; hop < 5; hop++) {
      cmd.buttons = 0;
      for (let i = 0; i < 200 && !state.grounded; i++) tick();
      assert.equal(state.grounded, true, `on the floor before hop ${hop}`);
      state.velocity.set([0, 700, 0]);
      cmd.buttons = B.jump;
      tick();
      assert.equal(events.jumped, true, `hop ${hop} jumped`);
      assert.ok(speed2d(state) <= 700 + 1e-9, `hop ${hop} speed ${speed2d(state)} stays at or below its take-off speed`);
      assert.ok(speed2d(state) <= previous + 1e-9, `hop ${hop} does not compound`);
      previous = speed2d(state);
    }
  });

  await run('landed is reported only on the tick that touches the ground', () => {
    const { state, cmd, tick } = player();
    cmd.buttons = B.jump;
    tick();
    cmd.buttons = 0;
    assert.equal(state.grounded, false, 'airborne after the jump');
    let airborneLanded = 0, landings = 0;
    for (let i = 0; i < 200; i++) {
      const wasAirborne = !state.grounded;
      tick();
      if (events.landed) landings++;
      if (events.landed && !state.grounded) airborneLanded++;
      if (wasAirborne && state.grounded) { assert.equal(events.landed, true, 'the touchdown tick reports landed'); break; }
    }
    assert.equal(airborneLanded, 0, 'no airborne tick reports landed');
    assert.equal(landings, 1, 'exactly one landing');
  });

  if (failed) { console.log(`${failed} failed`); process.exitCode = 1; }
} finally {
  await rm(fixture, { force: true });
}
