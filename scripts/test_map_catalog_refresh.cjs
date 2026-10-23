'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome',
    headless: true, args: ['--no-sandbox', '--disable-gpu', '--disable-webgl', '--disable-software-rasterizer'] });
  const base = process.env.BASE_URL || 'http://127.0.0.1:5176';
  const results = [];
  try {
    for (const scenario of [{ width: 390, mode: 'search' }, { width: 320, mode: 'keyboard' }]) {
      const context = await browser.newContext({ viewport: { width: scenario.width, height: 844 } });
      const page = await context.newPage(), requests = [], errors = [];
      page.on('request', request => requests.push(request.url()));
      page.on('pageerror', error => errors.push(error.message));
      let release;
      const catalogGate = new Promise(resolve => { release = resolve; });
      try {
        // Delay the genuine response, never replace the catalog or manipulate application state.
        await page.route('**/assets/maps/index.json', async route => { await catalogGate; await route.continue(); });
        const catalogRequested = page.waitForRequest(request => new URL(request.url()).pathname === '/assets/maps/index.json');
        await page.goto(base + '/?map=nt_ghost_ctg', { waitUntil: 'commit' });
        await catalogRequested;
        await page.locator('#launch-map-trigger').click();
        const dialog = page.locator('dialog[data-visual-picker="launch-map"]');
        const search = dialog.getByRole('searchbox');
        assert.equal(await page.locator('#launch-map').inputValue(), 'map:nt_ghost_ctg');
        if (scenario.mode === 'search') {
          await search.fill('Bullet');
        } else {
          await search.press('Tab');
          assert.equal(await page.evaluate(() => document.activeElement instanceof HTMLElement ? document.activeElement.dataset.value : null), 'map:nt_ghost_ctg');
        }
        release();
        await page.locator('#launch-map option[value="map:nt_bullet_tdm"]').waitFor({ state: 'attached' });
        assert.equal(await dialog.isVisible(), true);
        assert.equal(await page.locator('#launch-map').inputValue(), 'map:nt_ghost_ctg');
        let choice;
        if (scenario.mode === 'search') {
          assert.equal(await search.inputValue(), 'Bullet');
          assert.equal(await search.evaluate(input => input === document.activeElement), true);
          choice = dialog.locator('button[data-value="map:nt_bullet_tdm"]');
          await choice.waitFor({ state: 'visible' });
        } else {
          assert.equal(await page.evaluate(() => document.activeElement instanceof HTMLElement ? document.activeElement.dataset.value : null), 'map:nt_ghost_ctg');
          choice = dialog.locator('button[data-value="map:nt_ghost_ctg"]');
        }
        await choice.locator('img').waitFor({ state: 'attached' });
        await choice.locator('img').evaluate(async image => { if (!(image instanceof HTMLImageElement)) throw new Error('Map preview is not an image'); await image.decode(); });
        const layout = await page.evaluate(() => ({ viewport: innerWidth, document: document.documentElement.scrollWidth }));
        assert.equal(layout.document <= layout.viewport, true);
        if (process.env.QA_ARTIFACT_DIR) {
          fs.mkdirSync(process.env.QA_ARTIFACT_DIR, { recursive: true });
          await page.screenshot({ path: path.join(process.env.QA_ARTIFACT_DIR, `map-refresh-${scenario.mode}-${scenario.width}.png`) });
        }
        if (scenario.mode === 'search') await choice.click();
        else await page.keyboard.press('Enter');
        const selected = await page.locator('#launch-map').inputValue();
        assert.equal(selected, scenario.mode === 'search' ? 'map:nt_bullet_tdm' : 'map:nt_ghost_ctg');
        assert.equal(await dialog.count(), 0);
        const heavy = requests.filter(url => /\.(?:wasm|onnx|glb|mdl|stl|obj|zip)(?:[?#]|$)/i.test(url) || /\/assets\/(?:models|packs|policies)\//.test(url));
        assert.deepEqual(heavy, []); assert.deepEqual(errors, []);
        results.push({ ...scenario, selected, queryAndFocusPreserved: true, previewDecoded: true, layout, noHeavyBeforeLoad: true, errors });
      } finally { release(); await context.close(); }
    }
    if (process.env.QA_ARTIFACT_DIR) fs.writeFileSync(path.join(process.env.QA_ARTIFACT_DIR, 'map-catalog-refresh.json'), JSON.stringify(results, null, 2));
    console.log(JSON.stringify({ status: 'PASS', scope: 'Real minimal startup UI; genuine delayed map metadata, native mouse/keys, preserved query/focus and valid new selections. No renderer.', results }, null, 2));
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
