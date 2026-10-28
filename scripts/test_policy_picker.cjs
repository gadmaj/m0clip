/** Chromium: policy gallery retains canonical checkpoints, compact accessible identity, search and input isolation. */
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');
const attachReadyApp = require('./attach-ready-app.cjs');

(async () => {
  const browser = await chromium.launch({
    headless: process.env.HEADLESS === '1',
    executablePath: process.env.CHROMIUM_PATH,
    args: ['--no-sandbox', '--ozone-platform=x11'],
  });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: .5 });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto((process.env.BASE_URL || 'http://127.0.0.1:5176') + '/?plain&body=stock');
    await require('./launch-scene.cjs').launchScene(page, { terrain: 'flat', controls: true });
    await attachReadyApp(page.context(), page);
    await page.waitForFunction(() => window.__app?.lastFrame &&
      document.getElementById('overlay').classList.contains('hidden'), null, { timeout: 120000 });

    const policy = page.locator('#policy-trigger');
    const gallery = page.locator('dialog[data-visual-picker="policy"]');
    const search = gallery.getByRole('searchbox', { name: 'Search Policy', exact: true });
    const cards = gallery.locator('button[data-value]:visible');
    const select = page.locator('#sel-policy');
    const map = page.locator('#terrain-trigger');
    const mapGallery = page.locator('dialog[data-visual-picker="terrain"]');
    const original = await select.inputValue();
    const refresh = () => page.evaluate(() => {
      const app = window.__app;
      app.panel.setPolicies(app.status.policies, app.status.policy, app.status.robot);
    });
    const frames = () => page.evaluate(() => new Promise(resolve => {
      let ticks = 0;
      function tick() {
        if (++ticks < 8) return requestAnimationFrame(tick);
        resolve();
      }
      requestAnimationFrame(tick);
    }));
    const detail = gallery.locator('[data-visual-picker-detail]');
    const description = page.locator('#policy-description');
    const card = value => `dialog[data-visual-picker="policy"] button[data-value=${JSON.stringify(value)}]`;
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Accessibility.enable');
    // Chromium's computed accessible name/description of the actual control, not its DOM text.
    const ax = async selector => {
      const { root } = await cdp.send('DOM.getDocument', { depth: 0 });
      const { nodeId } = await cdp.send('DOM.querySelector', { nodeId: root.nodeId, selector });
      assert.ok(nodeId, `No element for ${selector}`);
      const { nodes } = await cdp.send('Accessibility.getPartialAXTree', { nodeId, fetchRelatives: false });
      return { name: nodes[0]?.name?.value ?? '', description: nodes[0]?.description?.value ?? '' };
    };
    const entry = name => page.evaluate(name => window.__app.status.policies.find(item => item.name === name), name);
    const previewSource = value => page.waitForFunction(selector =>
      document.querySelector(selector)?.getAttribute('src') || null, `${card(value)} .visual-picker-preview img`)
      .then(handle => handle.jsonValue());


    await policy.click();
    await search.fill('dance');
    const query = await search.inputValue();
    await cards.first().focus();
    const focused = await cards.first().getAttribute('data-value');
    await refresh();
    assert.equal(await search.inputValue(), query);
    assert.equal(await gallery.isVisible(), true);
    assert.equal(await page.evaluate(() => document.activeElement.dataset.value), focused);
    await page.keyboard.press('ArrowDown');
    assert.equal(await gallery.evaluate(dialog => dialog.contains(document.activeElement)), true);
    await page.keyboard.press('Escape');
    assert.equal(await select.inputValue(), original);
    assert.equal(await policy.evaluate(button => document.activeElement === button), true);

    await policy.click();
    await search.fill('zz_no_such_policy');
    assert.equal(await cards.count(), 0);
    await page.keyboard.press('Enter');
    assert.equal(await select.inputValue(), original);
    await page.keyboard.press('Numpad2');
    await page.keyboard.down('w');
    await frames();
    await page.keyboard.up('w');
    assert.equal(await page.evaluate(() => window.__app.noclip), false);
    assert.deepEqual(await page.evaluate(() => window.__app.command), [0, 0, 0]);
    await page.keyboard.press('Escape');
    await frames();
    assert.deepEqual(await page.evaluate(() => window.__app.command), [0, 0, 0]);

    await policy.click();
    await search.fill('811');
    assert.equal(await gallery.locator('button[data-value="amp_locomotion/amp_locomotion"]').isVisible(), true);
    await search.fill('amp_locomotion/amp_locomotion');
    assert.equal(await cards.count(), 1);
    await page.keyboard.press('Enter');
    assert.equal(await select.inputValue(), original, 'Search Enter must not silently select a card');
    await page.keyboard.press('Escape');

    // Load a different real checkpoint through a card, retaining its canonical identifier.
    const next = await page.evaluate(() => window.__app.status.policies.find(entry =>
      entry.family === 'r1_fw' && entry.group === 'amp_locomotion' && entry.name !== window.__app.status.policy)?.name);
    if (!next) throw new Error('This fixture requires another installed R1 locomotion checkpoint');
    await policy.click();
    await search.fill(next);
    assert.equal(await cards.count(), 1);
    await cards.first().focus();
    await page.keyboard.press('Enter');
    await page.waitForFunction(name => window.__app.status.policy === name, next, { timeout: 120000 });
    assert.equal(await select.inputValue(), next);
    const selectedTrigger = await ax('#policy-trigger');
    assert.ok(selectedTrigger.name.includes(next), 'Compact trigger exposes the exact selected checkpoint');
    assert.ok(!(await description.textContent()).includes(next), 'Pose/status text carries no technical identity');

    // Same-title 601 checkpoints stay separate exact choices with their own focused identity.
    const base = 'dances/601_dance1_subject2_segment1', alternate = `${base}-0602_20k`;
    const air = 'dances_air/601_dance1_subject2_segment1';
    const variants = { [base]: await entry(base), [alternate]: await entry(alternate), [air]: await entry(air) };
    for (const [name, info] of Object.entries(variants)) assert.ok(info, `This fixture requires installed ${name}`);
    await policy.click();
    await search.fill('601_dance1_subject2_segment1');
    assert.deepEqual((await cards.evaluateAll(buttons => buttons.map(button => button.dataset.value))).sort(),
      [base, alternate, air].sort());
    const visibleText = await cards.evaluateAll(buttons => buttons.map(button => button.innerText));
    assert.equal(new Set(visibleText).size, 3, 'Compact card text keeps the real variant difference visible');
    const names = new Set();
    for (const [name, info] of Object.entries(variants)) {
      const node = await ax(card(name));
      assert.ok(node.name.includes(name), `Card accessible name holds ${name}`);
      names.add(node.name);
      for (const fact of [String(info.fsmId), info.previewRobot]) assert.ok(node.description.includes(fact));
      assert.equal(node.description.includes('Air'), info.models.includes('air'), `${name} compatibility`);
      await page.locator(card(name)).focus();
      const focusedDetail = await detail.textContent();
      assert.ok(focusedDetail.includes(name) && focusedDetail.includes(info.previewRobot), `Focused detail for ${name}`);
      for (const other of Object.keys(variants)) if (!name.includes(other) && other !== name)
        assert.ok(!focusedDetail.includes(other), `No stale ${other} detail`);
    }
    assert.equal(names.size, 3);
    // Only exact robot/checkpoint media: the 0602_20k checkpoint must not borrow the baseline motion.
    const baseSource = await previewSource(base), alternateSource = await previewSource(alternate);
    assert.notEqual(alternateSource, baseSource);
    assert.ok(!alternateSource.startsWith(baseSource.slice(0, baseSource.lastIndexOf('/') + 1)));
    await page.locator(card(alternate)).focus();
    await page.keyboard.press('Enter');
    await page.waitForFunction(name => window.__app.status.policy === name, alternate, { timeout: 120000 });
    assert.equal(await select.inputValue(), alternate);
    const alternateTrigger = await ax('#policy-trigger');
    assert.ok(alternateTrigger.name.includes(alternate));
    assert.ok(alternateTrigger.description.includes(variants[alternate].previewRobot));

    // Completion presentation persists until an explicit new choice.
    await page.evaluate(name => window.__app.panel.showPolicyFinished(name, name), alternate);
    const finished = await description.textContent();
    assert.ok(finished && !finished.includes(alternate));
    await policy.click();
    assert.ok((await detail.textContent()).includes(alternate), 'Selected identity shown before any card focus');
    await page.keyboard.press('Escape');
    await refresh();
    assert.equal(await description.textContent(), finished);
    assert.ok((await ax('#policy-trigger')).name.includes(alternate));

    await policy.click();
    await search.fill(base);
    await page.locator(card(base)).focus();
    await page.keyboard.press(' ');
    await page.waitForFunction(name => window.__app.status.policy === name, base, { timeout: 120000 });
    assert.equal(await select.inputValue(), base);
    assert.notEqual(await description.textContent(), finished);

    // Refresh keeps the focused card's detail; a removed or filtered card leaves no stale detail.
    await policy.click();
    await search.fill('601_dance1_subject2_segment1');
    await page.locator(card(alternate)).focus();
    await refresh();
    assert.equal(await page.evaluate(() => document.activeElement.dataset.value), alternate);
    assert.ok((await detail.textContent()).includes(alternate));
    await page.evaluate(name => {
      const app = window.__app;
      app.panel.setPolicies(app.status.policies.filter(item => item.name !== name), app.status.policy, app.status.robot);
    }, alternate);
    assert.equal(await page.locator(card(alternate)).count(), 0);
    assert.equal(await gallery.evaluate(dialog => dialog.contains(document.activeElement)), true);
    assert.ok(!(await detail.textContent()).includes(alternate));
    await search.fill('zz_no_such_policy');
    assert.equal(await detail.textContent(), '');
    await search.fill('');
    assert.ok((await detail.textContent()).includes(base));
    await page.keyboard.press('Escape');
    await refresh();

    await policy.click();
    await search.fill('walking running');
    const byCategory = await cards.count();
    assert.equal(await gallery.locator('button[data-value="amp_locomotion/amp_locomotion"]').isVisible(), true);
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
      await cards.first().focus();
      const detailBox = await detail.boundingBox();
      assert.ok(detailBox && detailBox.x >= 0 && detailBox.x + detailBox.width <= width && detailBox.y + detailBox.height <= 844);
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
    const emptyTrigger = await ax('#policy-trigger');
    assert.ok(!`${emptyTrigger.name} ${emptyTrigger.description}`.includes(base), 'No stale selected identity');

    // Imported labels remain literal text; legitimate preview images are allowed.
    const name = 'custom/' + 'long_checkpoint_'.repeat(12) + '<img src=x onerror=alert(1)>';
    await page.evaluate(name => window.__app.panel.setPolicies([{
      name, family: 'r1_fw', dof: 24, group: 'custom', packId: 'custom',
      previewRobot: 'r1', models: ['air', 'edu'], fsmId: 802,
    }], name, 'r1'), name);
    assert.equal(await policy.isDisabled(), false);
    assert.ok((await ax('#policy-trigger')).name.includes(name));
    await policy.click();
    await search.fill('802');
    assert.equal(await cards.count(), 1);
    await search.fill('onerror');
    assert.equal(await cards.count(), 1);
    assert.ok((await ax(card(name))).name.includes(name), 'Imported card exposes its literal full name');
    await cards.first().focus();
    const longDetail = await detail.boundingBox();
    assert.ok(longDetail && longDetail.x >= 0 && longDetail.x + longDetail.width <= 320, 'Imported ID wraps inside 320px');
    // A very long identity scrolls inside its bounded block; the grid keeps the whole focused card visible.
    assert.ok(await detail.evaluate(node => node.scrollHeight > node.clientHeight));
    const gridBox = await gallery.locator('.visual-picker-grid').boundingBox(), focusedBox = await cards.first().boundingBox();
    assert.ok(gridBox.height > longDetail.height, 'Detail block cannot take over the gallery height');
    assert.ok(focusedBox.y >= gridBox.y && focusedBox.y + focusedBox.height <= gridBox.y + gridBox.height + 1);
    assert.equal(await gallery.locator('[onerror], img[src="x"]').count(), 0);
    const longBounds = await cards.first().boundingBox();
    assert.ok(longBounds.x >= 0 && longBounds.x + longBounds.width <= 320);
    await page.keyboard.press('Escape');

    // Same-title imported checkpoints whose differing parts overlap still get distinct visible labels.
    const overlapping = ['custom/dance_a', 'custom/dance-a', 'custom/dance_dance_a_a'];
    await page.evaluate(names => window.__app.panel.setPolicies(names.map(name => ({
      name, family: 'r1_fw', dof: 24, group: 'custom', packId: 'custom', previewRobot: 'r1', models: ['edu'],
    })), names[0], 'r1'), overlapping);
    await policy.click();
    assert.deepEqual((await cards.evaluateAll(buttons => buttons.map(button => button.dataset.value))).sort(), [...overlapping].sort());
    assert.equal(new Set(await cards.evaluateAll(buttons => buttons.map(button => button.innerText))).size, overlapping.length);
    const overlappingNames = new Set();
    for (const value of overlapping) {
      const node = await ax(card(value));
      assert.ok(node.name.includes(value));
      overlappingNames.add(node.name);
    }
    assert.equal(overlappingNames.size, overlapping.length);
    await page.keyboard.press('Escape');
    await refresh();
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({
      canonicalIds: true, fullNameSearch: true, stateSearch: true,
      categories: byCategory, backgroundUpdates: true, emptyState: true, keyboard: true,
      selectionLoaded: next, cameraProtected: true, mobile, longNames: true,
      reviewLockPreserved: true, errors,
    }));
  } finally {
    await browser.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
