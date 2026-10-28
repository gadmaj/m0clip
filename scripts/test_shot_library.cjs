/** Actual Chrome IndexedDB, isolated origin/profile. Run: node scripts/test_shot_library.cjs */
const assert = require('node:assert/strict');
const { build } = require('esbuild');
const { createServer } = require('node:http');
const { once } = require('node:events');
const { mkdtemp, rm } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');

(async () => {
  const profile = await mkdtemp(join(tmpdir(), 'm0clip-shot-idb-'));
  let context, server;
  try {
    const built = await build({ stdin: { contents: "import {ShotLibrary} from './src/record/library';import {PhotoLibrary} from './src/record/photos';import {RecordingRecovery} from './src/record/recovery';import {Take,TakeRecorder,saveTake,loadTake,motionCsv,validTakeRange} from './src/record/take';import {ShotPath} from './src/record/shot';import {Timeline} from './src/record/timeline';import {GeometryTrack} from './src/core/geometry';import {ShotLibraryDialog} from './src/ui/shot-library';globalThis.fixture={ShotLibrary,PhotoLibrary,RecordingRecovery,Take,TakeRecorder,saveTake,loadTake,motionCsv,validTakeRange,ShotPath,Timeline,GeometryTrack,ShotLibraryDialog};", resolveDir: process.cwd() }, outfile: 'fixture.js', bundle: true, platform: 'browser', format: 'iife', write: false });
    const javascript = built.outputFiles.find(file => file.path.endsWith('.js')).contents;
    const css = built.outputFiles.find(file => file.path.endsWith('.css')).contents;
    server = createServer((request, response) => {
      response.setHeader('Cache-Control', 'no-store');
      response.setHeader('Content-Type', request.url === '/fixture.js' ? 'text/javascript' : request.url === '/fixture.css' ? 'text/css' : 'text/html');
      response.end(request.url === '/fixture.js' ? javascript : request.url === '/fixture.css' ? css : '<!doctype html><title>Shot library IndexedDB fixture</title><link rel="stylesheet" href="/fixture.css"><script src="/fixture.js"></script>');
    });
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    const origin = `http://127.0.0.1:${server.address().port}`;
    context = await chromium.launchPersistentContext(profile, { executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome', headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'], viewport: { width: 800, height: 600 } });
    const errors = [];
    // Quota must be installed before the first write: Chrome caches previously granted bucket space.
    // A separate empty page retains the CDP override while data pages are destroyed and recreated.
    const quotaPage=await context.newPage();
    await quotaPage.goto(origin);
    const cdp=await context.newCDPSession(quotaPage);
    await cdp.send('Storage.overrideQuotaForOrigin',{origin,quotaSize:1024*1024});
    async function freshPage() {
      const page = await context.newPage();
      page.on('pageerror', error => errors.push(error.message));
      await page.goto(origin);
      await page.evaluate(() => {
        window.check = (condition, message) => { if (!condition) throw new Error(message); };
        window.equal = (a, b, message) => check(JSON.stringify(a) === JSON.stringify(b), message);
        window.hash = async array => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new Uint8Array(array.buffer, array.byteOffset, array.byteLength)))).map(v => v.toString(16).padStart(2, '0')).join('');
        window.trackHashes = async take => ({ ...Object.fromEntries(await Promise.all(['t', 'qpos', 'cmd', 'cam', 'hoist', 'camOrientation'].map(async key => [key, await hash(take[key])]))), geom: await hash(take.geom.values), fixedIds: await hash(take.geom.fixedIds) });
        window.sample = take => {
          const pose = new Float32Array(take.meta.ngeom * 7), qpos = new Float64Array(take.meta.nq);
          const start = take.range?.[0] ?? 0, time = start + .005;
          take.geomPoseAt(time, pose); take.qposAt(time, qpos);
          const path = new fixture.ShotPath(take, take.shot, start), camera = path.at(time);
          return { pose: Array.from(pose), qpos: Array.from(qpos), camera: { pos: camera.pos.toArray(), target: camera.target.toArray() }, viewport: take.camAt(time), csv: fixture.motionCsv(take, 100, start, take.range?.[1] ?? take.duration) };
        };
        window.readStore = async store => {
          const { promise, resolve, reject } = Promise.withResolvers();
          const opening = indexedDB.open('m0clip-shots');
          opening.onerror = () => reject(opening.error);
          opening.onsuccess = () => {
            const db = opening.result, tx = db.transaction(store), request = tx.objectStore(store).getAll();
            tx.oncomplete = () => { db.close(); resolve(request.result); };
            tx.onabort = () => { db.close(); reject(tx.error); };
          };
          return promise;
        };
        window.writeRecord = async (store, record) => {
          const { promise, resolve, reject } = Promise.withResolvers();
          const opening = indexedDB.open('m0clip-shots');
          opening.onerror = () => reject(opening.error);
          opening.onsuccess = () => {
            const db = opening.result, tx = db.transaction(store, 'readwrite'); tx.objectStore(store).put(record);
            tx.oncomplete = () => { db.close(); resolve(); }; tx.onabort = () => { db.close(); reject(tx.error); };
          };
          return promise;
        };
        window.rejects = async (action, pattern) => {
          let failure; try { await action(); } catch (error) { failure = error; }
          check(failure, 'Expected the operation to reject');
          if (pattern) check(pattern.test(`${failure.name}: ${failure.message}`), `Expected ${pattern}, got ${failure}`);
        };
        window.makeTake = offset => {
          const lighting = { sunAzimuth: 27, sunElevation: 61, sunIntensity: 1.5, sunColor: 0xffffff, ambient: .8, skyColor: 0xdfeaf5, groundColor: 0x1a2028, fill: .7, reflections: .55, exposure: 1, shadows: false, background: 0x0b0e12 };
          const meta = { robot: 'r1', terrain: 'flat', policy: 'fixture', created: new Date(1700000000000 + offset * 1000).toISOString(), ngeom: 2, nq: 8, baseQadr: 0, hinges: [{ name: 'elbow', qadr: 7 }], appearance: { colorway: 'product', parts: {} }, sourceHead: 'ghost', look: { preset: 'studio', custom: lighting, antialiasing: 'fxaa' } };
          meta.display = { textures: false, wireframe: true, characterWireframe: false, map: true, robot: true, decals: false };
          meta.flashlight = true;
          meta.lights = [{ id: 'initial', name: 'Initial key', kind: 'point', enabled: true, color: 0xffcc88, intensity: 31, position: [3, -2, 4], target: [0, 0, 1], range: 12, angle: 30, penumbra: .2 }];
          const recorder = new fixture.TakeRecorder(meta, { fixedIds: new Uint32Array([1]), fixed: new Float32Array([.4, .2, 1.5, 1, 0, 0, 0]) });
          for (let i = 0; i < 6; i++) {
            const step = i * .17 + offset, angle = i * .12, c = Math.cos(angle), s = Math.sin(angle);
            recorder.push({ clock: 10 + i * .02, xpos: new Float32Array([step, -step * .3, 1 + i * .03, step + .4, .2, 1.5]), xmat: new Float32Array([c, -s, 0, s, c, 0, 0, 0, 1, c, 0, s, 0, 1, 0, -s, 0, c]), qpos: new Float64Array([step, -step * .3, 1 + i * .03, Math.cos(angle / 2), 0, 0, Math.sin(angle / 2), step * .4]), hoistAnchor: i % 2 ? [step, .1, 2.3] : null }, [step * .7, .2 - i * .03, -.3 + i * .1], { pos: [2 + step, -3 + i * .13, 2.1], target: [step, .2, 1], fov: 47 + i, orientation: [0, Math.sin(angle / 2), 0, Math.cos(angle / 2)] });
            if (i === 2) recorder.mark('move', 'Forward arc');
            if (i === 4) recorder.mark('noclip', 'On');
          }
          const take = recorder.finish(); check(take, 'Fixture contains completed motion');
          take.shot = { mode: 'orbit', focal: 50, sensor: 24.89, distance: 4.7, azimuth: -73, elevation: 21, height: 1.2, orbitPeriod: -7, smooth: .08 };
          take.range = offset === 0 ? [.02, .08] : [.04, .09];
          take.meta.edits = { version: 1, appearance: { colorway: 'model', parts: { torso: { color: 0x18a5ef }, elbow: { roughness: .23 } } }, display: { textures: true, wireframe: false, characterWireframe: true, map: false, robot: true, decals: true }, flashlight: false, lights: [] };
          return take;
        };
        window.makeModel = () => ({ robot: 'r1', terrain: 'flat', ngeom: 2, nq: 8, baseQadr: 0, hinges: [{ name: 'elbow', qadr: 7 }], type: new Int32Array([7, 2]), size: new Float64Array([.2, .3, .4, .1, .2, .3]), rgba: new Float32Array([.2, .4, .8, 1, .7, .3, .1, .9]), group: new Int32Array([1, 2]), contype: new Int32Array([1, 0]), bodyid: new Int32Array([1, 1]), dataid: new Int32Array([0, -1]), bodyNames: ['world', 'torso'], meshes: { 0: { name: 'asymmetric triangle', vert: new Float32Array([0, 0, 0, .3, .1, 0, .1, .4, .2]), face: new Uint32Array([0, 1, 2]), pos: [.1, -.2, .3], quat: [1, 0, 0, 0] } }, bodyFrames: { parent: new Int32Array([0, 0]), pos: new Float64Array([0, 0, 0, .2, .3, .4]), quat: new Float64Array([1, 0, 0, 0, 1, 0, 0, 0]) }, geomFrames: { pos: new Float64Array([.1, .2, .3, .4, .5, .6]), quat: new Float64Array([1, 0, 0, 0, 1, 0, 0, 0]) } });
      });
      return page;
    }
    let page = await freshPage();
    await page.evaluate(async () => {
      const root = document.createElement('section'); document.body.append(root);
      const a = makeTake(0), b = makeTake(2), changes = [];
      const host = {
        close() {}, exportVideo() {}, exportData() {}, save() {}, library() {}, editLook() {}, viewMode() {},
        rangeChanged() {
          const range = [timeline.rangeIn, timeline.rangeOut];
          check(fixture.validTakeRange(range, timeline.take.duration), 'Every actual UI range is valid');
          timeline.take.range = range;
          changes.push([...range]);
        },
      };
      const timeline = new fixture.Timeline(root, host);
      root.querySelector('canvas').style.cssText = 'display:block;width:700px;height:200px';
      window.rangeFixture = { timeline, a, b, changes, hashes: await trackHashes(a), meta: structuredClone(a.meta), events: structuredClone(a.events) };
      document.addEventListener('keydown', e => { if (timeline.onKey(e)) e.preventDefault(); });
      timeline.open(a, 'A');
      await new Promise(requestAnimationFrame);
      equal([timeline.rangeIn, timeline.rangeOut, timeline.time], [.02, .08, .02], 'Open restores bounds and initial playhead');
      check(changes.length === 0, 'Restoring a take never dispatches a user save');
      timeline.open(b, 'B');
      equal([timeline.rangeIn, timeline.rangeOut, timeline.time], [.04, .09, .04], 'Opening B cannot inherit A bounds');
      timeline.open(a, 'A');
      equal(a.range, [.02, .08], 'Opening another take leaves A saved bounds untouched');
      timeline.seek(.03);
    });
    await page.getByTitle('Range start at the playhead (I)', { exact: true }).click();
    await page.evaluate(() => {
      const { timeline, changes } = rangeFixture;
      equal(changes, [[.03, .08]], 'In button dispatches exactly one changed range');
      timeline.setIn(.03);
      timeline.seek(.07);
      check(changes.length === 1, 'Identical setter and seeking never save');
    });
    await page.keyboard.press('o');
    await page.evaluate(() => {
      const { timeline, changes } = rangeFixture;
      equal(changes.at(-1), [.03, .07], 'Out keyboard edit uses the same range callback');
      timeline.fit();
    });
    const drag = await page.evaluate(() => {
      const { timeline } = rangeFixture, rect = document.querySelector('canvas').getBoundingClientRect();
      const x = t => rect.x + 10 + (rect.width - 20) * (t + .03 * timeline.duration) / (1.06 * timeline.duration);
      return { from: x(timeline.rangeIn), to: x(.04), y: rect.y + 8 };
    });
    await page.mouse.move(drag.from, drag.y); await page.mouse.down(); await page.mouse.move(drag.to, drag.y); await page.mouse.up();
    await page.evaluate(() => {
      const { timeline, a, b, changes } = rangeFixture;
      check(changes.length === 3 && Math.abs(a.range[0] - .04) < 1e-9 && a.range[1] === .07, 'Dragging the actual In flag dispatches changed bounds');
      const count = changes.length;
      timeline.setPlaying(true); timeline.tick(.01); timeline.setPlaying(false);
      check(changes.length === count, 'Playback never emits range metadata writes');
      equal(b.range, [.04, .09], 'Editing A does not mutate B');
      // A committed Shots rename reaches the open timeline in place: no seek, range save, take swap or playback change.
      timeline.seek(.05); timeline.setPlaying(true);
      const before = { range: [timeline.rangeIn, timeline.rangeOut], time: timeline.time, take: timeline.take, saved: [...a.range] };
      timeline.setTitle('A renamed');
      equal([timeline.rangeIn, timeline.rangeOut], before.range, 'Renaming keeps the range'); check(timeline.time === before.time, 'Renaming keeps the playhead');
      check(timeline.take === before.take && timeline.isOpen && timeline.playing && changes.length === count, 'Renaming keeps the open take and playback and saves no range');
      equal(a.range, before.saved, 'Renaming leaves the saved bounds untouched');
      check(timeline.root.getAttribute('aria-label').includes('A renamed'), 'Timeline accessible name follows the committed name');
      timeline.setPlaying(false);
    });
    await page.keyboard.press('x'); await page.keyboard.press('x');
    await page.evaluate(async () => {
      const { timeline, a, b, changes } = rangeFixture;
      equal(a.range, [0, a.duration], 'Clear restores full span');
      check(changes.length === 4, 'Repeated Clear only dispatches an actual change');
      timeline.setIn(a.duration); timeline.setOut(0);
      check(fixture.validTakeRange(a.range, a.duration), 'Endpoint edits never create an empty saved range');
      timeline.open(b, 'B'); const count = changes.length;
      equal([timeline.rangeIn, timeline.rangeOut, timeline.time], [.04, .09, .04], 'Reopening B restores its own bounds after A edits');
      const legacy = makeTake(3); delete legacy.range;
      timeline.open(legacy, 'Legacy');
      equal([timeline.rangeIn, timeline.rangeOut, timeline.time], [0, legacy.duration, 0], 'Missing range opens the full take');
      check(legacy.range === undefined && changes.length === count, 'Legacy open does not rewrite or save the take');
      equal(await trackHashes(a), rangeFixture.hashes, 'All seven original tracks survive timeline range interactions');
      equal(a.meta, rangeFixture.meta, 'Range controls leave original recording metadata untouched');
      equal(a.events, rangeFixture.events, 'Range controls leave original input events untouched');
      await new Promise(requestAnimationFrame);
      timeline.close(); timeline.root.remove();
    });
    const baseline = await page.evaluate(async () => {
      const library = new fixture.ShotLibrary(), model = makeModel(), first = makeTake(0), second = makeTake(2);
      // Constructor does not open a database. No database is created until the first save.
      check(!(await indexedDB.databases()).some(db => db.name === 'm0clip-shots'), 'Library opens lazily');
      const ids = [crypto.randomUUID(), crypto.randomUUID()];
      const expected = { ids, first: await trackHashes(first), second: await trackHashes(second), firstSample: sample(first), secondSample: sample(second), events: structuredClone(first.events), shot: structuredClone(first.shot), meta: structuredClone(first.meta), range: [...first.range], secondRange: [...second.range], duration: first.duration, frames: first.n, mesh: await hash(model.meshes[0].vert), rgba: await hash(model.rgba) };
      const saving = library.save({ id: ids[0], name: 'Arc one', take: first, model, thumbnail: null });
      first.meta.policy = 'mutated while opening'; first.shot.focal = 135; first.events[0].label = 'mutated while opening'; first.range[0] = .03;
      first.meta.display.decals = true; first.meta.flashlight = false; first.meta.lights[0].position[0] = 999;
      first.meta.edits.display.map = true; first.meta.edits.flashlight = true;
      await Promise.all([saving, library.save({ id: ids[1], name: 'Arc two', take: second, model, thumbnail: null })]);
      const shots = await readStore('shots');
      check(shots.find(s => s.id === ids[0]).sceneId === shots.find(s => s.id === ids[1]).sceneId, 'Same model object shares one stored scene identity');
      check(shots.every(s => !Object.hasOwn(s, 'range')), 'Range has one canonical copy in small info');
      equal(shots.find(s => s.id === ids[0]).info.range, expected.range, 'Stored info owns pre-await range snapshot');
      expected.sceneId = shots[0].sceneId;
      // Mutating caller-owned data after commit must not affect either independently opened take.
      for (const key of ['t', 'qpos', 'cmd', 'cam', 'hoist', 'camOrientation']) first[key].fill(999);
      first.geom.values.fill(999); first.geom.fixedIds.fill(0);
      model.meshes[0].vert.fill(999); model.rgba.fill(999);
      const opened = await library.open(ids[0]);
      check(opened.take instanceof fixture.Take, 'Open reconstructs actual Take methods');
      equal(await trackHashes(opened.take), expected.first, 'IDB structured clone owns all seven track arrays');
      equal(opened.take.meta, expected.meta, 'Metadata snapshot precedes async open'); equal(opened.take.shot, expected.shot, 'Shot snapshot precedes async open'); equal(opened.take.events, expected.events, 'Events snapshot precedes async open');
      equal(opened.take.range, expected.range, 'Trim snapshot precedes async open');
      check(opened.info.duration === expected.duration && opened.info.frames === expected.frames, 'Trim retains full recorded duration and frame count');
      opened.info.range[0] = .031;
      equal(opened.take.range, expected.range, 'Take bounds do not alias returned list metadata');
      equal(sample(opened.take), expected.firstSample, 'Motion and camera interpolation survive clone ownership');
      check(await hash(opened.model.meshes[0].vert) === expected.mesh && await hash(opened.model.rgba) === expected.rgba, 'IDB owns original geometry and paint buffers');
      opened.take.geom.values.fill(-400); opened.model.meshes[0].vert.fill(-400); opened.take.meta.policy = 'local open mutation';
      opened.take.range[0] = .033;
      equal((await library.open(ids[0])).take.range, expected.range, 'Each opened range is independently owned');
      equal(await trackHashes((await library.open(ids[0])).take), expected.first, 'Each open returns independently owned data');
      // Name-only edits must survive the page/connection recreation below.
      const renamedSecond = await library.rename(ids[1], '  Arc two renamed  ');
      check(renamedSecond.id === ids[1] && renamedSecond.name === 'Arc two renamed', 'Rename stores the trimmed name for the requested take');
      expected.secondName = renamedSecond.name;
      const photos = new fixture.PhotoLibrary(), canvas = document.createElement('canvas');
      canvas.width = 7; canvas.height = 5;
      const context = canvas.getContext('2d');
      context.fillStyle = '#18a5ef'; context.fillRect(0, 0, 7, 5); context.fillStyle = '#ff2000'; context.fillRect(1, 1, 2, 3);
      const png = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
      expected.photo = { id: crypto.randomUUID(), png: await hash(new Uint8Array(await png.arrayBuffer())), bytes: png.size };
      await photos.save({ id: expected.photo.id, name: 'Frame one', created: new Date(1700000100000).toISOString(), robot: 'r1', terrain: 'flat', png });
      const photoBefore = (await readStore('photos')).find(p => p.id === expected.photo.id);
      const transaction = IDBDatabase.prototype.transaction;
      IDBDatabase.prototype.transaction = function(stores, ...args) {
        const names = typeof stores === 'string' ? [stores] : Array.from(stores);
        check(names.every(name => name === 'photos'), 'PNG rename must never access original PNG data');
        return transaction.call(this, stores, ...args);
      };
      let renamedPhoto;
      try {
        for (const name of ['', '   ', '\n\t']) await rejects(() => photos.rename(expected.photo.id, name), /Error/);
        await rejects(() => photos.rename(crypto.randomUUID(), 'Missing'), /Error/);
        renamedPhoto = await photos.rename(expected.photo.id, ' Frame renamed ');
      } finally { IDBDatabase.prototype.transaction = transaction; }
      const photoAfter = (await readStore('photos')).find(p => p.id === expected.photo.id);
      check(photoBefore.info.name === 'Frame one' && photoAfter.info.name === 'Frame renamed' && renamedPhoto.name === 'Frame renamed', 'PNG rename commits the trimmed name');
      const stable = info => ({ ...info, name: null, updated: null, thumbnail: null });
      check(photoAfter.id === expected.photo.id, 'PNG rename keeps its record ID');
      equal(stable(photoAfter.info), stable(photoBefore.info), 'PNG rename preserves ID, creation, scene, dimensions and byte count');
      check(await hash(new Uint8Array(await photoAfter.info.thumbnail.arrayBuffer())) === await hash(new Uint8Array(await photoBefore.info.thumbnail.arrayBuffer())), 'PNG rename keeps the stored preview');
      await writeRecord('photos', { ...photoAfter, info: { ...photoAfter.info, width: 0 } });
      await rejects(() => photos.rename(expected.photo.id, 'Corrupt'), /Error/);
      check((await readStore('photos')).find(p => p.id === expected.photo.id).info.name === 'Frame renamed', 'Rejected PNG rename writes nothing');
      await writeRecord('photos', photoAfter);
      return expected;
    });
    await page.close(); // New page means no old Take, WeakMap, connection or imported-module instance survives.
    page = await freshPage();
    await page.evaluate(async expected => {
      const library = new fixture.ShotLibrary(), opened = await library.open(expected.ids[0]);
      equal(await trackHashes(opened.take), expected.first, 'Seven exact buffer hashes survive a page/connection reopen');
      equal(sample(opened.take), expected.firstSample, 'Real replay methods preserve nontrivial movement/camera after reopen');
      equal(opened.take.events, expected.events, 'Discrete motion events survive reopen');
      equal(opened.take.meta.look, expected.meta.look, 'Original look survives reopen');
      check((await library.open(expected.ids[1])).info.name === expected.secondName && (await library.list()).find(s => s.id === expected.ids[1]).name === expected.secondName, 'Take name survives page/connection recreation');
      const photos = new fixture.PhotoLibrary(), photo = await photos.open(expected.photo.id);
      check(photo.info.name === 'Frame renamed' && (await photos.list()).find(p => p.id === expected.photo.id).name === 'Frame renamed', 'PNG name survives page/connection recreation');
      check(photo.png.size === expected.photo.bytes && await hash(new Uint8Array(await photo.png.arrayBuffer())) === expected.photo.png, 'Renamed PNG keeps its original encoded bytes');
      for (const key of ['display', 'flashlight', 'lights']) equal(opened.take.meta[key], expected.meta[key], `Initial ${key} survives real IDB realm recreation`);
      equal(opened.take.meta.edits, expected.meta.edits, 'Edited display/flashlight and explicitly empty lights survive reopen');
      check(await hash(opened.model.meshes[0].vert) === expected.mesh, 'Stored scene survives page recreation');
      equal(opened.take.range, expected.range, 'Range survives page and connection recreation');
      const portable = await fixture.loadTake(await (await fixture.saveTake(opened.take)).arrayBuffer());
      equal(portable.range, expected.range, 'Actual IDB take retains range through portable ZIP');
      equal(portable.meta.edits, expected.meta.edits, 'Partial per-part paint survives IDB and ZIP together');
      for (const key of ['display', 'flashlight', 'lights']) equal(portable.meta[key], expected.meta[key], `Initial ${key} survives IDB → portable ZIP`);
      equal(sample(portable), expected.firstSample, 'Restored trim drives actual motion and camera-path sampling');
      equal(await trackHashes(portable), expected.first, 'IDB to ZIP retains seven exact buffer hashes');
      opened.take.meta.edits = { version: 1, appearance: { colorway: 'model', parts: { torso: { color: 0x18a5ef, roughness: .23 } } }, display: { textures: false, wireframe: true, map: true, robot: false }, flashlight: true, lights: [{ ...opened.take.meta.lights[0], id: 'edited', name: 'Edited key', intensity: 71 }] };
      opened.take.shot.focal = 85;
      opened.take.range = [.03, .07];
      const desiredMeta = structuredClone(opened.take.meta), desiredShot = structuredClone(opened.take.shot), desiredRange = [...opened.take.range];
      // Reject heavy store access outright during metadata edits/list, rather than infer from timings/counts.
      const transaction = IDBDatabase.prototype.transaction;
      IDBDatabase.prototype.transaction = function(stores, ...args) {
        const names = typeof stores === 'string' ? [stores] : Array.from(stores);
        check(names.every(name => name === 'shots'), 'Metadata update/list must never access tracks or scenes');
        return transaction.call(this, stores, ...args);
      };
      try {
        const updating = library.update(expected.ids[0], { meta: opened.take.meta, shot: opened.take.shot, range: opened.take.range });
        opened.take.meta.edits.appearance.parts.torso.color = 0; opened.take.shot.focal = 14; opened.take.range[0] = .04;
        opened.take.meta.edits.display.robot = true; opened.take.meta.edits.flashlight = false; opened.take.meta.edits.lights[0].intensity = 1;
        await updating;
        const listed = await library.list(); check(listed[0].id === expected.ids[0], 'Updated entry sorts first');
        equal(listed[0].range, desiredRange, 'Small listing carries updated range');
        check(listed[0].duration === expected.duration && listed[0].frames === expected.frames, 'Listed duration and frames remain full-sized');
        for (const change of [
          { display: { ...desiredMeta.display, decals: null } }, { flashlight: 1 }, { lights: [desiredMeta.lights[0], desiredMeta.lights[0]] },
          { edits: { ...desiredMeta.edits, display: {} } }, { edits: { ...desiredMeta.edits, flashlight: null } },
          { edits: { ...desiredMeta.edits, lights: [{ ...desiredMeta.lights[0], intensity: -1 }] } },
        ]) await rejects(() => library.update(expected.ids[0], { meta: { ...desiredMeta, ...change }, shot: desiredShot, range: desiredRange }), /invalid/i);
        for (const range of [null, [], [0], [0, .02, .03], [0, 0], [.07, .03], [-.01, .03], [0, expected.duration + .001], [NaN, .04], [0, Infinity], ['0', .04]]) {
          await rejects(() => library.update(expected.ids[0], { meta: desiredMeta, shot: desiredShot, range }), /invalid/i);
          equal((await library.list()).find(s => s.id === expected.ids[0]).range, desiredRange, 'Invalid range update cannot commit');
        }
        for (const range of [[0, expected.duration], [0, Number.MIN_VALUE], [expected.duration - 1e-9, expected.duration], undefined]) {
          await library.update(expected.ids[0], { meta: desiredMeta, shot: desiredShot, range });
          const info = (await library.list()).find(s => s.id === expected.ids[0]);
          equal(info.range, range, 'Boundary and clear edits use only small metadata storage');
        }
        await library.update(expected.ids[0], { meta: desiredMeta, shot: desiredShot, range: desiredRange });
      } finally { IDBDatabase.prototype.transaction = transaction; }
      const edited = await library.open(expected.ids[0]), other = await library.open(expected.ids[1]);
      equal(edited.take.meta, desiredMeta, 'Metadata edit captures mutable input before async open'); equal(edited.take.shot, desiredShot, 'Camera edit captures mutable input');
      equal(edited.take.range, desiredRange, 'Range update captures input before awaiting database open');
      equal(other.take.range, expected.secondRange, 'Take B retains its independent trim');
      equal(await trackHashes(edited.take), expected.first, 'Metadata edit preserves every track hash');
      equal(await trackHashes(other.take), expected.second, 'Metadata edit preserves other saved shot'); equal(sample(other.take), expected.secondSample, 'Other take camera/motion unaffected');
      await library.update(expected.ids[0], { meta: desiredMeta, shot: desiredShot, range: undefined });
      const cleared = await library.open(expected.ids[0]);
      check(cleared.take.range === undefined && !Object.hasOwn(cleared.info, 'range'), 'Explicit undefined clears canonical trim');
      equal(await trackHashes(cleared.take), expected.first, 'Clearing range preserves all seven exact buffers');
      await library.update(expected.ids[0], { meta: desiredMeta, shot: desiredShot, range: desiredRange });
      // Name-only take edits use the small shots store; autosave before or after a rename keeps the custom name.
      const unnamed = (await readStore('shots')).find(s => s.id === expected.ids[0]);
      IDBDatabase.prototype.transaction = function(stores, ...args) {
        const names = typeof stores === 'string' ? [stores] : Array.from(stores);
        check(names.every(name => name === 'shots'), 'Take rename must never access tracks or scenes');
        return transaction.call(this, stores, ...args);
      };
      let named;
      try {
        for (const name of ['', '   ', '\n\t']) await rejects(() => library.rename(expected.ids[0], name), /Error/);
        check((await readStore('shots')).find(s => s.id === expected.ids[0]).info.name === unnamed.info.name, 'Empty names write nothing');
        await rejects(() => library.rename(crypto.randomUUID(), 'Missing'), /Error/);
        named = await library.rename(expected.ids[0], 'Custom arc');
        await Promise.all([library.update(expected.ids[0], { meta: desiredMeta, shot: { ...desiredShot, focal: 60 }, range: desiredRange }), library.rename(expected.ids[0], 'Custom arc 2')]);
        const concurrent = (await readStore('shots')).find(s => s.id === expected.ids[0]);
        check(concurrent.info.name === 'Custom arc 2' && concurrent.shot.focal === 60, 'Concurrent autosave and rename both commit their own fields');
        await Promise.all([library.rename(expected.ids[0], 'Custom arc 3'), library.update(expected.ids[0], { meta: desiredMeta, shot: desiredShot, range: desiredRange })]);
        await library.update(expected.ids[0], { meta: desiredMeta, shot: desiredShot, range: desiredRange });
      } finally { IDBDatabase.prototype.transaction = transaction; }
      const renamedRecord = (await readStore('shots')).find(s => s.id === expected.ids[0]);
      check(named.id === expected.ids[0] && named.name === 'Custom arc', 'Rename returns the requested take info');
      check(renamedRecord.info.name === 'Custom arc 3', 'Post-rename autosave cannot overwrite the custom name');
      const stable = record => ({ ...record, info: { ...record.info, name: null, updated: null } });
      equal(stable(renamedRecord), stable(unnamed), 'Rename preserves ID, created, range, preview, scene, metadata, camera and events');
      const renamedTake = await library.open(expected.ids[0]);
      check(renamedTake.info.name === 'Custom arc 3', 'Renamed take reopens with its custom name');
      equal(await trackHashes(renamedTake.take), expected.first, 'Rename preserves every track hash');
      equal(await trackHashes(await fixture.loadTake(await (await fixture.saveTake(renamedTake.take)).arrayBuffer())), expected.first, 'Renamed take keeps exact portable ZIP tracks');
      await writeRecord('shots', { ...renamedRecord, info: { ...renamedRecord.info, id: crypto.randomUUID() } });
      await rejects(() => library.rename(expected.ids[0], 'Corrupt'), /Error/);
      check((await readStore('shots')).find(s => s.id === expected.ids[0]).info.name === 'Custom arc 3', 'Rejected corrupt rename writes nothing');
      await writeRecord('shots', renamedRecord);
      // Force a real transaction abort after real requests have been queued; no fake IndexedDB implementation.
      const add = IDBObjectStore.prototype.add;
      IDBObjectStore.prototype.add = function(...args) {
        const req = add.apply(this, args);
        if (this.name === 'scenes') req.addEventListener('success', () => this.transaction.abort(), { once: true });
        return req;
      };
      const abortedId = crypto.randomUUID();
      try { await rejects(() => library.save({ id: abortedId, name: 'Aborted creation', take: makeTake(3), model: makeModel(), thumbnail: null }), /abort|inactive/i); }
      finally { IDBObjectStore.prototype.add = add; }
      check(!(await readStore('shots')).some(s => s.id === abortedId) && !(await readStore('tracks')).some(s => s.id === abortedId), 'Abort leaves no half-created take');
      equal(await trackHashes((await library.open(expected.ids[0])).take), expected.first, 'Abort cannot clear older data');
      const sceneIds = (await readStore('scenes')).map(scene => scene.id); equal(sceneIds, [expected.sceneId], 'Abort leaves no new orphan scene');
      // Corruption rejects before replay. Restore each real record so unrelated checks remain meaningful.
      const record = (await readStore('shots')).find(s => s.id === expected.ids[0]);
      for (const corrupted of [{ ...record, events: [{ t: -1, kind: 'move', label: 'invalid' }] }, { ...record, meta: { ...record.meta, robot: 'go2' } }, { ...record, shot: { ...record.shot, focal: -2 } }, ...[[0, 0], [0, record.info.duration + .001], [0, .02, .03], [NaN, .03], null].map(range => ({ ...record, info: { ...record.info, range } }))]) {
        await writeRecord('shots', corrupted); await rejects(() => library.open(expected.ids[0]), /invalid/i); await writeRecord('shots', record);
      }
      for (const change of [
        { display: null }, { flashlight: 'true' }, { lights: null },
        { edits: { ...record.meta.edits, display: { ...record.meta.display, characterWireframe: 1 } } },
        { edits: { ...record.meta.edits, flashlight: null } }, { edits: { ...record.meta.edits, lights: [record.meta.lights[0], record.meta.lights[0]] } },
      ]) {
        const corrupted = { ...record, meta: { ...record.meta, ...change } };
        await writeRecord('shots', corrupted); await rejects(() => library.open(record.id), /invalid/i); await writeRecord('shots', record);
      }
      const legacy = structuredClone(record); delete legacy.info.range;
      await writeRecord('shots', legacy);
      check((await library.open(record.id)).take.range === undefined, 'Schema-1 entries without optional range remain loadable');
      check(!(await library.list()).find(s => s.id === record.id).range, 'Legacy list does not invent range');
      await writeRecord('shots', record);
      const invalidTake = makeTake(5); invalidTake.range = [0, invalidTake.duration + .001];
      await rejects(() => library.save({ id: crypto.randomUUID(), name: 'Invalid range', take: invalidTake, model: makeModel(), thumbnail: null }), /invalid/i);
      const tracks = (await readStore('tracks')).find(s => s.id === record.id);
      check(tracks.geom.fixedIds instanceof Uint32Array && tracks.geom.values instanceof Float32Array, 'Geometry persists as plain typed data, not a class or dense compatibility track');
      equal([...tracks.geom.fixedIds], [1], 'Original fixed geometry ID persists');
      check(tracks.geom.values.length === 7 + record.info.frames * 7, 'Fixed pose is stored once before moving frames');
      const byteCount = tracks.geom.fixedIds.byteLength + tracks.geom.values.byteLength
        + ['t', 'qpos', 'cmd', 'cam', 'hoist', 'camOrientation'].reduce((n, key) => n + tracks[key].byteLength, 0);
      check(record.info.bytes === byteCount, 'Completed-shot byte accounting includes fixed IDs and values exactly once');
      for (const geom of [
        { fixedIds: new Uint32Array([2]), values: tracks.geom.values },
        { fixedIds: new Uint32Array([1, 1]), values: new Float32Array(14) },
        { fixedIds: new Uint32Array([1, 0]), values: new Float32Array(14) },
        { fixedIds: new Int32Array([1]), values: tracks.geom.values },
        { fixedIds: new Uint32Array([1]), values: tracks.geom.values.slice(1) },
        { fixedIds: new Uint32Array([1]), values: new Float64Array(tracks.geom.values) },
        { fixedIds: new Uint32Array([1]), values: tracks.geom.values.map((v, i) => i === 0 ? NaN : v) },
      ]) {
        await writeRecord('tracks', { ...tracks, geom }); await rejects(() => library.open(record.id), /invalid/i);
        await writeRecord('tracks', tracks);
      }
      await writeRecord('tracks', { ...tracks, cam: new Float64Array(tracks.cam) }); await rejects(() => library.open(record.id), /invalid/i); await writeRecord('tracks', tracks);
      const scene = (await readStore('scenes'))[0];
      await writeRecord('scenes', { ...scene, model: { ...scene.model, robot: 'go2' } }); await rejects(() => library.open(record.id), /invalid/i); await writeRecord('scenes', scene);
      window.goodMeta = desiredMeta; window.goodShot = desiredShot; window.goodRange = desiredRange;
    }, baseline);
    // Chrome's actual storage quota, not a mocked rejection. Only this fixture's isolated origin is affected.
    await page.evaluate(async expected => {
      const library = new fixture.ShotLibrary(), huge = new Blob([new Uint8Array(16 * 1024 * 1024).fill(71)], { type: 'image/webp' });
      await rejects(() => library.update(expected.ids[0], { meta: { ...goodMeta, policy: 'must not commit' }, shot: goodShot, range: undefined, thumbnail: huge }), /quota/i);
      const quotaId = crypto.randomUUID();
      await rejects(() => library.save({ id: quotaId, name: 'Quota creation', take: makeTake(4), model: makeModel(), thumbnail: huge }), /quota/i);
      const first = await library.open(expected.ids[0]), second = await library.open(expected.ids[1]);
      equal(first.take.meta, goodMeta, 'Failed quota update preserves last committed metadata'); equal(first.take.shot, goodShot, 'Failed quota update preserves camera'); check(first.info.thumbnail === null, 'Failed preview never replaces last committed preview');
      equal(first.take.range, goodRange, 'Failed quota update preserves last committed range');
      equal(await trackHashes(first.take), expected.first, 'Quota failure preserves first buffers'); equal(await trackHashes(second.take), expected.second, 'Quota failure preserves unrelated shot');
      check(!(await readStore('shots')).some(s => s.id === quotaId) && !(await readStore('tracks')).some(s => s.id === quotaId), 'Quota creation is atomic');
      equal((await readStore('scenes')).map(scene => scene.id), [expected.sceneId], 'Quota failure leaves no orphan model');
    }, baseline);
    await cdp.send('Storage.overrideQuotaForOrigin', { origin });
    await page.evaluate(async expected => {
      const library = new fixture.ShotLibrary();
      await library.remove(expected.ids[0]);
      await rejects(() => library.rename(expected.ids[0], 'After delete'), /Error/);
      check(!(await readStore('shots')).some(s => s.id === expected.ids[0]), 'Rename after deletion cannot resurrect a take');
      const photos = new fixture.PhotoLibrary();
      await photos.remove(expected.photo.id);
      await rejects(() => photos.rename(expected.photo.id, 'After delete'), /Error/);
      check(!(await readStore('photos')).some(p => p.id === expected.photo.id) && !(await readStore('photoData')).some(p => p.id === expected.photo.id), 'Rename after deletion cannot resurrect a PNG');
      await rejects(() => library.update(expected.ids[0], { meta: goodMeta, shot: goodShot, range: goodRange }));
      await rejects(() => library.open(expected.ids[0]));
      const second = await library.open(expected.ids[1]);
      equal(await trackHashes(second.take), expected.second, 'Shared scene remains loadable after first take deletion');
      equal(sample(second.take), expected.secondSample, 'Surviving take still replays original motion/camera');
      check(await hash(second.model.meshes[0].vert) === expected.mesh, 'Shared geometry retained for survivor');
      const reusedId = crypto.randomUUID();
      await library.save({ id: reusedId, name: 'Reused opened scene', take: second.take, model: second.model, thumbnail: null });
      check((await readStore('shots')).find(shot => shot.id === reusedId).sceneId === expected.sceneId, 'Opened model object retains its persisted scene identity');
      await library.remove(expected.ids[1]);
      equal(await trackHashes((await library.open(reusedId)).take), expected.second, 'New saved reference keeps shared scene loadable');
      await library.remove(reusedId);
      check(!(await readStore('scenes')).some(scene => scene.id === expected.sceneId), 'Final reference deletion garbage-collects its scene');
      check(!(await readStore('tracks')).some(track => expected.ids.includes(track.id)), 'Explicit deletion removes only owned tracks');
      // The WeakMap still knows this model, but its last reference was deleted. Creation must restore it atomically.
      const restoredId = crypto.randomUUID();
      await library.save({ id: restoredId, name: 'Restored scene', take: second.take, model: second.model, thumbnail: null });
      equal(await trackHashes((await library.open(restoredId)).take), expected.second, 'Missing cached scene is restored on creation');
      await library.remove(restoredId);
      check(!(await readStore('scenes')).some(scene => scene.id === expected.sceneId), 'Restored scene is collected after its final deletion');
      equal(await library.list(), [], 'Deleted entries never resurrect');
    }, baseline);
    // Shots rename → active take owner, through the real dialog, real input and real IndexedDB commits.
    await page.close(); page = await freshPage();
    const renameIds = await page.evaluate(async () => {
      const library = new fixture.ShotLibrary(), photos = new fixture.PhotoLibrary(), model = makeModel();
      const ids = { active: crypto.randomUUID(), other: crypto.randomUUID(), gone: crypto.randomUUID(), photo: crypto.randomUUID() };
      for (const [id, name, offset] of [[ids.active, 'Active take', 6], [ids.other, 'Other take', 7], [ids.gone, 'Gone take', 8]]) {
        await library.save({ id, name, take: makeTake(offset), model, thumbnail: null });
      }
      const canvas = document.createElement('canvas'); canvas.width = canvas.height = 4; canvas.getContext('2d').fillRect(0, 0, 2, 2);
      const png = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
      await photos.save({ id: ids.photo, name: 'Frame', created: new Date(1700000200000).toISOString(), robot: 'r1', terrain: 'flat', png });
      const notices = [], show = document.createElement('button'); show.id = 'show-shots'; show.textContent = 'Shots'; document.body.append(show);
      const dialog = new fixture.ShotLibraryDialog(document.body, { library, photos, recoveries: new fixture.RecordingRecovery(library),
        open: () => {}, deleted: () => {}, takeRenamed: (id, name) => notices.push({ id, name }), blocked: () => null, modalChanged: () => {} });
      show.onclick = () => dialog.open();
      // A real competing readwrite transaction holds the shots store until released, delaying the rename commit.
      window.holdShots = () => new Promise((resolve, reject) => {
        const opening = indexedDB.open('m0clip-shots');
        opening.onerror = () => reject(opening.error);
        opening.onsuccess = () => {
          const db = opening.result, tx = db.transaction('shots', 'readwrite'), store = tx.objectStore('shots');
          let held = true; const spin = () => { if (held) store.count().onsuccess = spin; };
          const done = new Promise(finished => { tx.oncomplete = () => { db.close(); finished(); }; });
          spin(); resolve({ release() { held = false; return done; } });
        };
      });
      const active = await library.open(ids.active);
      window.renameFixture = { library, photos, ids, notices, dialog, activeHashes: await trackHashes(active.take), activeRange: active.take.range, activeShot: active.take.shot };
      return ids;
    });
    const shotCard = id => page.locator(`article.shot-library-card[data-shot-id="${id}"]`);
    const notices = () => page.evaluate(() => renameFixture.notices);
    const startRename = async (id, name) => {
      await shotCard(id).locator('[data-shot-action="rename"]').click();
      const input = shotCard(id).locator('.shot-library-rename-input'); await input.fill(name); return input;
    };
    await page.click('#show-shots'); await shotCard(renameIds.active).waitFor();
    // Renaming another take reports that take's own committed identity, never the active one.
    await (await startRename(renameIds.other, 'Other renamed')).press('Enter');
    await page.waitForFunction(() => renameFixture.notices.length === 1);
    assert.deepEqual(await notices(), [{ id: renameIds.other, name: 'Other renamed' }], 'Only the committed take identity and trimmed name are reported');
    // Late completion: close and reopen Shots while the active take rename is still waiting to commit.
    await page.evaluate(async () => { renameFixture.hold = await holdShots(); });
    const pending = await startRename(renameIds.active, '  Late name  ');
    await pending.press('Enter');
    await page.waitForFunction(() => document.querySelector('.shot-library-rename-input')?.readOnly === true);
    await page.keyboard.press('Escape');
    assert.equal(await page.evaluate(() => renameFixture.dialog.isOpen), false, 'Shots closes while the rename is pending');
    await page.click('#show-shots');
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    assert.equal((await notices()).length, 1, 'No owner notification before the rename transaction commits');
    await page.evaluate(() => renameFixture.hold.release());
    await page.waitForFunction(() => renameFixture.notices.length === 2);
    assert.deepEqual((await notices())[1], { id: renameIds.active, name: 'Late name' }, 'A committed rename reaches the active owner after the dialog session changed');
    await shotCard(renameIds.active).locator('h3', { hasText: 'Late name' }).waitFor();
    assert.deepEqual(await page.evaluate(() => ({ editor: document.querySelectorAll('.shot-library-rename').length, focus: document.activeElement?.classList.contains('shot-library-rename-input') ?? false })),
      { editor: 0, focus: false }, 'The old session cannot restore its editor or take focus in the reopened list');
    await page.evaluate(async () => {
      const { library, ids, activeHashes, activeRange, activeShot } = renameFixture, opened = await library.open(ids.active);
      check(opened.info.name === 'Late name', 'Reopened session lists the committed name');
      equal(await trackHashes(opened.take), activeHashes, 'Rename leaves the take tracks untouched');
      equal([opened.take.range, opened.take.shot], [activeRange, activeShot], 'Rename leaves range and camera untouched');
      // Metadata autosave after the rename owns range/camera/meta only; the committed name survives it.
      await library.update(ids.active, { meta: opened.take.meta, shot: { ...opened.take.shot, focal: 70 }, range: opened.take.range });
      const saved = (await library.list()).find(info => info.id === ids.active);
      check(saved.name === 'Late name', 'Autosave keeps the committed name');
    });
    // A failed commit keeps the draft beside an actionable error and never notifies the owner.
    await page.evaluate(() => new fixture.ShotLibrary().remove(renameFixture.ids.gone));
    const doomed = await startRename(renameIds.gone, 'Never kept');
    await doomed.press('Enter');
    const error = shotCard(renameIds.gone).locator('.shot-library-rename-error');
    await error.waitFor({ state: 'visible' });
    assert.equal((await notices()).length, 2, 'A failed rename never notifies the owner');
    assert.deepEqual(await doomed.evaluate(input => ({ value: input.value, invalid: input.getAttribute('aria-invalid'), described: document.getElementById(input.getAttribute('aria-describedby'))?.textContent.trim().length > 0 })),
      { value: 'Never kept', invalid: 'true', described: true }, 'Failure keeps the draft with an associated error');
    await shotCard(renameIds.gone).locator('[data-shot-action="rename-cancel"]').click();
    await shotCard(renameIds.gone).waitFor({ state: 'detached' });
    // PNG renames have no take owner.
    await (await startRename(renameIds.photo, 'Frame renamed')).press('Enter');
    await page.waitForFunction(async () => (await renameFixture.photos.list()).find(info => info.id === renameFixture.ids.photo)?.name === 'Frame renamed');
    assert.equal((await notices()).length, 2, 'PNG rename does not notify the take owner');
    assert.deepEqual(errors, [], 'No uncaught browser storage errors');
    console.log('PASS: actual Chrome IDB clone ownership, all seven exact track hashes, replay/camera/page reopen, small metadata updates, take/PNG name-only renames, shared-scene GC, corruption rejection, real abort and real quota atomicity');
  } finally {
    try { if (context) await context.close(); }
    finally { if (server) await new Promise(resolve => server.close(resolve)); await rm(profile, { recursive: true, force: true }); }
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
