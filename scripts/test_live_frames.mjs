/** The shared live-frame mailbox (src/sim/live-frames.ts) without a browser: exact frame copies, the
 * seqlock's torn-read guard (deterministic and with a real writer thread), latest-wins live intake,
 * the message-only fallback without SharedArrayBuffer, and a Player take that stays complete while
 * posted frame messages are held back the way Chrome defers them during a held key. */
import assert from 'node:assert/strict';
import buildFixture from './build-fixture.cjs';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Worker } from 'node:worker_threads';

const root = process.cwd();
const fixture = resolve(root, `.live-frames-test-${process.pid}.mjs`);
const { code } = await buildFixture({ root, platform: 'node', format: 'es', externalPackages: true, source:
  "export {createLiveFrameWriter,LiveFrameWriter,LiveFrameReader,LiveFrameIntake,LiveFramePublisher} from './src/sim/live-frames';" +
  "export {PlayerWorld} from './src/worker/player-world';export {PlayerTakeRecorder} from './src/record/player-take';" +
  "export {GMOD_MOVE_PROFILE} from './src/player/movement';" });
await writeFile(fixture, code
  .replaceAll('"/wasm/mujoco.js"', JSON.stringify(pathToFileURL(resolve(root, 'node_modules/mujoco/mujoco.js')).href))
  .replaceAll('"/wasm/mujoco.wasm"', JSON.stringify(resolve(root, 'node_modules/mujoco/mujoco.wasm'))));
globalThis.fetch = async url => {
  try { return new Response(await readFile(resolve(root, 'public' + new URL(url, 'http://local').pathname))); }
  catch { return new Response('', { status: 404 }); }
};

const ok = name => console.log(`ok ${name}`);

/** A robot-shaped frame whose every value derives from `v`. */
function robotFrame(moving, nq, v, hoistAnchor = null) {
  return { t: 'frame', xpos: new Float32Array(moving * 3).map((_, i) => v + i), xmat: new Float32Array(moving * 9).map((_, i) => v - i),
    baseX: v + 0.25, baseY: v - 0.25, hoistAnchor, clock: v * 0.02, qpos: new Float64Array(nq).map((_, i) => v + i / 7) };
}
function playerState(v) {
  return { origin: Float64Array.of(v, v + 1, v + 2), velocity: Float64Array.of(v / 3, 0.1, -v), yaw: v * 1.5, pitch: -v / 9,
    grounded: v % 2 === 0, groundGeom: 3, ducked: false, duckFraction: 0.125, eyeHeight: 64, colliderBody: 7, thirdPerson: v % 3 === 0,
    tool: 'physgun', grab: v % 2 ? null : { entity: 'g1-1', body: 4, point: Float64Array.of(1, 2, v), target: Float64Array.of(v, 5, 6) },
    entities: [{ id: 'g1-1', state: 'alive', hits: v }, { id: 'go2-2', state: 'ragdoll', hits: 0 }] };
}
const modelMessage = (mode, ngeom, fixed, nq) => ({ t: 'model', desc: { mode, ngeom, nq },
  geometry: { fixedIds: Uint32Array.from({ length: fixed }, (_, i) => i), fixed: new Float32Array(fixed * 7), fixedXmat: new Float32Array(fixed * 9) } });
/** More player state than a 16 KiB slot holds. */
const crowdEntities = Array.from({ length: 1000 }, (_, k) => ({ id: `robot-${k}`, state: 'alive', hits: k }));

try {
  const { createLiveFrameWriter, LiveFrameWriter, LiveFrameReader, LiveFrameIntake, LiveFramePublisher, PlayerWorld, PlayerTakeRecorder,
    GMOD_MOVE_PROFILE } = await import(pathToFileURL(fixture));

  {
    const layout = { moving: 3, nq: 4, player: false };
    assert.equal(globalThis.crossOriginIsolated, undefined);
    assert.equal(createLiveFrameWriter(layout), null, 'not cross-origin isolated by default');
    assert.equal(createLiveFrameWriter(layout, false), null);
    const shared = globalThis.SharedArrayBuffer;
    globalThis.SharedArrayBuffer = undefined;
    try { assert.equal(createLiveFrameWriter(layout, true), null, 'no SharedArrayBuffer'); }
    finally { globalThis.SharedArrayBuffer = shared; }
    // The worker then posts frames exactly as before: no mailbox, no sequence numbers.
    const publisher = new LiveFramePublisher(false), model = modelMessage('robot', 5, 2, 4), frame = robotFrame(3, 4, 1);
    publisher.annotate(model); publisher.annotate(frame);
    assert.equal('live' in model, false); assert.equal('seq' in frame, false);
    const intake = LiveFrameIntake.forModel(model), seen = [];
    intake.drain(true, f => seen.push(f)); intake.drain(false, f => seen.push(f));
    assert.deepEqual(seen, []);
    assert.equal(intake.accept(undefined), true); assert.equal(intake.accept(undefined), true);
    ok('without cross-origin isolation or SharedArrayBuffer every frame arrives by message only');
  }

  {
    const publisher = new LiveFramePublisher(true), model = modelMessage('robot', 7, 2, 4);
    publisher.annotate(model);
    assert.ok(model.live instanceof SharedArrayBuffer);
    const reader = new LiveFrameReader(model.live, { moving: 5, nq: 4 });
    assert.throws(() => new LiveFrameReader(model.live, { moving: 6, nq: 4 }), /does not match its model/);
    const frames = [robotFrame(5, 4, 1, [1, 2, 3]), robotFrame(5, 4, 2, null), robotFrame(5, 4, 3)];
    delete frames[2].hoistAnchor;
    for (const [i, f] of frames.entries()) { publisher.annotate(f); assert.equal(f.seq, i); }
    for (const f of frames) assert.deepStrictEqual(reader.read(f.seq), f);
    assert.equal(reader.read(3), null, 'not written yet');
    // A wrong-size frame or one carrying player state into a robot mailbox stays message-only.
    const wrong = robotFrame(4, 4, 9), extra = { ...robotFrame(5, 4, 10), player: playerState(1) };
    publisher.annotate(wrong); publisher.annotate(extra);
    assert.equal(reader.read(wrong.seq), null); assert.equal(reader.read(extra.seq), null);

    const player = new LiveFramePublisher(true), pm = modelMessage('player', 6, 1, 3);
    player.annotate(pm);
    const preader = new LiveFrameReader(pm.live, { moving: 5, nq: 3 });
    for (let v = 0; v < 4; v++) {
      const f = { ...robotFrame(5, 3, v), player: playerState(v) };
      player.annotate(f);
      assert.deepStrictEqual(preader.read(f.seq), f, `player frame ${v}`);
    }
    // Numbers plain JSON loses (NaN, ±Infinity, -0) arrive exactly, inside typed arrays too.
    for (const odd of [Number.NaN, Infinity, -Infinity, -0]) {
      const p = playerState(1), f = { ...robotFrame(5, 3, 1), player: { ...p, pitch: odd, origin: Float64Array.of(odd, -0, 1) } };
      player.annotate(f);
      assert.deepStrictEqual(preader.read(f.seq), f, `pitch ${Object.is(odd, -0) ? '-0' : odd}`);
    }
    // Player state larger than a slot holds stays message-only.
    const crowd = { ...robotFrame(5, 3, 2), player: { ...playerState(2), entities: crowdEntities } };
    player.annotate(crowd);
    assert.equal(preader.read(crowd.seq), null);
    ok('mailbox frames are exact copies of their messages; oversize or mismatched frames stay message-only');
  }

  {
    const writer = new LiveFrameWriter({ moving: 2, nq: 2, player: false }, 4);
    const reader = new LiveFrameReader(writer.buffer, { moving: 2, nq: 2 });
    const realLoad = Atomics.load;
    /** Runs `during` inside the reader's `n`th Atomics.load call (0: latest, 1: first slot check, 2: second). */
    const readWith = (seq, n, during) => {
      let calls = 0;
      Atomics.load = (array, index) => {
        if (calls++ === n) { Atomics.load = realLoad; during(); }
        return realLoad(array, index);
      };
      try { return reader.read(seq); } finally { Atomics.load = realLoad; }
    };
    for (let v = 0; v < 4; v++) writer.write(robotFrame(2, 2, v));
    assert.deepStrictEqual(readWith(1, 2, () => {}), { ...robotFrame(2, 2, 1), seq: 1 }, 'an undisturbed read');
    // The writer laps slot 1 after the reader copied it, and again before it copied it.
    assert.equal(readWith(1, 2, () => { for (let v = 4; v < 6; v++) writer.write(robotFrame(2, 2, v)); }), null, 'overwritten after copying');
    assert.equal(readWith(2, 1, () => { for (let v = 6; v < 8; v++) writer.write(robotFrame(2, 2, v)); }), null, 'overwritten before copying');
    // A slot being written holds -1, never a complete sequence number.
    const i32 = new Int32Array(writer.buffer), slot = 32 / 4 + (7 % 4) * (i32[3] / 4);
    assert.ok(reader.read(7));
    Atomics.store(i32, slot, -1);
    assert.equal(reader.read(7), null, 'a slot mid-write');
    assert.equal(reader.read(3), null, 'older than the ring');
    ok('the seqlock rejects copies the writer touched');
  }

  {
    // A real writer thread overwrites a two-slot ring as fast as it can while this thread reads.
    const moving = 40000, nq = 64;
    const worker = new Worker(`
      const { parentPort, workerData } = require('node:worker_threads');
      import(workerData.fixture).then(({ LiveFrameWriter }) => {
        const writer = new LiveFrameWriter({ moving: ${moving}, nq: ${nq}, player: true }, 2);
        const stop = new Int32Array(new SharedArrayBuffer(4));
        parentPort.postMessage({ buffer: writer.buffer, stop: stop.buffer });
        const xpos = new Float32Array(${moving * 3}), xmat = new Float32Array(${moving * 9}), qpos = new Float64Array(${nq});
        let v = 0;
        while (!Atomics.load(stop, 0)) {
          v++;
          xpos.fill(v); xmat.fill(v); qpos.fill(v);
          writer.write({ t: 'frame', xpos, xmat, qpos, baseX: v, baseY: v, clock: v, hoistAnchor: [v, v, v],
            player: { origin: Float64Array.of(v, v, v), velocity: Float64Array.of(0, 0, 0), yaw: v, pitch: 0, grounded: true, groundGeom: 0,
              ducked: false, duckFraction: 0, eyeHeight: 64, colliderBody: 1, thirdPerson: false, tool: 'none', grab: null,
              entities: Array.from({ length: v % 5 }, (_, k) => ({ id: 'e' + v, state: 'alive', hits: k })) } });
        }
        parentPort.postMessage({ written: v });
      });`, { eval: true, workerData: { fixture: pathToFileURL(fixture).href } });
    const { buffer, stop } = await new Promise(r => worker.once('message', r));
    const reader = new LiveFrameReader(buffer, { moving, nq });
    const raw = new Float32Array(buffer), i32 = new Int32Array(buffer), slotFloats = i32[3] / 4, xmatStart = (8 + 8 * (7 + nq)) / 4;
    let good = 0, rejected = 0, naiveTorn = 0;
    const until = performance.now() + 1500;
    while (performance.now() < until) {
      const latest = reader.latest();
      if (latest < 0) continue;
      const f = reader.read(latest);
      if (!f) { rejected++; continue; }
      const v = f.clock;
      assert.ok(f.xpos.every(x => x === v) && f.xmat.every(x => x === v) && f.qpos.every(x => x === v), 'one frame per copy');
      assert.ok(f.baseX === v && f.baseY === v && f.hoistAnchor.every(x => x === v) && f.player.origin.every(x => x === v) && f.player.yaw === v);
      assert.ok(f.player.entities.length === v % 5 && f.player.entities.every(e => e.id === 'e' + v));
      good++;
      // The same slot copied without the seqlock checks: its first and last rotation values can disagree.
      const base = 32 / 4 + ((latest + 1) % 2) * slotFloats + xmatStart;
      const first = raw[base], copy = raw.slice(base, base + moving * 12);
      if (copy[copy.length - 1] !== first) naiveTorn++;
    }
    Atomics.store(new Int32Array(stop), 0, 1);
    const { written } = await new Promise(r => worker.once('message', r));
    await worker.terminate();
    assert.ok(good > 0, `consistent reads ${good}`);
    console.log(`  ${written} frames written, ${good} consistent reads, ${rejected} rejected, ${naiveTorn} torn unchecked copies`);
    ok('concurrent reads from a lapping writer thread only ever return whole frames');
  }

  {
    const writer = new LiveFrameWriter({ moving: 1, nq: 1, player: false }, 4);
    const intake = new LiveFrameIntake(new LiveFrameReader(writer.buffer, { moving: 1, nq: 1 }));
    const seen = [], take = f => seen.push(f.seq);
    intake.drain(false, take); intake.drain(true, take);
    assert.deepEqual(seen, [], 'nothing written');
    for (let v = 0; v < 3; v++) writer.write(robotFrame(1, 1, v));
    intake.drain(false, take);
    assert.deepEqual(seen, [2], 'only the newest frame is presented');
    intake.drain(false, take);
    assert.deepEqual(seen, [2], 'and only once');
    assert.deepEqual([0, 1, 2].map(s => intake.accept(s)), [false, false, false], 'their messages are not presented again');
    writer.write(robotFrame(1, 1, 3));
    assert.equal(intake.accept(3), true, 'a newer message is presented');
    intake.drain(false, take);
    assert.deepEqual(seen, [2], 'the mailbox does not repeat it');
    // In order: the mailbox no longer holds 4 and 5, so their messages fill the gap before 6..9 follow.
    for (let v = 4; v < 10; v++) writer.write(robotFrame(1, 1, v));
    intake.drain(true, take);
    assert.deepEqual(seen, [2], 'waits for frames the ring dropped');
    assert.equal(intake.accept(4), true); assert.equal(intake.accept(5), true);
    intake.drain(true, take);
    assert.deepEqual(seen, [2, 6, 7, 8, 9]);
    assert.deepEqual([6, 7, 8, 9].map(s => intake.accept(s)), [false, false, false, false]);
    ok('live intake: the newest mailbox frame wins and each frame is taken once');
  }

  {
    // Randomized interleavings of worker writes, message deliveries and animation frames.
    let seed = 7;
    const random = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
    for (let round = 0; round < 200; round++) {
      const writer = new LiveFrameWriter({ moving: 1, nq: 1, player: true }, 1 + Math.floor(random() * 12));
      const intake = new LiveFrameIntake(new LiveFrameReader(writer.buffer, { moving: 1, nq: 1 }));
      const queue = [], taken = [];
      const recordFrom = Math.floor(random() * 60);
      let written = 0, recordStart = -1;
      while (written < 400 || queue.length) {
        const r = random();
        if (r < 0.45 && written < 400) {
          // Some frames are too large for a slot and travel by message only.
          const f = { ...robotFrame(1, 1, written), player: { ...playerState(written), ...random() < 0.05 ? { entities: crowdEntities } : {} } };
          writer.write(f); queue.push(written++);
        } else if (r < 0.75 && queue.length) {
          // A burst of deferred messages arrives.
          for (let n = 1 + Math.floor(random() * 30); n-- && queue.length;) { const seq = queue.shift(); if (intake.accept(seq)) taken.push(seq); }
        } else {
          const recording = taken.length >= recordFrom;
          if (recording && recordStart < 0) recordStart = taken.length;
          intake.drain(recording, f => taken.push(f.seq));
        }
      }
      for (let i = 1; i < taken.length; i++) assert.ok(taken[i] > taken[i - 1], 'never twice, never backwards');
      if (recordStart >= 0) {
        const recorded = taken.slice(recordStart);
        assert.deepEqual(recorded, Array.from(recorded, (_, i) => recorded[0] + i), 'a recording takes every frame in order');
        assert.equal(recorded[recorded.length - 1], 399);
      }
    }
    ok('randomized: exactly once in order while recording, never twice or backwards otherwise');
  }

  {
    // A real Player world posts through the worker's publisher. Its frame messages are held back for a
    // stretch, as Chrome holds them while W auto-repeats on a slow renderer; animation frames keep reading
    // the mailbox. The take must record every simulated frame once, in order.
    const publisher = new LiveFramePublisher(true), messages = [], models = [];
    let newest = -1;
    const world = new PlayerWorld({
      post(m, transfer = []) {
        publisher.annotate(m);
        if (m.t === 'model') models.push(m);
        else if (m.t === 'frame') { newest = m.seq; messages.push(structuredClone(m, { transfer })); }
      },
      entries: () => [], config: () => Promise.reject(new Error('No policies in this test.')) });
    assert.equal(await world.load(await world.prepare('flat', null), { tools: ['physgun'], knifeTiming: { primaryRange: 32, primaryCycle: 0.4, primaryHitDelay: 0.1 } }, () => true), true);
    const [model] = models;
    assert.ok(model.live instanceof SharedArrayBuffer);
    const intake = LiveFrameIntake.forModel(model), tickMs = GMOD_MOVE_PROFILE.tickInterval * 1000;
    const recorder = new PlayerTakeRecorder({ mode: 'player', terrain: 'flat', created: new Date(0).toISOString(), content: [] }, model.desc, model.geometry);
    const presentation = { thirdPerson: false, bodyYaw: 0, body: { sequence: 0, cycle: 0, poseParameters: new Float32Array(0), layers: [] } };
    const cam = { pos: [3, 0, 2], target: [0, 0, 1], fov: 70 };
    const fromMailbox = new Map(), shown = [];
    let recording = false, sequence = 0, now = 0;
    const present = (f, source) => {
      shown.push({ seq: f.seq, source, x: f.player.origin[0] });
      if (source === 'mailbox') fromMailbox.set(f.seq, f);
      if (recording) recorder.push(f, null, cam, presentation);
    };
    const deliver = () => { for (const m of messages.splice(0)) {
      const copy = fromMailbox.get(m.seq);
      if (copy) assert.deepStrictEqual(copy, m, `mailbox frame ${m.seq} equals its message`);
      if (intake.accept(m.seq)) present(m, 'message');
    } };
    const raf = () => intake.drain(recording, f => present(f, 'mailbox'));
    const hold = (forward, thirdPerson) => world.input({ sequence: ++sequence, yaw: 0, pitch: 0, forward, side: 0, held: 0, pressed: 0, reset: false, thirdPerson });
    await world.wake(now, false);
    for (let i = 0; i < 5; i++) { now += tickMs; await world.wake(now, false); }
    deliver();
    recording = true;
    const firstRecorded = shown.length;
    // Held W, with third person part of the way: no frame messages arrive; three animation frames per second.
    hold(1, false);
    const holdFrom = shown.length;
    for (let i = 1; i <= 300; i++) {
      if (i === 150) hold(1, true);
      now += tickMs; await world.wake(now, false);
      if (i % 20 === 0) raf();
    }
    const duringHold = shown.slice(holdFrom);
    assert.ok(duringHold.length > 0 && duringHold.every(s => s.source === 'mailbox'), 'the hold is presented from the mailbox');
    assert.ok(duringHold[duringHold.length - 1].x > duringHold[0].x + 50, 'the player visibly moves during the hold');
    // Release: the deferred messages arrive at once; nothing is presented or recorded twice.
    hold(0, false);
    const posted = messages.length;
    deliver();
    for (let i = 0; i < 10; i++) { now += tickMs; await world.wake(now, false); if (i % 3 === 0) raf(); }
    deliver();
    raf();
    const recorded = shown.slice(firstRecorded), seqs = recorded.map(s => s.seq);
    assert.ok(posted >= 300, `frames posted during the hold ${posted}`);
    assert.deepEqual(seqs, Array.from(seqs, (_, i) => seqs[0] + i), 'every frame once, in order');
    assert.equal(seqs[0], shown[firstRecorded - 1].seq + 1, 'from the first frame after recording began');
    assert.equal(seqs[seqs.length - 1], newest, 'up to the newest frame');
    const take = recorder.stop();
    assert.equal(take.n, recorded.length, 'the take holds every frame presented while recording');
    assert.ok(take.events.some(e => e.kind === 'view' && e.label === 'Third person'), 'third person during the hold is recorded');
    console.log(`  ${posted} frames posted during the hold, ${duringHold.length} presented live from the mailbox, take ${take.n} frames`);
    ok('a Player take records every frame while frame messages are held back');
    world.dispose?.();
  }
} finally {
  await rm(fixture, { force: true });
}
