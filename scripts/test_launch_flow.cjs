/** Chromium: actual launch remains lightweight and isolates scene input until entry. */
const assert = require('node:assert/strict');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const { launchScene } = require('./launch-scene.cjs');
const { chooseVisual } = require('./choose-visual.cjs');

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROME_BIN || '/usr/bin/google-chrome', headless: true,
    args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  try {
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const page = await context.newPage(), errors = [], heavyRequests = [], sourceIndexRequests=[];
    page.on('pageerror', error => errors.push(error.message));
    page.on('request', request => {
      const path = new URL(request.url()).pathname;
      if (/\/wasm\/|\/assets\/(models|source-robots|policies)\/|\.(onnx|wasm|mdl)$|\/assets\/characters\/.*\.glb$|\/assets\/packs\/.*\.zip$|\/assets\/maps\/.*\.(glb|bin)$/.test(path))
        heavyRequests.push(path);
      if(path.endsWith('/model_names.txt'))sourceIndexRequests.push(path);
    });
    const base = process.env.BASE_URL || 'http://127.0.0.1:5176';
    let releaseCatalog;
    const catalogGate = new Promise(resolve => { releaseCatalog = resolve; });
    await page.route('**/assets/maps/index.json', async route => {
      const response = await route.fetch();
      await catalogGate;
      await route.fulfill({ response });
    });
    await page.goto(base + '/?plain&body=stock', { waitUntil: 'domcontentloaded' });
    await page.locator('#launch-map-trigger').waitFor({ state: 'visible' });
    await page.locator('#launch-map-trigger').click();
    const catalogResponse = page.waitForResponse(response => new URL(response.url()).pathname === '/assets/maps/index.json');
    releaseCatalog();
    const catalog = await (await catalogResponse).json();
    await page.waitForFunction(ids => ids.every(id => Array.from(document.querySelector('#launch-map').options)
      .some(option => option.value === `map:${id}`)), catalog.maps.map(map => map.id));
    const refreshedMaps = page.locator('dialog[data-visual-picker="launch-map"]');
    if (!await refreshedMaps.isVisible()) await page.locator('#launch-map-trigger').click();
    await refreshedMaps.locator('button[data-value="rough"]').click();
    assert.equal(await page.locator('#launch-map').inputValue(), 'rough',
      'A map chosen after the asynchronous catalog arrives must not be a dead stale card');
    assert.equal(await refreshedMaps.isVisible(), false);
    await page.unroute('**/assets/maps/index.json');
    await page.locator('#launch-map-trigger').click();
    const maps = page.locator('dialog[data-visual-picker="launch-map"]');
    await maps.waitFor({ state: 'visible' });
    const flat = maps.locator('button[data-value="flat"]');
    await flat.scrollIntoViewIfNeeded();
    await flat.locator('img').waitFor();
    await page.waitForFunction(() => {
      const image = document.querySelector('dialog[data-visual-picker="launch-map"] button[data-value="flat"] img');
      return image?.complete && image.naturalWidth > 0;
    });
    await page.keyboard.press('Escape');
    await page.locator('#launch-map-trigger').click();
    await maps.locator('button[data-value="rough"]').focus();
    await page.keyboard.down('Enter');
    assert.equal(await maps.isVisible(), false);
    await page.keyboard.down('Enter');
    assert.equal(await maps.isVisible(), false, 'Held Enter must not reopen the gallery after a selection');
    await page.keyboard.up('Enter');
    assert.deepEqual(heavyRequests, [], 'The map gallery must not load simulation assets');
    await chooseVisual(page, 'launch-map', 'flat');
    await page.locator('#launch-next').click();
    await page.locator('#launch-load').waitFor({ state: 'visible' });
    await chooseVisual(page, 'launch-robot', 'r1');
    assert.deepEqual(sourceIndexRequests, [], 'Source indexes wait for the explicit Search Source models action');
    await page.locator('#launch-character-trigger').click();
    const characters=page.locator('dialog[data-visual-picker="launch-character"]');
    for(const id of ['stock','boxy','round','prism','dog','gingerbread-man','the-wrapped','psx-low-poly-skeleton','ralph','dragon-wyvern','pmodels:hl:picardia_v1sc'])
      assert.equal(await characters.locator(`button[data-value=${JSON.stringify(id)}]`).count(),1);
    await page.keyboard.press('Escape');
    await chooseVisual(page,'launch-character','psx-dog');
    assert.equal(await page.locator('#launch-robot').inputValue(),'go2','A quadruped launch choice selects its own compatible physics');
    await chooseVisual(page,'launch-character','gingerbread-man');
    assert.equal(await page.locator('#launch-robot').inputValue(),'r1','A launch-only R1 character deliberately chooses compatible physics');
    assert.deepEqual(heavyRequests, [], 'Character galleries use images, never geometry');
    await page.locator('#launch-character-trigger').click();
    const indexes='**/pmodels/database/*/model_names.txt';
    await page.route(indexes,route=>route.fulfill({status:503,contentType:'text/plain',headers:{'access-control-allow-origin':'*'},body:'Index unavailable'}));
    await characters.getByRole('button',{name:'Search Source models',exact:true}).click();
    await characters.getByRole('status').filter({hasText:'503'}).waitFor();
    await page.unroute(indexes);
    await characters.getByRole('button',{name:'Retry',exact:true}).click();
    await characters.locator('button[data-value]').first().waitFor({state:'visible'});
    assert.equal(await characters.locator('button[data-value]').count(),40);
    const cachedIndexRequests=sourceIndexRequests.length;
    const firstPage=await characters.locator('button[data-value]').first().getAttribute('data-value');
    await characters.getByRole('button',{name:'Next',exact:true}).click();
    await page.waitForFunction(first=>{
      const card=document.querySelector('dialog[data-visual-picker="launch-character"] button[data-value]');
      return card&&card.getAttribute('data-value')!==first;
    },firstPage);
    const remote=await characters.locator('button[data-value]').first().getAttribute('data-value');
    await characters.locator('button[data-value]').first().click();
    assert.equal(await page.locator('#launch-character').inputValue(),remote,'A dynamic Source choice commits to the canonical select');
    await page.locator('#launch-character-trigger').click();
    assert.equal(await characters.locator(`button[data-value=${JSON.stringify(remote)}]`).count(),1,'The chosen remote option survives gallery reconstruction');
    await characters.getByRole('button',{name:'Search Source models',exact:true}).click();
    await characters.locator('button[data-value]').first().waitFor({state:'visible'});
    const sourceQuery=characters.getByRole('searchbox');
    await sourceQuery.fill('m0clip-no-source-model-with-this-name');
    await characters.getByRole('status').filter({hasText:'No matching Source models.'}).waitFor();
    await sourceQuery.fill('picardia');
    const picardia=characters.locator('button[data-value="pmodels:hl:picardia_v1sc"]');
    await picardia.waitFor({state:'visible'});await picardia.scrollIntoViewIfNeeded();
    await page.waitForFunction(()=>{
      const image=document.querySelector('dialog[data-visual-picker="launch-character"] button[data-value="pmodels:hl:picardia_v1sc"] img');
      return image?.complete&&image.naturalWidth>0&&image.crossOrigin==='anonymous';
    });
    await picardia.click();
    assert.equal(await page.locator('#launch-character').inputValue(),'pmodels:hl:picardia_v1sc');
    assert.equal(await characters.isVisible(),false);
    assert.equal(sourceIndexRequests.length,cachedIndexRequests,'Source names indexes are cached across queries, pages and gallery reconstruction');
    assert.deepEqual(heavyRequests, [], 'Source search and canonical choice do not load a model before Load');
    await chooseVisual(page, 'launch-character', 'boxy');
    await page.waitForFunction(() => {
      const image=document.querySelector('#launch-character-trigger img');
      return image?.complete && image.naturalWidth > 0;
    });
    await page.keyboard.press('w');
    await page.keyboard.press('v');
    assert.equal(await page.locator('#viewport canvas').count(), 0, 'Scene shortcuts must not initialize the scene');
    assert.deepEqual(heavyRequests, [], 'Character selection must not load simulation assets');
    await page.locator('#launch-load').click();
    await page.waitForFunction(() => {
      const enter = document.querySelector('#launch-enter');
      return enter && !enter.hidden && !enter.disabled && enter.getClientRects().length > 0;
    }, null, { timeout: 240000 });
    assert.equal(await page.locator('#app').evaluate(app => app.inert), true, 'Ready is not yet scene entry');
    await page.locator('#launch-enter').click();
    await page.waitForFunction(() => document.querySelector('#launch-screen')?.hidden === true);
    assert.equal(await page.locator('#app').evaluate(app => app.inert), false);
    const beforeHelp = await page.evaluate(() => ({
      flightHidden: document.querySelector('#flight-hud').hidden,
      recordingHidden: document.querySelector('#rec-badge').hidden,
      panelLayout: document.body.className,
    }));
    await page.locator('.help-trigger').click();
    for (const key of ['Space', 'n', 'v', 'ArrowUp', 'Tab']) await page.keyboard.press(key);
    await page.evaluate(()=>new Promise(resolve=>{
      let frames=0;requestAnimationFrame(function tick(){if(++frames===2)resolve(frames);else requestAnimationFrame(tick);});
    }));
    assert.equal(await page.locator('.help-dialog').evaluate(dialog => dialog.open), true,
      'Initial help focus must not turn a scene shortcut into closing Help');
    assert.deepEqual(await page.evaluate(() => ({
      flightHidden: document.querySelector('#flight-hud').hidden,
      recordingHidden: document.querySelector('#rec-badge').hidden,
      panelLayout: document.body.className,
    })), beforeHelp, 'Help must own scene shortcuts');
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('.help-dialog').isVisible(), false);
    assert.equal(await page.locator('.help-trigger').evaluate(button => document.activeElement === button), true);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await launchScene(page);
    assert.equal(await page.locator('#app').evaluate(app => app.inert), false);
    assert.deepEqual(errors, []);
    await context.close();
    const failedContext = await browser.newContext(), failed = await failedContext.newPage();
    await failed.route(/\/assets\/models\/.*\.xml(?:\?|$)/, route => route.fulfill({ status: 503, contentType: 'text/plain', body: 'Model XML unavailable' }));
    await failed.goto(base + '/?plain&body=stock', { waitUntil: 'networkidle' });
    await chooseVisual(failed, 'launch-map', 'flat');
    await failed.locator('#launch-next').click();
    await failed.locator('#launch-load').click();
    const status = failed.locator('#launch-status[data-kind="error"]');
    await status.waitFor({ state: 'visible', timeout: 240000 });
    const failure = await status.textContent();
    assert.match(failure, /\b503\b/, 'The failed asset status must remain actionable');
    await failed.waitForLoadState('networkidle');
    assert.equal(await status.textContent(), failure, 'Other completed assets must not erase a loading error');
    assert.equal(await failed.locator('#launch-enter').isDisabled(), true);
    assert.equal(await failed.locator('#launch-screen').isVisible(), true);
    await failedContext.close();
    console.log(JSON.stringify({ explicitLoad: true, inputIsolation: true, realEntry: true, reload: true, failedLoadStaysVisible: true, errors }));
  } finally {
    await browser.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
