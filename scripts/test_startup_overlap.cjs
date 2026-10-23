/** Actual headed Chrome startup evidence; no application/renderer patches or fake asset bodies.
 * OVERLAP_PHASE=baseline|candidate BASE_URL=<immutable release> PLAYWRIGHT_MODULE=<path>
 * QA_ARTIFACT_DIR=<dir> xvfb-run -a node scripts/test_startup_overlap.cjs
 * Baseline defaults to cold,warm. Candidate requires OVERLAP_HANDOFF=1.
 * OVERLAP_SCENARIOS selects cold,warm,flat,air,g1,g1-air,no-policy,map-failure,config-failure,
 * both-failure,original,original-primary,ownership,restores,shared.
 * Origin Cache-Control/ETag/Range headers survive unchanged; warm means the same
 * browser context and origin, including origin-required revalidation, not a forced cache hit.
 * OVERLAP_NATURAL=1 removes deliberate holds/streams for bounded local timing only.
 * OVERLAP_CONTROL=1 explicitly permits ownership/restores baseline diagnostic controls.
 * OVERLAP_OBSERVATION=playwright reproduces the original snapshot-observed stall;
 * default cdp performs side-effect-free DOM reads without snapshot/actionability waits.
 * createProxy(base, { gates, timing }) optionally buffers exact-path gates from a Map:
 * { released: false, afterBytes: 0, status: 200 }. Zero-byte gates hold headers and
 * may return an intentional 503 after capturing the real upstream success body.
 * Positive thresholds hold once enough real bytes have streamed; status is ignored
 * after success headers. Held resources retain heldAt/releasedAt and original hashes.
 * Per-proxy timing overrides only the five pacing fields; exported limits stay intact.
 */
'use strict';
const assert = require('node:assert/strict');
const http = require('node:http');
const https = require('node:https');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { chooseVisual } = require('./choose-visual.cjs');
const { snapshot, raf } = require('./test_loading_progress.cjs');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const MAP = 'nt_bullet_tdm';
const visual = `/assets/maps/${MAP}/visual.glb`;
const wasm = '/wasm/mujoco.wasm';
const isZip = pathname => /\/assets\/packs\/.*\.zip$/.test(pathname);
const isHeavy = pathname => /\/wasm\/|\/assets\/(models|source-robots)\/|\.(onnx|wasm)$|\/assets\/packs\/.*\.zip$|\/assets\/maps\/.*\.(glb|bin|xml|rgb|rgba)(?:\.gz)?$/.test(pathname);
const limits = { engineHoldMs: 6000, engineStreamMs: 1200, selectedZipStreamMs: 4000, selectedMapStreamMs: 4000, steps: 32, maxControlledBytes: 64 * 1024 * 1024, dpr: .5, viewport: { width: 1280, height: 800 } };
const natural = process.env.OVERLAP_NATURAL === '1';
if (natural) Object.assign(limits, { engineHoldMs: 0, engineStreamMs: 0, selectedZipStreamMs: 0, selectedMapStreamMs: 0, steps: 1 });

async function createProxy(base, options = {}) {
  const origin = new URL(base), sockets = new Set(), timers = new Map(), upstreamRequests = new Set();
  const gates = options.gates;
  const timing = Object.fromEntries(['engineHoldMs', 'engineStreamMs', 'selectedZipStreamMs', 'selectedMapStreamMs', 'steps']
    .map(key => [key, options.timing?.[key] ?? limits[key]]));
  let run, closed = false;
  const runs = [];
  function begin(name) { run = { name, started: Date.now(), resources: [], ownershipStage: null }; runs.push(run); return run; }
  function later(ms, res) {
    if (closed || res?.destroyed) return Promise.resolve();
    return new Promise(resolve => {
      const finished = () => { clearTimeout(timer); timers.delete(timer); res?.removeListener('close', finished); resolve(); };
      const timer = setTimeout(finished, ms);
      timers.set(timer, finished); res?.once('close', finished);
    });
  }
  async function holdGate(gate, resource, res) {
    if (gate.released || closed || res.destroyed) return;
    resource.held = true; resource.heldAt = Date.now();
    while (!gate.released && !closed && !res.destroyed) await later(50, res);
    if (gate.released) resource.releasedAt = Date.now();
  }
  const server = http.createServer((req, res) => {
    const pathname = new URL(req.url, origin).pathname, current = run;
    const resource = { path: pathname, method: req.method, started: Date.now(), bytes: 0, done: false };
    current.resources.push(resource);
    const gate = gates?.get(pathname), afterBytes = gate?.afterBytes ?? 0;
    const configFailure = ['config-failure', 'both-failure'].includes(current.name) && isZip(pathname);
    const engineFailure = current.name === 'both-failure' && /\/assets\/models\/.*\.xml$/.test(pathname);
    const mapFailure = ['map-failure', 'original-primary'].includes(current.name) && pathname === visual;
    const lateFailure = current.name === 'ownership' && current.ownershipStage === 'late' && pathname === visual;
    const retryFailure = current.name === 'ownership' && current.ownershipStage === 'retry' && pathname === visual && !current.retryFailed;
    const nativeFailure = ['original', 'original-primary'].includes(current.name) && /\/assets\/source-robots\/.*\.glb$/.test(pathname);
    if (configFailure || engineFailure || mapFailure || lateFailure || retryFailure || nativeFailure) {
      void (async () => {
        if (engineFailure) await later(timing.engineHoldMs, res);
        if (lateFailure) {
          resource.held = true;
          while (!current.releaseLate && !closed && !res.destroyed) await later(50, res);
        }
        if (closed || res.destroyed) return;
        resource.status = 503; resource.expectedFailure = true;
        if (retryFailure) current.retryFailed = true;
        res.writeHead(503, { 'content-type': 'text/plain', 'cache-control': 'no-store' });
        res.end(`Startup QA ${configFailure ? 'selected policy' : engineFailure ? 'Engine model' : 'selected map'} unavailable`);
        resource.done = true; resource.ended = Date.now();
      })();
      return;
    }
    const request = (origin.protocol === 'https:' ? https : http).request(new URL(req.url, origin), {
      method: req.method, headers: { ...req.headers, host: origin.host, 'accept-encoding': 'identity' },
    }, response => {
      const headers = { ...response.headers }; delete headers.connection; delete headers['transfer-encoding'];
      resource.status = response.statusCode; resource.cacheControl = headers['cache-control'];
      resource.etag = headers.etag; resource.requestConditional = req.headers['if-none-match'];
      const controlled = response.statusCode === 200 && req.method !== 'HEAD' &&
        (pathname === wasm || isZip(pathname) || pathname === visual || gate);
      if (!controlled) {
        res.writeHead(response.statusCode, headers);
        const hash = crypto.createHash('sha256');
        response.on('data', chunk => { resource.bytes += chunk.length; hash.update(chunk); });
        response.on('end', () => { resource.sha256 = hash.digest('hex'); resource.done = true; resource.ended = Date.now(); });
        response.pipe(res); return;
      }
      resource.controlled = true;
      const parts = []; let size = 0;
      response.on('data', chunk => { size += chunk.length; if (size > limits.maxControlledBytes) request.destroy(new Error('Real fixture exceeds 64 MiB controlled-body limit')); else parts.push(chunk); });
      response.on('end', async () => {
        const body = Buffer.concat(parts); resource.decoded = body.length; resource.sha256 = crypto.createHash('sha256').update(body).digest('hex');
        resource.upstreamEnded = Date.now();
        if (pathname === wasm) await later(timing.engineHoldMs, res);
        if (current.name === 'ownership' && current.ownershipStage === 'rebuild' && pathname === visual) {
          resource.held = true;
          while (!current.releaseRebuild && !closed && !res.destroyed) await later(50, res);
        }
        if (gate && afterBytes === 0) {
          await holdGate(gate, resource, res);
          if (closed || res.destroyed) return;
          if (gate.status === 503) {
            resource.status = 503; resource.expectedFailure = true;
            res.writeHead(503, { 'content-type': 'text/plain', 'cache-control': 'no-store' });
            res.end('Startup QA gated resource unavailable');
            resource.done = true; resource.ended = Date.now();
            return;
          }
        }
        if (closed || res.destroyed) return;
        res.writeHead(response.statusCode, headers); resource.firstByte = Date.now();
        const streamMs = pathname === wasm ? timing.engineStreamMs : isZip(pathname) ? timing.selectedZipStreamMs : pathname === visual ? timing.selectedMapStreamMs : 0;
        const chunkSize = Math.ceil(body.length / timing.steps);
        let gateReached = false;
        try {
          for (let offset = 0; offset < body.length && !closed && !res.destroyed; offset += chunkSize) {
            const chunk = body.subarray(offset, offset + chunkSize);
            if (!res.write(chunk)) await new Promise(resolve => {
              const finished = () => { res.removeListener('drain', finished); res.removeListener('close', finished); resolve(); };
              res.once('drain', finished); res.once('close', finished);
            });
            resource.bytes += chunk.length;
            if (gate && afterBytes > 0 && !gateReached && resource.bytes >= afterBytes) {
              gateReached = true;
              await holdGate(gate, resource, res);
            }
            await later(streamMs / timing.steps, res);
          }
          if (!closed && !res.destroyed) { res.end(); resource.done = true; }
        } finally { resource.ended = Date.now(); }
      });
    });
    upstreamRequests.add(request);
    request.on('close', () => upstreamRequests.delete(request));
    request.on('error', error => { resource.error = error.message; if (!res.headersSent) res.writeHead(502); res.end(); });
    res.on('close', () => { if (!request.destroyed) request.destroy(); if (!resource.done) resource.clientClosedAt = Date.now(); });
    req.pipe(request);
  });
  server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { url: `http://127.0.0.1:${server.address().port}`, runs, begin,
    async close() { closed = true; for (const finish of timers.values()) finish(); for (const request of upstreamRequests) request.destroy(); for (const socket of sockets) socket.destroy(); await new Promise(resolve => server.close(resolve)); } };
}

async function waitFor(predicate, message, timeout = 45000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { const value = predicate(); if (value) return value; await delay(50); }
  throw new Error(message);
}
async function downloadFrom(page, action) {
  // Listen before the trusted gesture without leaving a rejecting waiter behind
  // if that gesture fails. Only an actual browser download can satisfy this.
  const downloads = [], receive = download => downloads.push(download);
  page.on('download', receive);
  try {
    await action();
    const download = await waitFor(() => downloads[0], 'Real consumer download must arrive after its UI action', 120000);
    assert.equal(downloads.length, 1, 'One capture/save gesture must produce one download');
    return download;
  } finally { page.off('download', receive); }
}
async function playback(page, out, name) {
  await page.locator('#launch-enter').click();
  await page.waitForFunction(() => document.querySelector('#launch-screen').hidden);
  assert.equal(await page.locator('#app').evaluate(app => app.inert), false);
  const frames = await raf(page);
  const canvasSize = await page.locator('#viewport canvas').evaluate(canvas => ({ width: canvas.width, height: canvas.height }));
  const capture = await downloadFrom(page, () => page.locator('#capture-screenshot').click());
  const capturePath = path.join(out, `${name}-consumer-capture.png`);
  await capture.saveAs(capturePath); const png = fs.readFileSync(capturePath);
  assert.ok(png.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])), 'Consumer screenshot must have the PNG signature');
  assert.equal(png.subarray(12, 16).toString('ascii'), 'IHDR', 'Consumer PNG must begin with its image header');
  assert.equal(png.readUInt32BE(8), 13, 'PNG IHDR has the specified 13-byte payload');
  const encodedSize = { width: png.readUInt32BE(16), height: png.readUInt32BE(20) };
  assert.deepEqual(encodedSize, canvasSize, 'Consumer PNG dimensions must match the actual viewport canvas');
  await page.getByRole('button', { name: 'Record V', exact: true }).click(); await delay(1600);
  await page.getByTitle('Stop recording and open the timeline (V)', { exact: true }).click();
  const play = page.getByTitle('Play / pause (Space)', { exact: true }); await play.waitFor();
  if (await play.getAttribute('aria-pressed') !== 'true') await play.click();
  const before = await page.locator('.dk-clock').textContent(); await delay(350); await raf(page);
  const after = await page.locator('.dk-clock').textContent(); assert.notEqual(after, before, 'Live recorded timeline must advance');
  await page.screenshot({ path: path.join(out, `${name}-playback.png`) });
  return { frames, before, after, capture: { filename: capture.suggestedFilename(), bytes: png.length, canvasSize, encodedSize } };
}
async function pick(page, proxy, run, name, sharedUrl) {
  await page.goto(sharedUrl || `${proxy.url}/?plain&body=stock`, { waitUntil: 'domcontentloaded' });
  await page.locator('#launch-map-trigger').waitFor();
  if (name === 'cold') assert.equal(await page.locator('#launch-map').inputValue(), 'map:nt_ghost_ctg', 'Fresh default stays Ghost');
  const terrain = ['flat', 'air', 'g1', 'g1-air', 'no-policy', 'config-failure', 'both-failure', 'ownership'].includes(name) ? 'flat' : `map:${MAP}`;
  if (name === 'shared') assert.equal(await page.locator('#launch-map').inputValue(), terrain, 'Actual shared link selects the recorded map before Load');
  else await chooseVisual(page, 'launch-map', terrain);
  await page.locator('#launch-next').click();
  const robot = name === 'air' ? 'r1_air' : name === 'g1' ? 'g1' : name === 'g1-air' ? 'g1_air' : name === 'no-policy' ? 'go2' : 'r1';
  if (name === 'air') assert.equal(await page.locator('#launch-robot').inputValue(), 'r1_air', 'Remembered Air-only policy retains its actual compatible plant');
  else if (name !== 'shared') await chooseVisual(page, 'launch-robot', robot);
  if (!['original', 'original-primary', 'shared'].includes(name)) await chooseVisual(page, 'launch-character', 'stock');
  assert.deepEqual(run.resources.filter(resource => isHeavy(resource.path)), [], 'No heavy assets before explicit Load');
  const loadStartedAt = Date.now(); await page.locator('#launch-load').click();
  return { terrain, robot, loadStartedAt };
}
function analyze(result, run, phase) {
  const zip = run.resources.filter(resource => isZip(resource.path));
  assert.ok(zip.length <= 1, 'Only selected hosted ZIP may download, without duplicate/retry');
  assert.ok(zip.every(resource => resource.path.startsWith('/assets/packs/r1/')), 'Aggregate catalog ZIP must never download');
  const demandedZips = result.requests.filter(resource => isZip(resource.path));
  assert.ok(demandedZips.length <= 1 && demandedZips.every(resource => resource.path.startsWith('/assets/packs/r1/')), 'Browser/cache demand stays selected-only without aggregate or duplicate policy requests');
  const mapBodies = result.requests.filter(resource => /\/assets\/maps\/.*\.(glb|bin|xml|rgb|rgba)(?:\.gz)?$/.test(resource.path));
  assert.ok(mapBodies.every(resource => resource.path.startsWith(`/assets/maps/${MAP}/`)), 'Only the actually selected real converted map may download');
  if (!result.terrain.startsWith('map:') && result.name !== 'ownership') assert.equal(mapBodies.length, 0, 'Built-in fixtures cannot start an unrelated converted map');
  const models = run.resources.filter(resource => /\/assets\/models\/.*\.xml$/.test(resource.path));
  result.modelPaths = models.map(resource => resource.path); result.selectedZip = zip[0]?.path;
  const engine = run.resources.find(resource => resource.path === wasm);
  const map = run.resources.find(resource => resource.path === visual);
  result.timing = { loadToReadyMs: result.ready ? result.ready.at - result.loadStartedAt : null,
    enginePrerequisiteEnd: engine?.ended, selectedZipStart: zip[0]?.started, selectedZipEnd: zip[0]?.ended,
    selectedMapStart: map?.started, selectedMapEnd: map?.ended,
    zipBeforeEnginePrerequisite: !!zip[0] && zip[0].started < engine?.ended,
    mapBeforeEnginePrerequisite: !!map && map.started < engine?.ended };
  if (result.name === 'cold') {
    assert.ok(engine?.done && zip[0]?.done && map?.done, 'Cold launch uses complete real physics, selected ZIP and selected map');
    assert.equal(result.timing.zipBeforeEnginePrerequisite, phase === 'candidate', 'Selected ZIP critical-path dependency differs only in integrated candidate');
    assert.equal(result.timing.mapBeforeEnginePrerequisite, phase === 'candidate', 'Selected map critical-path dependency differs only in integrated candidate');
    assert.ok(result.ready.at > Math.max(engine.ended, zip[0].ended, map.ended), 'Canonical ready waits real required assets');
  }
  if (['g1', 'g1-air', 'no-policy'].includes(result.name)) {
    assert.equal(zip.length, 0, 'Driverless robot must not download hosted policies');
    assert.ok(!run.resources.some(resource => /ort.*\.wasm$|\.onnx$/.test(resource.path)), 'Driverless init must not initialize inference');
    assert.ok(models.some(resource => resource.path.includes(`/models/${result.robot.split('_')[0]}/`)), 'Correct driverless physics bundle must load');
  }
  if (result.name === 'air') {
    assert.equal(result.physicsAtReady.model, 'R1 Air · 20-DOF', 'Worker canonical status, not bundle file presence, identifies compiled Air physics');
    assert.ok(zip.length === 1, 'Air selects exactly one compatible policy');
  }
  if (result.name === 'g1') assert.equal(result.physicsAtReady.model, 'G1 EDU · 29-DOF', 'Canonical worker status identifies actual G1 variant');
  if (result.name === 'g1-air') assert.equal(result.physicsAtReady.model, 'G1 Air · 23-DOF', 'Canonical worker status identifies actual Air G1 variant');
  if (result.name === 'flat') assert.equal(result.physicsAtReady.model, 'R1 EDU · 24-DOF', 'Default R1 retains EDU physics');
  if (['g1', 'g1-air', 'no-policy'].includes(result.name)) assert.equal(result.physicsAtReady.policy, 'No policy', 'Driverless status cannot silently pick a policy');
  const requiredPaths = result.requests.filter(resource => /\.(glb|zip)$/.test(resource.path)).map(resource => resource.path);
  if (!['ownership', 'restores'].includes(result.name)) assert.equal(new Set(requiredPaths).size, requiredPaths.length, 'First model build must reuse in-flight map/body downloads');
}
async function readDOM(cdp, expression) {
  // Direct read-only Runtime inspection distinguishes a renderer JS stall from
  // Playwright snapshot/actionability waiting. Never invokes application methods.
  let timer;
  try {
    const response = await Promise.race([
      cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Read-only CDP DOM inspection exceeded 30s observation budget')), 30000); }),
    ]);
    assert.ok(!response.exceptionDetails, `Read-only DOM inspection failed: ${JSON.stringify(response.exceptionDetails)}`);
    return response.result.value;
  } finally { clearTimeout(timer); }
}
async function waitDOM(cdp, expression, message, timeout = 30000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { if (await readDOM(cdp, expression)) return; await delay(50); }
  throw new Error(message);
}
async function mouseDOM(page, cdp, selector) {
  let geometry;
  for (let attempt = 0; attempt < 12; attempt++) {
    geometry = await readDOM(cdp, `(() => {
      const element = document.querySelector(${JSON.stringify(selector)});
      if (!element) return null;
      const rect = element.getBoundingClientRect(), x = rect.x + rect.width / 2, y = rect.y + rect.height / 2;
      let scroller = element.parentElement;
      while (scroller && !(scroller.scrollHeight > scroller.clientHeight && /auto|scroll/.test(getComputedStyle(scroller).overflowY))) scroller = scroller.parentElement;
      const clip = scroller?.getBoundingClientRect(), hit = element.contains(document.elementFromPoint(x, y));
      return { x, y, width: rect.width, height: rect.height, disabled: element.disabled,
        hit,
        scroll: clip && (!hit || y < clip.top + 25 || y > clip.bottom - 25) ? {
          x: Math.max(1, Math.min(innerWidth - 1, clip.x + clip.width / 2)),
          y: Math.max(1, Math.min(innerHeight - 1, clip.y + clip.height / 2)),
          delta: y - (clip.y + clip.height / 2) } : null };
    })()`);
    if (geometry?.hit || !geometry?.scroll) break;
    await page.mouse.move(geometry.scroll.x, geometry.scroll.y);
    await page.mouse.wheel(0, geometry.scroll.delta); await delay(100);
  }
  assert.ok(geometry?.width && geometry.height && geometry.hit && !geometry.disabled, `Actual visible pointer target required: ${selector}: ${JSON.stringify(geometry)}`);
  await page.mouse.click(geometry.x, geometry.y);
}
async function visualMouse(page, cdp, id, value) {
  await mouseDOM(page, cdp, `#${id}-trigger`);
  await waitDOM(cdp, `!!document.querySelector('dialog[data-visual-picker="${id}"][open]')`, `Real ${id} gallery must open`);
  await mouseDOM(page, cdp, `dialog[data-visual-picker="${id}"] button[data-value="${value}"]`);
  await waitDOM(cdp, `!document.querySelector('dialog[data-visual-picker="${id}"][open]')`, `Real ${id} selection must close its gallery`);
}

async function ownership(page, run, out) {
  await page.locator('#launch-enter').click();
  const cdp = await page.context().newCDPSession(page);
  const observedByPlaywright = process.env.OVERLAP_OBSERVATION === 'playwright';
  run.observation = observedByPlaywright ? 'playwright' : 'direct-cdp';
  run.ownershipStage = 'rebuild';
  if (observedByPlaywright) await chooseVisual(page, 'terrain', `map:${MAP}`);
  else await visualMouse(page, cdp, 'terrain', `map:${MAP}`);
  const held = await waitFor(() => run.resources.find(resource => resource.path === visual && resource.held), 'Real selected map must be held for same-map rebuild');
  const probeAt = Date.now();
  run.pendingMapDOM = observedByPlaywright ? await Promise.race([
    page.evaluate(() => ({ at: Date.now(), hidden: document.hidden, inert: document.querySelector('#app').inert, robotDisabled: document.querySelector('#robot-trigger').disabled })),
    delay(5000).then(() => { throw new Error('Read-only DOM probe blocked for 5s while real map pending'); }),
  ]) : await readDOM(cdp, `({ at: Date.now(), hidden: document.hidden, inert: document.querySelector('#app').inert, robotDisabled: document.querySelector('#robot-trigger').disabled })`);
  run.pendingMapDOMRoundTripMs = Date.now() - probeAt;
  run.pendingMapHeartbeat = await readDOM(cdp, `new Promise(resolve => { const start = performance.now(); setTimeout(() => resolve({ elapsedMs: performance.now() - start }), 200); })`);
  // Real input and DOM-open postconditions, independent of slow RAF actionability.
  await visualMouse(page, cdp, 'robot', 'go2');
  await waitFor(() => run.resources.find(resource => /\/models\/go2\/.*\.xml$/.test(resource.path)), 'Robot rebuild must start while map remains pending');
  await waitDOM(cdp, `!!document.querySelector('#status')?.dataset.k?.includes('No policy')`, 'Canonical rebuilt go2 status must arrive while the original map is still pending', 120000);
  assert.equal(held.done, false, 'Map remains genuinely held through the same-map model build');
  assert.equal(run.resources.filter(resource => resource.path === visual).length, 1, 'Same-map robot rebuild shares the in-flight visual');
  run.releaseRebuild = true; await waitFor(() => held.done, 'Held real map must complete');
  await waitDOM(cdp, `document.querySelector('#map-loading').hidden`, 'Original map readiness callback survives same-map rebuild', 120000); await raf(page);
  await page.screenshot({ path: path.join(out, 'ownership-same-map.png') });
  await visualMouse(page, cdp, 'terrain', 'flat');
  run.ownershipStage = 'late'; await visualMouse(page, cdp, 'terrain', `map:${MAP}`);
  const late = await waitFor(() => run.resources.find(resource => resource.path === visual && resource.expectedFailure === undefined && resource.held && resource !== held), 'Late map must really start');
  await visualMouse(page, cdp, 'terrain', 'rough');
  await waitDOM(cdp, `document.querySelector('#map-loading').hidden`, 'New built-in scene must own readiness before delivering the old error', 120000);
  run.releaseLate = true;
  await waitFor(() => late.done, 'Old map error must be delivered'); await delay(1500); await raf(page);
  const status = await readDOM(cdp, `document.querySelector('#map-loading span').textContent`);
  assert.ok(!/failed|503|unavailable/i.test(status), 'Late map error must not replace the newest built-in scene');
  assert.match(await readDOM(cdp, `document.querySelector('#terrain-trigger').textContent`), /rough/i);
  await page.screenshot({ path: path.join(out, 'ownership-late-map.png') });
  const newestTerrain = await readDOM(cdp, `document.querySelector('#terrain-trigger').textContent`);
  run.ownershipStage = 'retry'; await visualMouse(page, cdp, 'terrain', `map:${MAP}`);
  await waitDOM(cdp, `!document.querySelector('#map-loading button').hidden`, 'Real map failure must expose retry', 120000);
  await mouseDOM(page, cdp, '#map-loading button');
  await waitDOM(cdp, `document.querySelector('#map-loading').hidden`, 'Real map retry must finish', 120000); await raf(page);
  assert.match(await readDOM(cdp, `document.querySelector('#terrain-trigger').textContent`), /bullet/i, 'Map-only retry preserves current terrain');
  await page.screenshot({ path: path.join(out, 'ownership-map-retry.png') });
  return { sameMapRequests: 1, oldErrorAt: late.ended, newestTerrain, status, mapRetry: true };
}

async function movePlayPanel(page, cdp, targetX) {
  // Use the existing workspace drag affordance to uncover Screenshot during
  // timeline review; never click through the actual overlapping timeline.
  const before = await readDOM(cdp, `(() => {
    const panel = document.querySelector('#play-window').getBoundingClientRect();
    const grip = document.querySelector('[aria-label="Move Play panel"]').getBoundingClientRect();
    return { x: panel.x, width: panel.width, viewportWidth: innerWidth, gripX: grip.x + 80, gripY: grip.y + 15 };
  })()`);
  const nextX = targetX ?? before.viewportWidth - before.width - 20;
  await page.mouse.move(before.gripX, before.gripY); await page.mouse.down();
  await page.mouse.move(before.gripX + nextX - before.x, before.gripY, { steps: 8 }); await page.mouse.up();
  await waitDOM(cdp, `Math.abs(document.querySelector('#play-window').getBoundingClientRect().x - ${JSON.stringify(nextX)}) < 1`, 'Real workspace drag must move the Play panel');
  return before.x;
}

async function restores(page, run, out) {
  await page.locator('#launch-enter').click(); await raf(page);
  if (await page.locator('#toggle-menu').getAttribute('aria-expanded') === 'false') await page.locator('#toggle-menu').click();
  const sceneCollapse = page.locator('#scene-window .floating-collapse');
  if (await sceneCollapse.getAttribute('aria-expanded') === 'false') await sceneCollapse.click();
  await page.getByText('Saved views', { exact: true }).click();
  await page.getByLabel('View name', { exact: true }).fill('Overlap Bullet');
  await page.getByRole('button', { name: 'Save view', exact: true }).click();
  const bookmark = await page.evaluate(() => JSON.parse(localStorage.getItem('ume-saved-views-v1')).find(bookmark => bookmark.name === 'Overlap Bullet'));
  assert.equal(bookmark.view.terrain, `map:${MAP}`);
  await page.getByRole('button', { name: 'Share current view', exact: true }).click();
  const sharedUrl = await page.getByLabel('Shareable view link', { exact: true }).inputValue();
  assert.ok(new URL(sharedUrl).hash.startsWith('#view='), 'Share UI must emit a real serialized scene link');
  run.sharedUrl = sharedUrl; run.savedBookmark = bookmark;
  const cdp = await page.context().newCDPSession(page);
  await visualMouse(page, cdp, 'terrain', 'flat');
  await waitDOM(cdp, `!document.querySelector('#overlay').classList.contains('hidden')`, 'Actual flat rebuild must start before waiting for its completion', 10000);
  await waitDOM(cdp, `document.querySelector('#overlay').classList.contains('hidden')`, 'Flat physics must finish before saved restore', 120000);
  const start = run.resources.length;
  await mouseDOM(page, cdp, '.saved-view-restore[aria-label="Overlap Bullet"]');
  if (process.env.OVERLAP_OBSERVATION === 'playwright') await page.getByText('View restored.', { exact: true }).waitFor({ timeout: 120000 });
  else await waitDOM(cdp, `[...document.querySelectorAll('.saved-view-state')].some(element => element.textContent === 'View restored.')`, 'Actual saved restore must finish', 120000);
  await waitDOM(cdp, `document.querySelector('#map-loading').hidden`, 'Restored map visuals must complete', 120000); await raf(page);
  assert.match(await readDOM(cdp, `document.querySelector('#terrain-trigger').textContent`), /bullet/i);
  const restoredMaps = run.resources.slice(start).filter(resource => resource.path === visual);
  assert.ok(restoredMaps.length <= 1, 'Saved map restore cannot duplicate an in-flight visual');
  await page.screenshot({ path: path.join(out, 'saved-view-restored.png') });
  await mouseDOM(page, cdp, `button[title="Record the robot's motion and your inputs (V)"]`); await delay(1600);
  await mouseDOM(page, cdp, 'button[title="Stop recording and open the timeline (V)"]');
  const take = await downloadFrom(page, () => mouseDOM(page, cdp, 'button[title="Save this take to reopen it later (.take.zip)"]'));
  await take.saveAs(path.join(out, 'overlap-real.take.zip'));
  await mouseDOM(page, cdp, 'button[title="Close the timeline, back to the live sim (Esc)"]');
  await visualMouse(page, cdp, 'terrain', 'flat');
  await waitDOM(cdp, `!document.querySelector('#overlay').classList.contains('hidden')`, 'Actual live flat rebuild must start before waiting for its completion', 10000);
  await waitDOM(cdp, `document.querySelector('#overlay').classList.contains('hidden')`, 'Live flat scene must finish before take review', 120000);
  await mouseDOM(page, cdp, 'button[title="Open the last take on the timeline"]');
  await mouseDOM(page, cdp, '[role="radio"][title="The camera as it moved while recording"]');
  const playPanelX = await page.locator('#scene-actions').count() ? undefined : await movePlayPanel(page, cdp);
  const shot = await downloadFrom(page, () => mouseDOM(page, cdp, '#capture-screenshot'));
  await shot.saveAs(path.join(out, 'take-restored-consumer.png'));
  assert.match(shot.suggestedFilename(), /^nt_bullet_tdm_r1_/, 'Review capture must wait for the take map, not the live flat picker');
  await page.screenshot({ path: path.join(out, 'take-restored-live.png') });
  if (playPanelX !== undefined) await movePlayPanel(page, cdp, playPanelX);
  await mouseDOM(page, cdp, 'button[title="Close the timeline, back to the live sim (Esc)"]');
  const live = await downloadFrom(page, () => mouseDOM(page, cdp, '#capture-screenshot'));
  await live.saveAs(path.join(out, 'take-returned-flat-consumer.png'));
  assert.match(live.suggestedFilename(), /^flat_r1_/, 'Leaving review restores newest live terrain');
  assert.match(await readDOM(cdp, `document.querySelector('#terrain-trigger').textContent`), /flat/i);
  return { sharedUrl, savedTerrain: bookmark.view.terrain, savedMapRequests: restoredMaps.length, takeFilename: take.suggestedFilename(), reviewCapture: shot.suggestedFilename(), liveCapture: live.suggestedFilename() };
}

async function main() {
  const phase = process.env.OVERLAP_PHASE;
  assert.ok(['baseline', 'candidate'].includes(phase), 'Explicit OVERLAP_PHASE required');
  assert.ok(process.env.BASE_URL, 'Explicit immutable BASE_URL required');
  if (phase === 'candidate') assert.equal(process.env.OVERLAP_HANDOFF, '1', 'Candidate requires explicit owner preview handoff');
  const scenarios = (process.env.OVERLAP_SCENARIOS || (phase === 'baseline' ? 'cold,warm' : 'cold,warm,flat,air,g1,g1-air,no-policy,map-failure,config-failure,both-failure,original,original-primary,ownership,restores,shared')).split(',');
  if (phase === 'baseline') assert.ok(scenarios.every(name => ['cold', 'warm'].includes(name) || (process.env.OVERLAP_CONTROL === '1' && ['ownership', 'restores'].includes(name))), 'Baseline allows timing and explicitly authorized runtime controls, never the candidate suite');
  const out = process.env.QA_ARTIFACT_DIR; assert.ok(out, 'Explicit QA_ARTIFACT_DIR required'); fs.mkdirSync(out, { recursive: true });
  const baseline = process.env.BASELINE_RESULTS ? JSON.parse(fs.readFileSync(process.env.BASELINE_RESULTS, 'utf8')) : null;
  if (baseline) assert.deepEqual(baseline.limits, limits, 'Comparison must use identical HTTP fixture, viewport and DPR');
  const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
  const proxy = await createProxy(process.env.BASE_URL), results = [];
  const launchBrowser = () => chromium.launch({ headless: false, executablePath: process.env.CHROME_EXECUTABLE || '/usr/bin/google-chrome', args: ['--no-sandbox', '--ozone-platform=x11', '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding'] });
  let browser = await launchBrowser();
  let warmContext;
  const save = () => fs.writeFileSync(path.join(out, 'results.json'), JSON.stringify({ phase, upstream: process.env.BASE_URL, chrome: browser.version(), domObservationBudgetMs: 30000, limits, results, runs: proxy.runs }, null, 2));
  try {
    for (const name of scenarios) {
      const run = proxy.begin(name), errors = [], consoleErrors = [], networkErrors = [], httpErrors = [], requests = [], samples = [];
      const context = name === 'warm' && warmContext ? warmContext : await browser.newContext({ viewport: limits.viewport, deviceScaleFactor: limits.dpr, recordVideo: { dir: path.join(out, 'video'), size: { width: 960, height: 600 } } });
      const captureTrace = name === 'ownership' && (process.env.OVERLAP_OBSERVATION === 'playwright' || process.env.OVERLAP_TRACE === '1');
      if (captureTrace) await context.tracing.start({ screenshots: true, snapshots: true });
      if (['original', 'original-primary'].includes(name)) await context.addInitScript(() => localStorage.setItem('ume-head-visuals', JSON.stringify({ r1: 'ghost' })));
      if (name === 'air') await context.addInitScript(() => localStorage.setItem('ume-prefs', JSON.stringify({ robot: 'r1_air', terrain: 'flat', policy: 'locomotion_20dofs/locomotion_20dofs' })));
      const page = await context.newPage();
      page.on('pageerror', error => errors.push(error.message));
      page.on('console', message => { if (message.type() === 'error') consoleErrors.push({ text: message.text(), location: message.location(), at: Date.now() }); });
      context.on('request', request => requests.push({ path: new URL(request.url()).pathname, at: Date.now() }));
      context.on('requestfailed', request => networkErrors.push({ path: new URL(request.url()).pathname, error: request.failure()?.errorText, at: Date.now() }));
      context.on('response', response => { if (response.status() >= 400) httpErrors.push({ path: new URL(response.url()).pathname, status: response.status(), at: Date.now() }); });
      let sampling = true;
      const sampler = (async () => { while (sampling) { try { samples.push(await snapshot(page)); } catch {} await delay(100); } })();
      const result = { name, errors, consoleErrors, networkErrors, httpErrors, requests, samples }; results.push(result);
      try {
        const sharedUrl = name === 'shared' ? results.find(result => result.name === 'restores')?.restores?.sharedUrl || proxy.runs.find(run => run.name === 'restores')?.sharedUrl : undefined;
        if (name === 'shared') assert.ok(sharedUrl, 'Shared receiver requires preceding actual Share UI evidence');
        Object.assign(result, await pick(page, proxy, run, name, sharedUrl));
        assert.deepEqual(requests.filter(request => request.at < result.loadStartedAt && isHeavy(request.path)), [], 'Heavy browser demand, including HTTP-cache hits, starts only after explicit Load');
        if (['map-failure', 'config-failure', 'both-failure', 'original', 'original-primary'].includes(name)) {
          await page.locator('#launch-status[data-kind="error"]').waitFor({ timeout: 120000 });
          result.firstError = await snapshot(page);
          if (['map-failure', 'original-primary'].includes(name)) {
            const engine = await waitFor(() => run.resources.find(resource => resource.path === wasm && resource.done), 'Engine must finish after early selected-map error');
            assert.ok(result.firstError.at < engine.ended, 'Map failure occurs before Engine prerequisite finishes');
          }
          await waitFor(() => run.resources.filter(resource => resource.controlled).every(resource => resource.done), 'All concurrent controlled work must drain');
          if (name !== 'both-failure') {
            await page.waitForFunction(() => document.querySelector('#status')?.dataset.k, null, { timeout: 120000 });
            result.workerStatusAfterFailure = { at: Date.now(), rows: await page.locator('#status').evaluate(status => JSON.parse(status.dataset.k)) };
          }
          if (name === 'original-primary') await waitFor(() => run.resources.some(resource => resource.expectedFailure && /\/source-robots\/.*\.glb$/.test(resource.path)), 'Late optional-native failure must really challenge the early primary map failure');
          await delay(3000); result.lateError = await snapshot(page);
          assert.equal(result.lateError.status, result.firstError.status, 'Later worker messages must preserve canonical error');
          assert.equal(result.lateError.ready, false, 'Failure must not unlock Enter');
          assert.match(result.firstError.status, /503|failed|could not load/i);
          if (name === 'both-failure') assert.ok(!/selected policy unavailable|^failed to load/i.test(result.firstError.status), 'Engine/model error keeps precedence over policy error');
          if (['config-failure', 'both-failure'].includes(name)) {
            const failedZip = run.resources.find(resource => isZip(resource.path)), engine = run.resources.find(resource => resource.path === wasm);
            assert.ok(failedZip?.expectedFailure, 'Actual selected policy ZIP must fail before Engine is available');
            if (engine) assert.ok(failedZip.ended < engine.ended, 'Policy HTTP failure genuinely precedes held physics completion');
          }
          assert.deepEqual(errors, [], 'Handled startup errors must not produce unhandled page/worker rejection');
          assert.ok(httpErrors.length > 0 && httpErrors.every(error => run.resources.some(resource => resource.expectedFailure && resource.path === error.path)), 'Every failed HTTP response must be the exact deliberate fixture failure');
          assert.deepEqual(networkErrors, [], 'Handled HTTP errors must not hide transport failures');
          await page.screenshot({ path: path.join(out, `${name}-error.png`) });
          if (name === 'original-primary') assert.equal(await page.locator('#launch-original').isVisible(), false, 'Optional native failure cannot offer an escape that clears primary map failure');
          if (name === 'original') {
            await page.locator('#launch-original').click();
            await page.locator('#launch-enter:not([disabled])').waitFor({ timeout: 120000 });
            result.ready = await snapshot(page); await page.locator('#launch-enter').click(); result.frames = await raf(page);
            result.originalRecovered = true;
          }
        } else {
          await page.locator('#launch-enter:not([disabled])').waitFor({ timeout: 240000 }); result.ready = await snapshot(page);
          // Runtime ownership uses one continuous video, not a launch-only DOM
          // sampler or automatic trace/snapshot readbacks competing with rendering.
          sampling = false; await sampler;
          await page.waitForFunction(() => document.querySelector('#status')?.dataset.k);
          result.physicsAtReady = await page.locator('#status').evaluate(status => Object.fromEntries(JSON.parse(status.dataset.k).map(([key, value]) => [key, value])));
          result.resourceTiming = await page.evaluate(() => performance.getEntriesByType('resource').map(entry => ({ name: new URL(entry.name).pathname, startTime: entry.startTime, responseEnd: entry.responseEnd, transferSize: entry.transferSize, decodedBodySize: entry.decodedBodySize })));
          assert.equal(result.ready.value, 1, 'Only canonical readiness completes progress');
          for (const sample of samples) if (!sample.ready) assert.notEqual(sample.value, 1, 'No readiness/progress shortcut while assets pending');
          await page.screenshot({ path: path.join(out, `${name}-ready.png`) });
          if (name === 'cold') result.playback = await playback(page, out, name);
          else if (name === 'ownership') result.ownership = await ownership(page, run, out);
          else if (name === 'restores') result.restores = await restores(page, run, out);
          else { await page.locator('#launch-enter').click(); result.frames = await raf(page); }
          assert.deepEqual(errors, [], 'Successful scene must have no uncaught errors');
          assert.deepEqual(networkErrors, [], 'Successful scene must have no hidden network errors');
          assert.ok(httpErrors.every(error => name === 'ownership' && run.resources.some(resource => resource.expectedFailure && resource.path === error.path)), 'Every failed HTTP asset must be an exact intentional ownership fixture failure');
        }
        const workerDiagnostics = consoleErrors.filter(error => /\/sim\.worker-[^/]+\.js$/.test(new URL(error.location.url).pathname));
        const expectedWorkerCount = ['config-failure', 'both-failure'].includes(name) ? 1 : 0;
        assert.equal(workerDiagnostics.length, expectedWorkerCount, 'Handled worker failures produce exactly one original caught diagnostic, never an extra unhandled rejection');
        for (const diagnostic of workerDiagnostics) {
          const originalLine = diagnostic.text.split('\n')[0];
          assert.ok(originalLine && result.firstError?.status.includes(originalLine), 'Original worker diagnostic must remain inside the canonical visible failure');
        }
        const browserDiagnostics = consoleErrors.filter(error => !workerDiagnostics.includes(error));
        assert.ok(browserDiagnostics.every(error => {
          const pathname = error.location.url && new URL(error.location.url).pathname;
          return run.resources.some(resource => resource.expectedFailure && resource.status === 503 && resource.path === pathname) &&
            httpErrors.some(response => response.path === pathname && response.status === 503);
        }), 'Every browser error must identify the exact deliberate failed resource and its observed HTTP 503; no other console entries');
        if (baseline && ['cold', 'warm'].includes(name)) {
          const before = baseline.results.find(result => result.name === name), beforeRun = baseline.runs.find(run => run.name === name);
          assert.ok(before?.passed, 'Comparison needs qualified baseline of same scenario');
          const bodies = run.resources.filter(resource => resource.done && resource.status === 200 && (resource.path === wasm || isZip(resource.path) || resource.path === visual));
          result.identicalPayloads = bodies.map(resource => {
            const old = beforeRun.resources.find(previous => previous.path === resource.path && previous.status === 200);
            assert.equal(resource.sha256, old?.sha256, 'Measured releases must use identical real selected payloads');
            assert.equal(resource.decoded, old?.decoded, 'Measured decoded payload sizes must agree');
            return { path: resource.path, sha256: resource.sha256, decoded: resource.decoded };
          });
          result.comparison = { baselineLoadToReadyMs: before.ready.at - before.loadStartedAt, candidateLoadToReadyMs: result.ready.at - result.loadStartedAt,
            deltaMs: (before.ready.at - before.loadStartedAt) - (result.ready.at - result.loadStartedAt), originCachePolicyPreserved: true };
        }
        analyze(result, run, phase); result.passed = true;
      } catch (error) {
        result.failure = error.stack;
        // Preserve the failure, then let a held real response finish so failure
        // screenshots/teardown cannot themselves deadlock on our fixture gate.
        run.releaseRebuild = true; run.releaseLate = true;
        await page.screenshot({ path: path.join(out, `${name}-FAILED-after-release.png`), timeout: 10000 }).catch(error => { result.failureScreenshot = error.message; });
      }
      finally {
        sampling = false; await sampler;
        await page.close();
        result.video = await page.video().path();
        if (captureTrace) { result.trace = path.join(out, 'ownership-trace.zip'); await context.tracing.stop({ path: result.trace }); }
        context.removeAllListeners('request'); context.removeAllListeners('requestfailed'); context.removeAllListeners('response');
        if (name === 'cold' && scenarios.includes('warm')) warmContext = context;
        else { await context.close(); if (context === warmContext) warmContext = undefined; }
        save();
      }
      console.log(JSON.stringify({ name, passed: !!result.passed, timing: result.timing, failure: result.failure }));
      // Each independent scene gets a fresh owned Chrome process; only the actual
      // cold/warm pair retains a browser/cache. This bounds accumulated GPU state.
      if (!warmContext && name !== scenarios.at(-1)) { await browser.close(); browser = await launchBrowser(); }
    }
  } finally { if (warmContext) await warmContext.close(); await browser.close(); await proxy.close(); save(); }
  assert.ok(results.every(result => result.passed), 'Startup overlap evidence failed; inspect results.json/screenshots/video');
}
module.exports = { createProxy, limits };
if (require.main === module) main().catch(error => { console.error(error); process.exitCode = 1; });
