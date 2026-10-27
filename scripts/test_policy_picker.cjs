/** Chromium: policy gallery retains canonical checkpoints, search and input isolation. */
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');

(async () => {
  const browser = await chromium.launch({
    headless: process.env.HEADLESS === '1',
    args: ['--no-sandbox', '--ozone-platform=x11'],
  });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: .5 });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/{src/main.ts*,assets/main-*.js}', async route => {
      const response = await route.fetch();
      await route.fulfill({ response, body: require('./expose-app.cjs')(await response.text()) });
    });
    await page.goto((process.env.BASE_URL || 'http://127.0.0.1:5176') + '/?plain&body=stock');
    await require('./launch-scene.cjs').launchScene(page, { terrain: 'flat', controls: true });
    await page.waitForFunction(() => window.__app?.lastFrame &&
      document.getElementById('overlay').classList.contains('hidden'), null, { timeout: 120000 });

    const policy = page.locator('#policy-trigger');
    const gallery = page.locator('dialog[data-visual-picker="policy"]');
    const search = gallery.getByRole('searchbox', { name: 'Search Policy', exact: true });
    const cards = gallery.locator('button[data-value]:visible');
    const select = page.locator('#sel-policy');
    const map = page.locator('#terrain-trigger');
    const mapGallery = page.locator('dialog[data-visual-picker="terrain"]');
    const count = await select.locator('option').count();
    const original = await select.inputValue();
    const refresh = () => page.evaluate(() => {
      const app = window.__app;
      app.panel.setPolicies(app.status.policies, app.status.policy, app.status.robot);
    });
    const frames = () => page.evaluate(() => new Promise(resolve => {
      const start = window.__app.view.renderer.info.render.frame;
      let ticks = 0;
      function tick() {
        if (++ticks < 8) return requestAnimationFrame(tick);
        resolve({ ticks, rendered: window.__app.view.renderer.info.render.frame - start });
      }
      requestAnimationFrame(tick);
    }));

    const metadata = await page.evaluate(() => window.__app.status.policies.map(entry => ({
      name: entry.name, robot: entry.previewRobot,
      optionRobot: Array.from(document.querySelector('#sel-policy').options)
        .find(option => option.value === entry.name)?.dataset.previewRobot,
    })));
    assert.ok(metadata.length);
    for (const entry of metadata) {
      assert.ok(entry.robot, `Missing exact worker preview identity for ${entry.name}`);
      assert.equal(entry.optionRobot, entry.robot);
    }

    await policy.click();
    await search.fill('dance');
    const query = await search.inputValue();
    const matches = await cards.count();
    assert.ok(matches > 0);
    await cards.first().focus();
    const focused = await cards.first().getAttribute('data-value');
    await refresh();
    assert.equal(await search.inputValue(), query);
    assert.equal(await gallery.isVisible(), true);
    assert.equal(await cards.count(), matches);
    assert.equal(await page.evaluate(() => document.activeElement.dataset.value), focused);
    await page.keyboard.press('ArrowDown');
    assert.equal(await gallery.evaluate(dialog => dialog.contains(document.activeElement)), true);
    await page.keyboard.press('Escape');
    assert.equal(await select.inputValue(), original);
    assert.equal(await policy.evaluate(button => document.activeElement === button), true);

    await policy.click();
    await search.fill('zz_no_such_policy');
    assert.equal(await cards.count(), 0);
    assert.equal(await gallery.getByRole('status').textContent(), 'No matching options.');
    await page.keyboard.press('Enter');
    assert.equal(await select.inputValue(), original);
    await page.keyboard.press('Numpad2');
    await page.keyboard.down('w');
    const advancing = await frames();
    await page.keyboard.up('w');
    assert.ok(advancing.rendered > 0, 'Input isolation requires an advancing scene, not a frozen tab');
    assert.equal(await page.evaluate(() => window.__app.noclip), false);
    assert.deepEqual(await page.evaluate(() => window.__app.command), [0, 0, 0]);
    await page.keyboard.press('Escape');
    await frames();
    assert.deepEqual(await page.evaluate(() => window.__app.command), [0, 0, 0]);

    await policy.click();
    const stateId = await select.locator('option').evaluateAll(options =>
      options.map(option => option.title.match(/Robot state: (\d+)/)?.[1]).find(Boolean));
    let stateMatches = 0;
    if (stateId) {
      await search.fill(stateId);
      stateMatches = await cards.count();
      assert.ok(stateMatches > 0);
    }
    await search.fill('amp_locomotion/amp_locomotion');
    assert.equal(await cards.count(), 1);
    await page.keyboard.press('Enter');
    assert.equal(await select.inputValue(), original, 'Search Enter must not silently select a card');
    await page.keyboard.press('Escape');

    // Load a different real checkpoint through a card, retaining its canonical identifier.
    const next = await select.evaluate(select => Array.from(select.options).find(option =>
      option.value !== select.value && option.textContent.startsWith('Walk and run'))?.value);
    assert.ok(next);
    await policy.click();
    await search.fill(next);
    assert.equal(await cards.count(), 1);
    await cards.first().focus();
    await page.keyboard.press('Enter');
    await page.waitForFunction(name => window.__app.status.policy === name, next, { timeout: 120000 });
    assert.equal(await select.inputValue(), next);
    assert.ok((await policy.textContent()).includes(next));
    assert.ok((await page.locator('#policy-description').textContent()).includes(next));

    await policy.click();
    await search.fill('walking running');
    const byCategory = await cards.count();
    assert.ok(byCategory > 0, 'Every search token must match category metadata');
    await page.keyboard.press('Escape');
    await map.click();
    assert.equal(await gallery.count(), 0);
    await mapGallery.getByRole('searchbox').fill('ghost');
    assert.equal(await mapGallery.locator('button[data-value]:visible').count(), 1);
    await page.keyboard.press('Escape');
    assert.equal(await mapGallery.count(), 0);
    assert.equal(await map.evaluate(button => document.activeElement === button), true);

    await policy.click();
    await search.fill('walk');
    if (!process.env.SKIP_SCREENSHOTS) await page.screenshot({ path: '/tmp/policy-picker-desktop.png' });
    const mobile = [];
    for (const width of [390, 320]) {
      await page.setViewportSize({ width, height: 844 });
      assert.equal(await search.inputValue(), width === 390 ? 'walk' : '');
      await search.fill('');
      assert.equal(await cards.count(), count);
      const bounds = await gallery.boundingBox();
      assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= width);
      assert.ok(bounds.y >= 0 && bounds.y + bounds.height <= 844);
      for (const box of await cards.evaluateAll(buttons => buttons.map(button => {
        const box = button.getBoundingClientRect();
        return { x: box.x, width: box.width, height: box.height };
      }))) {
        assert.ok(box.x >= 0 && box.x + box.width <= width && box.height > 0);
      }
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      await page.waitForFunction(() => {
        const first = document.querySelector('dialog[data-visual-picker="policy"] button[data-value]:not([hidden]) .visual-picker-preview');
        return first && first.textContent !== 'Preview loading…';
      });
      await gallery.locator('img').evaluateAll(images => Promise.all(images.filter(image => {
        const box = image.getBoundingClientRect();
        return box.bottom > 0 && box.top < innerHeight && box.width > 0 && box.height > 0;
      }).map(image => image.decode())));
      if (!process.env.SKIP_SCREENSHOTS) await page.screenshot({ path: `/tmp/policy-picker-${width}.png` });
      mobile.push({ width, bounds });
    }
    await page.keyboard.press('Tab');
    assert.equal(await gallery.isVisible(), true);
    assert.equal(await gallery.evaluate(dialog => dialog.contains(document.activeElement)), true);
    await page.keyboard.press('Escape');

    // A worker metadata refresh must not unlock the select during review.
    await select.evaluate(select => { select.disabled = true; });
    await refresh();
    assert.equal(await policy.isDisabled(), true);
    await select.evaluate(select => { select.disabled = false; });
    await page.evaluate(() => window.__app.panel.setPolicies([], ''));
    assert.equal(await policy.isDisabled(), true);
    assert.equal(await gallery.count(), 0);

    // Imported labels remain literal text; legitimate preview images are allowed.
    const name = 'custom/' + 'long_checkpoint_'.repeat(12) + '<img src=x onerror=alert(1)>';
    await page.evaluate(name => window.__app.panel.setPolicies([{
      name, family: 'r1_fw', dof: 24, group: 'custom', packId: 'custom',
      previewRobot: 'r1', models: ['air', 'edu'], fsmId: 802,
    }], name, 'r1'), name);
    assert.equal(await policy.isDisabled(), false);
    await policy.click();
    await search.fill('802');
    assert.equal(await cards.count(), 1);
    await search.fill('onerror');
    assert.equal(await cards.count(), 1);
    assert.ok((await cards.first().textContent()).includes(name));
    assert.equal(await gallery.locator('[onerror], img[src="x"]').count(), 0);
    const longBounds = await cards.first().boundingBox();
    assert.ok(longBounds.x >= 0 && longBounds.x + longBounds.width <= 320);
    await page.keyboard.press('Escape');
    await refresh();
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({
      count, canonicalIds: true, exactPreviewMetadata: metadata, fullNameSearch: true, stateMatches,
      categories: byCategory, backgroundUpdates: true, emptyState: true, keyboard: true,
      selectionLoaded: next, cameraProtected: true, advancing, mobile, longNames: true,
      reviewLockPreserved: true, errors,
    }));
  } finally {
    await browser.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
