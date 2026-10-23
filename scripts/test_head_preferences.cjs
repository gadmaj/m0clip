/** Consumer regression: deliberate head intent, native geometry, launch precedence and recovery.
 * BASE_URL=<immutable candidate> PLAYWRIGHT_MODULE=<playwright> node scripts/test_head_preferences.cjs
 * HEADLESS=0 CHROME_EXECUTABLE=/usr/bin/google-chrome DISPLAY=:<private Xvfb> enables headed QA.
 * Only response instrumentation exposes App; rendering, assets and worker failures remain real.
 */
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const { launchScene } = require('./launch-scene.cjs');
const exposeApp = require('./expose-app.cjs');
const base = process.env.BASE_URL || 'http://127.0.0.1:5176';
const timeout = 240000;
const ghostURL = '**/assets/source-robots/neotokyo-girlbot/girlbot_head.glb';
const output = process.env.QA_OUTPUT;

async function picturedChoice(page, id, value) {
  // Shared visual-choice action pattern, with progressive attachment/decode before clicking.
  await page.locator(`#${id}-trigger`).click();
  const dialog = page.locator(`dialog[data-visual-picker="${id}"]`);
  const card = dialog.locator(`button[data-value="${value}"]`);
  await card.waitFor({ state: 'visible' });
  await card.scrollIntoViewIfNeeded();
  await page.waitForFunction(({ id, value }) => {
    const card = document.querySelector(`dialog[data-visual-picker="${id}"] button[data-value="${value}"]`);
    const image = card?.querySelector('img');
    const canvas = card?.querySelector('canvas');
    return (image?.complete && image.naturalWidth > 0) || (canvas?.width > 0 && canvas?.height > 0);
  }, { id, value }, { timeout });
  if (await card.isDisabled()) throw new Error(`Unavailable ${id} choice: ${value}`);
  await card.click();
  await dialog.waitFor({ state: 'hidden' });
}
async function ready(page) {
  await page.waitForFunction(() => window.__app?.lastFrame &&
    document.querySelector('#overlay').classList.contains('hidden'), null, { timeout });
}
async function enter(page) {
  await page.waitForFunction(() => {
    const b = document.querySelector('#launch-enter');
    return b && !b.hidden && !b.disabled;
  }, null, { timeout });
  await page.locator('#launch-enter').click();
  await page.waitForFunction(() => document.querySelector('#launch-screen').hidden, null, { timeout });
  await ready(page);
}
async function appearance(page) {
  const trigger = page.locator('#source-head-visual-trigger');
  if (!await trigger.isVisible()) {
    if (await page.locator('#toggle-menu').getAttribute('aria-expanded') === 'false') await page.locator('#toggle-menu').click();
    const expandScene = page.getByRole('button', { name: 'Expand Scene panel', exact: true });
    if (await expandScene.isVisible()) await expandScene.click();
  }
  if (!await trigger.isVisible()) await page.getByText('Robot appearance', { exact: true }).click();
}
async function proof(page) {
  return page.evaluate(() => {
    const a = window.__app, v = a.view, h = v.parts.get('head_yaw_link')?.mesh;
    const m = h?.material;
    const positions = h?.geometry.attributes.position.array;
    let geometryHash = 2166136261;
    if (positions) for (const byte of new Uint8Array(positions.buffer, positions.byteOffset, positions.byteLength))
      geometryHash = Math.imul(geometryHash ^ byte, 16777619) >>> 0;
    return { robot: a.viewModel?.robot, terrain: a.viewModel?.terrain, policy: a.status?.policy,
      desired: v.getHeadVisual(), applied: v.getSourceHead(), appearance: v.getAppearance(),
      stored: JSON.parse(localStorage.getItem('ume-head-visuals') || '{}'),
      native: h?.userData.sourceRobotPart || null, triangles: h?.geometry.index?.count / 3,
      geometryHash,
      baseMap: !!m?.map, normalMap: !!m?.normalMap, color: m?.color?.getHex(),
      modules: [...v.parts.values()].filter(p => p.mesh.userData.robotModule).map(p => p.mesh.userData.robotModule),
      contextLost: v.renderer.getContext().isContextLost(), frame: !!a.lastFrame };
  });
}
function nativeGhost(p) {
  assert.equal(p.desired, 'ghost'); assert.equal(p.applied, 'ghost');
  assert.equal(p.native, 'models/nt/props_tech/girlbot_head.mdl');
  assert.equal(p.baseMap, true); assert.equal(p.normalMap, true);
  assert.equal(p.frame, true); assert.equal(p.contextLost, false);
}
function stock(p) { assert.equal(p.desired, 'stock'); assert.equal(p.applied, 'stock'); assert.equal(p.native, null); }
async function screenshot(page, name) {
  if (output) await page.screenshot({ path: path.join(output, name + '.png') });
}
async function fixture(browser, heads = {}) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 1, serviceWorkers: 'block' });
  const page = await context.newPage(), errors = [], requests = [], failed = [];
  await page.addInitScript(heads => {
    if (sessionStorage.getItem('head-test-seeded')) return;
    sessionStorage.setItem('head-test-seeded', '1');
    localStorage.setItem('ume-prefs', JSON.stringify({ robot: 'r1', terrain: 'flat' }));
    localStorage.setItem('ume-head-visuals', JSON.stringify(heads));
  }, heads);
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => { if (m.type() === 'error' && /shader|WebGLProgram|context lost/i.test(m.text())) errors.push(m.text()); });
  page.on('request', r => { if (r.url().includes('/source-robots/')) requests.push(new URL(r.url()).pathname); });
  page.on('response', r => { if (r.status() >= 400) failed.push({ url: new URL(r.url()).pathname, status: r.status() }); });
  await page.route('**/{src/main.ts*,assets/main-*.js}', async route => {
    const response = await route.fetch();
    await route.fulfill({ response, body: exposeApp(await response.text()) });
  });
  await page.bringToFront();
  return { context, page, errors, requests, failed };
}
async function load(page, terrain = 'flat', character) {
  await page.goto(base + '/?plain&body=stock', { waitUntil: 'domcontentloaded' });
  await picturedChoice(page, 'launch-map', terrain);
  await page.locator('#launch-next').click();
  if (character) await picturedChoice(page, 'launch-character', character);
  await page.locator('#launch-load').click();
}
(async () => {
  if (output) await fs.mkdir(output, { recursive: true });
  const browser = await chromium.launch({ headless: process.env.HEADLESS !== '0',
    ...(process.env.CHROME_EXECUTABLE ? { executablePath: process.env.CHROME_EXECUTABLE } : {}),
    args: ['--no-sandbox', '--ozone-platform=x11', '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding'] });
  const report = {};
  try {
    const f = await fixture(browser), { page } = f;
    try {
      await load(page); await enter(page); await appearance(page);
      await picturedChoice(page, 'robot-colorway', 'product');
      const original = await proof(page);
      await picturedChoice(page, 'source-head-visual', 'ghost');
      await page.waitForFunction(() => window.__app.view.getSourceHead() === 'ghost', null, { timeout });
      const deliberate = await proof(page); nativeGhost(deliberate);
      assert.notEqual(deliberate.geometryHash, original.geometryHash, 'Ghost replaces actual original head vertices');
      assert.equal(deliberate.stored[deliberate.robot], 'ghost');
      await screenshot(page, 'deliberate-ghost');
      await page.reload({ waitUntil: 'domcontentloaded' });
      // Do not click the apparently preselected Original card: this is an ordinary reload.
      await launchScene(page); await ready(page);
      const reloaded = await proof(page); nativeGhost(reloaded);
      assert.equal(reloaded.geometryHash, deliberate.geometryHash, 'Ordinary reload restores the same actual native vertices');
      assert.deepEqual(reloaded.appearance, deliberate.appearance);
      assert.equal(reloaded.color, deliberate.color);
      await screenshot(page, 'reloaded-native-ghost');
      await appearance(page);
      await picturedChoice(page, 'character', 'boxy');
      let p = await proof(page); stock(p); assert.equal(p.stored[p.robot], 'stock');
      assert.equal(p.modules.find(m => m.region === 'head')?.style, 'boxy');
      assert.notEqual(p.geometryHash, original.geometryHash, 'Tinbot replaces the actual original head vertices');
      const boxyGeometry = p.geometryHash;
      await picturedChoice(page, 'source-head-visual', 'ghost');
      await page.waitForFunction(() => window.__app.view.getSourceHead() === 'ghost');
      await page.getByText('Mix robot parts', { exact: true }).click();
      await picturedChoice(page, 'module-head', 'round');
      p = await proof(page); stock(p); assert.equal(p.stored[p.robot], 'stock');
      assert.equal(p.modules.find(m => m.region === 'head')?.style, 'round');
      assert.notEqual(p.geometryHash, boxyGeometry, 'Round module replaces the actual Tinbot head vertices');
      await picturedChoice(page, 'source-head-visual', 'ghost');
      await page.waitForFunction(() => window.__app.view.getSourceHead() === 'ghost');
      const robot = p.robot;
      await picturedChoice(page, 'robot', 'g1');
      await page.waitForFunction(() => window.__app.viewModel?.robot.startsWith('g1') && window.__app.lastFrame && document.querySelector('#overlay').classList.contains('hidden'), null, { timeout });
      const other = await proof(page);
      assert.equal(other.applied, 'stock'); assert.equal(other.native, null); assert.equal(other.stored[robot], 'ghost');
      await picturedChoice(page, 'robot', 'r1');
      await page.waitForFunction(() => window.__app.viewModel?.robot.startsWith('r1') && window.__app.view.getSourceHead() === 'ghost', null, { timeout });
      nativeGhost(await proof(page));
      for (const character of ['stock', 'boxy']) {
        // Seed only the next scene's existing intent using the deliberate live gallery action.
        await appearance(page); await picturedChoice(page, 'source-head-visual', 'ghost');
        const count = f.requests.length;
        await load(page, 'flat', character); await enter(page);
        const explicit = await proof(page); stock(explicit); assert.equal(explicit.stored[explicit.robot], 'stock');
        assert.deepEqual(f.requests.slice(count), [], 'An explicit stock/Tinbot launch must not request unused Ghost assets');
      }
      assert.deepEqual(f.errors, []); assert.deepEqual(f.failed, []);
      report.reload = { robot, triangles: reloaded.triangles, native: reloaded.native, paint: reloaded.appearance,
        originalTriangles: original.triangles, perRobotIsolation: true, presets: ['stock', 'boxy'], errors: f.errors };
    } finally { await f.context.close(); }

    const recovery = await fixture(browser, { r1: 'ghost', r1_air: 'ghost', r1_air_edu: 'ghost' });
    try {
      const { page } = recovery;
      await page.route(ghostURL, route => route.fulfill({ status: 503, contentType: 'text/plain', body: 'native-head-503' }));
      await load(page);
      await page.locator('#launch-original').waitFor({ state: 'visible', timeout });
      const before = await proof(page);
      await page.evaluate(() => { window.__sceneIdentity = window.__app; window.__rendererIdentity = window.__app.view.renderer; });
      assert.equal(before.applied, 'stock'); assert.equal(before.desired, 'ghost');
      assert.equal(await page.locator('#launch-enter').isDisabled(), true);
      await screenshot(page, 'optional503-original-offer');
      await page.locator('#launch-original').click();
      await enter(page);
      const after = await proof(page); stock(after);
      assert.equal(after.stored[after.robot], 'stock');
      assert.deepEqual([after.robot, after.terrain, after.policy], [before.robot, before.terrain, before.policy]);
      assert.equal(after.modules.some(m => m.style !== 'stock'), false);
      assert.equal(await page.evaluate(() => window.__sceneIdentity === window.__app && window.__rendererIdentity === window.__app.view.renderer), true);
      await screenshot(page, 'recovered-original-entered');
      const count = recovery.requests.length;
      await page.reload({ waitUntil: 'domcontentloaded' }); await launchScene(page); await ready(page);
      stock(await proof(page)); assert.deepEqual(recovery.requests.slice(count), []);
      assert.deepEqual(recovery.errors, []);
      assert.equal(recovery.failed.some(r => r.status === 503 && r.url.endsWith('girlbot_head.glb')), true);
      report.recovery = { sameScene: true, stockPersists: true, before, after, failures: recovery.failed };
    } finally { await recovery.context.close(); }

    const linkedRecovery = await fixture(browser);
    try {
      const { page } = linkedRecovery;
      await page.addInitScript(() => {
        window.__headTestRaf = 0;
        const tick = () => { window.__headTestRaf++; requestAnimationFrame(tick); };
        requestAnimationFrame(tick);
      });
      await load(page); await enter(page); await appearance(page);
      const original = await proof(page);
      await picturedChoice(page, 'character', 'boxy');
      await picturedChoice(page, 'source-head-visual', 'ghost');
      await page.waitForFunction(() => window.__app.view.getSourceHead() === 'ghost', null, { timeout });
      // A camera fixture includes roll; flight owns it so OrbitControls cannot flatten
      // the quaternion between fixture setup and the real Share button's capture.
      await page.evaluate(() => {
        const a = window.__app;
        a.setNoclip(true); a.flight.stop(); a.heldView = true;
        a.view.camera.position.set(2.6, -3.1, 1.8);
        a.view.controls.target.set(0, 0, .7);
        a.view.camera.lookAt(a.view.controls.target);
        a.view.camera.rotateZ(.13);
        a.view.camera.fov = 63; a.view.camera.updateProjectionMatrix();
      });
      const savedViews = page.getByText('Saved views', { exact: true });
      if (!await savedViews.evaluate(e => e.parentElement.open)) await savedViews.click();
      await page.getByRole('button', { name: 'Share current view', exact: true }).click();
      const linkedURL = await page.getByLabel('Shareable view link', { exact: true }).inputValue();
      // The actual UI-encoded payload, not a pre-click camera sample, is authoritative.
      const linked = JSON.parse(Buffer.from(new URL(linkedURL).hash.slice(6), 'base64url').toString());
      assert.equal(linked.sourceHead, 'ghost');
      assert.equal(linked.appearance.modules.head, 'boxy');
      await page.route(ghostURL, route => route.fulfill({ status: 503, contentType: 'text/plain', body: 'linked-native-head-503' }));
      // A distinct query forces a receiver document without a storage-denied blank origin.
      const receiverURL = new URL(linkedURL);
      receiverURL.searchParams.set('head-test-receiver', '1');
      await page.goto(receiverURL.href, { waitUntil: 'domcontentloaded' });
      await page.locator('#launch-next').click(); await page.locator('#launch-load').click();
      await page.locator('#launch-original').waitFor({ state: 'visible', timeout });
      await page.evaluate(() => {
        window.__sceneIdentity = window.__app;
        window.__rendererIdentity = window.__app.view.renderer;
        document.querySelector('#launch-original').addEventListener('pointerup', e => {
          window.__originalTrusted = e.isTrusted;
        }, { once: true });
      });
      assert.equal(await page.locator('#launch-enter').isDisabled(), true);
      await screenshot(page, 'linked503-original-offer');
      await page.locator('#launch-original').click();
      await enter(page);
      await page.waitForFunction(() => !window.__app.pendingViewRestore, null, { timeout });
      const after = await proof(page); stock(after);
      assert.equal(after.geometryHash, original.geometryHash, 'Linked Original recovery restores actual stock head vertices');
      assert.equal(after.modules.some(m => m.style !== 'stock'), false);
      assert.equal(after.stored[after.robot], 'stock');
      const restored = await page.evaluate(() => ({
        view: window.__app.captureView(), hash: location.hash, raf: window.__headTestRaf,
        sameScene: window.__sceneIdentity === window.__app && window.__rendererIdentity === window.__app.view.renderer,
        trusted: window.__originalTrusted,
      }));
      assert.equal(restored.sameScene, true); assert.equal(restored.trusted, true);
      const updated = JSON.parse(Buffer.from(restored.hash.slice(6), 'base64url').toString());
      assert.equal(updated.sourceHead, 'stock'); assert.equal(updated.appearance.sourceBody, 'stock');
      assert.equal(Object.values(updated.appearance.modules).every(style => style === 'stock'), true);
      for (const key of ['robot', 'terrain', 'look', 'display', 'flashlight', 'flight', 'noclip', 'fov']) {
        assert.deepEqual(updated[key], linked[key], `Recovered URL retains ${key}`);
        assert.deepEqual(restored.view[key], linked[key], `Recovered scene retains ${key}`);
      }
      for (const key of ['position', 'target', 'orientation']) for (let i = 0; i < linked[key].length; i++) {
        assert.ok(Math.abs(updated[key][i] - linked[key][i]) < 1e-6, `Recovered URL retains ${key}[${i}]`);
        assert.ok(Math.abs(restored.view[key][i] - linked[key][i]) < 1e-6, `Recovered scene retains ${key}[${i}]`);
      }
      await page.waitForFunction(raf => window.__headTestRaf > raf + 2, restored.raf, { timeout });
      await screenshot(page, 'linked-original-entered');
      const count = linkedRecovery.requests.length;
      await page.evaluate(() => history.replaceState(null, '', location.pathname + '?plain&body=stock'));
      await page.reload({ waitUntil: 'domcontentloaded' }); await launchScene(page); await ready(page);
      const reloaded = await proof(page); stock(reloaded);
      assert.equal(reloaded.geometryHash, original.geometryHash); assert.equal(reloaded.stored[reloaded.robot], 'stock');
      assert.deepEqual(linkedRecovery.requests.slice(count), []);
      assert.deepEqual(linkedRecovery.errors, []);
      assert.equal(linkedRecovery.failed.some(r => r.status === 503 && r.url.endsWith('girlbot_head.glb')), true);
      report.linkedRecovery = { sameScene: true, trustedOriginal: true, stockPersists: true, linked, updated, after,
        failures: linkedRecovery.failed };
    } finally { await linkedRecovery.context.close(); }

    const fatal = await fixture(browser, { r1: 'ghost', r1_air: 'ghost', r1_air_edu: 'ghost' });
    try {
      await fatal.page.route(/\/assets\/models\/.*\.xml(?:\?|$)/, route => route.fulfill({ status: 503, contentType: 'text/plain', body: 'fatal-model-503' }));
      await load(fatal.page);
      await fatal.page.locator('#launch-status[data-kind="error"]').waitFor({ state: 'visible', timeout });
      await fatal.page.waitForLoadState('networkidle');
      assert.equal(await fatal.page.locator('#launch-original').isVisible(), false);
      assert.equal(await fatal.page.locator('#launch-enter').isDisabled(), true);
      assert.equal(await fatal.page.locator('#app').evaluate(a => a.inert), true);
      assert.equal(fatal.failed.some(r => r.status === 503 && r.url.endsWith('.xml')), true);
      await screenshot(fatal.page, 'fatal-xml-no-original');
      report.fatalXML = { failures: fatal.failed, entryBlocked: true, originalHidden: true };
    } finally { await fatal.context.close(); }

    const late = await fixture(browser, { r1: 'ghost', r1_air: 'ghost', r1_air_edu: 'ghost' });
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    try {
      const { page } = late;
      let mapRequested = false;
      await page.route(ghostURL, route => route.fulfill({ status: 503, contentType: 'text/plain', body: 'native-head-503' }));
      await page.route('**/assets/maps/nt_dawn_ctg/visual.glb', async route => {
        mapRequested = true; await gate;
        await route.fulfill({ status: 503, contentType: 'text/plain', body: 'fatal-map-503' });
      });
      await load(page, 'map:nt_dawn_ctg');
      await page.locator('#launch-original').waitFor({ state: 'visible', timeout });
      assert.equal(mapRequested, true);
      await page.locator('#launch-original').click();
      assert.equal(await page.locator('#launch-enter').isDisabled(), true);
      release();
      await page.locator('#launch-status[data-kind="error"]').waitFor({ state: 'visible', timeout });
      await page.waitForLoadState('networkidle');
      assert.equal(await page.locator('#launch-enter').isDisabled(), true);
      assert.equal(await page.locator('#launch-original').isVisible(), false);
      assert.equal(await page.locator('#launch-screen').isVisible(), true);
      assert.equal(await page.locator('#app').evaluate(a => a.inert), true);
      assert.equal(late.failed.some(r => r.url.endsWith('/nt_dawn_ctg/visual.glb') && r.status === 503), true);
      await screenshot(page, 'late-fatal-map-keeps-entry-blocked');
      report.lateFatal = { failures: late.failed, recoveryCannotUnlock: true };
    } finally { release(); await late.context.close(); }
    if (output) await fs.writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report));
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
