/** Chromium integration: live export setup, genuine recording, encoder freeze/cancel and PNG output.
 * Run against the integrated app; no synthetic take, frames, camera track or joints. */
'use strict';
const assert = require('node:assert/strict');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const { chooseVisual } = require('./choose-visual.cjs');

(async () => {
  const browser = await chromium.launch({ headless: false, args: ['--no-sandbox', '--ozone-platform=x11'] });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => {
      if (message.type() === 'error' && /WebGLProgram|shader/.test(message.text())) errors.push(message.text());
    });
    for (const pattern of ['**/src/main.ts*', '**/assets/main-*.js']) {
      await page.route(pattern, async route => {
        const response = await route.fetch();
        await route.fulfill({ response, body: require('./expose-app.cjs')(await response.text()) });
      });
    }
    await page.goto((process.env.BASE_URL || 'http://127.0.0.1:5176') + '/?plain&body=stock');
    await require('./launch-scene.cjs').launchScene(page, { terrain: 'flat' });
    await page.waitForFunction(() => window.__app?.lastFrame && document.getElementById('overlay').classList.contains('hidden'), null, { timeout: 120000 });
    const setupBaseline = await page.evaluate(() => {
      const app = window.__app;
      app.setNoclip(true);
      const camera = app.view.camera;
      const before = { position: camera.position.toArray(), target: app.view.controls.target.toArray(),
        orientation: camera.quaternion.toArray(), up: camera.up.toArray(), fov: camera.fov,
        noclip: app.noclip, speed: app.flight.speed, hover: app.flight.hover };
      app.openExport('video');
      return before;
    });
    const root = page.locator('#export');
    assert.equal(await root.getByRole('button', { name: 'Render video', exact: true }).isDisabled(), true);
    assert.deepEqual(await page.evaluate(() => {
      const host = window.__app.dialog.host;
      return [host.take(), host.path(), host.range()];
    }), [null, null, null]);
    const sceneControl = page.locator('#workspace-panels button[aria-controls="scene-window"]');
    assert.equal(await sceneControl.isVisible(), true);
    assert.equal(await sceneControl.isEnabled(), true, 'Opening camera/output setup does not lock Scene controls');
    await sceneControl.click();
    assert.equal(await page.locator('#scene-window').evaluate(element => element.inert), false);
    assert.equal(await page.locator('#scene-actions').evaluate(element => element.inert), false);
    assert.equal(await sceneControl.evaluate((button, exportId) =>
      button.getBoundingClientRect().top < document.getElementById(exportId).getBoundingClientRect().top, 'export'), true,
    'Scene controls stay accessible above camera/output setup');
    const row = label => root.locator('.xf').filter({ has: page.locator('label', { hasText: new RegExp('^' + label + '$') }) });

    // All setup is available without recording, including framing, lens, output and data settings.
    await root.getByRole('button', { name: 'Orbit', exact: true }).click();
    await root.getByRole('button', { name: 'Side', exact: true }).click();
    await root.getByRole('button', { name: 'Use current view', exact: true }).click();
    await row('Distance').locator('input[type=number]').fill('3.75');
    await row('Distance').locator('input[type=number]').press('Tab');
    await row('Focal length').locator('input').fill('50');
    await row('Focal length').locator('input').press('Tab');
    await chooseVisual(page, 'export-sensor', 24.89);
    await chooseVisual(page, 'export-resolution', 'custom');
    await root.locator('.x-dims input').nth(0).fill('128');
    await root.locator('.x-dims input').nth(0).press('Tab');
    await root.locator('.x-dims input').nth(1).fill('96');
    await root.locator('.x-dims input').nth(1).press('Tab');
    await row('Frame rate').locator('select').selectOption('24');
    await row('Speed').locator('select').selectOption('0.5');
    await row('Container').locator('select').selectOption('mov');
    assert.equal(await row('Codec').locator('select').locator('option').count(), 2);
    await row('Container').locator('select').selectOption('webm');
    assert.equal(await row('Codec').locator('select').locator('option').count(), 3);
    await row('Container').locator('select').selectOption('png');
    await row('Quality').locator('select').selectOption('very-high');
    await row('Background').locator('select').selectOption('alpha');
    await root.getByLabel('Ground plane', { exact: false }).uncheck();
    const liveShot = await page.evaluate(() => ({ ...window.__app.shot }));
    assert.equal(liveShot.mode, 'orbit'); assert.equal(liveShot.distance, 3.75); assert.equal(liveShot.focal, 50); assert.equal(liveShot.sensor, 24.89);
    await root.getByRole('button', { name: 'Blender & data', exact: true }).click();
    for (const name of ['Export .glb', 'Export .csv', 'Save take']) assert.equal(await root.getByRole('button', { name, exact: true }).isDisabled(), true);
    await row('Key rate').locator('select').selectOption('25');
    await row('Rate').locator('select').selectOption('50');
    await root.getByLabel('Shot camera', { exact: false }).uncheck();
    const configured = await page.evaluate(() => JSON.parse(localStorage.getItem('ume-export')));
    assert.deepEqual(configured.shot, liveShot);
    assert.equal(configured.out.glbFps, 25); assert.equal(configured.out.csvFps, 50); assert.equal(configured.out.glbCamera, false);
    assert.equal(configured.out.transparent, true); assert.equal(configured.out.floor, false);
    await page.locator('#viewport canvas').focus();
    await page.keyboard.press('Escape');
    assert.equal(await root.isHidden(), true, 'Escape closes LIVE static setup even when the scene retains keyboard focus');
    const escapedCamera = await page.evaluate(() => {
      const app = window.__app, camera = app.view.camera;
      return { position: camera.position.toArray(), target: app.view.controls.target.toArray(),
        orientation: camera.quaternion.toArray(), up: camera.up.toArray(), fov: camera.fov,
        noclip: app.noclip, speed: app.flight.speed, hover: app.flight.hover };
    });
    assert.deepEqual(escapedCamera, setupBaseline, 'Escape restores the exact live camera, not the static shot preview');
    const setupRestored = await page.evaluate(() => {
      const app = window.__app;
      app.openExport('video');
      app.startRecording();
      const preparing = app.recordStarting;
      app.openExport('video');
      const camera = app.view.camera;
      return { restored: { position: camera.position.toArray(), target: app.view.controls.target.toArray(),
        orientation: camera.quaternion.toArray(), up: camera.up.toArray(), fov: camera.fov,
        noclip: app.noclip, speed: app.flight.speed, hover: app.flight.hover },
        preparing, setupOpen: app.dialog.isOpen, shot: { ...app.shot } };
    });
    assert.equal(setupRestored.preparing, true, 'The consumer regression exercises pending real visual preparation');
    assert.equal(setupRestored.setupOpen, false, 'Recording closes static setup and cannot reopen it during preparation');
    assert.deepEqual(setupRestored.restored, setupBaseline, 'Recording starts from the restored presented live camera');
    assert.deepEqual(setupRestored.shot, liveShot, 'Beginning recording preserves pre-record output shot settings');
    await page.waitForFunction(() => window.__app.rec?.frames >= 10, null, { timeout: 120000 });
    await page.evaluate(() => window.__app.openExport('video'));
    assert.equal(await root.isHidden(), true, 'Active recording cannot replace the recorded viewport with an unrecorded shot camera');
    const reviewBaseline = await page.evaluate(() => {
      const app = window.__app, camera = app.view.camera;
      const before = { position: camera.position.toArray(), target: app.view.controls.target.toArray(),
        orientation: camera.quaternion.toArray(), up: camera.up.toArray(), fov: camera.fov,
        noclip: app.noclip, speed: app.flight.speed, hover: app.flight.hover };
      app.stopRecording();
      return before;
    });
    await page.waitForFunction(() => window.__app.timeline.isOpen && window.__app.take?.n >= 10);
    assert.equal(await page.evaluate(() => window.__app.noclip), reviewBaseline.noclip, 'Opening review never rewrites noclip physics');
    const recordedCamera = await page.evaluate(() => window.__app.take.camAt(0));
    for (const [key, expected] of [['pos', setupBaseline.position], ['target', setupBaseline.target], ['orientation', setupBaseline.orientation]]) {
      recordedCamera[key].forEach((value, index) => assert.ok(Math.abs(value - expected[index]) < 1e-4,
        `Recorded ${key}[${index}] must match the presented live camera after setup closes`));
    }
    assert.equal(recordedCamera.fov, setupBaseline.fov);
    await page.evaluate(() => window.__app.openExport('data'));
    for (const name of ['Export .glb', 'Export .csv', 'Save take']) assert.equal(await root.getByRole('button', { name, exact: true }).isEnabled(), true);
    await root.getByRole('button', { name: 'Video', exact: true }).click();
    await row('Distance').locator('input[type=number]').fill('6.5');
    await row('Distance').locator('input[type=number]').press('Tab');
    assert.deepEqual(await page.evaluate(() => JSON.parse(localStorage.getItem('ume-export')).shot), liveShot, 'review camera edits must not replace live preferences');
    assert.equal(await root.getByRole('button', { name: 'Render video', exact: true }).isEnabled(), true);

    // Hold only genuine stage preparation; the actual render still reads the real recorded take.
    await page.evaluate(() => {
      const d = window.__app.dialog, originalStage = d.host.stage, originalSave = d.host.save;
      window.__restoreExportHost = () => { d.host.stage = originalStage; d.host.save = originalSave; };
      let release;
      const gate = new Promise(resolve => { release = resolve; });
      window.__releaseExport = release;
      d.host.stage = () => {
        const stage = originalStage();
        return { ...stage, prepare: async () => { window.__stageWaiting = true; await gate; await stage.prepare?.(); } };
      };
      d.host.save = blob => { window.__exportBlob = blob; };
      window.__exportRun = d.renderVideoJob();
    });
    await page.waitForFunction(() => window.__stageWaiting);
    assert.equal(await root.locator('input:enabled, select:enabled').count(), 0, 'keyboard-editable fields freeze too');
    assert.equal(await root.locator('button:enabled').count(), 1);
    assert.equal(await root.getByRole('button', { name: 'Cancel', exact: true }).isEnabled(), true);
    assert.equal(await page.locator('#scene-actions').evaluate(element => element.inert), true,
      'Relocated robot/map/record/capture controls freeze during encoding');
    const frozen = await page.evaluate(() => ({ shot: { ...window.__app.shot }, out: { ...window.__app.dialog.out } }));
    await page.locator('#viewport canvas').focus();
    await page.keyboard.press('Escape');
    assert.equal(await root.isVisible(), true, 'encoding cannot close the dialog');
    assert.deepEqual(await page.evaluate(() => ({ shot: { ...window.__app.shot }, out: { ...window.__app.dialog.out } })), frozen);
    await root.getByRole('button', { name: 'Cancel', exact: true }).click();
    await page.evaluate(async () => { window.__releaseExport(); await window.__exportRun; });
    assert.equal(await root.getByRole('button', { name: 'Video', exact: true }).isEnabled(), true);
    assert.equal(await page.locator('#scene-actions').evaluate(element => element.inert), false,
      'Relocated scene controls unlock after cancellation');
    const rendered = await page.evaluate(async () => {
      const d = window.__app.dialog;
      window.__restoreExportHost();
      const save = d.host.save;
      let output;
      d.host.save = blob => { output = blob; };
      try {
        await d.renderVideoJob();
        return { bytes: output?.size, header: output ? Array.from(new Uint8Array(await output.arrayBuffer()).subarray(0, 4)) : null,
          failed: d.status.classList.contains('err'), exporting: window.__app.exporting };
      } finally { d.host.save = save; }
    });
    assert.ok(rendered.bytes > 100, JSON.stringify(rendered));
    assert.deepEqual(rendered.header, [80, 75, 3, 4]); assert.equal(rendered.failed, false); assert.equal(rendered.exporting, false);
    const reviewRestored = await page.evaluate(() => {
      const app = window.__app;
      app.dialog.close();app.closeReview();
      const camera = app.view.camera;
      const restored = { position: camera.position.toArray(), target: app.view.controls.target.toArray(),
        orientation: camera.quaternion.toArray(), up: camera.up.toArray(), fov: camera.fov,
        noclip: app.noclip, speed: app.flight.speed, hover: app.flight.hover };
      app.openExport('video');
      return restored;
    });
    assert.deepEqual(reviewRestored, reviewBaseline, 'Leaving review restores the exact live camera and flight/physics settings');
    assert.equal(await root.getByRole('button', { name: 'Render video', exact: true }).isDisabled(), true);
    assert.deepEqual(await page.evaluate(() => ({ ...window.__app.shot })), liveShot, 'leaving review restores the live shot');
    assert.deepEqual(await page.evaluate(() => {
      const host = window.__app.dialog.host; return [host.take(), host.path(), host.range()];
    }), [null, null, null], 'an old recording does not make live setup exportable');
    await page.locator('#viewport canvas').focus();
    await page.keyboard.press('v');
    assert.equal(await root.isHidden(), true, 'The V shortcut closes LIVE static preview before recording its actual viewport');
    await page.waitForFunction(() => window.__app.rec?.frames >= 10, null, { timeout: 120000 });
    assert.deepEqual(await page.evaluate(() => ({ ...window.__app.shot })), liveShot, 'V preserves the pre-record export recipe');
    await page.keyboard.press('v');
    await page.waitForFunction(() => window.__app.timeline.isOpen && !window.__app.rec);
    const shortcutCamera = await page.evaluate(() => window.__app.take.camAt(0));
    assert.equal(shortcutCamera.fov, reviewBaseline.fov, 'V records the restored live FOV, not the output preview lens');
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ liveSetup: true, realTake: true, reviewIsolation: true, cancellation: true, rendered, errors }));
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
