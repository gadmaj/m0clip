/** Real worker/MuJoCo, no renderer: driverless gravity, manual control, hoist, pause and portable capture. */
'use strict';
const assert = require('node:assert/strict');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');

(async () => {
  const base = process.env.BASE_URL || 'http://127.0.0.1:5176';
  const browser = await chromium.launch({ executablePath: process.env.CHROME_BIN || '/usr/bin/google-chrome', headless: true, args: ['--no-sandbox'] });
  try {
    const context = await browser.newContext(), page = await context.newPage(), pageErrors = [], policyRequests = [];
    page.on('pageerror', error => pageErrors.push(error.message));
    page.on('request', request => { if (/\.onnx(?:\?|$)|\/assets\/packs\/.*\.zip(?:\?|$)/.test(request.url())) policyRequests.push(request.url()); });
    await page.route(base + '/__driverless-physics', route => route.fulfill({ contentType: 'text/html', headers: { 'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'require-corp' }, body: '<!doctype html><title>Driverless physics integration</title>' }));
    await page.goto(base + '/__driverless-physics');
    await page.evaluate(async () => {
      const { FrameGeometryBuffer } = await import('/src/sim/geometry-frames.ts');
      const { TakeRecorder, saveTake, loadTake } = await import('/src/record/take.ts');
      // Isolated no-pack library forces the real supported manual/driverless path.
      const db = await new Promise((resolve, reject) => {
        const request = indexedDB.open('ume-default-packs', 1);
        request.onupgradeneeded = () => request.result.createObjectStore('settings');
        request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
      });
      await new Promise((resolve, reject) => {
        const transaction = db.transaction('settings', 'readwrite'); transaction.objectStore('settings').put(true, 'r1-default-v1');
        transaction.oncomplete = resolve; transaction.onerror = () => reject(transaction.error);
      }); db.close();
      window.physicsFixture = { errors: [], frames: [], replies: {}, request: 0, model: null, geometry: null, status: null, recorder: null, TakeRecorder, saveTake, loadTake };
      const fixture = window.physicsFixture;
      fixture.worker = new Worker('/src/worker/sim.worker.ts?worker_file&type=module', { type: 'module' });
      fixture.worker.onerror = event => fixture.errors.push(event.message || 'Worker module failed');
      fixture.worker.onmessage = ({ data: message }) => {
        if (message.t === 'error' || message.t === 'notice') fixture.errors.push(message.msg);
        if (message.t === 'viewReady') fixture.replies[message.request] = message;
        if (message.t === 'status') fixture.status = message;
        if (message.t === 'model') { fixture.model = message.desc; fixture.geometry = new FrameGeometryBuffer(message.desc.ngeom, message.geometry); }
        if (message.t === 'frame') {
          if (!message.qpos.every(Number.isFinite)) fixture.errors.push('Non-finite native qpos');
          fixture.geometry.apply(message.xpos, message.xmat);
          fixture.frames.push({ clock: message.clock, qpos: Array.from(message.qpos) });
          if (fixture.recorder) fixture.recorder.push({ ...message, xpos: fixture.geometry.xpos, xmat: fixture.geometry.xmat }, [0, 0, 0], { pos: [2, -2, 1], target: [message.baseX, message.baseY, message.qpos[fixture.model.baseQadr + 2]], fov: 60, orientation: [0, 0, 0, 1] });
        }
      };
      fixture.worker.postMessage({ t: 'init', robot: 'go2', robotExplicit: true, terrain: 'flat' });
    });
    await page.waitForFunction(() => physicsFixture.errors.length || physicsFixture.frames.length >= 2 && physicsFixture.status, null, { timeout: 180000 });
    const sync = async messages => {
      const request = await page.evaluate(messages => {
        const fixture = physicsFixture, request = ++fixture.request;
        for (const message of messages) fixture.worker.postMessage(message);
        fixture.worker.postMessage({ t: 'viewReady', request }); return request;
      }, messages);
      await page.waitForFunction(request => physicsFixture.errors.length || physicsFixture.replies[request], request);
    };
    const until = async duration => {
      const start = await page.evaluate(() => physicsFixture.frames.at(-1)?.clock || 0);
      await page.waitForFunction(({ start, duration }) => physicsFixture.errors.length || physicsFixture.frames.at(-1)?.clock >= start + duration, { start, duration }, { timeout: 60000 });
    };
    const initial = await page.evaluate(() => ({ errors: physicsFixture.errors, robot: physicsFixture.model.robot, nq: physicsFixture.model.nq, ngeom: physicsFixture.model.ngeom, status: physicsFixture.status }));
    assert.deepEqual(initial.errors, []); assert.equal(initial.robot, 'go2'); assert.equal(initial.nq, 19); assert.equal(initial.status.policy, '-'); assert.equal(initial.status.dof, 0);
    await sync([{ t: 'pause', on: true }, { t: 'reset' }, { t: 'hoist', on: false }, { t: 'state', state: 'zero_torque' }]);
    await page.evaluate(() => {
      const f = physicsFixture, m = f.model;
      f.captureStart = f.frames.length;
      f.recorder = new f.TakeRecorder({ robot: m.robot, terrain: m.terrain, policy: '-', created: new Date(0).toISOString(), ngeom: m.ngeom, nq: m.nq, baseQadr: m.baseQadr, hinges: m.hinges }, f.geometry.partition);
    });
    await sync([{ t: 'pause', on: false }]); await until(1.2);
    const drop = await page.evaluate(() => {
      const f = physicsFixture, frames = f.frames.slice(f.captureStart), first = frames[0], last = frames.at(-1), b = f.model.baseQadr;
      return { startZ: first.qpos[b + 2], endZ: last.qpos[b + 2], rootDrop: first.qpos[b + 2] - last.qpos[b + 2], jointChange: Math.max(...f.model.hinges.map(h => Math.abs(first.qpos[h.qadr] - last.qpos[h.qadr]))) };
    });
    assert.ok(drop.rootDrop > .05, `Real gravity did not drop the driverless body: ${JSON.stringify(drop)}`);
    assert.ok(drop.jointChange > .02, `Native articulated joints did not move: ${JSON.stringify(drop)}`);
    await sync([{ t: 'hoist', on: true }]); await until(2);
    const lift = await page.evaluate(() => { const f = physicsFixture; return { z: f.frames.at(-1).qpos[f.model.baseQadr + 2], state: f.status.state, hoist: f.status.hoist }; });
    assert.equal(lift.hoist, true); assert.ok(lift.z > drop.endZ + .05, `Existing hoist did not lift native physics: ${JSON.stringify(lift)}`);
    const states = [];
    for (const state of ['lock', 'damping']) {
      await sync([{ t: 'state', state }]); await until(.4);
      states.push(await page.evaluate(() => ({ state: physicsFixture.status.state, policy: physicsFixture.status.policy, clock: physicsFixture.frames.at(-1).clock })));
      assert.equal(states.at(-1).state, state); assert.equal(states.at(-1).policy, '-');
    }
    await sync([{ t: 'pause', on: true }]);
    const paused = await page.evaluate(async () => {
      const f = physicsFixture, before = f.frames.length, clock = f.frames.at(-1).clock;
      for (let i = 0; i < 8; i++) await new Promise(requestAnimationFrame);
      return { before, after: f.frames.length, clock, afterClock: f.frames.at(-1).clock };
    });
    assert.equal(paused.after, paused.before); assert.equal(paused.afterClock, paused.clock);
    const capture = await page.evaluate(async () => {
      const f = physicsFixture, take = f.recorder.finish(); f.recorder = null;
      const blob = await f.saveTake(take), restored = await f.loadTake(await blob.arrayBuffer());
      const hash = async array => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new Uint8Array(array.buffer, array.byteOffset, array.byteLength)))).map(v => v.toString(16).padStart(2, '0')).join('');
      const tracks = take => [take.t, take.geom.fixedIds, take.geom.values, take.qpos, take.cmd, take.cam, take.hoist, take.camOrientation];
      return { frames: take.n, duration: take.duration, fixed: take.geom.fixedIds.length, moving: take.geom.movingCount, zipBytes: blob.size, before: await Promise.all(tracks(take).map(hash)), after: await Promise.all(tracks(restored).map(hash)), firstZ: restored.basePosAt(0)[2], lastZ: restored.basePosAt(restored.duration)[2], errors: f.errors };
    });
    assert.ok(capture.frames >= 180); assert.ok(capture.duration >= 3.6); assert.deepEqual(capture.after, capture.before); assert.deepEqual(capture.errors, []);
    assert.deepEqual(policyRequests, []); assert.deepEqual(pageErrors, []);
    const proof = { driverless: { robot: initial.robot, nq: initial.nq, policy: initial.status.policy }, drop, lift, states, paused, capture, noPolicyRequests: true };
    if (process.env.QA_ARTIFACT_DIR) { require('node:fs').mkdirSync(process.env.QA_ARTIFACT_DIR, { recursive: true }); require('node:fs').writeFileSync(require('node:path').join(process.env.QA_ARTIFACT_DIR, 'driverless-physics.json'), JSON.stringify(proof, null, 2)); }
    console.log(JSON.stringify(proof, null, 2));
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
