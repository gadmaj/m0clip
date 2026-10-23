/** Actual Chrome PNG bytes, native decoding, IndexedDB abort/quota retention and pictured gallery. Run from the repo root. */
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { build } = require('esbuild');
const { createServer } = require('node:http');
const { once } = require('node:events');
const { mkdtemp, readFile, rm } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');

(async () => {
  const profile = await mkdtemp(join(tmpdir(), 'm0clip-photo-idb-'));
  let context, server;
  try {
    const built = await build({ stdin: { contents: "import {PhotoLibrary} from './src/record/photos';import {ShotLibrary} from './src/record/library';import {Take} from './src/record/take';import {GeometryTrack} from './src/core/geometry';import {RecordingRecovery} from './src/record/recovery';import {ShotLibraryDialog} from './src/ui/shot-library';globalThis.fixture={PhotoLibrary,ShotLibrary,Take,GeometryTrack,RecordingRecovery,ShotLibraryDialog};", resolveDir: process.cwd() }, outfile: 'fixture.js', bundle: true, platform: 'browser', format: 'iife', write: false });
    const javascript = built.outputFiles.find(file => file.path.endsWith('.js')).contents;
    const css = built.outputFiles.find(file => file.path.endsWith('.css')).contents;
    server = createServer((request, response) => {
      response.setHeader('Cache-Control', 'no-store');
      response.setHeader('Content-Type', request.url === '/fixture.js' ? 'text/javascript' : request.url === '/fixture.css' ? 'text/css' : 'text/html');
      response.end(request.url === '/fixture.js' ? javascript : request.url === '/fixture.css' ? css : '<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><title>PNG retention fixture</title><link rel="stylesheet" href="/fixture.css"><style>body{margin:0}:root{--sans:Arial,sans-serif;--text:#eee;--text-2:#bbb;--panel:#30342d;--raised:#3b4036;--bg:#20231e;--line-hi:#6a6d62;--r:0;--accent:#e1b859;--danger:#e8a59a;--danger-dim:#593a32;--shadow:#111;--bevel:#575b50;--scrim:#0009}</style><button id="show">Shots</button><script src="/fixture.js"></script>');
    });
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    const origin = `http://127.0.0.1:${server.address().port}`;
    context = await chromium.launchPersistentContext(profile, { executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome', headless: true, acceptDownloads: true, args: ['--no-sandbox', '--disable-dev-shm-usage'], viewport: { width: 960, height: 800 } });
    const errors = [];
    // Set the real quota before ANY writes. Keep its CDP owner alive across data-realm destruction.
    const quotaPage = await context.newPage(); await quotaPage.goto(origin);
    const cdp = await context.newCDPSession(quotaPage);
    await cdp.send('Storage.overrideQuotaForOrigin', { origin, quotaSize: 1024 * 1024 });
    async function freshPage() {
      const page = await context.newPage();
      page.on('pageerror', error => errors.push(error.message)); await page.goto(origin);
      await page.evaluate(() => {
        window.check = (condition, message) => { if (!condition) throw new Error(message); };
        window.equal = (a, b, message) => check(JSON.stringify(a) === JSON.stringify(b), message);
        window.hash = async value => {
          const bytes = value instanceof Blob ? await value.arrayBuffer() : value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength);
          return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), v => v.toString(16).padStart(2, '0')).join('');
        };
        window.trackHashes = take => Promise.all(['t', 'geom', 'qpos', 'cmd', 'cam', 'hoist', 'camOrientation'].map(key => hash(key === 'geom' ? take.geom.values : take[key])));
        window.rejects = async (action, pattern) => {
          let failure; try { await action(); } catch (error) { failure = error; }
          check(failure && pattern.test(`${failure.name}: ${failure.message}`), `Expected ${pattern}, got ${failure}`);
        };
        window.rows = async store => {
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
        window.encode = async canvas => {
          const { promise, resolve, reject } = Promise.withResolvers();
          canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error('Fixture PNG encode failed')), 'image/png');
          return promise;
        };
        window.picture = async (portrait = false, noise = false) => {
          const canvas = document.createElement('canvas');
          canvas.width = noise ? 1024 : portrait ? 360 : 640; canvas.height = noise ? 1024 : portrait ? 640 : 360;
          const ctx = canvas.getContext('2d');
          if (noise) {
            const image = ctx.createImageData(canvas.width, canvas.height);
            for (let start = 0; start < image.data.length; start += 65536) crypto.getRandomValues(image.data.subarray(start, start + 65536));
            ctx.putImageData(image, 0, 0);
          } else {
            ctx.fillStyle = portrait ? '#1246d3' : '#d32818'; ctx.fillRect(0, 0, canvas.width, canvas.height);
            ctx.fillStyle = '#75ad29'; ctx.fillRect(canvas.width / 2, 0, canvas.width / 2, canvas.height / 2);
            ctx.fillStyle = '#e3c519'; ctx.fillRect(canvas.width / 2, canvas.height / 2, canvas.width / 4, canvas.height / 4);
          }
          const encoded = await encode(canvas); canvas.width = canvas.height = 0;
          // A valid ancillary tEXt chunk makes the original distinguishable from ANY thumbnail re-encode.
          const bytes = new Uint8Array(await encoded.arrayBuffer()), text = new TextEncoder().encode(`capture\0original-${portrait}-${noise}`);
          const chunk = new Uint8Array(12 + text.length), view = new DataView(chunk.buffer);
          view.setUint32(0, text.length); chunk.set([116, 69, 88, 116], 4); chunk.set(text, 8);
          let crc = 0xffffffff;
          for (const byte of chunk.subarray(4, 8 + text.length)) {
            crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = crc >>> 1 ^ (crc & 1 ? 0xedb88320 : 0);
          }
          view.setUint32(8 + text.length, (crc ^ 0xffffffff) >>> 0);
          return new Blob([bytes.subarray(0, bytes.length - 12), chunk, bytes.subarray(bytes.length - 12)], { type: 'image/png' });
        };
        window.decoded = async blob => {
          const bitmap = await createImageBitmap(blob), canvas = document.createElement('canvas');
          canvas.width = bitmap.width; canvas.height = bitmap.height;
          const ctx = canvas.getContext('2d'); ctx.drawImage(bitmap, 0, 0);
          const result = { width: bitmap.width, height: bitmap.height, pixel: Array.from(ctx.getImageData(Math.floor(bitmap.width / 4), Math.floor(bitmap.height / 4), 1, 1).data) };
          bitmap.close(); canvas.width = canvas.height = 0; return result;
        };
        window.motion = () => {
          const meta = { robot: 'r1', terrain: 'flat', policy: 'fixture', created: '2026-10-20T12:00:00.000Z', ngeom: 1, nq: 7, baseQadr: 0, hinges: [] };
          const t = new Float64Array([0, .1, .2]), geom = new Float32Array(21), qpos = new Float32Array(21), cmd = new Float32Array(9), cam = new Float32Array(21), hoist = new Float32Array(9).fill(NaN), orientation = new Float32Array(12);
          for (let i = 0; i < 3; i++) {
            geom.set([i < 2 ? 0 : i * .13, i < 2 ? 0 : -.2 * i, 1, 0, 0, 0, 1], i * 7); qpos.set([i * .13, -.2 * i, 1, 1, 0, 0, 0], i * 7);
            cmd.set([.4 * i, -.3, .2], i * 3); cam.set([2 + i, -3, 2, .1 * i, 0, 1, 48 + i], i * 7); orientation.set([0, 0, 0, 1], i * 4);
          }
          const take = new fixture.Take(meta, t, fixture.GeometryTrack.dense(meta.ngeom, t.length, geom), qpos, cmd, cam, hoist, [{ t: .1, kind: 'move', label: 'Side step' }], orientation);
          take.range = [.05, .18];
          const model = { robot: 'r1', terrain: 'flat', ngeom: 1, nq: 7, baseQadr: 0, hinges: [], type: new Int32Array([2]), size: new Float64Array([.2, .3, .4]), rgba: new Float32Array([.2, .4, .8, 1]), group: new Int32Array([1]), contype: new Int32Array([1]), bodyid: new Int32Array([0]), dataid: new Int32Array([-1]), bodyNames: ['world'], meshes: {} };
          return { take, model };
        };
        window.mount = () => {
          const library = new fixture.ShotLibrary(), photos = new fixture.PhotoLibrary(), recoveries = new fixture.RecordingRecovery(library);
          const dialog = new fixture.ShotLibraryDialog(document.body, { library, photos, recoveries, open: () => {}, deleted: () => {}, blocked: () => null, modalChanged: () => {} });
          document.querySelector('#show').onclick = () => dialog.open();
          window.gallery = { library, photos, recoveries, dialog };
        };
      });
      return page;
    }
    let page = await freshPage();
    const expected = await page.evaluate(async () => {
      const photos = new fixture.PhotoLibrary(), library = new fixture.ShotLibrary(), a = await picture(), b = await picture(true);
      const ids = ['photo-landscape', 'photo-portrait', 'motion-untouched'];
      const { take, model } = motion(), sceneId = 'legacy-scene', draftId = 'legacy-draft';
      const trackKeys = ['t', 'geom', 'qpos', 'cmd', 'cam', 'hoist', 'camOrientation'];
      const strides = { t: 1, geom: 7, qpos: 7, cmd: 3, cam: 7, hoist: 3, camOrientation: 4 };
      const raw = Object.fromEntries(trackKeys.map(key => [key, key === 'geom' ? take.geom.values : take[key]]));
      const bytes = trackKeys.reduce((n, key) => n + raw[key].byteLength, 0);
      const shotInfo = { id: ids[2], name: 'Side step', created: take.meta.created, updated: take.meta.created, robot: take.meta.robot,
        terrain: take.meta.terrain, duration: take.duration, frames: take.n, bytes, thumbnail: null, range: take.range };
      const canvas = document.createElement('canvas'); canvas.width = 320; canvas.height = 180;
      const bitmap = await createImageBitmap(a); canvas.getContext('2d').drawImage(bitmap, 0, 0, 320, 180); bitmap.close();
      const thumbnail = await encode(canvas); canvas.width = canvas.height = 0;
      const photoInfo = { id: ids[0], name: 'Red tile / left', created: '2026-10-20T12:01:00Z', updated: '2026-10-20T12:01:00Z',
        robot: 'r1', terrain: 'flat', width: 640, height: 360, bytes: a.size, thumbnail };
      const chunks = [0, 2].map((from, i) => {
        const to = i ? 3 : 2;
        return { recordingId: draftId, from, ...Object.fromEntries(trackKeys.map(key => [key, raw[key].slice(from * strides[key], to * strides[key])])) };
      });
      const opening = indexedDB.open('m0clip-shots', 2), seeded = Promise.withResolvers();
      opening.onupgradeneeded = () => {
        const db = opening.result;
        for (const name of ['shots', 'drafts']) db.createObjectStore(name, { keyPath: 'id' }).createIndex('sceneId', 'sceneId');
        for (const name of ['tracks', 'scenes', 'photos', 'photoData']) db.createObjectStore(name, { keyPath: 'id' });
        db.createObjectStore('chunks', { keyPath: ['recordingId', 'from'] });
      };
      opening.onerror = () => seeded.reject(opening.error);
      opening.onsuccess = () => {
        const db = opening.result, tx = db.transaction(['shots', 'tracks', 'scenes', 'photos', 'photoData', 'drafts', 'chunks'], 'readwrite');
        tx.objectStore('shots').add({ id: ids[2], info: shotInfo, meta: take.meta, events: take.events, sceneId });
        tx.objectStore('tracks').add({ id: ids[2], ...raw });
        tx.objectStore('scenes').add({ id: sceneId, terrain: take.meta.terrain, model });
        tx.objectStore('photos').add({ id: ids[0], info: photoInfo }); tx.objectStore('photoData').add({ id: ids[0], png: a });
        tx.objectStore('drafts').add({ id: draftId, info: { ...shotInfo, id: draftId, name: 'Legacy world rows', thumbnail: null }, meta: take.meta, events: take.events, sceneId });
        for (const chunk of chunks) tx.objectStore('chunks').add(chunk);
        tx.oncomplete = () => { db.close(); seeded.resolve(); }; tx.onabort = () => { db.close(); seeded.reject(tx.error); };
      };
      await seeded.promise;
      // Abort a real versionchange after its conversion request succeeds; no partial schema or data cutover.
      const update = IDBCursor.prototype.update;
      IDBCursor.prototype.update = function(...args) {
        const request = update.apply(this, args);
        if (this.source.name === 'tracks') request.addEventListener('success', () => this.source.transaction.abort(), { once: true });
        return request;
      };
      try { await rejects(() => library.open(ids[2]), /abort/i); }
      finally { IDBCursor.prototype.update = update; }
      const oldTracks = (await rows('tracks'))[0], oldDraft = (await rows('drafts'))[0];
      check(oldTracks.geom instanceof Float32Array && oldDraft.geometry === undefined, 'Aborted upgrade retains both original dense schemas');
      check((await indexedDB.databases()).find(db => db.name === 'm0clip-shots').version === 2, 'Aborted upgrade rolls back the database version');
      check(await hash((await rows('photoData'))[0].png) === await hash(a), 'Aborted geometry upgrade leaves original PNG bytes intact');
      const restored = await new fixture.RecordingRecovery(library).read(draftId);
      equal(await trackHashes(restored.take), await trackHashes(take), 'V2 draft upgrade preserves seven semantic tracks byte-for-byte');
      check(restored.take.geom.fixedIds.length === 0 && restored.take.geom.values.length === 21, 'V2 migration never guesses a fixed world row from the initial chunk');
      check(restored.take.poseAt(.2).xpos[0] === take.geom.values[14] && restored.take.poseAt(0).xpos[0] === 0, 'A world row varying only in a late legacy chunk remains animated');
      const upgradedDraft = (await rows('drafts'))[0];
      check(upgradedDraft.geometry.fixedIds.length === 0 && upgradedDraft.geometry.fixed.length === 0 && upgradedDraft.info.bytes === bytes, 'Legacy draft migration adds only an empty partition and retains byte accounting');
      equal(await Promise.all((await rows('chunks')).flatMap(chunk => trackKeys.map(key => hash(chunk[key])))),
        await Promise.all(chunks.flatMap(chunk => trackKeys.map(key => hash(chunk[key])))), 'Upgrade leaves every original chunk byte untouched');
      equal(await trackHashes((await library.open(ids[2])).take), await trackHashes(take), 'V2 completed-track conversion retains all geometry and six other arrays');
      check(await hash((await photos.open(ids[0])).png) === await hash(a), 'Successful V2 upgrade preserves original PNG Blob');
      await new fixture.RecordingRecovery(library).remove(draftId);
      await photos.save({ id: ids[1], name: 'Blue tile / right', created: '2026-10-20T12:02:00Z', robot: 'r1', terrain: 'flat', png: b });
      const info = await photos.list();
      check(info.length === 2, 'Both captures retained');
      const thumbs = await Promise.all(ids.slice(0, 2).map(async id => {
        const item = info.find(row => row.id === id), thumb = await decoded(item.thumbnail), original = await decoded((await photos.open(id)).png);
        check(thumb.width <= 320 && thumb.height <= 200 && thumb.width > 0 && thumb.height > 0, 'Actual preview is bounded, not collapsed');
        equal(thumb.pixel, original.pixel, 'Preview is derived from this original capture');
        check(await hash(item.thumbnail) !== await hash(id === ids[0] ? a : b), 'Original bytes are not replaced with preview encoding');
        return { hash: await hash(item.thumbnail), ...thumb };
      }));
      check(thumbs[0].hash !== thumbs[1].hash, 'Independent captures have independent previews');
      return { ids, originals: [await hash(a), await hash(b)], thumbs, tracks: await trackHashes(take) };
    });
    await page.close(); page = await freshPage();
    await page.evaluate(async expected => {
      const photos = new fixture.PhotoLibrary(), library = new fixture.ShotLibrary();
      for (let i = 0; i < 2; i++) {
        const saved = await photos.open(expected.ids[i]);
        check(await hash(saved.png) === expected.originals[i], 'Exact original PNG survives realm destruction');
        equal([saved.info.width, saved.info.height], i ? [360, 640] : [640, 360], 'Original dimensions survive independently');
        check(await hash(saved.info.thumbnail) === expected.thumbs[i].hash, 'Independent preview persists across realms');
      }
      const a = await photos.open(expected.ids[0]);
      await rejects(() => photos.save({ ...a.info, png: a.png }), /constraint/i);
      check(await hash((await photos.open(expected.ids[0])).png) === expected.originals[0], 'Duplicate ID cannot replace a completed capture');
      const badId = 'invalid-png';
      await rejects(() => photos.save({ ...a.info, id: badId, png: new Blob([a.png], { type: 'image/jpeg' }) }), /invalid/i);
      await rejects(() => photos.save({ ...a.info, id: badId, png: a.png.slice(0, 33, 'image/png') }), /decode|invalid/i);
      check(!(await photos.list()).some(info => info.id === badId), 'Invalid images never create metadata');
      // Abort real queued writes, not a fake storage rejection. Both stores must roll back together.
      const add = IDBObjectStore.prototype.add;
      IDBObjectStore.prototype.add = function(...args) {
        const request = add.apply(this, args);
        if (this.name === 'photoData') request.addEventListener('success', () => this.transaction.abort(), { once: true });
        return request;
      };
      try { await rejects(() => photos.save({ ...a.info, id: 'aborted-photo', png: a.png }), /abort|inactive/i); }
      finally { IDBObjectStore.prototype.add = add; }
      check(!(await rows('photos')).some(row => row.id === 'aborted-photo') && !(await rows('photoData')).some(row => row.id === 'aborted-photo'), 'Aborted capture leaves no half-record');
      const remove = IDBObjectStore.prototype.delete;
      IDBObjectStore.prototype.delete = function(...args) {
        const request = remove.apply(this, args);
        if (this.name === 'photoData') request.addEventListener('success', () => this.transaction.abort(), { once: true });
        return request;
      };
      try { await rejects(() => photos.remove(expected.ids[0]), /abort|inactive/i); }
      finally { IDBObjectStore.prototype.delete = remove; }
      check(await hash((await photos.open(expected.ids[0])).png) === expected.originals[0], 'Aborted deletion retains original AND metadata');
      const huge = await picture(false, true);
      check(huge.size > 1024 * 1024, 'Real encoded PNG exceeds installed origin quota');
      await rejects(() => photos.save({ ...a.info, id: 'quota-photo', png: huge }), /quota/i);
      check(!(await rows('photos')).some(row => row.id === 'quota-photo') && !(await rows('photoData')).some(row => row.id === 'quota-photo'), 'Real quota failure is atomic');
      for (let i = 0; i < 2; i++) check(await hash((await photos.open(expected.ids[i])).png) === expected.originals[i], 'Abort/quota never evicts a previous PNG');
      const take = (await library.open(expected.ids[2])).take;
      equal(await trackHashes(take), expected.tracks, 'Photo failures do not alter completed motion');
      mount();
    }, expected);
    await page.getByRole('button', { name: 'Shots', exact: true }).click();
    await page.waitForFunction(() => document.querySelectorAll('.shot-library-card').length === 3 && document.querySelector('.shot-library-grid').getAttribute('aria-busy') === 'false');
    for (const width of [320, 390, 960]) {
      await page.setViewportSize({ width, height: 800 });
      await page.locator('[data-shot-id="photo-landscape"] .shot-library-preview img').waitFor();
      await page.waitForFunction(() => [...document.querySelectorAll('[data-shot-kind="photo"] .shot-library-preview img')].every(image => image.complete && image.naturalWidth > 0));
      const layout = await page.evaluate(() => {
        const dialog = document.querySelector('dialog'), grid = document.querySelector('.shot-library-grid');
        return { overflow: dialog.scrollWidth > dialog.clientWidth || grid.scrollWidth > grid.clientWidth, previewHeights: [...grid.querySelectorAll('.shot-library-preview')].map(node => node.getBoundingClientRect().height) };
      });
      assert.equal(layout.overflow, false, `Unfiltered mixed gallery fits ${width}px`);
      assert.ok(layout.previewHeights.every(height => height > 100), `Unfiltered preview tracks stay visible at ${width}px`);
    }
    const landscape = page.locator('[data-shot-id="photo-landscape"]');
    await landscape.getByRole('button', { name: 'Open: Red tile / left', exact: true }).click();
    await page.getByRole('button', { name: 'Back to shots', exact: true }).waitFor();
    await page.waitForFunction(() => document.querySelector('.shot-library-photo img')?.naturalWidth === 640);
    await page.evaluate(async expected => {
      const image = document.querySelector('.shot-library-photo img');
      check(await hash(await (await fetch(image.src)).blob()) === expected.originals[0], 'Photo view uses actual ORIGINAL captured image');
      check(document.activeElement.textContent === 'Back to shots', 'Photo open restores keyboard focus to visible controls');
    }, expected);
    const downloadReady = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Save PNG', exact: true }).click();
    const download = await downloadReady;
    assert.equal(download.suggestedFilename(), 'Red tile _ left.png');
    assert.equal(createHash('sha256').update(await readFile(await download.path())).digest('hex'), expected.originals[0], 'PNG backup downloads exact original bytes');
    await page.evaluate(async () => {
      await gallery.photos.save({ id: 'photo-deferred', name: 'Deferred capture', created: new Date().toISOString(), robot: 'r1', terrain: 'flat', png: await picture() });
      gallery.dialog.refresh();
      check(!document.querySelector('.shot-library-photo').hidden, 'Background retention refresh does not replace the open original');
    });
    await page.getByRole('button', { name: 'Back to shots', exact: true }).click();
    await page.waitForFunction(() => document.querySelectorAll('.shot-library-card').length === 4 && document.querySelector('.shot-library-grid').getAttribute('aria-busy') === 'false');
    // Hold only presentation AFTER real IDB open/decode. Closing/reopening must discard that older session.
    await page.evaluate(() => {
      const original = gallery.photos.open.bind(gallery.photos), held = Promise.withResolvers();
      window.releasePhoto = held.resolve;
      gallery.photos.open = async id => { const saved = await original(id); window.photoRead = true; await held.promise; return saved; };
      window.restorePhotoOpen = () => { gallery.photos.open = original; };
    });
    await page.locator('[data-shot-id="photo-portrait"]').getByRole('button', { name: 'Open: Blue tile / right', exact: true }).click();
    await page.waitForFunction(() => window.photoRead);
    await page.getByRole('button', { name: 'Close', exact: true }).click();
    await page.getByRole('button', { name: 'Shots', exact: true }).click();
    await page.evaluate(() => { releasePhoto(); restorePhotoOpen(); });
    await page.waitForFunction(() => document.querySelectorAll('.shot-library-card').length === 4 && document.querySelector('.shot-library-grid').getAttribute('aria-busy') === 'false');
    assert.equal(await page.locator('.shot-library-photo').isVisible(), false, 'Stale photo async result cannot enter a new modal session');
    const search = page.getByRole('searchbox');
    await search.fill('PNG capture'); assert.equal(await page.locator('.shot-library-card:visible').count(), 3);
    await search.fill('take'); assert.equal(await page.locator('.shot-library-card:visible').count(), 1);
    await search.fill('');
    await page.locator('[data-shot-id="photo-landscape"]').getByRole('button', { name: 'Delete: Red tile / left', exact: true }).click();
    await page.getByRole('button', { name: 'Delete shot', exact: true }).click();
    await page.waitForFunction(() => !document.querySelector('[data-shot-id="photo-landscape"]') && document.querySelector('.shot-library-grid').getAttribute('aria-busy') === 'false');
    await page.evaluate(async expected => {
      await rejects(() => gallery.photos.open(expected.ids[0]), /no longer exists/i);
      check(await hash((await gallery.photos.open(expected.ids[1])).png) === expected.originals[1], 'Deleting one capture preserves the other original');
      const take = (await gallery.library.open(expected.ids[2])).take;
      equal(await trackHashes(take), expected.tracks, 'Deleting a photo preserves every completed take track');
      equal(take.range, [.05, .18], 'Mixed gallery retains selected/full take duration metadata');
      check(!(await rows('photoData')).some(row => row.id === expected.ids[0]), 'Delete removes only its owned original bytes');
    }, expected);
    await page.getByRole('button', { name: 'Close', exact: true }).click();
    assert.deepEqual(errors, [], 'No uncaught browser errors');
    console.log('PASS: exact original PNG and independent preview after realm destruction, true quota and transaction abort retention, take isolation, original image view/download, mixed responsive gallery, deferred refresh and stale modal sessions');
  } finally {
    try { if (context) await context.close(); }
    finally {
      if (server) { const { promise, resolve } = Promise.withResolvers(); server.close(resolve); await promise; }
      await rm(profile, { recursive: true, force: true });
    }
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
