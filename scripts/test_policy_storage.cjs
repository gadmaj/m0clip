/** Chromium: cached policy bytes survive migration, failed replacement, blocked upgrades and deletion. */
'use strict';
const assert = require('node:assert/strict');
const { createServer } = require('node:http');
const { createReadStream } = require('node:fs');
const { resolve } = require('node:path');
const { build } = require('esbuild');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');

(async () => {
  let server, browser;
  try {
    const bundled = await build({ stdin: { contents: "import * as packs from './src/packs';import {installDefaultPacks} from './src/packs/defaults';globalThis.fixture={...packs,installDefaultPacks};", resolveDir: process.cwd() }, bundle: true, platform: 'browser', format: 'iife', write: false });
    const paths = ['/assets/packs/r1-default-v1.json', '/assets/packs/r1/amp_locomotion_amp_locomotion.zip', '/assets/packs/r1/amp_locomotion_811_main_policy_17k.zip'];
    let offline = false;
    server = createServer((request, response) => {
      response.setHeader('Cross-Origin-Opener-Policy', 'same-origin'); response.setHeader('Cross-Origin-Embedder-Policy', 'require-corp'); response.setHeader('Cache-Control', 'no-store');
      if (request.url === '/fixture.js') { response.setHeader('Content-Type', 'text/javascript'); response.end(bundled.outputFiles[0].text); }
      else if (paths.includes(request.url)) {
        if (offline) { response.writeHead(503); response.end('Offline fixture'); }
        else { response.setHeader('Content-Type', request.url.endsWith('.json') ? 'application/json' : 'application/zip'); createReadStream(resolve('public' + request.url)).pipe(response); }
      } else { response.setHeader('Content-Type', 'text/html'); response.end('<!doctype html><title>Policy storage integration</title><script src="/fixture.js"></script>'); }
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const origin = `http://127.0.0.1:${server.address().port}`;
    browser = await chromium.launch({ executablePath: process.env.CHROME_BIN || '/usr/bin/google-chrome', headless: true, args: ['--no-sandbox'] });
    const errors = [];
    async function fresh() {
      const context = await browser.newContext(), page = await context.newPage();
      page.on('pageerror', error => errors.push(error.message)); await page.goto(origin);
      await page.evaluate(async () => {
        const urls = ['/assets/packs/r1/amp_locomotion_amp_locomotion.zip', '/assets/packs/r1/amp_locomotion_811_main_policy_17k.zip'];
        fixture.realPacks = await Promise.all(urls.map(async url => fixture.parsePack(new Uint8Array(await (await fetch(url)).arrayBuffer()))));
        fixture.hashes = async pack => {
          const files = {};
          for (const [name, bytes] of Object.entries(pack.files)) files[name] = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))).map(v => v.toString(16).padStart(2, '0')).join('');
          return { id: pack.id, manifest: pack.manifest, config: pack.config, files };
        };
        fixture.seedLegacy = async (hold = false) => {
          const db = await new Promise((resolve, reject) => {
            const request = indexedDB.open('r1-policy-packs', 1); request.onupgradeneeded = () => request.result.createObjectStore('packs', { keyPath: 'id' });
            request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
          });
          await new Promise((resolve, reject) => { const transaction = db.transaction('packs', 'readwrite'); for (const pack of fixture.realPacks) transaction.objectStore('packs').put(pack); transaction.oncomplete = resolve; transaction.onabort = () => reject(transaction.error); });
          if (hold) fixture.heldLegacy = db; else db.close();
        };
        fixture.raw = async (version, store, id) => {
          const db = await new Promise((resolve, reject) => { const request = indexedDB.open('r1-policy-packs', version); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
          try { return await new Promise((resolve, reject) => { const request = db.transaction(store).objectStore(store).get(id); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); }); } finally { db.close(); }
        };
      });
      return { context, page };
    }

    const migration = await fresh();
    const migrated = await migration.page.evaluate(async () => {
      await fixture.seedLegacy(); const before = await Promise.all(fixture.realPacks.map(fixture.hashes));
      const catalog = await fixture.listPacks();
      const after = await Promise.all(fixture.realPacks.map(async pack => fixture.hashes(await fixture.loadPack(pack.id))));
      return { before, after, metadataOnly: catalog.every(pack => !Object.hasOwn(pack, 'files')) };
    });
    assert.deepEqual(migrated.after, migrated.before); assert.equal(migrated.metadataOnly, true);

    const abortedReplacement = await migration.page.evaluate(async () => {
      const first = fixture.realPacks[0], second = fixture.realPacks[1];
      const primary = first.manifest.checkpoints[0].file, alternate = second.manifest.checkpoints[0].file;
      const replacement = { ...first, config: { ...first.config, name: 'Updated policy' }, files: { ...first.files, [primary]: second.files[alternate] } };
      fixture.replacement = replacement;
      const before = await fixture.hashes(await fixture.loadPack(first.id));
      const put = IDBObjectStore.prototype.put;
      IDBObjectStore.prototype.put = function (...args) { const request = Reflect.apply(put, this, args); if (this.name === 'payloads') request.addEventListener('success', () => this.transaction.abort(), { once: true }); return request; };
      let rejected = false;
      try { await fixture.storePack(replacement); } catch { rejected = true; } finally { IDBObjectStore.prototype.put = put; }
      return { rejected, before, after: await fixture.hashes(await fixture.loadPack(first.id)) };
    });
    assert.equal(abortedReplacement.rejected, true); assert.deepEqual(abortedReplacement.after, abortedReplacement.before);
    const replaced = await migration.page.evaluate(async () => { await fixture.storePack(fixture.replacement); return { expected: await fixture.hashes(fixture.replacement), actual: await fixture.hashes(await fixture.loadPack(fixture.replacement.id)) }; });
    assert.deepEqual(replaced.actual, replaced.expected);
    const removed = await migration.page.evaluate(async () => {
      const id = fixture.realPacks[0].id; await fixture.deletePack(id);
      let unavailable = false; try { await fixture.loadPack(id); } catch { unavailable = true; }
      const payloadRemoved = await fixture.raw(2, 'payloads', id) === undefined;
      const survivor = await fixture.hashes(await fixture.loadPack(fixture.realPacks[1].id));
      await fixture.deleteAllPacks();
      return { unavailable, payloadRemoved, survivor, expected: await fixture.hashes(fixture.realPacks[1]), catalog: await fixture.listPacks(), finalPayload: await fixture.raw(2, 'payloads', fixture.realPacks[1].id) === undefined };
    });
    assert.equal(removed.unavailable, true); assert.equal(removed.payloadRemoved, true); assert.deepEqual(removed.survivor, removed.expected); assert.deepEqual(removed.catalog, []); assert.equal(removed.finalPayload, true);
    await migration.context.close();

    const abortUpgrade = await fresh();
    const rollback = await abortUpgrade.page.evaluate(async () => {
      await fixture.seedLegacy(); const expected = await fixture.hashes(fixture.realPacks[0]), put = IDBObjectStore.prototype.put;
      IDBObjectStore.prototype.put = function (...args) { const request = Reflect.apply(put, this, args); if (this.name === 'payloads') request.addEventListener('success', () => this.transaction.abort(), { once: true }); return request; };
      let rejected = false;
      try { await fixture.listPacks(); } catch { rejected = true; } finally { IDBObjectStore.prototype.put = put; }
      const legacy = await fixture.hashes(await fixture.raw(1, 'packs', fixture.realPacks[0].id));
      await fixture.listPacks();
      return { rejected, expected, legacy, retried: await fixture.hashes(await fixture.loadPack(fixture.realPacks[0].id)) };
    });
    assert.equal(rollback.rejected, true); assert.deepEqual(rollback.legacy, rollback.expected); assert.deepEqual(rollback.retried, rollback.expected);
    await abortUpgrade.context.close();

    const blockedUpgrade = await fresh();
    const blocked = await blockedUpgrade.page.evaluate(async () => {
      await fixture.seedLegacy(true); let error = '';
      try { await fixture.listPacks(); } catch (failure) { error = failure.message; }
      fixture.heldLegacy.close();
      const catalog = await fixture.listPacks();
      return { rejected: !!error, error, ids: catalog.map(pack => pack.id).sort(), expectedIds: fixture.realPacks.map(pack => pack.id).sort(), expected: await fixture.hashes(fixture.realPacks[0]), restored: await fixture.hashes(await fixture.loadPack(fixture.realPacks[0].id)) };
    });
    assert.equal(blocked.rejected, true); assert.deepEqual(blocked.ids, blocked.expectedIds); assert.deepEqual(blocked.restored, blocked.expected);
    await blockedUpgrade.context.close();

    const hosted = await fresh();
    const firstLoad = await hosted.page.evaluate(async () => {
      const catalog = await fixture.installDefaultPacks(await fixture.listPacks(), () => {}), id = fixture.realPacks[0].id;
      const loaded = await fixture.loadPack(id);
      return { metadataOnly: catalog.every(pack => !Object.hasOwn(pack, 'files')), expected: await fixture.hashes(fixture.realPacks[0]), actual: await fixture.hashes(loaded) };
    });
    assert.equal(firstLoad.metadataOnly, true); assert.deepEqual(firstLoad.actual, firstLoad.expected);
    offline = true;
    const offlineLoad = await hosted.page.evaluate(async () => {
      const catalog = await fixture.listPacks(), pack = await fixture.loadPack(fixture.realPacks[0].id);
      let unselectedUnavailable = false; try { await fixture.loadPack(fixture.realPacks[1].id); } catch { unselectedUnavailable = true; }
      return { cached: await fixture.hashes(pack), unselectedUnavailable, stillListed: (await fixture.listPacks()).some(row => row.id === fixture.realPacks[1].id), metadataOnly: catalog.every(row => !Object.hasOwn(row, 'files')) };
    });
    assert.deepEqual(offlineLoad.cached, firstLoad.expected); assert.equal(offlineLoad.unselectedUnavailable, true); assert.equal(offlineLoad.stillListed, true); assert.equal(offlineLoad.metadataOnly, true);
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ legacyFilesExact: true, abortedReplacementPreserved: true, replacementExact: true, deletionRemovesPayloads: true, abortedUpgradePreservedLegacy: true, blockedUpgradeRetryExact: true, cachedPolicyWorksOffline: true, failedUnselectedDownloadPreservesCatalog: true, errors }));
  } finally { if (browser) await browser.close(); if (server) await new Promise(resolve => server.close(resolve)); }
})().catch(error => { console.error(error); process.exitCode = 1; });
