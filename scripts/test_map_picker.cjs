/** Chromium: complete visual map gallery, real previews, search, keyboard and narrow screens. */
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');
const { chooseVisual } = require('./choose-visual.cjs');

(async () => {
  const browser = await chromium.launch({ headless: process.env.HEADLESS === '1', args: ['--no-sandbox', '--ozone-platform=x11'] });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.addInitScript(() => {
      const native = requestAnimationFrame;
      window.requestAnimationFrame = callback => native(time => setTimeout(() => callback(time), 150));
    });
    await page.route('**/{src/main.ts*,assets/main-*.js}', async route => {
      const response = await route.fetch();
      await route.fulfill({ response, body: require('./expose-app.cjs')(await response.text()).replace('this.renderLoop()', 'void 0') });
    });
    await page.goto((process.env.BASE_URL || 'http://127.0.0.1:5176') + '/?plain')
      .then(() => require('./launch-scene.cjs').launchScene(page));
    await page.waitForFunction(() => window.__app?.lastFrame && document.getElementById('overlay').classList.contains('hidden'), null, { timeout: 120000 });
    const trigger = page.locator('#terrain-trigger');
    const gallery = page.locator('dialog[data-visual-picker="terrain"]');
    const search = gallery.getByRole('searchbox');
    const cards = gallery.locator('button[data-value]');
    const visibleCards = gallery.locator('button[data-value]:visible');
    const original = await page.evaluate(() => window.__app.panel.terrain);
    const originalLabel = await trigger.textContent();
    await trigger.focus();
    await page.keyboard.press('Space');
    assert.equal(await gallery.isVisible(), true, 'Space activates the focused gallery trigger, not the actor stop shortcut');
    await page.keyboard.press('Escape');
    assert.equal(await trigger.evaluate(button => document.activeElement === button), true);
    const robot = await page.evaluate(() => {
      const app = window.__app;
      window.__reselection = { model: app.model, send: app.send, navigation: [] };
      app.send = function (message) {
        if (message.t === 'terrain' || message.t === 'robot') window.__reselection.navigation.push(message);
        return window.__reselection.send.call(this, message);
      };
      return app.status.robot;
    });
    await chooseVisual(page, 'terrain', original);
    await chooseVisual(page, 'robot', robot);
    const reselected = await page.evaluate(() => {
      const app = window.__app, captured = window.__reselection;
      app.send = captured.send;
      delete window.__reselection;
      return { navigation: captured.navigation, sameModel: app.model === captured.model };
    });
    assert.deepEqual(reselected.navigation, [], 'Reselecting active map/robot must not request a scene rebuild');
    assert.equal(reselected.sameModel, true, 'Reselecting active choices preserves the actual simulation model');
    await trigger.click();
    await gallery.waitFor({ state: 'visible' });
    assert.equal(await cards.count(), 29, 'Every built-in terrain and converted map is available');
    const labels = await cards.allTextContents();
    const mapCards = gallery.locator('button[data-value^="map:"]');
    assert.equal(await mapCards.count(), 24);
    assert.ok((await mapCards.allTextContents()).every(label => label.includes('.bsp')), 'Map filenames remain visible');
    // Previews are progressive: bring every card into view, then require an actual decoded image.
    for (let index = 0; index < await cards.count(); index++) {
      const card = cards.nth(index);
      await card.scrollIntoViewIfNeeded();
      await card.locator('img').waitFor();
      await page.waitForFunction(value => {
        const card = Array.from(document.querySelectorAll('dialog[data-visual-picker="terrain"] button[data-value]'))
          .find(button => button.dataset.value === value);
        const image = card?.querySelector('img');
        return image?.complete && image.naturalWidth > 0 && image.naturalHeight > 0;
      }, await card.getAttribute('data-value'));
    }
    await search.fill('nt_ghost_ctg.bsp');
    assert.equal(await visibleCards.count(), 1, 'Full filename search finds the matching card');
    assert.equal(await visibleCards.first().getAttribute('data-value'), 'map:nt_ghost_ctg');
    if (!process.env.SKIP_SCREENSHOTS) await page.screenshot({ path: '/tmp/map-picker-desktop.png', timeout: 60000 });
    await page.keyboard.press('Escape');
    assert.equal(await gallery.isVisible(), false);
    assert.equal(await trigger.textContent(), originalLabel, 'Cancel leaves the visible selection unchanged');
    assert.equal(await page.evaluate(() => window.__app.panel.terrain), original);
    assert.equal(await trigger.evaluate(button => document.activeElement === button), true);

    await trigger.click();
    await search.fill('no_such_map_zyx');
    assert.equal(await visibleCards.count(), 0);
    await page.keyboard.press('Enter');
    assert.equal(await gallery.isVisible(), true);
    assert.equal(await page.evaluate(() => window.__app.panel.terrain), original);
    const terrain = original === 'rough' ? 'flat' : 'rough';
    await search.fill(terrain);
    assert.equal(await visibleCards.count(), 1);
    await page.keyboard.press('Tab');
    assert.equal(await visibleCards.first().evaluate(button => document.activeElement === button), true);
    await page.keyboard.press('Home');
    await page.keyboard.press('Enter');
    assert.equal(await gallery.isVisible(), false);
    assert.equal(await page.evaluate(() => window.__app.panel.terrain), terrain);
    await page.waitForFunction(terrain => window.__app.model?.terrain === terrain && document.getElementById('overlay').classList.contains('hidden'), terrain, { timeout: 120000 });

    await trigger.click();
    await search.fill('neotokyo');
    const gameMatches = await visibleCards.count();
    assert.ok(gameMatches > 0, 'Game groups are searchable');
    assert.ok((await visibleCards.evaluateAll(buttons => buttons.map(button => button.dataset.value))).includes('map:nt_ghost_ctg'));
    await search.fill('ghost');
    assert.equal(await visibleCards.count(), 1);
    await search.fill('');
    const mobileBounds = [];
    for (const width of [390, 320]) {
      await page.setViewportSize({ width, height: 844 });
      for (const card of [cards.first(), cards.last()]) {
        await card.scrollIntoViewIfNeeded();
        const image = card.locator('img');
        await image.waitFor({ state: 'attached' });
        await image.evaluate(image => image.decode());
        const picture = await image.boundingBox(), tile = await card.boundingBox();
        assert.equal(await image.isVisible(), true,
          `Map picture ${await card.getAttribute('data-value')} at ${width}px must not collapse: ${JSON.stringify({ picture, tile })}`);
        assert.ok(picture && tile && picture.y >= tile.y && picture.y + picture.height <= tile.y + tile.height + 1,
          'The card must contain its visible picture rather than spilling into the next row');
      }
      if (!process.env.SKIP_SCREENSHOTS) await page.screenshot({ path: `/tmp/map-picker-mobile-${width}.png`, timeout: 60000 });
      const bounds = await gallery.boundingBox();
      assert.ok(bounds && bounds.x >= 0 && bounds.x + bounds.width <= width);
      assert.ok(bounds.y >= 0 && bounds.y + bounds.height <= 844);
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      mobileBounds.push({ width, ...bounds });
    }
    await page.keyboard.press('Escape');
    await chooseVisual(page, 'terrain', 'map:nt_ghost_ctg');
    assert.equal(await page.evaluate(() => window.__app.panel.terrain), 'map:nt_ghost_ctg');
    await page.waitForFunction(() => window.__app.model?.terrain === 'map:nt_ghost_ctg' && document.getElementById('overlay').classList.contains('hidden'), null, { timeout: 120000 });
    assert.match(await trigger.textContent(), /nt_ghost_ctg\.bsp/);
    assert.equal(await gallery.isVisible(), false);
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ cards: labels.length, renderedPreviews: 29, filenameSearch: true, gameMatches, keyboardCancel: true, keyboardSelection: true, mapSelection: true, actualMapLoaded: true, mobileBounds, errors }));
  } finally {
    await browser.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
