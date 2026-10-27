/** Real-Chrome consumer regression. Run only against an explicitly integrated preview.
 * BASE_URL=http://127.0.0.1:PORT PLAYWRIGHT_MODULE=/path/to/playwright \
 *   node scripts/test_loading_progress.cjs
 * Optional: LOADING_SCENARIOS=cold,warm,concurrent,unknown,compressed,stall,interrupt,failure,original,mobile
 * MOBILE_WIDTH=320 or 390 selects the loading-layout viewport for the mobile scenario.
 * A loopback reverse proxy streams unchanged real asset payloads; no readiness/render hooks.
 * Covers transfer accounting and real scene/error behavior independently of delayed Pong;
 * the dedicated Source startup regression owns the >30-second morph/game contract.
 */
const assert = require('node:assert/strict');
const http = require('node:http');
const https = require('node:https');
const zlib = require('node:zlib');
const fs = require('node:fs');
const path = require('node:path');
const { chooseVisual } = require('./choose-visual.cjs');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const wasm = '/wasm/mujoco.wasm';
const isSceneAsset = pathname => /\/wasm\/|\/assets\/(?:models|source-robots|packs)\/|\.(?:wasm|onnx)$/.test(pathname);

async function createProxy(upstream) {
  const origin = new URL(upstream), sockets = new Set(), runs = [], timers = new Set();
  let scenario = 'cold', run, closed = false;
  function later(ms) { return new Promise(resolve => { const t = setTimeout(() => { timers.delete(t); resolve(); }, ms); timers.add(t); }); }
  function begin(name) { scenario = name; run = { name, started: Date.now(), resources: [], active: 0, peak: 0 }; runs.push(run); return run; }
  begin('cold');
  const server = http.createServer((req, res) => {
    const pathname = new URL(req.url, origin).pathname, current = run, mode = scenario;
    const record = { path: pathname, started: Date.now(), bytes: 0, decoded: 0, done: false, chunks: [], controlled: false };
    current.resources.push(record);
    if (mode === 'failure' && /\/assets\/models\/.*\.xml$/.test(pathname)) {
      record.failed = true; res.writeHead(503, { 'content-type': 'text/plain', 'cache-control': 'no-store' }); res.end('Real-network QA: model unavailable'); return;
    }
    if (mode === 'original' && /\/assets\/source-robots\/.*\.glb$/.test(pathname)) {
      record.failed = true; res.writeHead(503, { 'content-type': 'text/plain', 'cache-control': 'no-store' }); res.end('Real-network QA: optional head unavailable'); return;
    }
    const lateImage = mode === 'failure' && pathname === '/assets/source/flashlight.png';
    const target = pathname === wasm || lateImage || (mode === 'concurrent' && /\/meshes\//.test(pathname));
    const request = (origin.protocol === 'https:' ? https : http).request(new URL(req.url, origin), {
      method: req.method, headers: { ...req.headers, host: origin.host, 'accept-encoding': 'identity' },
    }, upstreamResponse => {
      const headers = { ...upstreamResponse.headers };
      delete headers.connection; delete headers['transfer-encoding'];
      // Browser cache is deliberately enabled for the cold -> warm consumer regression.
      // All adversarial scenarios start in a separate context and cannot inherit those bytes.
      // Preserve real upstream cache policy otherwise: no-store + incremental
      // readers has a Chromium false-CDP-abort defect (issues.chromium.org/564326773).
      if (mode === 'cold' || mode === 'warm') headers['cache-control'] = 'public, max-age=3600';
      // A fatal disconnect fixture must not be repaired by Chrome's partial-cache
      // Range recovery; all real loader retries still run and meet the same failure.
      if (mode === 'interrupt' && target) headers['cache-control'] = 'no-store';
      if (!target || req.method === 'HEAD' || upstreamResponse.statusCode !== 200) {
        res.writeHead(upstreamResponse.statusCode, headers);
        upstreamResponse.on('data', chunk => { record.bytes += chunk.length; record.decoded += chunk.length; });
        upstreamResponse.on('end', () => { record.done = true; record.ended = Date.now(); });
        upstreamResponse.pipe(res); return;
      }
      record.controlled = true;
      const parts = []; let size = 0;
      upstreamResponse.on('data', chunk => {
        size += chunk.length;
        if (size > 64 * 1024 * 1024) { request.destroy(new Error('QA fixture exceeds 64 MiB resource limit')); return; }
        parts.push(chunk);
      });
      upstreamResponse.on('end', async () => {
        let body = Buffer.concat(parts); record.decoded = body.length;
        if (mode === 'compressed') { body = zlib.gzipSync(body); headers['content-encoding'] = 'gzip'; }
        else delete headers['content-encoding'];
        if (mode === 'unknown') delete headers['content-length'];
        else headers['content-length'] = String(body.length);
        record.expectedWire = body.length;
        if (res.destroyed || closed) return;
        if (lateImage) {
          while (!current.failureObservedAt && !res.destroyed && !closed) await later(50);
          await later(800);
        }
        res.writeHead(upstreamResponse.statusCode, headers);
        current.active++; current.peak = Math.max(current.peak, current.active);
        const steps = lateImage ? 2 : /\/meshes\//.test(pathname) ? 8 : ['cold', 'unknown'].includes(mode) ? 120 : 45;
        const chunkSize = Math.max(1, Math.ceil(body.length / steps));
        try {
          for (let offset = 0; offset < body.length && !res.destroyed && !closed; offset += chunkSize) {
            if (mode === 'stall' && offset >= body.length / 3 && !record.stalledAt) {
              record.stalledAt = Date.now(); await later(6500); record.resumedAt = Date.now();
            }
            if (mode === 'interrupt' && offset >= body.length / 3) { record.failed = true; res.destroy(); break; }
            const chunk = body.subarray(offset, offset + chunkSize);
            res.write(chunk); record.bytes += chunk.length; record.chunks.push({ at: Date.now(), bytes: record.bytes });
            await later(/\/meshes\//.test(pathname) ? 110 : 120);
          }
          if (!res.destroyed) { res.end(); record.done = true; }
        } finally { current.active--; record.ended = Date.now(); }
      });
    });
    request.on('error', error => { record.error = error.message; if (!res.headersSent) res.writeHead(502); res.end(); });
    res.on('close', () => { if (!request.destroyed) request.destroy(); });
    req.pipe(request);
  });
  server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${server.address().port}`, begin, runs,
    async close() { closed = true; for (const socket of sockets) socket.destroy(); for (const timer of timers) clearTimeout(timer); await new Promise(resolve => server.close(resolve)); },
  };
}

async function snapshot(page) {
  return page.evaluate(() => {
    const progress = document.querySelector('#launch-progress'), enter = document.querySelector('#launch-enter');
    const bytes = document.querySelector('#launch-bytes'), eta = document.querySelector('#launch-eta');
    const byteRect = bytes?.getBoundingClientRect(), etaRect = eta?.getBoundingClientRect();
    return {
      at: Date.now(), bytes: document.querySelector('#launch-bytes')?.textContent ?? '',
      eta: document.querySelector('#launch-eta')?.textContent ?? '',
      status: document.querySelector('#launch-status')?.textContent ?? '',
      error: document.querySelector('#launch-status')?.dataset.kind === 'error',
      state: document.querySelector('#launch-transfer')?.dataset.state,
      value: progress?.hasAttribute('value') ? progress.value / progress.max : null,
      maximum: progress?.hasAttribute('value') ? progress.max : null,
      ready: !!enter && !enter.disabled, screen: !document.querySelector('#launch-screen')?.hidden,
      loadingVisible: !document.querySelector('#launch-loading-step')?.hidden && !document.querySelector('#launch-screen')?.hidden,
      byteBox: byteRect && { x: byteRect.x, y: byteRect.y, height: byteRect.height },
      etaBox: etaRect && { x: etaRect.x, y: etaRect.y, height: etaRect.height },
    };
  });
}
const numericEta = text => /\d+(?:\.\d+)?\s*(?:s\b|sec|m\b|min|h\b|hour)/i.test(text);
const mbValues = text => [...text.matchAll(/([\d,.]+)\s*MB/gi)].map(match => Number(match[1].replaceAll(',', '')));
const loadedMB = text => {
  const match = text.match(/·\s*([\d,.]+)\s*\/\s*[\d,.]+\s*MB/);
  return match ? Number(match[1].replaceAll(',', '')) : null;
};
const etaSeconds = text => {
  const matches = [...text.matchAll(/(\d+(?:\.\d+)?)\s*(seconds?|secs?|s\b|minutes?|mins?|m\b|hours?|h\b)/gi)];
  return matches.length ? matches.reduce((sum, match) => sum + Number(match[1]) * (/^h/i.test(match[2]) ? 3600 : /^m/i.test(match[2]) ? 60 : 1), 0) : null;
};

async function raf(page, frames = 12) {
  return page.evaluate(frames => new Promise(resolve => {
    let count = 0; const start = performance.now();
    function tick() { if (++count < frames) requestAnimationFrame(tick); else resolve({ frames: count, elapsed: performance.now() - start }); }
    requestAnimationFrame(tick);
  }), frames);
}

async function pick(page, proxy, { mobile = false, head = false } = {}) {
  await page.goto(`${proxy.url}/?plain&body=stock`, { waitUntil: 'domcontentloaded' });
  await page.locator('#launch-map-trigger').waitFor();
  if (mobile) {
    // Inspect the real fresh Ghost choice and complete unfiltered gallery before the bounded fixture.
    const initialMap = await page.locator('#launch-map').inputValue();
    assert.equal(initialMap, 'map:nt_ghost_ctg', 'A fresh launch must use the requested Ghost default');
    for (const width of [320, 390]) {
      await page.setViewportSize({ width, height: 844 });
      await page.locator('#launch-map-trigger').tap();
      await page.waitForFunction(() => [...document.querySelectorAll('dialog[open] button[data-value] img')].some(image => image.complete && image.naturalWidth));
      const gallery = await page.evaluate(() => ({
        choices: [...document.querySelectorAll('#launch-map option')].map(option => option.value),
        cards: [...document.querySelectorAll('dialog[open] button[data-value]')].map(card => ({
          value: card.dataset.value, label: card.textContent.trim(), width: card.getBoundingClientRect().width, height: card.getBoundingClientRect().height,
        })),
      }));
      assert.ok(gallery.choices.every(value => gallery.cards.some(card => card.value === value)), 'Complete mobile gallery must expose every available map, not only a filtered choice');
      assert.ok(gallery.cards.every(card => card.label && card.width > 24 && card.height > 24), 'Dense unfiltered gallery cards must remain readable and usable');
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'Complete mobile map gallery must fit the document width');
      await page.screenshot({ path: path.join(process.env.QA_ARTIFACT_DIR, `mobile-map-gallery-${width}.png`), fullPage: true });
      await page.keyboard.press('Escape');
    }
    const width = Number(process.env.MOBILE_WIDTH || 390);
    assert.ok(width === 320 || width === 390, 'MOBILE_WIDTH must be 320 or 390');
    await page.setViewportSize({ width, height: 844 });
  }
  await chooseVisual(page, 'launch-map', 'flat');
  await page.locator('#launch-next').click();
  if (!head) await chooseVisual(page, 'launch-character', 'stock');
  const loadStartedAt = Date.now();
  await page.locator('#launch-load').click();
  return { loadStartedAt };
}

async function enterAndPlayback(page, out) {
  await page.locator('#launch-enter').click();
  await page.waitForFunction(() => document.querySelector('#launch-screen')?.hidden === true);
  assert.equal(await page.locator('#app').evaluate(app => app.inert), false, 'Explicit scene entry must release scene input');
  const frames = await raf(page);
  await page.getByRole('button', { name: 'Record V', exact: true }).click();
  await delay(1800);
  await page.getByTitle('Stop recording and open the timeline (V)', { exact: true }).click();
  const play = page.getByTitle('Play / pause (Space)', { exact: true }); await play.waitFor();
  if (await play.getAttribute('aria-pressed') !== 'true') await play.click();
  const before = await page.locator('.dk-clock').textContent();
  await delay(350); await raf(page); const after = await page.locator('.dk-clock').textContent();
  assert.notEqual(after, before, 'Recorded scene timeline must actually advance during playback');
  await page.screenshot({ path: path.join(out, 'scene-playback.png') });
  return { frames, before, after };
}

async function inspectDetails(page, { failed = false } = {}) {
  const disclosure = page.locator('#launch-details');
  const before = await snapshot(page);
  await disclosure.locator('summary').focus();
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => document.querySelector('#launch-details').open);
  await page.locator('#launch-detail-transfers li').first().waitFor();
  const details = await disclosure.evaluate(node => ({
    readiness: node.querySelector('#launch-detail-readiness').textContent,
    status: node.querySelector('#launch-detail-status').textContent,
    bytes: node.querySelector('#launch-detail-bytes').textContent,
    rows: [...node.querySelectorAll('li')].map(row => ({
      path: row.firstElementChild.textContent, state: row.dataset.state, amount: row.lastElementChild.textContent,
    })),
    live: node.querySelectorAll('[aria-live], [role="status"], [role="alert"]').length,
  }));
  assert.match(details.readiness, /Simulation: (ready|pending) · Visuals: (ready|pending) · First frame: (ready|pending)/);
  assert.match(details.bytes, /^\d+ B received · \d+ B (?:fixed maximum|discovered)/);
  if (before.ready) assert.equal(details.readiness, 'Simulation: ready · Visuals: ready · First frame: ready', 'Final readiness details must reflect the actual scene gates');
  assert.ok(details.rows.every(row => ['loading', 'done', 'failed', 'cancelled'].includes(row.state)));
  assert.ok(details.rows.every(row => /^\d+ B received/.test(row.amount)), 'Every resource amount must report observed bytes');
  assert.ok(details.rows.every(row => !/[?#]/.test(row.path) && !/https?:\/\//.test(row.path)), 'Asset labels must omit URL query tokens, fragments and credentials');
  assert.equal(details.live, 0, 'Detailed byte and transfer changes must not create live-region chatter');
  if (failed) assert.ok(details.rows.some(row => row.state === 'failed'), 'A failed real asset must remain visible in the transfer history');
  const after = await snapshot(page);
  assert.deepEqual(after.byteBox, before.byteBox, 'Opening Details must not move the MB row');
  assert.deepEqual(after.etaBox, before.etaBox, 'Opening Details must not move the ETA row');
  await page.keyboard.press('Space');
  await page.waitForFunction(() => !document.querySelector('#launch-details').open);
  // Observe only the optional content, not the real progress shell.
  await disclosure.evaluate(node => {
    window.__detailMutationCount = 0;
    window.__detailObserver = new MutationObserver(records => { window.__detailMutationCount += records.length; });
    window.__detailObserver.observe(node.querySelector('.launch-detail-content'), { subtree: true, childList: true, characterData: true, attributes: true });
  });
  await delay(800);
  const mutations = await page.evaluate(() => { window.__detailObserver.disconnect(); return window.__detailMutationCount; });
  assert.equal(mutations, 0, 'Collapsed Details must not rebuild or update its transfer list on progress ticks');
  await disclosure.locator('summary').click();
  await page.waitForFunction(() => document.querySelector('#launch-details').open);
  await disclosure.locator('summary').click();
  await page.waitForFunction(() => !document.querySelector('#launch-details').open);
  return details;
}

async function runSuite() {
  assert.ok(process.env.BASE_URL, 'BASE_URL must identify the explicit integrated preview, never an implicit published/stale build');
  const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
  const out = process.env.QA_ARTIFACT_DIR || '/tmp/m0clip-loading-qa/integrated'; process.env.QA_ARTIFACT_DIR = out;
  fs.mkdirSync(out, { recursive: true });
  const proxy = await createProxy(process.env.BASE_URL), results = [], browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  let warmContext;
  const scenarios = (process.env.LOADING_SCENARIOS || 'cold,warm,concurrent,unknown,compressed,stall,interrupt,failure,original,mobile').split(',');
  try {
    for (const name of scenarios) {
      const run = proxy.begin(name), mobile = name === 'mobile';
      const context = name === 'warm' && warmContext ? warmContext : await browser.newContext({
        viewport: mobile ? { width: 390, height: 844 } : { width: 1280, height: 800 }, deviceScaleFactor: .5,
        isMobile: mobile, hasTouch: mobile, recordVideo: { dir: path.join(out, 'video'), size: mobile ? { width: 390, height: 844 } : { width: 960, height: 600 } },
      });
      if (name === 'original') await context.addInitScript(() => localStorage.setItem('ume-head-visuals', JSON.stringify({ r1: 'ghost' })));
      const page = await context.newPage(), errors = [], networkErrors = [], samples = [], requestedPaths = [];
      page.on('pageerror', error => errors.push(error.message));
      const requestStarts = new WeakMap();
      const requested = request => {
        requestStarts.set(request, Date.now());
        if (request.url().startsWith(proxy.url)) requestedPaths.push(new URL(request.url()).pathname);
      };
      const failedRequest = request => networkErrors.push({
        id: request._guid, url: request.url(), started: requestStarts.get(request), failedAt: Date.now(),
        readyAtFailure: samples.at(-1)?.ready, error: request.failure()?.errorText,
        proxyCompletions: run.resources.filter(resource => new URL(request.url()).pathname === resource.path).map(resource => ({
          path: resource.path, bytes: resource.bytes, decoded: resource.decoded, done: resource.done, ended: resource.ended,
        })),
      });
      context.on('request', requested);
      context.on('requestfailed', failedRequest);
      let sampling = true;
      const sampler = (async () => { while (sampling) { try { samples.push(await snapshot(page)); } catch {} await delay(125); } })();
      const result = { name, errors, networkErrors, samples, requestedPaths }; results.push(result);
      try {
        const { loadStartedAt } = await pick(page, proxy, { mobile, head: name === 'original' });
        result.loadStartedAt = loadStartedAt;
        await page.locator('#launch-progress').waitFor();
        assert.equal(await page.locator('#launch-details').evaluate(node => node.open), false, 'Details must start genuinely collapsed');
        assert.equal(await page.locator('#launch-detail-transfers li').count(), 0, 'A collapsed initial load must not materialize transfer rows');
        if (['cold', 'unknown', 'compressed', 'stall', 'concurrent'].includes(name)) {
          const deadline = Date.now() + 45000;
          while (!run.resources.some(resource => resource.path === wasm && resource.bytes > 0 && resource.controlled) && Date.now() < deadline) await delay(50);
          await page.screenshot({ path: path.join(out, `${name}-streaming.png`), fullPage: mobile });
        }
        if (['cold', 'unknown', 'compressed', 'mobile'].includes(name)) result.details = await inspectDetails(page);
        if (mobile) await page.screenshot({ path: path.join(out, 'mobile-loading.png'), fullPage: true });
        if (name === 'stall') {
          const deadline = Date.now() + 45000;
          while (!run.resources.some(resource => resource.stalledAt) && Date.now() < deadline) await delay(100);
          const transfer = run.resources.find(resource => resource.stalledAt); assert.ok(transfer, 'The real response must enter its stalled interval');
          await delay(5000); const stalled = await snapshot(page); result.stalled = stalled;
          assert.equal(numericEta(stalled.eta), false, 'Stalled bytes must expire the previous numeric estimate');
          assert.equal(stalled.ready, false, 'Stalled scene download cannot become ready');
          assert.notEqual(stalled.value, 1, 'Stalled scene download cannot show complete progress');
          await page.screenshot({ path: path.join(out, 'stall-expired-eta.png') });
        }
        if (['interrupt', 'failure', 'original'].includes(name)) {
          await page.locator('#launch-status[data-kind="error"]').waitFor({ timeout: 180000 });
          const failed = await snapshot(page); result.failure = failed;
          if (name === 'failure') assert.match(failed.status, /503/, 'Original HTTP error detail must remain actionable');
          result.details = await inspectDetails(page, { failed: true });
          if (name === 'failure') {
            run.failureObservedAt = Date.now();
            const deadline = Date.now() + 15000;
            while (!run.resources.some(resource => resource.path === '/assets/source/flashlight.png' && resource.done) && Date.now() < deadline) await delay(100);
            const lateAsset = run.resources.find(resource => resource.path === '/assets/source/flashlight.png');
            assert.ok(lateAsset?.done && lateAsset.ended > run.failureObservedAt, 'Canonical-error retention must be challenged by a genuinely later real asset completion');
          }
          await delay(2000); const late = await snapshot(page);
          assert.equal(late.status, failed.status, 'Late asset completion must not replace the canonical failure');
          assert.equal(late.ready, false, 'Failed scene must not unlock entry');
          await page.screenshot({ path: path.join(out, `${name}-error.png`), fullPage: mobile });
          if (name === 'original') {
            await page.locator('#launch-original').click();
            await page.locator('#launch-enter:not([disabled])').waitFor({ timeout: 180000 });
            await page.locator('#launch-enter').click();
            assert.equal(await page.locator('#launch-screen').isHidden(), true, 'Original recovery must still enter the real scene');
            result.originalRecovered = true;
          }
        } else {
          await page.locator('#launch-enter:not([disabled])').waitFor({ timeout: 240000 });
          const ready = await snapshot(page); result.ready = ready;
          assert.equal(ready.value, 1, 'A successful complete selected payload should finish the byte meter; readiness is checked independently');
          if (name === 'cold' || mobile) result.readyDetails = await inspectDetails(page);
          const controlled = run.resources.filter(resource => resource.controlled && resource.done);
          const decoded = controlled.reduce((sum, resource) => sum + resource.decoded, 0);
          assert.ok(Math.max(...mbValues(ready.bytes)) * 1e6 >= decoded - 120000, 'Displayed decoded MB must include all streamed real assets, not compressed wire length');
          if (name === 'cold') {
            const unique = resources => [...resources.reduce((entities, resource) => {
              const previous = entities.get(resource.path);
              if (!previous || resource.decoded > previous.decoded) entities.set(resource.path, resource);
              return entities;
            }, new Map()).values()];
            const required = unique(run.resources.filter(resource => resource.started >= result.loadStartedAt && isSceneAsset(resource.path) && resource.done));
            const payload = required.reduce((sum, resource) => sum + resource.decoded, 0);
            const startup = unique(run.resources.filter(resource => resource.started >= result.loadStartedAt && resource.done && !/\/previews\//.test(resource.path)));
            const ceiling = startup.reduce((sum, resource) => sum + resource.decoded, 0);
            result.payloadReconciliation = { requiredPayload: payload, allStartupPayload: ceiling, displayed: Math.max(...mbValues(ready.bytes)) * 1e6,
              assets: required.map(({ path, decoded }) => ({ path, decoded })) };
            assert.ok(required.some(resource => /ort.*\.wasm$/.test(resource.path)), 'Cold fixture must load the actual ONNX runtime');
            assert.ok(required.some(resource => /\/packs\/.*\.zip$/.test(resource.path)), 'Cold fixture must load the actual policy pack');
            assert.ok(result.payloadReconciliation.displayed >= payload - 120000, 'Scene-wide decoded MB must include MuJoCo, all model meshes, ONNX WASM and policy payloads');
            assert.ok(result.payloadReconciliation.displayed <= ceiling + 120000, 'Scene-wide payload must not count bytes twice or invent additional downloaded assets');
          }
          if (name === 'warm') {
            const cold = results.find(result => result.name === 'cold');
            assert.ok(cold?.ready, 'Warm cache scenario requires the preceding cold launch');
            const demand = new Set(requestedPaths);
            const expected = cold.payloadReconciliation.assets.filter(asset => demand.has(asset.path)).reduce((sum, asset) => sum + asset.decoded, 0);
            const network = run.resources.filter(resource => isSceneAsset(resource.path)).reduce((sum, resource) => sum + resource.decoded, 0);
            result.cacheEvidence = { requiredRequestedPayload: expected, actualNetworkPayload: network, displayedPayload: loadedMB(ready.bytes) * 1e6 };
            assert.ok(result.cacheEvidence.displayedPayload >= expected - 120000, 'Warm decoded MB must include every requested asset, including browser HTTP-cache payloads');
            assert.ok(result.cacheEvidence.displayedPayload > network + 1e6, 'Warm regression must actually count decoded bytes served without a proxy/network body');
          }
          if (name === 'cold') result.playback = await enterAndPlayback(page, out);
          else { await page.screenshot({ path: path.join(out, `${name}-ready.png`), fullPage: mobile }); await page.locator('#launch-enter').click(); if (mobile) await raf(page); }
          if (mobile) {
            result.viewport = await page.evaluate(() => ({ width: innerWidth, scroll: document.documentElement.scrollWidth }));
            assert.ok(result.viewport.scroll <= result.viewport.width + 1, 'Mobile scene must not require horizontal document scrolling');
          }
          assert.deepEqual(errors, [], 'Successful load must not introduce uncaught application errors');
          assert.deepEqual(networkErrors, [], 'Successful scene load must not lose network failures');
        }
        const active = samples.filter(sample => sample.state === 'loading' && !sample.error);
        const layout = samples.filter(sample => sample.loadingVisible && sample.byteBox?.height);
        assert.ok(layout.length > 1, 'A real visible loading interval must be sampled');
        for (const sample of layout) {
          assert.deepEqual(sample.byteBox, layout[0].byteBox, 'Actual stage/readiness updates must not relocate or wrap MB');
          assert.deepEqual(sample.etaBox, layout[0].etaBox, 'Actual stage/readiness updates must not relocate or wrap ETA');
          assert.equal(sample.byteBox.x, sample.etaBox.x, 'MB and ETA must share a stable left edge');
        }
        if (name === 'cold') assert.ok(new Set(layout.map(sample => sample.status)).size > 1, 'The layout regression must observe actual changing scene stages');
        for (const sample of samples) {
          if (sample.value === 1 && !sample.ready) assert.equal(numericEta(sample.eta), false, 'A complete payload cannot pretend to time unfinished scene preparation');
          if (sample.state === 'preparing') assert.equal(numericEta(sample.eta), false, 'Download estimates must not pretend to time CPU/graphics preparation');
        }
        if (name === 'unknown' || name === 'compressed') {
          const transfer = run.resources.find(resource => resource.path === wasm);
          const during = active.filter(sample => sample.at >= transfer.chunks[0].at + 250 && sample.at <= transfer.ended - 250);
          assert.ok(during.length >= 3, 'Unknown/compressed response must remain genuinely streaming across observations');
          assert.ok(during.some(sample => numericEta(sample.eta)), 'The fixed exact selected payload supports real-rate ETA independently of chunked/compressed response headers');
        }
        if (name === 'cold' || name === 'stall') assert.ok(active.some(sample => numericEta(sample.eta)), 'Known streaming downloads must yield a current-download estimate after real rate samples');
        const maxima = samples.filter(sample => sample.maximum !== null && sample.loadingVisible).map(sample => sample.maximum);
        assert.ok(maxima.length, 'The selected scene must declare its exact payload maximum');
        assert.equal(new Set(maxima).size, 1, 'The payload maximum cannot grow or shrink across discovery, streaming, failures or preparation');
        if (name === 'cold') {
          const transfer = run.resources.find(resource => resource.path === wasm);
          const stable = active.filter(sample => sample.at > transfer.chunks[0].at + 2000 && sample.at < transfer.ended - 600 && numericEta(sample.eta));
          result.etaEvidence = stable.map(sample => ({ displayed: etaSeconds(sample.eta), actualRemaining: (transfer.ended - sample.at) / 1000 }));
          assert.ok(result.etaEvidence.some(({ displayed, actualRemaining }) => Math.abs(displayed - actualRemaining) <= Math.max(2, actualRemaining * .6)), 'Current-download ETA must correspond to observed response completion, not an invented scene countdown');
          const during = active.filter(sample => sample.at >= transfer.chunks[0].at && sample.at <= transfer.ended);
          const values = during.map(sample => loadedMB(sample.bytes)).filter(value => value !== null);
          assert.ok(values.length >= 3 && values.at(-1) > values[0] + 1, 'Actual decoded MB must advance visibly while the response streams');
          for (let index = 1; index < values.length; index++) assert.ok(values[index] >= values[index - 1], 'Displayed cumulative decoded bytes must not move backwards');
          for (const sample of during) {
            const bytesSent = transfer.chunks.filter(chunk => chunk.at <= sample.at).at(-1)?.bytes ?? 0;
            const loaded = loadedMB(sample.bytes);
            if (loaded !== null) assert.ok(loaded * 1e6 >= bytesSent - 1e6, 'Displayed decoded MB must follow actual consumed chunks within bounded sampling/rounding delay');
          }
        }
        if (name === 'concurrent') assert.ok(run.peak > 1, 'Concurrent regression must actually stream overlapping asset responses');
        result.passed = true;
      } catch (error) {
        result.failureMessage = error.stack; await page.screenshot({ path: path.join(out, `${name}-FAILED.png`), fullPage: true }).catch(() => {});
      } finally {
        sampling = false; await sampler; await page.close();
        context.off('request', requested);
        context.off('requestfailed', failedRequest);
        if (name === 'cold' && scenarios.includes('warm')) warmContext = context;
        else { await context.close(); if (context === warmContext) warmContext = undefined; }
        fs.writeFileSync(path.join(out, 'results.json'), JSON.stringify({ base: process.env.BASE_URL, results, proxy: proxy.runs }, null, 2));
      }
    }
  } finally { if (warmContext) await warmContext.close(); await browser.close(); await proxy.close(); }
  console.log(JSON.stringify(results.map(({ name, passed, failureMessage, playback }) => ({ name, passed: !!passed, failureMessage, playback })), null, 2));
  assert.ok(results.every(result => result.passed), 'One or more real-network loading scenarios failed; inspect results.json and screenshots');
}
module.exports = { createProxy, snapshot, raf };
if (require.main === module) runSuite().catch(error => { console.error(error); process.exitCode = 1; });
