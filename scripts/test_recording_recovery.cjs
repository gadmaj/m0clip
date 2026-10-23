/** Actual Chrome IndexedDB/Web Locks, isolated profile/origin. Run: node scripts/test_recording_recovery.cjs */
const assert = require('node:assert/strict');
const { build } = require('esbuild');
const { createServer } = require('node:http');
const { once } = require('node:events');
const { mkdtemp, rm } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');

(async () => {
  const profile = await mkdtemp(join(tmpdir(), 'm0clip-recovery-'));
  let context, server;
  try {
    const bundled = await build({ stdin: { contents: "import {RecordingRecovery} from './src/record/recovery';import {ShotLibrary} from './src/record/library';import {TakeRecorder,saveTake,loadTake,motionCsv} from './src/record/take';import {denseGeometryPartition} from './src/core/geometry';globalThis.fixture={RecordingRecovery,ShotLibrary,TakeRecorder,saveTake,loadTake,motionCsv,denseGeometryPartition};", resolveDir: process.cwd() }, bundle: true, platform: 'browser', format: 'iife', write: false });
    server = createServer((request, response) => {
      response.setHeader('Cache-Control', 'no-store');
      response.setHeader('Content-Type', request.url === '/fixture.js' ? 'text/javascript' : 'text/html');
      response.end(request.url === '/fixture.js' ? bundled.outputFiles[0].contents : '<!doctype html><title>Recording recovery fixture</title><script src="/fixture.js"></script>');
    });
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    const origin = `http://127.0.0.1:${server.address().port}`;
    context = await chromium.launchPersistentContext(profile, { executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome', headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
    const errors = [];
    // Set a real quota BEFORE the first write; Chrome otherwise caches a larger bucket grant.
    const quotaPage = await context.newPage(); await quotaPage.goto(origin);
    const cdp = await context.newCDPSession(quotaPage);
    await cdp.send('Storage.overrideQuotaForOrigin', { origin, quotaSize: 1024 * 1024 });

    async function freshPage() {
      const page = await context.newPage();
      page.on('pageerror', error => errors.push(error.message));
      await page.goto(origin);
      await page.evaluate(() => {
        window.check = (value, message) => { if (!value) throw new Error(message); };
        window.equal = (a, b, message) => check(JSON.stringify(a) === JSON.stringify(b), message);
        window.rejects = async (action, pattern) => {
          let failure; try { await action(); } catch (error) { failure = error; }
          check(failure && pattern.test(`${failure.name}: ${failure.message}`), `Expected ${pattern}, received ${failure}`);
        };
        window.hash = async array => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new Uint8Array(array.buffer, array.byteOffset, array.byteLength)))).map(v => v.toString(16).padStart(2, '0')).join('');
        window.trackHashes = async take => ({ ...Object.fromEntries(await Promise.all(['t', 'qpos', 'cmd', 'cam', 'hoist', 'camOrientation'].map(async key => [key, await hash(take[key])]))), geom: await hash(take.geom.values), fixedIds: await hash(take.geom.fixedIds) });
        window.sample = take => [.017, 1.133, take.duration - .007].map(time => {
          time = Math.max(0, Math.min(time, take.duration));
          const pose = new Float32Array(take.meta.ngeom * 7), qpos = new Float64Array(take.meta.nq);
          take.geomPoseAt(time, pose); take.qposAt(time, qpos);
          return { pose: [...pose], qpos: [...qpos], viewport: take.camAt(time), cmd: take.cmdAt(time) };
        });
        window.storeWork = async (stores, mode, work) => {
          const { promise, resolve, reject } = Promise.withResolvers();
          const opening = indexedDB.open('m0clip-shots');
          opening.onerror = () => reject(opening.error);
          opening.onsuccess = () => {
            const db = opening.result, tx = db.transaction(stores, mode); let result;
            try { result = work(tx); } catch (error) { tx.abort(); db.close(); reject(error); return; }
            tx.oncomplete = () => { db.close(); resolve(result?.result); };
            tx.onabort = () => { db.close(); reject(tx.error ?? new Error('Fixture transaction aborted')); };
          };
          return promise;
        };
        window.rows = store => storeWork([store], 'readonly', tx => tx.objectStore(store).getAll());
        window.replace = (store, record) => storeWork([store], 'readwrite', tx => tx.objectStore(store).put(record));
        window.released = async id => {
          const held = (await navigator.locks.query()).held.find(lock => lock.name === `m0clip-recording:${id}`);
          if (held) await navigator.locks.request(held.name, { mode: 'exclusive' }, () => {});
        };
        window.meta = () => ({ robot: 'r1', terrain: 'flat', policy: 'fixture arc', created: '2026-02-03T04:05:06.000Z', sourceTime: 731.25,
          ngeom: 2, nq: 8, baseQadr: 0, hinges: [{ name: 'elbow', qadr: 7 }], appearance: { colorway: 'product', parts: {} }, sourceHead: 'ghost',
          look: { preset: 'custom', antialiasing: 'fxaa', custom: { sunAzimuth: 27, sunElevation: 61, sunIntensity: 1.5, sunColor: 0xffffff,
            ambient: .8, skyColor: 0xdfeaf5, groundColor: 0x1a2028, fill: .7, reflections: .55, exposure: 1.1, shadows: false, background: 0x0b0e12 } },
          edits: { version: 1, appearance: { colorway: 'model', parts: { torso: { color: 0x18a5ef, roughness: .23 } } }, lights: [] } });
        window.makeModel = () => ({ robot: 'r1', terrain: 'flat', ngeom: 2, nq: 8, baseQadr: 0, hinges: [{ name: 'elbow', qadr: 7 }],
          type: new Int32Array([7, 2]), size: new Float64Array([.2, .3, .4, .1, .2, .3]), rgba: new Float32Array([.2, .4, .8, 1, .7, .3, .1, .9]),
          group: new Int32Array([1, 2]), contype: new Int32Array([1, 0]), bodyid: new Int32Array([1, 1]), dataid: new Int32Array([0, -1]), bodyNames: ['world', 'torso'],
          meshes: { 0: { name: 'asymmetric triangle', vert: new Float32Array([0, 0, 0, .3, .1, 0, .1, .4, .2]), face: new Uint32Array([0, 1, 2]), pos: [.1, -.2, .3], quat: [1, 0, 0, 0] } },
          bodyFrames: { parent: new Int32Array([0, 0]), pos: new Float64Array([0, 0, 0, .2, .3, .4]), quat: new Float64Array([1, 0, 0, 0, 1, 0, 0, 0]) },
          geomFrames: { pos: new Float64Array([0, .1, .2, .3, .4, .5]), quat: new Float64Array([1, 0, 0, 0, 1, 0, 0, 0]) } });
        window.fill = (recorder, from, to) => {
          for (let i = from; i < to; i++) {
            const phase = i * .031, c = Math.cos(phase), s = Math.sin(phase), x = Math.sin(phase) * .7 + i * .003;
            recorder.push({ clock: 47 + i * .02, xpos: new Float32Array([x, -x * .3, 1 + .1 * s, x + .4, .2 + .1 * c, 1.5]),
              xmat: new Float32Array([c, -s, 0, s, c, 0, 0, 0, 1, c, 0, s, 0, 1, 0, -s, 0, c]),
              qpos: new Float64Array([x, -x * .3, 1 + .1 * s, Math.cos(phase / 2), 0, 0, Math.sin(phase / 2), s * .4]),
              hoistAnchor: i % 3 ? [x, .1, 2.3 + s] : null }, [.7 * s, .2 * c, -.3 + .1 * s],
              { pos: [2 + x, -3 + .13 * s, 2.1 + .2 * c], target: [x, .2, 1], fov: 47 + 3 * s, orientation: [0, Math.sin(phase / 2), 0, Math.cos(phase / 2)] });
            if (i % 41 === 1) recorder.mark('move', `Arc ${i}`);
            if (i === 7) recorder.mark('noclip', 'On');
            if (i === 131) recorder.mark('hoist', 'Attach');
            if (i === 205) recorder.mark('policy', 'Pose');
          }
        };
        window.compactGeometry = () => ({ fixedIds: new Uint32Array([1]), fixed: new Float32Array([.4, .2, 1.5, 1, 0, 0, 0]) });
        window.makeTake = (count, geometry = fixture.denseGeometryPartition()) => { const recorder = new fixture.TakeRecorder(meta(), geometry); fill(recorder, 0, count); return recorder.finish(); };
        window.begin = (model, name, geometry = fixture.denseGeometryPartition()) => {
          const recorder = new fixture.TakeRecorder(meta(), geometry), pending = [], failed = Promise.withResolvers();
          const state = { recorder, status: null, failed: failed.promise };
          state.writer = new fixture.RecordingRecovery().record(recorder, model, name, status => {
            state.status = status;
            if (status.error) failed.resolve(status);
            for (let i = pending.length - 1; i >= 0; i--) {
              const waiter = pending[i];
              if (status.error) { pending.splice(i, 1); waiter.reject(new Error(status.error)); }
              else if (!status.saving && status.frames >= waiter.frames) { pending.splice(i, 1); waiter.resolve(status); }
            }
          });
          state.committed = frames => {
            if (state.status?.error) return Promise.reject(new Error(state.status.error));
            if (state.status && !state.status.saving && state.status.frames >= frames) return Promise.resolve(state.status);
            const waiter = Promise.withResolvers(); pending.push({ ...waiter, frames }); return waiter.promise;
          };
          return state;
        };
        window.library = new fixture.ShotLibrary(); window.recovery = new fixture.RecordingRecovery(library);
      });
      return page;
    }

    // Real legacy V1 schema and an actual saved motion take, not an empty upgrade smoke test.
    let owner = await freshPage();
    const baseline = await owner.evaluate(async () => {
      const take = makeTake(11), model = makeModel(), id = crypto.randomUUID(), sceneId = crypto.randomUUID();
      const keys = ['t', 'geom', 'qpos', 'cmd', 'cam', 'hoist', 'camOrientation'];
      const info = { id, name: 'V1 retained take', created: take.meta.created, updated: take.meta.created, robot: take.meta.robot,
        terrain: take.meta.terrain, duration: take.duration, frames: take.n, bytes: keys.reduce((n, key) => n + (key === 'geom' ? take.geom.values : take[key]).byteLength, 0), thumbnail: null };
      const opening = indexedDB.open('m0clip-shots', 1), done = Promise.withResolvers();
      opening.onupgradeneeded = () => {
        const db = opening.result; db.createObjectStore('shots', { keyPath: 'id' }).createIndex('sceneId', 'sceneId');
        db.createObjectStore('tracks', { keyPath: 'id' }); db.createObjectStore('scenes', { keyPath: 'id' });
      };
      opening.onerror = () => done.reject(opening.error);
      opening.onsuccess = () => {
        const db = opening.result, tx = db.transaction(['shots', 'tracks', 'scenes'], 'readwrite');
        check(db.version === 1, 'Fixture begins with genuine V1 database');
        tx.objectStore('shots').add({ id, info, meta: take.meta, events: take.events, sceneId });
        tx.objectStore('tracks').add(Object.fromEntries([['id', id], ...keys.map(key => [key, key === 'geom' ? take.geom.values : take[key]])]));
        tx.objectStore('scenes').add({ id: sceneId, terrain: take.meta.terrain, model });
        tx.oncomplete = () => { db.close(); done.resolve(); }; tx.onabort = () => { db.close(); done.reject(tx.error); };
      };
      await done.promise;
      return { id, sceneId, hashes: await trackHashes(take), sample: sample(take), meta: take.meta, events: take.events, mesh: await hash(model.meshes[0].vert) };
    });
    await owner.close(); owner = await freshPage();
    const interrupted = await owner.evaluate(async expected => {
      const reopened = await library.open(expected.id); // This opens and upgrades V1 -> V3.
      equal(await trackHashes(reopened.take), expected.hashes, 'V1 upgrade retains every real completed-track byte');
      equal(sample(reopened.take), expected.sample, 'V1 upgrade retains native motion/camera replay');
      check(reopened.take.geom.fixedIds.length === 0 && reopened.take.geom.values.length === reopened.take.n * reopened.take.meta.ngeom * 7, 'Unknown V1 world rows remain entirely moving without constancy inference');
      const secondId = crypto.randomUUID();
      await library.save({ id: secondId, name: 'Other retained take', take: makeTake(9), model: reopened.model, thumbnail: null });
      window.active = begin(reopened.model, 'Interrupted moving camera', compactGeometry());
      const writes = [], add = IDBObjectStore.prototype.add, getKey = IDBObjectStore.prototype.getKey;
      let sceneLookups = 0, sceneWrites = 0;
      IDBObjectStore.prototype.add = function(value, ...rest) {
        if (this.name === 'chunks') writes.push({ from: value.from, frames: value.t.length });
        if (this.name === 'scenes') sceneWrites++;
        return add.call(this, value, ...rest);
      };
      IDBObjectStore.prototype.getKey = function(...args) { if (this.name === 'scenes') sceneLookups++; return getKey.apply(this, args); };
      try {
        fill(active.recorder, 0, 2); active.writer.changed(); await active.committed(2);
        fill(active.recorder, 2, 130); active.writer.checkpoint(); await active.committed(130);
        fill(active.recorder, 130, 258); active.writer.checkpoint(); await active.committed(258);
        fill(active.recorder, 258, 285); active.writer.checkpoint(); await active.committed(285);
      } finally { IDBObjectStore.prototype.add = add; IDBObjectStore.prototype.getKey = getKey; }
      equal(writes, [{ from: 0, frames: 2 }, { from: 2, frames: 128 }, { from: 130, frames: 128 }, { from: 258, frames: 27 }], 'Real IDB writes contain only new contiguous spans, never whole prefixes');
      check(sceneLookups === 1 && sceneWrites === 0, 'Existing native scene is looked up only once; incremental commits do not copy it');
      const chunks = (await rows('chunks')).filter(chunk => chunk.recordingId === active.writer.id);
      equal(chunks.map(c => [c.from, c.t.length]), writes.map(c => [c.from, c.frames]), 'Committed chunks match the observed incremental writes');
      check(chunks[1].t[0] > 0 && chunks[3].t[0] > chunks[2].t.at(-1), 'Chunks preserve absolute original take time');
      const draft = (await rows('drafts')).find(row => row.id === active.writer.id);
      equal([...draft.geometry.fixedIds], [1], 'Draft stores the original fixed ID layout');
      equal([...draft.geometry.fixed], [...compactGeometry().fixed], 'Draft retains the fixed pose exactly');
      check(chunks.every(chunk => !Object.hasOwn(chunk, 'geometry') && chunk.geom.length === chunk.t.length * 7), 'Every chunk contains only moving geometry and never repeats the fixed payload');
      const fixedBytes = draft.geometry.fixedIds.byteLength + draft.geometry.fixed.byteLength;
      check(draft.info.bytes === fixedBytes + chunks.reduce((n, chunk) => n + ['t', 'geom', 'qpos', 'cmd', 'cam', 'hoist', 'camOrientation'].reduce((n, key) => n + chunk[key].byteLength, 0), 0), 'Draft byte accounting counts the fixed payload once across all chunks');
      check(active.recorder.snapshot(0).geometry && active.recorder.snapshot(2).geometry === undefined, 'Only snapshot zero owns a fixed partition');
      const independent = active.recorder.snapshot(280), originalEvent = independent.events[0].label;
      independent.events[0].label = 'Caller-only mutation'; independent.geom.fill(-999);
      check(active.recorder.snapshot(280).events[0].label === originalEvent && active.recorder.snapshot(280).geom[0] !== -999, 'Snapshots independently own events and only their requested track span');
      const oracle = makeTake(285, compactGeometry()); // The active recorder is intentionally NEVER finished/stopped/released.
      return { id: active.writer.id, secondId, secondHashes: await trackHashes(makeTake(9)), hashes: await trackHashes(oracle), sample: sample(oracle),
        meta: oracle.meta, events: oracle.events, frames: oracle.n, duration: oracle.duration, chunks: chunks.length };
    }, baseline);
    let observer = await freshPage();
    await observer.evaluate(async ({ baseline, interrupted }) => {
      for (const action of [() => recovery.read(interrupted.id), () => recovery.recover(interrupted.id), () => recovery.remove(interrupted.id)]) {
        await rejects(action, /active in another tab/i);
      }
      check((await rows('drafts')).some(row => row.id === interrupted.id), 'Real other-tab lock protects the recording draft');
      check((await rows('chunks')).filter(row => row.recordingId === interrupted.id).length === interrupted.chunks, 'Blocked actions change no chunks');
      equal(await trackHashes((await library.open(baseline.id)).take), baseline.hashes, 'Blocked actions never affect a completed take');
    }, { baseline, interrupted });
    await owner.close(); // Realm loss releases the real browser lock; no finish/stop/release call.
    await observer.evaluate(async ({ baseline, interrupted }) => {
      const restored = await recovery.read(interrupted.id);
      equal(await trackHashes(restored.take), interrupted.hashes, 'Seven SHA-256 track hashes survive interrupted-realm loss');
      equal(sample(restored.take), interrupted.sample, 'Actual Take/ShotPath replay matches motion and camera after realm loss');
      equal(restored.take.meta, interrupted.meta, 'Source clock, native appearance, Look and post edits recover without substitution');
      equal(restored.take.events, interrupted.events, 'Original timed input events faithfully recover');
      check(restored.take.hoist.some(Number.isNaN) && restored.take.hoist.some(Number.isFinite), 'Recovery retains both disabled and active hoist states');
      check(await hash(restored.model.meshes[0].vert) === baseline.mesh, 'Recovery retains actual shared scene geometry');
      const portable = await fixture.loadTake(await (await fixture.saveTake(restored.take)).arrayBuffer());
      equal(await trackHashes(portable), interrupted.hashes, 'Backup ZIP retains all seven original tracks');
      equal(portable.meta.edits, interrupted.meta.edits, 'Native post edits survive recovery backup ZIP');
      check((await recovery.list()).some(info => info.id === interrupted.id), 'Read/backup never consumes the checkpoint');
      // Remove a real middle chunk and restore it: no silent shortening or fake partial success.
      const chunks = (await rows('chunks')).filter(row => row.recordingId === interrupted.id), middle = chunks[1];
      await storeWork(['chunks'], 'readwrite', tx => tx.objectStore('chunks').delete([middle.recordingId, middle.from]));
      await rejects(() => recovery.read(interrupted.id), /invalid/i); await replace('chunks', middle);
      const badQuaternion = { ...middle, camOrientation: new Float64Array(middle.camOrientation) };
      await replace('chunks', badQuaternion); await rejects(() => recovery.read(interrupted.id), /invalid/i); await replace('chunks', middle);
      const badTime = structuredClone(middle); badTime.t[0] = 0;
      await replace('chunks', badTime); await rejects(() => recovery.read(interrupted.id), /invalid/i); await replace('chunks', middle);
      const draft = (await rows('drafts')).find(row => row.id === interrupted.id);
      for (const geometry of [
        { fixedIds: new Uint32Array([2]), fixed: draft.geometry.fixed },
        { fixedIds: new Uint32Array([1, 1]), fixed: new Float32Array(14) },
        { fixedIds: new Uint32Array([1, 0]), fixed: new Float32Array(14) },
        { fixedIds: new Int32Array([1]), fixed: draft.geometry.fixed },
        { fixedIds: new Uint32Array([1]), fixed: draft.geometry.fixed.slice(1) },
      ]) {
        await replace('drafts', { ...draft, geometry }); await rejects(() => recovery.read(interrupted.id), /invalid/i); await replace('drafts', draft);
      }
      await replace('chunks', { ...middle, geom: new Float32Array(middle.geom.length * 2) });
      await rejects(() => recovery.read(interrupted.id), /invalid/i); await replace('chunks', middle);
      // Abort an actual full-save transaction after tracks were queued. Draft removal must roll back too.
      const add = IDBObjectStore.prototype.add;
      IDBObjectStore.prototype.add = function(...args) {
        const request = add.apply(this, args);
        if (this.name === 'tracks') request.addEventListener('success', () => this.transaction.abort(), { once: true });
        return request;
      };
      try { await rejects(() => recovery.recover(interrupted.id), /abort|inactive/i); }
      finally { IDBObjectStore.prototype.add = add; }
      equal(await trackHashes((await recovery.read(interrupted.id)).take), interrupted.hashes, 'Aborted promotion retains the entire committed recovery');
      equal(await trackHashes((await library.open(baseline.id)).take), baseline.hashes, 'Aborted promotion preserves the V1 completed take');
      equal(await trackHashes((await library.open(interrupted.secondId)).take), interrupted.secondHashes, 'Aborted promotion preserves unrelated completed takes');
      const promoted = await recovery.recover(interrupted.id);
      equal(await trackHashes(promoted.take), interrupted.hashes, 'Successful promotion preserves all seven tracks');
      check(promoted.info.thumbnail === null, 'Recovery does not pretend to have captured a completed viewport thumbnail');
      check(!(await rows('drafts')).some(row => row.id === interrupted.id) && !(await rows('chunks')).some(row => row.recordingId === interrupted.id), 'Completed save atomically consumes only its own draft and chunks');
      check((await rows('shots')).find(row => row.id === interrupted.id).sceneId === baseline.sceneId, 'Reopened recovery promotion reuses its stored scene identity');
      window.sharedModel = promoted.model;
    }, { baseline, interrupted });

    const failed = await observer.evaluate(async ({ baseline, interrupted }) => {
      window.aborted = begin(sharedModel, 'Aborted incremental append');
      fill(aborted.recorder, 0, 2); aborted.writer.changed(); await aborted.committed(2);
      const prefixHashes = await trackHashes(makeTake(2)), add = IDBObjectStore.prototype.add;
      IDBObjectStore.prototype.add = function(...args) {
        const request = add.apply(this, args);
        if (this.name === 'chunks') request.addEventListener('success', () => this.transaction.abort(), { once: true });
        return request;
      };
      try { fill(aborted.recorder, 2, 130); aborted.writer.changed(); await aborted.failed; }
      finally { IDBObjectStore.prototype.add = add; }
      check(/abort|inactive/i.test(aborted.writer.error), 'Actual append abort produces a persistent actionable error');
      fill(aborted.recorder, 130, 140); aborted.writer.changed(); aborted.writer.checkpoint();
      await aborted.writer.stop(); await aborted.writer.stop(); aborted.writer.release(); aborted.writer.release();
      await released(aborted.writer.id);
      equal(await trackHashes((await recovery.read(aborted.writer.id)).take), prefixHashes, 'Abort keeps exactly the last committed prefix, not later RAM frames');
      check(aborted.recorder.finish().n === 140, 'Checkpoint errors leave ordinary full-take recording/playback available');
      window.quota = begin(sharedModel, 'Quota interrupted append');
      fill(quota.recorder, 0, 2); quota.writer.changed(); await quota.committed(2);
      const transaction=IDBDatabase.prototype.transaction;let quotaAbort;
      IDBDatabase.prototype.transaction=function(...args){
        const tx=transaction.apply(this,args);
        tx.addEventListener('abort',()=>{quotaAbort=tx.error?.name;},{once:true});return tx;
      };
      try { fill(quota.recorder, 2, 12000); quota.writer.changed(); await quota.failed; }
      finally { IDBDatabase.prototype.transaction=transaction; }
      check(quotaAbort==='QuotaExceededError',`Real quota transaction must reject: ${quotaAbort}; ${quota.writer.error}`);
      check(quota.status.frames === 2, 'Failed quota append never reports uncommitted frames as durable');
      await quota.writer.stop(); quota.writer.release(); await released(quota.writer.id);
      equal(await trackHashes((await recovery.read(quota.writer.id)).take), prefixHashes, 'Quota failure leaves the prior two-frame prefix exact');
      check((await rows('chunks')).filter(row => row.recordingId === quota.writer.id).length === 1, 'Quota failure leaves no partial new chunk');
      equal(await trackHashes((await library.open(baseline.id)).take), baseline.hashes, 'Quota failure preserves the original upgraded take');
      equal(await trackHashes((await library.open(interrupted.id)).take), interrupted.hashes, 'Quota failure preserves the newly recovered completed take');
      return { abortedId: aborted.writer.id, quotaId: quota.writer.id };
    }, { baseline, interrupted });
    await cdp.send('Storage.overrideQuotaForOrigin', { origin });

    const finalSave = await observer.evaluate(async () => {
      window.finalizing = begin(sharedModel, 'Full completed take');
      fill(finalizing.recorder, 0, 2); finalizing.writer.changed(); await finalizing.committed(2);
      fill(finalizing.recorder, 2, 49); finalizing.writer.changed();
      const barrier = finalizing.writer.stop();
      fill(finalizing.recorder, 49, 50); finalizing.writer.changed(); finalizing.writer.checkpoint();
      await barrier;
      check((await rows('chunks')).filter(row => row.recordingId === finalizing.writer.id).length === 1, 'stop synchronously closes the queue and takes no new snapshot');
      const take = finalizing.recorder.finish(); window.finalTake = take;
      return { id: finalizing.writer.id, hashes: await trackHashes(take) };
    });
    const guard = await freshPage();
    await guard.evaluate(async id => {
      await rejects(() => recovery.recover(id), /active in another tab/i);
      await rejects(() => recovery.remove(id), /active in another tab/i);
    }, finalSave.id);
    await observer.evaluate(async expected => {
      await library.save({ id: expected.id, name: 'Full completed take', take: finalTake, model: sharedModel, thumbnail: null });
      check(!(await rows('drafts')).some(row => row.id === expected.id) && !(await rows('chunks')).some(row => row.recordingId === expected.id), 'Parent-style full save atomically removes its checkpoint');
      finalizing.writer.release(); finalizing.writer.release();
      equal(await trackHashes((await library.open(expected.id)).take), expected.hashes, 'Final completed save contains even the uncheckpointed tail');
      const short = begin(sharedModel, 'One frame only');
      fill(short.recorder, 0, 1); short.writer.changed(); short.writer.checkpoint(); await short.writer.stop(); short.writer.release();
      check(!(await recovery.list()).some(info => info.id === short.writer.id), 'A one-frame recording never creates a false recovery');
      const immediate = begin(sharedModel, 'Stopped before lock acquisition');
      fill(immediate.recorder, 0, 2); immediate.writer.changed();
      await immediate.writer.stop(); immediate.writer.release();
      check(!(await recovery.list()).some(info => info.id === immediate.writer.id), 'Immediate stop safely crosses asynchronous lock acquisition without a late write');
    }, finalSave);
    await guard.close();

    await observer.evaluate(async () => {
      const geometry = { fixedIds: new Uint32Array([0, 1]), fixed: new Float32Array([3, 4, 5, 1, 0, 0, 0, 7, 8, 9, 1, 0, 0, 0]) };
      const fixed = begin(sharedModel, 'All world geometry', geometry);
      fill(fixed.recorder, 0, 2); fixed.writer.changed(); await fixed.committed(2);
      const snapshot = fixed.recorder.snapshot(0);
      snapshot.geometry.fixed.fill(-100); snapshot.geometry.fixedIds.fill(0);
      equal([...fixed.recorder.snapshot(0).geometry.fixed], [...geometry.fixed], 'First-snapshot fixed values are independently owned');
      fill(fixed.recorder, 2, 130); fixed.writer.checkpoint(); await fixed.committed(130);
      await fixed.writer.stop(); fixed.writer.release(); await released(fixed.writer.id);
      const chunks = (await rows('chunks')).filter(row => row.recordingId === fixed.writer.id);
      check(chunks.length === 2 && chunks.every(chunk => chunk.geom.length === 0), 'All-fixed recordings commit valid empty moving geometry spans');
      const restored = await recovery.read(fixed.writer.id), oracle = makeTake(130, geometry);
      equal(await trackHashes(restored.take), await trackHashes(oracle), 'All-fixed recovery preserves its single fixed prefix and all six motion tracks');
      equal([...restored.take.poseAt(restored.take.duration).xpos], [3, 4, 5, 7, 8, 9], 'All-fixed playback still addresses every full-model geometry row');
      await recovery.remove(fixed.writer.id);

      const malformed = begin(sharedModel, 'Changed late fixed layout');
      fill(malformed.recorder, 0, 2); malformed.writer.changed(); await malformed.committed(2);
      const snapshotAt = malformed.recorder.snapshot.bind(malformed.recorder);
      malformed.recorder.snapshot = from => ({ ...snapshotAt(from), geometry: compactGeometry() });
      fill(malformed.recorder, 2, 130); malformed.writer.checkpoint(); await malformed.failed;
      await malformed.writer.stop(); malformed.writer.release(); await released(malformed.writer.id);
      equal(await trackHashes((await recovery.read(malformed.writer.id)).take), await trackHashes(makeTake(2)), 'A forbidden late fixed payload aborts before changing the durable prefix');
      await recovery.remove(malformed.writer.id);
    });

    // Both reference kinds participate in scene collection; deleting completed shots must not strand drafts.
    await observer.evaluate(async ({ baseline, interrupted, failed, finalSave }) => {
      await library.remove(baseline.id); await library.remove(interrupted.secondId); await library.remove(interrupted.id); await library.remove(finalSave.id);
      check((await rows('scenes')).some(scene => scene.id === baseline.sceneId), 'Draft references retain a scene after the last completed take is deleted');
      equal(await trackHashes((await recovery.read(failed.abortedId)).take), await trackHashes(makeTake(2)), 'Surviving draft remains playable after all completed-shot deletions');
      await recovery.remove(failed.abortedId);
      check((await rows('scenes')).some(scene => scene.id === baseline.sceneId), 'One draft deletion cannot collect another draft scene');
      equal(await trackHashes((await recovery.read(failed.quotaId)).take), await trackHashes(makeTake(2)), 'Unrelated recovery survives draft deletion');
      await recovery.remove(failed.quotaId);
      check(!(await rows('scenes')).some(scene => scene.id === baseline.sceneId), 'Final draft deletion collects the unreferenced scene');
      equal(await library.list(), [], 'Only explicitly deleted completed takes disappear'); equal(await recovery.list(), [], 'Only explicitly deleted recoveries disappear');
    }, { baseline, interrupted, failed, finalSave });
    assert.deepEqual(errors, [], 'No uncaught browser storage/lock errors');
    console.log('PASS: actual Chrome V1 upgrade, seven-track interrupted realm recovery, incremental-only writes, native replay/post edits/ZIP, true two-tab locks, abort/quota prefix retention, atomic full-save promotion and shared-scene collection');
  } finally {
    try { if (context) await context.close(); }
    finally {
      if (server) { const closed = Promise.withResolvers(); server.close(error => error ? closed.reject(error) : closed.resolve()); await closed.promise; }
      await rm(profile, { recursive: true, force: true });
    }
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
