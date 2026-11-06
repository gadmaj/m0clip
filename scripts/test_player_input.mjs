/** Player controls end to end without a browser: the real PlayerInputController receives
 * dispatched DOM events, and its frames drive the real PlayerWorld (MuJoCo flat world, PlayerMover)
 * on simulated worker ticks. Assertions read the worker's posted player frames and status. */
import assert from 'node:assert/strict';
import buildFixture from './build-fixture.cjs';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const root = process.cwd();
const fixture = resolve(root, `.player-input-test-${process.pid}.mjs`);
const { code } = await buildFixture({ root, platform: 'node', format: 'es', externalPackages: true, source:
  "export {PlayerWorld} from './src/worker/player-world';export {PlayerInputController} from './src/player/input';" +
  "export {GMOD_MOVE_PROFILE} from './src/player/movement';export {PlayerTakeRecorder,validPlayerTracks} from './src/record/player-take';" +
  "export {PLAYER_BUTTON} from './src/player/types';" });
await writeFile(fixture, code
  .replaceAll('"/wasm/mujoco.js"', JSON.stringify(pathToFileURL(resolve(root, 'node_modules/mujoco/mujoco.js')).href))
  .replaceAll('"/wasm/mujoco.wasm"', JSON.stringify(resolve(root, 'node_modules/mujoco/mujoco.wasm'))));
globalThis.fetch = async url => {
  try { return new Response(await readFile(resolve(root, 'public' + new URL(url, 'http://local').pathname))); }
  catch { return new Response('', { status: 404 }); }
};

// The DOM surface the controller listens to.
globalThis.window = new EventTarget();
const doc = globalThis.document = Object.assign(new EventTarget(), {
  pointerLockElement: null, hidden: false,
  exitPointerLock() { if (doc.pointerLockElement) { doc.pointerLockElement = null; doc.dispatchEvent(new Event('pointerlockchange')); } },
});
const canvas = Object.assign(new EventTarget(), {
  requestPointerLock() { doc.pointerLockElement = canvas; doc.dispatchEvent(new Event('pointerlockchange')); return Promise.resolve(); },
});
const event = (type, fields) => Object.assign(new Event(type, { cancelable: true }), fields);

const KNIFE = { primaryRange: 32, primaryCycle: 0.4, primaryHitDelay: 0.1 };

try {
  const { PlayerWorld, PlayerInputController, GMOD_MOVE_PROFILE, PlayerTakeRecorder, validPlayerTracks, PLAYER_BUTTON } =
    await import(pathToFileURL(fixture));
  const tickMs = GMOD_MOVE_PROFILE.tickInterval * 1000;

  /** One Player world wired as App and the worker wire it; `raf()` stands for App's frame loop. */
  async function session(tools = ['physgun', 'spawn', 'knife']) {
    const s = Object.setPrototypeOf({ frames: [], status: null, sent: [], toolRequests: [], distances: [], errors: [], blocked: false, now: 0, models: [] }, proto);
    s.world = new PlayerWorld({ post(m) {
      if (m.t === 'frame') {
        const p = m.player;
        s.frames.push({ z: p.origin[2], x: p.origin[0], y: p.origin[1], speed: Math.hypot(p.velocity[0], p.velocity[1]),
          vz: p.velocity[2], grounded: p.grounded, tool: p.tool, third: p.thirdPerson });
        s.onFrame?.(m);
      } else if (m.t === 'playerStatus') {
        s.status = m;
        s.input?.setAvailableTools(m.availableTools);
        s.input?.confirmTool(m.tool);
      } else if (m.t === 'model') s.models.push(m);
      else if (m.t === 'error') s.errors.push(m.msg);
    },
    // No imported policies: the spawn gun is available but has no robot to place.
    entries: () => [],
    config: () => Promise.reject(new Error('No policies in this test.')) });
    const plan = await s.world.prepare('flat', null);
    assert.equal(await s.world.load(plan, { tools, knifeTiming: KNIFE }, () => true), true);
    s.input = new PlayerInputController(canvas, {
      blocked: () => s.blocked,
      input: frame => { s.sent.push(structuredClone(frame)); s.world.input(structuredClone(frame)); },
      tool: tool => { s.toolRequests.push(tool); s.world.selectTool(tool); },
      unavailable: () => {}, inspect: () => {}, spawnMenu: () => {},
      holdDistance: direction => { s.distances.push(direction); s.world.wheel(direction); },
      locked: locked => { if (!locked) s.world.stop(); },
      thirdPerson: () => {}, lockError: error => { throw error; }, lockRequested: () => {},
    });
    s.world.postStatus();
    s.input.setEnabled(true);
    s.input.requestLock();
    await s.settle();
    // The first wake only starts the worker's real-time clock; each later one runs one tick.
    await s.world.wake(s.now, false);
    await s.ticks(2);
    return s;
  }
  const proto = {
    async settle() { await new Promise(r => setImmediate(r)); },
    raf() { this.input.update(); },
    async ticks(n) { for (let i = 0; i < n; i++) { this.now += tickMs; await this.world.wake(this.now, false); } },
    key(code, down, repeat = false) { this.input.key({ code, repeat, preventDefault() {} }, down); },
    wheel(clicks, { alt = false, shift = false } = {}) {
      // Chrome reports Shift+wheel on the horizontal axis; one click is 120 legacy units, opposite in sign.
      const delta = 100 * clicks, legacy = -120 * clicks;
      window.dispatchEvent(event('wheel', { altKey: alt, shiftKey: shift,
        deltaY: shift ? 0 : delta, deltaX: shift ? delta : 0, wheelDeltaY: shift ? 0 : legacy, wheelDeltaX: shift ? legacy : 0 }));
    },
    /** Dispatch DOM mouse/pointer events in browser order; downs target the locked canvas. */
    mouse(...steps) { for (const [type, button] of steps) (type.endsWith('down') ? canvas : window).dispatchEvent(event(type, { button })); },
    /** Takeoffs: ticks where the player leaves the ground moving up. */
    takeoffs(from = 0) {
      let n = 0;
      for (let i = Math.max(1, from); i < this.frames.length; i++)
        if (this.frames[i - 1].grounded && !this.frames[i].grounded && this.frames[i].vz > 0) n++;
      return n;
    },
    last() { return this.frames[this.frames.length - 1]; },
    async land() { for (let i = 0; i < 200 && !this.last().grounded; i++) await this.ticks(1); assert.ok(this.last().grounded, 'player landed'); },
    dispose() { this.input.dispose(); doc.pointerLockElement = null; },
  };
  const run = async (name, body, tools) => {
    const s = await session(tools);
    try { await body(s); console.log(`ok ${name}`); } finally { s.dispose(); }
  };

  await run('a new world starts with its first tool, and wheel down jumps with every tool without switching', async s => {
    assert.equal(s.status.tool, 'physgun');
    assert.equal(s.input.tool, 'physgun');
    for (const [slot, tool] of [['Digit2', 'physgun'], ['Digit3', 'spawn'], ['Digit1', 'knife']]) {
      s.key(slot, true); s.key(slot, false); await s.settle(); s.raf();
      await s.land();
      const from = s.frames.length - 1, requests = s.toolRequests.length;
      s.wheel(1); await s.settle(); s.raf();
      await s.ticks(4);
      assert.equal(s.takeoffs(from), 1, `wheel down jumps with the ${tool}`);
      assert.equal(s.last().tool, tool, `wheel down keeps the ${tool}`);
      assert.equal(s.input.tool, tool);
      assert.equal(s.toolRequests.length, requests, 'wheel down requested no tool');
    }
  });

  await run('wheel down jumps with no tool at all', async s => {
    assert.equal(s.status.tool, 'none');
    s.wheel(1); await s.settle(); s.raf();
    await s.ticks(4);
    assert.equal(s.takeoffs(), 1);
    assert.equal(s.last().tool, 'none');
  }, []);

  await run('Shift+wheel down (running) jumps', async s => {
    s.key('ShiftLeft', true); await s.settle();
    s.wheel(1, { shift: true }); await s.settle(); s.raf();
    await s.ticks(4);
    assert.equal(s.takeoffs(), 1);
    assert.equal(s.last().tool, 'physgun');
  });

  await run('a click per tick keeps hopping: each landing jumps again', async s => {
    for (let i = 0; i < 160; i++) { s.wheel(1); await s.settle(); s.raf(); await s.ticks(1); }
    // 200 in/s jump against 600 in/s² gravity is ~0.67 s in the air: 160 ticks (2.4 s) hold three landings.
    assert.ok(s.takeoffs() >= 3, `expected repeated hops, got ${s.takeoffs()}`);
    assert.equal(s.last().tool, 'physgun');
  });

  await run('held Space jumps once and does not bunny hop by itself', async s => {
    s.key('Space', true); await s.settle(); s.raf();
    for (let i = 0; i < 160; i++) { s.key('Space', true, true); await s.settle(); s.raf(); await s.ticks(1); }
    assert.equal(s.takeoffs(), 1);
    assert.ok(s.last().grounded, 'landed while Space was held');
    s.key('Space', false); await s.settle(); s.raf();
    s.key('Space', true); await s.settle(); s.raf();
    await s.ticks(4);
    // Already landed: the release and the new press arrive between the same two ticks.
    assert.equal(s.takeoffs(), 2, 'a Space press after a release within one tick jumps');
    s.key('Space', false); await s.settle();
  });

  await run('wheel clicks while Space is held still jump on landing', async s => {
    s.key('Space', true); await s.settle(); s.raf();
    await s.ticks(2);
    assert.equal(s.takeoffs(), 1);
    await s.land();
    s.wheel(1); await s.settle(); s.raf();
    await s.ticks(4);
    assert.equal(s.takeoffs(), 2);
  });

  await run('focus loss and unlock cancel a press the worker has not simulated', async s => {
    s.key('Space', true); await s.settle(); s.raf();
    window.dispatchEvent(new Event('blur')); await s.settle();
    await s.ticks(30);
    assert.equal(s.takeoffs(), 0, 'blur after Space');
    s.wheel(1); await s.settle(); s.raf();
    window.dispatchEvent(new Event('blur')); await s.settle();
    await s.ticks(30);
    assert.equal(s.takeoffs(), 0, 'blur after a wheel click');
    s.wheel(1); await s.settle(); s.raf();
    doc.exitPointerLock(); await s.settle();
    await s.ticks(30);
    assert.equal(s.takeoffs(), 0, 'pointer unlock after a wheel click');
    s.input.requestLock(); await s.settle();
    s.wheel(1); await s.settle(); s.raf();
    await s.ticks(4);
    assert.equal(s.takeoffs(), 1, 'the next press after relocking jumps');
  });

  await run('a press released before a worker tick is still cancelled by focus loss', async s => {
    const tap = async (press, release) => { press(); await s.settle(); release(); await s.settle(); };
    const space = () => tap(() => s.key('Space', true), () => s.key('Space', false));
    await space();
    window.dispatchEvent(new Event('blur')); await s.settle();
    await s.ticks(30);
    assert.equal(s.takeoffs(), 0, 'Space tap, then blur');
    await space();
    await s.ticks(4);
    assert.equal(s.takeoffs(), 1, 'the same tap without blur jumps');
    // The spawn gun reports its click as an attempt; this world has no policy to spawn with.
    s.key('Digit3', true); s.key('Digit3', false); await s.settle();
    const click = () => tap(() => s.mouse(['pointerdown', 0], ['mousedown', 0]), () => s.mouse(['pointerup', 0], ['mouseup', 0]));
    await click();
    window.dispatchEvent(new Event('blur')); await s.settle();
    await s.ticks(5);
    assert.deepEqual(s.errors, [], 'left click, then blur');
    await click();
    await s.ticks(5);
    assert.equal(s.errors.length, 1, 'the same click without blur reaches the spawn gun');
    // Exactly one release frame per transition, even after a neutral frame.
    const before = s.sent.length;
    window.dispatchEvent(new Event('blur')); window.dispatchEvent(new Event('blur')); await s.settle();
    assert.equal(s.sent.length, before + 1);
  });

  await run('Alt+wheel sets a held object\'s reach; plain wheel never does', async s => {
    s.input.setHoldingObject(true);
    s.wheel(-1, { alt: true }); s.wheel(2, { alt: true }); await s.settle(); s.raf();
    assert.deepEqual(s.distances, [1, -2], 'Alt+wheel up is farther, down is nearer, per click');
    await s.ticks(4);
    assert.equal(s.takeoffs(), 0, 'Alt+wheel down does not jump');
    s.wheel(-1); await s.settle(); s.raf();
    assert.equal(s.input.tool, 'physgun', 'plain wheel up does not drop a held object by switching tools');
    s.wheel(1); await s.settle(); s.raf();
    await s.ticks(4);
    assert.equal(s.takeoffs(), 1, 'plain wheel down jumps while holding');
    assert.deepEqual(s.distances, [1, -2]);
    assert.deepEqual(s.toolRequests, []);
  });

  await run('wheel up selects the previous tool and does not jump', async s => {
    s.wheel(-1); await s.settle(); s.raf();
    await s.ticks(4);
    assert.deepEqual(s.toolRequests, ['knife']);
    assert.equal(s.last().tool, 'knife');
    assert.equal(s.takeoffs(), 0);
  });

  await run('a short W tap between slow rendered frames still walks, and the release stops', async s => {
    const start = s.last().x;
    s.key('KeyW', true); await s.settle();
    await s.ticks(6);
    s.key('KeyW', false); await s.settle();
    await s.ticks(60);
    assert.ok(Math.abs(s.last().x - start) > 1, 'the tap moved the player');
    assert.ok(s.last().speed < 1, 'the release reached the worker without a rendered frame');
  });

  await run('a modal opened while W is held stops the player once', async s => {
    s.key('KeyW', true); await s.settle(); s.raf();
    await s.ticks(40);
    assert.ok(s.last().speed > 150, 'walking');
    s.blocked = true;
    const before = s.sent.length;
    for (let i = 0; i < 5; i++) { s.raf(); await s.ticks(12); }
    assert.ok(s.last().speed < 1, 'the blocked input released W');
    assert.equal(s.sent.length, before + 1, 'one release frame, not one per rendered frame');
  });

  await run('chorded mouse buttons release without a rendered frame, and a tool swap keeps movement', async s => {
    s.key('KeyW', true); await s.settle();
    // A browser sends pointerdown/pointerup only for the first press and the last release of a
    // chord; mousedown/mouseup arrive for every button. No animation frame runs here.
    s.mouse(['pointerdown', 0], ['mousedown', 0], ['mousedown', 2], ['mouseup', 0], ['pointerup', 2], ['mouseup', 2]);
    await s.settle();
    const attack = PLAYER_BUTTON.attack | PLAYER_BUTTON.attack2;
    assert.ok(s.sent.some(frame => (frame.pressed & attack) === attack), 'both presses reached the worker');
    assert.equal(s.sent[s.sent.length - 1].held & attack, 0, 'no mouse button is left held');
    s.key('Digit3', true); s.key('Digit3', false); await s.settle();
    await s.ticks(40);
    assert.equal(s.last().tool, 'spawn');
    assert.ok(s.last().speed > 150, 'W still walks after the tool swap');
  });

  await run('a tool swap does not carry a held attack into the new tool', async s => {
    s.mouse(['pointerdown', 0], ['mousedown', 0]); await s.settle();
    // Key 3 sends the tool at once; the controller's release follows in a microtask, and a worker
    // tick may run in between.
    s.key('Digit3', true);
    await s.ticks(5);
    s.key('Digit3', false); s.mouse(['pointerup', 0], ['mouseup', 0]); await s.settle();
    await s.ticks(5);
    assert.equal(s.last().tool, 'spawn');
    assert.deepEqual(s.errors, [], 'the held physics gun button did not fire the spawn gun');
    s.mouse(['pointerdown', 0], ['mousedown', 0]); await s.settle();
    await s.ticks(5);
    assert.equal(s.errors.length, 1, 'a new click fires the spawn gun');
  });

  await run('worker stop and pause return the view to first person', async s => {
    s.key('KeyX', true); await s.settle();
    await s.ticks(2);
    assert.equal(s.last().third, true);
    s.world.stop();
    await s.ticks(2);
    assert.equal(s.last().third, false, 'stop');
    s.key('KeyX', false); await s.settle(); s.key('KeyX', true); await s.settle();
    await s.ticks(2);
    assert.equal(s.last().third, true);
    s.world.setPaused(true); s.world.setPaused(false);
    await s.world.wake(s.now, false);
    await s.ticks(2);
    assert.equal(s.last().third, false, 'pause');
  });

  await run('takes record release frames and read older wheel jumps as jump presses', async s => {
    const [{ desc, geometry }] = s.models;
    const recorder = new PlayerTakeRecorder({ mode: 'player', terrain: 'flat', created: new Date(0).toISOString(), content: [] },
      desc, geometry);
    const presentation = { thirdPerson: false, bodyYaw: 0, body: { sequence: 0, cycle: 0, poseParameters: new Float32Array(0), layers: [] } };
    const cam = { pos: [3, 0, 2], target: [0, 0, 1], fov: 70 };
    s.onFrame = m => recorder.push(m, s.sent[s.sent.length - 1] ?? null, cam, presentation);
    s.wheel(1); await s.settle();
    await s.ticks(3);
    window.dispatchEvent(new Event('blur')); await s.settle();
    await s.ticks(3);
    const take = recorder.stop();
    const poses = Array.from({ length: take.n }, (_, i) => ({ ...take.poseAt(take.t[i]).input }));
    assert.ok(poses.some(p => p.pressed & PLAYER_BUTTON.jump), 'the wheel jump press is recorded');
    assert.ok(poses.some(p => p.reset), 'the release frame is recorded');
    // A take saved before this change marked a knife wheel jump with flag bit 1 and no pressed bit.
    const i = 0, q = i * 4;
    take.tracks.inputBits[q + 2] = 0;
    take.tracks.inputBits[q + 3] = 4 | 1;
    assert.equal(validPlayerTracks(take.tracks, take.n, take.tables, true), true);
    const legacy = take.poseAt(take.t[i]).input;
    assert.equal(legacy.pressed & PLAYER_BUTTON.jump, PLAYER_BUTTON.jump);
    assert.equal(legacy.reset, false);
  });
} finally {
  await rm(fixture, { force: true });
}
