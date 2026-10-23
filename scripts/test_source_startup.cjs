/** Explicit immutable preview only. SOURCE_HANDOFF=1 SOURCE_STAGE=... BASE_URL=... xvfb-run -a node scripts/test_source_startup.cjs */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { createProxy } = require('./test_startup_overlap.cjs');
const { chooseVisual } = require('./choose-visual.cjs');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const output = process.env.QA_ARTIFACT_DIR || '/tmp/m0clip-source-startup';
const scene = '/assets/models/go2/scene.xml';
const heavy = value => /\/wasm\/|\/assets\/(models|source-robots)\/|\.(onnx|wasm)$|\/assets\/packs\/.*\.zip$|\/assets\/maps\/.*\.(glb|bin|xml|rgba)(?:\.gz)?$/.test(value);
const defaults = ['selection', 'width320', 'width375', 'width390', 'width414', 'width768', 'fast', 'slow', 'error-morph', 'ready-morph', 'reduced', 'reduced-change', 'background'];
async function nativeBrowser(directory) {
  const profile = fs.mkdtempSync(path.join(directory, 'native-profile-')), video = path.join(directory, 'native-display.mp4');
  const chromeLog = fs.createWriteStream(path.join(directory, 'native-chrome.stderr')), recorderLog = fs.createWriteStream(path.join(directory, 'native-video.stderr'));
  const chrome = spawn('/usr/bin/google-chrome', ['--no-sandbox', '--no-first-run', '--no-default-browser-check', '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--window-size=1280,800', '--ozone-platform=x11', '--disable-dev-shm-usage', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
  chrome.stderr.pipe(chromeLog);
  const endpoint = await new Promise((resolve, reject) => {
    let log = ''; const timer = setTimeout(() => reject(new Error('Owned native Chrome did not expose its CDP endpoint')), 15000);
    chrome.stderr.on('data', bytes => { log += bytes; const match = log.match(/DevTools listening on (ws:\/\/\S+)/); if (match) { clearTimeout(timer); resolve(match[1]); } });
    chrome.once('error', reject); chrome.once('exit', code => { clearTimeout(timer); reject(new Error(`Owned native Chrome exited ${code}`)); });
  });
  // noDefaults skips Playwright's original main-target focus override, not merely a second session's state.
  const browser = await chromium.connectOverCDP(endpoint, { noDefaults: true });
  const context = browser.contexts()[0], page = context.pages()[0] || await context.newPage();
  const actual = await page.evaluate(() => ({ width: innerWidth, height: innerHeight, dpr: devicePixelRatio }));
  const recorder = spawn('ffmpeg', ['-y', '-f', 'x11grab', '-video_size', '1280x1024', '-framerate', '12', '-i', process.env.DISPLAY, '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '25', '-pix_fmt', 'yuv420p', video], { stdio: ['pipe', 'ignore', 'pipe'] });
  recorder.stderr.pipe(recorderLog);
  async function finish(process, signal) {
    if (process.exitCode !== null) return;
    await new Promise(resolve => {
      const timer = setTimeout(() => process.kill('SIGKILL'), 5000);
      process.once('exit', () => { clearTimeout(timer); resolve(); });
      if (signal) process.kill(signal); else process.stdin.write('q\n');
    });
  }
  return { browser, context, page, video, actual, async stop() { await finish(recorder); await finish(chrome, 'SIGTERM'); chromeLog.end(); recorderLog.end(); fs.rmSync(profile, { recursive: true, force: true }); assert.equal(recorder.exitCode, 0, 'Actual native display recording must finalize'); } };
}
async function until(check, message, timeout = 180000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { const value = await check(); if (value) return value; await delay(25); }
  throw new Error(message);
}
async function raf(page, count = 4) {
  return page.evaluate(count => new Promise(resolve => { const started = performance.now(); let frames = 0; function frame() { if (++frames >= count) resolve({ frames, elapsed: performance.now() - started }); else requestAnimationFrame(frame); } requestAnimationFrame(frame); }), count);
}
async function shot(cdp, directory, name) {
  const image = await cdp.send('Page.captureScreenshot', { format: 'png', fromSurface: true, captureBeyondViewport: false });
  const filename = path.join(directory, `${name}.png`); fs.writeFileSync(filename, Buffer.from(image.data, 'base64')); return filename;
}
async function geometry(locator) {
  return locator.evaluate(element => { const r = element.getBoundingClientRect(), target = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2); return { x: r.x, y: r.y, width: r.width, height: r.height, hit: !!target && (element === target || element.contains(target)), disabled: !!element.disabled }; });
}
async function hit(locator) { const value = await geometry(locator); assert.ok(value.hit && value.width > 0 && value.height > 0 && !value.disabled, 'Actual native target must be exposed'); return value; }
async function snapshot(page) {
  return page.evaluate(() => {
    const stage = document.querySelector('#launch-load-stage'), rect = stage.getBoundingClientRect();
    return { at: performance.now(), phase: stage.dataset.game, stage: { x: rect.x, y: rect.y, width: rect.width, height: rect.height }, ready: !document.querySelector('#launch-enter').disabled, error: document.querySelector('#launch-status').dataset.kind === 'error', status: document.querySelector('#launch-status').textContent, bytes: document.querySelector('#launch-bytes').textContent, eta: document.querySelector('#launch-eta').textContent, focus: document.activeElement.id, overflow: Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) > innerWidth, font: getComputedStyle(document.body).fontFamily };
  });
}
async function observe(page, events, gates, releaseOnMorph) {
  await page.exposeFunction('__sourceObserved', record => {
    events.push(record);
    if (releaseOnMorph && record.phase === 'morph') for (const gate of gates.values()) {
      if (!gate.released) { gate.triggeredAt = Date.now(); gate.released = true; }
    }
  });
  await page.evaluate(() => {
    const stage = document.querySelector('#launch-load-stage'), enter = document.querySelector('#launch-enter'), status = document.querySelector('#launch-status');
    document.querySelector('#launch-load').addEventListener('click', () => window.__sourceObserved({ kind: 'load', at: performance.now(), wall: Date.now(), focus: document.activeElement.id }), { capture: true });
    new MutationObserver(() => { const r = stage.getBoundingClientRect(); window.__sourceObserved({ kind: 'state', at: performance.now(), wall: Date.now(), phase: stage.dataset.game, stage: { x: r.x, y: r.y, width: r.width, height: r.height }, ready: !enter.disabled, error: status.dataset.kind === 'error', focus: document.activeElement.id }); }).observe(document.querySelector('#launch-loading-step'), { subtree: true, attributes: true, attributeFilter: ['data-game', 'disabled', 'data-kind'] });
  });
}
async function gallery(page, id, directory, touch = false) {
  if (touch) await page.locator(`#${id}-trigger`).tap(); else await page.locator(`#${id}-trigger`).click();
  const dialog = page.locator(`dialog[data-visual-picker="${id}"]`); await dialog.waitFor({ state: 'visible' });
  const expected = await page.locator(`#${id} option`).evaluateAll(options => options.map(option => option.value));
  const actual = await dialog.locator('button[data-value]').evaluateAll(cards => cards.map(card => card.dataset.value)); assert.deepEqual(actual, expected);
  const pictures = [];
  for (const value of actual) {
    const card = dialog.locator(`button[data-value=${JSON.stringify(value)}]`); await card.scrollIntoViewIfNeeded();
    const image = card.locator('img'); await image.waitFor({ state: 'visible' });
    await until(() => image.evaluate(image => image.complete && image.naturalWidth > 0), 'Every real preview must finish attachment and decode');
    const picture = await image.evaluate(async image => { await image.decode(); const card = image.closest('button').getBoundingClientRect(), r = image.getBoundingClientRect(); return { src: image.currentSrc, attached: image.isConnected, naturalWidth: image.naturalWidth, naturalHeight: image.naturalHeight, fits: r.x >= card.x - 1 && r.right <= card.right + 1 && r.y >= card.y - 1 && r.bottom <= card.bottom + 1 }; });
    assert.ok(picture.attached && picture.fits); pictures.push({ value, ...picture });
  }
  fs.writeFileSync(path.join(directory, `${id}-gallery.json`), JSON.stringify({ expected, actual, pictures }, null, 2));
  await page.screenshot({ path: path.join(directory, `${id}-gallery.png`) }); await page.keyboard.press('Escape');
  await dialog.waitFor({ state: 'hidden' }); return { expected, actual, pictures };
}
async function select(page, directory, widthCase) {
  await page.locator('#launch-map-trigger').waitFor();
  if (widthCase) await gallery(page, 'launch-map', directory);
  await chooseVisual(page, 'launch-map', 'flat'); await page.locator('#launch-next').click();
  if (widthCase) await gallery(page, 'launch-robot', directory);
  await chooseVisual(page, 'launch-robot', 'go2');
  if (widthCase) await gallery(page, 'launch-character', directory);
  await chooseVisual(page, 'launch-character', 'stock');
  assert.equal(await page.locator('#launch-pong-controls').isVisible(), false);
  const view = await page.evaluate(() => ({ width: innerWidth, scroll: Math.max(document.documentElement.scrollWidth, document.body.scrollWidth), characters: [...document.querySelectorAll('#launch-character option')].map(option => ({ character: option.value, disabled: option.disabled })) }));
  assert.ok(view.scroll <= view.width); await page.screenshot({ path: path.join(directory, 'selection.png') }); return view;
}
async function pixels(page) {
  return page.locator('#launch-pong').evaluate(canvas => {
    const data = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
    const background = [...data.slice(0, 4)], column = Math.round(canvas.width * .043), rows = [];
    for (let y = 35; y < canvas.height - 24; y++) { const offset = (y * canvas.width + column) * 4; if (background.some((value, i) => data[offset + i] !== value)) rows.push(y); }
    let hash = 2166136261; for (const value of data) hash = Math.imul(hash ^ value, 16777619);
    return { hash: hash >>> 0, paddle: rows.length ? rows.reduce((a,b) => a+b, 0) / rows.length : null, width: canvas.width, height: canvas.height };
  });
}
async function game(page, directory, cdp, touch) {
  const canvas = page.locator('#launch-pong'), box = await canvas.boundingBox(); await hit(canvas);
  if (touch) await canvas.tap({ position: { x: box.width * .3, y: box.height * .75 } });
  else await page.mouse.click(box.x + box.width * .3, box.y + box.height * .75);
  const pointerFrames = await raf(page), pointer = await pixels(page);
  await page.keyboard.down('ArrowUp'); await raf(page, 8); await page.keyboard.up('ArrowUp'); const keyboard = await pixels(page);
  assert.ok(pointer.paddle !== null && keyboard.paddle < pointer.paddle, 'Trusted game keys must move the visible paddle');
  await page.keyboard.press('Space'); assert.equal(await page.locator('#launch-pong-pause').getAttribute('aria-pressed'), 'false');
  const paused = await pixels(page); await raf(page, 6); assert.deepEqual(await pixels(page), paused, 'Paused actual canvas stays still while real RAF advances');
  await page.locator('#launch-pong-pause').click(); assert.equal(await page.locator('#launch-pong-pause').getAttribute('aria-pressed'), 'true');
  const first = await pixels(page); await raf(page, 6); const moving = await pixels(page); assert.notEqual(first.hash, moving.hash, 'Actual Pong pixels must animate');
  await shot(cdp, directory, 'native-game'); return { pointerFrames, pointer, keyboard, paused, first, moving };
}
async function entry(page, directory, cdp, held = false) {
  await page.locator('#launch-enter:not([disabled])').waitFor({ timeout: 180000 });
  assert.equal(await page.locator('#launch-pong-controls').isVisible(), false);
  await page.locator('#launch-enter').click(); await page.locator('#launch-screen').waitFor({ state: 'hidden' }); const frames = await raf(page);
  if (held) { await page.keyboard.down('n'); await raf(page); await page.keyboard.up('n'); await page.keyboard.up('w'); }
  assert.equal(await page.locator('#flight-hud').isVisible(), false); assert.equal(await page.locator('#app').getAttribute('inert'), null);
  await shot(cdp, directory, 'entered'); return frames;
}
async function runCase(name, page, proxy, run, gates, directory, cdp, events) {
  const widthCase = name.startsWith('width'); await page.goto(`${proxy.url}/?plain&body=stock`, { waitUntil: 'domcontentloaded' });
  await page.locator('#launch-map-trigger').waitFor(); await observe(page, events, gates, ['ready-morph', 'error-morph'].includes(name));
  const initial = await snapshot(page); assert.equal(initial.phase, 'waiting'); assert.equal(await page.locator('#launch-pong-controls').isVisible(), false);
  if (name === 'selection') {
    await delay(31050); assert.equal(await page.locator('#launch-pong-controls').isVisible(), false);
    assert.deepEqual(run.resources.filter(resource => heavy(resource.path)), []); await shot(cdp, directory, 'selection-after31s');
    return { initial, after: await snapshot(page), selectionWaitMilliseconds: 31050 };
  }
  if (name === 'tap') {
    const map = await gallery(page, 'launch-map', directory, true);
    const next = page.locator('#launch-next'); await hit(next); await next.tap();
    await page.locator('#launch-character-step').waitFor({ state: 'visible' });
    await gallery(page, 'launch-character', directory, true);
    await page.locator('#launch-character-trigger').tap();
    const original = page.locator('dialog[data-visual-picker="launch-character"] button[data-value="stock"]'); await hit(original); await original.tap();
    assert.equal(await page.locator('#launch-character').inputValue(), 'stock');
    const feedback = await page.evaluate(() => ({ token: getComputedStyle(document.documentElement).getPropertyValue('--tap'), next: getComputedStyle(document.querySelector('#launch-next')).webkitTapHighlightColor, original: getComputedStyle(document.querySelector('#launch-character-trigger')).webkitTapHighlightColor, width: innerWidth, scroll: Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) }));
    assert.ok(feedback.scroll <= feedback.width); assert.deepEqual(run.resources.filter(resource => heavy(resource.path)), []);
    await shot(cdp, directory, 'native-character-tap');
    return { initial, map, feedback };
  }
  const selection = await select(page, directory, widthCase); assert.deepEqual(run.resources.filter(resource => heavy(resource.path)), []);
  if (widthCase) return { initial, selection };
  await page.locator('#launch-load').click(); await until(() => events.find(event => event.kind === 'load'), 'Trusted explicit Load must be observed');
  const before = await snapshot(page), focusBefore = before.focus;
  if (name === 'fast') {
    await page.locator('#launch-enter:not([disabled])').waitFor({ timeout: 120000 });
    const ready = await snapshot(page), load = events.find(event => event.kind === 'load'); assert.ok(ready.at - load.at < 30000, 'This actual Go2/Flat control must finish before the game threshold');
    assert.ok(!events.some(event => event.phase === 'morph' || event.phase === 'pong'));
    const frames = await entry(page, directory, cdp); await delay(31050 - (ready.at - load.at)); assert.ok(!events.some(event => event.phase === 'morph' || event.phase === 'pong'));
    return { selection, before, ready, frames, elapsed: ready.at - load.at };
  }
  await until(() => run.resources.find(resource => resource.held), 'Real selected prerequisite must reach the HTTP fixture gate');
  if (name === 'background') {
    const sourceWindow = await cdp.send('Browser.getWindowForTarget');
    const other = await page.context().newPage(), otherCdp = await page.context().newCDPSession(other);
    await other.goto('about:blank'); await other.bringToFront();
    const otherWindow = await otherCdp.send('Browser.getWindowForTarget');
    const hidden = await until(() => page.evaluate(() => document.hidden && ({ hidden: document.hidden, visibility: document.visibilityState, focused: document.hasFocus() })), 'Actual native second tab must hide the loading document', 5000);
    const hiddenAt = Date.now(); await until(() => events.find(event => event.phase === 'pong'), 'Actual unfinished background loading must cross the real threshold', 65000);
    await page.bringToFront();
    const visible = await until(() => page.evaluate(() => !document.hidden && ({ hidden: document.hidden, visibility: document.visibilityState, focused: document.hasFocus() })), 'Native tab return must genuinely restore visibility', 5000);
    await other.close();
    const pressed = await page.locator('#launch-pong-pause').getAttribute('aria-pressed'), first = await pixels(page), frames = await raf(page, 8), after = await pixels(page);
    assert.ok(pressed === 'false' || first.hash !== after.hash, 'Visible return must not advertise playing while the actual court is frozen');
    await shot(cdp, directory, 'background-return'); const interaction = await game(page, directory, cdp, false);
    for (const gate of gates.values()) gate.released = true;
    return { selection, before, sourceWindow, otherWindow, hidden, visible, hiddenAt, pressed, first, after, frames, interaction, entered: await entry(page, directory, cdp) };
  }
  if (name === 'reduced') {
    await page.locator('#launch-load-stage[data-game="pong"]').waitFor({ timeout: 60000 });
    assert.ok(!events.some(event => event.phase === 'morph')); assert.equal(await page.locator('#launch-pong-pause').getAttribute('aria-pressed'), 'false');
    const first = await pixels(page), frames = await raf(page, 8); assert.deepEqual(await pixels(page), first); await shot(cdp, directory, 'reduced-paused');
    const interaction = await game(page, directory, cdp, false); for (const gate of gates.values()) gate.released = true;
    return { selection, before, reduced: { first, frames }, interaction, entered: await entry(page, directory, cdp) };
  }
  if (name === 'ready-morph' || name === 'error-morph') {
    const morph = await until(() => events.find(event => event.phase === 'morph'), 'Actual delayed morph must be observed before real response release', 60000);
    if (name === 'error-morph') await page.locator('#launch-status[data-kind="error"]').waitFor({ timeout: 120000 });
    else await page.locator('#launch-enter:not([disabled])').waitFor({ timeout: 180000 });
    const settled = await snapshot(page); assert.equal(settled.phase, 'waiting'); assert.equal(await page.locator('#launch-pong-controls').isVisible(), false);
    await delay(1600); assert.equal((await snapshot(page)).phase, 'waiting', 'Cancelled morph timer must not resurrect Pong'); await shot(cdp, directory, 'cancelled-morph');
    const settleEvent = events.find(event => name === 'error-morph' ? event.error : event.ready);
    return { selection, before, morph, releasedAt: Math.min(...[...gates.values()].map(gate => gate.triggeredAt)), settled, settledDuringMorph: !!settleEvent && settleEvent.at - morph.at < 1100, settlementMillisecondsAfterMorph: settleEvent?.at - morph.at, practicalRaceLimit: 'Read-only phase observation releases a genuine response immediately; canonical model construction is not mocked and may complete after the 1100ms morph.', entered: name === 'ready-morph' ? await entry(page, directory, cdp) : null };
  }
  await page.locator('#launch-load-stage[data-game="morph"]').waitFor({ timeout: 60000 });
  const morph = await snapshot(page), load = events.find(event => event.kind === 'load'); assert.ok(morph.at - load.at > 30000);
  assert.equal(morph.focus, focusBefore, 'Delayed animation must not steal focus'); assert.equal(morph.overflow, false);
  const pieces = await page.locator('.launch-morph > i').evaluateAll(elements => elements.map(element => { const r = element.getBoundingClientRect(), css = getComputedStyle(element); return { className: element.className, x: r.x, y: r.y, width: r.width, height: r.height, opacity: css.opacity }; }));
  await shot(cdp, directory, 'morph');
  if (name === 'slow') for (const step of [1, 2, 3]) { await delay(200); await shot(cdp, directory, `morph-step${step}`); }
  if (name === 'reduced-change') await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.locator('#launch-load-stage[data-game="pong"]').waitFor({ timeout: 10000 }); const pong = await snapshot(page);
  const centerDelta = { x: pong.stage.x + pong.stage.width / 2 - (before.stage.x + before.stage.width / 2), y: pong.stage.y + pong.stage.height / 2 - (before.stage.y + before.stage.height / 2) };
  fs.writeFileSync(path.join(directory, 'phase-proof.json'), JSON.stringify({ before, morph, pieces, pong, centerDelta }, null, 2));
  await shot(cdp, directory, 'revealed-court');
  assert.ok(Math.abs(centerDelta.x) <= 1 && Math.abs(centerDelta.y) <= 1, `Actual progress/court center must stay in place: ${JSON.stringify(centerDelta)}`);
  if (name === 'reduced-change') assert.equal(await page.locator('#launch-pong-pause').getAttribute('aria-pressed'), 'false');
  assert.ok(run.resources.some(resource => resource.held && resource.bytes > 0), 'Long control delivers real asset bytes before its deliberate pause');
  const interaction = await game(page, directory, cdp, name === 'slow');
  await page.keyboard.down('w'); await page.keyboard.down('n'); for (const gate of gates.values()) gate.released = true;
  const entered = await entry(page, directory, cdp, true); return { selection, before, morph, pieces, pong, interaction, entered };
}
(async () => {
  assert.equal(process.env.SOURCE_HANDOFF, '1', 'Actual integrated preview handoff is required'); assert.ok(process.env.BASE_URL && process.env.SOURCE_STAGE);
  fs.mkdirSync(output, { recursive: true }); const results = [];
  for (const name of (process.env.SOURCE_SCENARIOS || defaults.join(',')).split(',')) {
    const directory = path.join(output, name); fs.mkdirSync(directory, { recursive: true });
    const width = name === 'tap' ? 390 : name.startsWith('width') ? Number(name.slice(5)) : 1280, viewport = { width, height: width < 800 ? 844 : 800 };
    const gates = new Map();
    if (['slow', 'reduced', 'reduced-change', 'background'].includes(name)) gates.set(scene, { released: false, afterBytes: 1, status: 200 });
    if (['ready-morph', 'error-morph'].includes(name)) gates.set(scene, { released: false, afterBytes: 0, status: name === 'error-morph' ? 503 : 200 });
    const proxy = await createProxy(process.env.BASE_URL, { gates, timing: { engineHoldMs: 0, engineStreamMs: 600, selectedZipStreamMs: 0, selectedMapStreamMs: 0, steps: 64 } }), run = proxy.begin(name);
    const native = name === 'background' ? await nativeBrowser(directory) : null;
    const browser = native?.browser || await chromium.launch({ executablePath: '/usr/bin/google-chrome', headless: false, args: ['--no-sandbox', '--ozone-platform=x11', '--disable-dev-shm-usage', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding'] });
    const context = native?.context || await browser.newContext({ viewport, deviceScaleFactor: width < 800 ? 1 : .5, isMobile: width < 800, hasTouch: true, reducedMotion: name === 'reduced' ? 'reduce' : 'no-preference', recordVideo: { dir: path.join(directory, 'video'), size: width < 800 ? viewport : { width: 960, height: 600 } } });
    const page = native?.page || await context.newPage(), cdp = await context.newCDPSession(page), events = [], errors = [], consoleErrors = [], warnings = [], networkErrors = [], httpErrors = [];
    page.on('pageerror', error => errors.push(error.message)); page.on('requestfailed', request => networkErrors.push({ url: request.url(), error: request.failure()?.errorText }));
    page.on('response', response => { if (response.status() >= 400) httpErrors.push({ url: response.url(), path: new URL(response.url()).pathname, status: response.status() }); });
    page.on('console', message => { if (['error', 'warning'].includes(message.type())) (message.type() === 'error' ? consoleErrors : warnings).push({ text: message.text(), location: message.location() }); });
    const result = { name, viewport, events, errors, consoleErrors, warnings, networkErrors, httpErrors, resources: run.resources }; results.push(result);
    if (native) result.native = native.actual;
    try {
      result.proof = await runCase(name, page, proxy, run, gates, directory, cdp, events);
      assert.deepEqual(errors, []); assert.deepEqual(networkErrors, []);
      const deliberate = run.resources.filter(resource => resource.expectedFailure);
      assert.ok(httpErrors.every(error => error.status === 503 && deliberate.some(resource => resource.path === error.path)));
      const worker = consoleErrors.filter(error => /\/sim\.worker-[^/]+\.js$/.test(new URL(error.location.url).pathname));
      assert.equal(worker.length, name === 'error-morph' ? 1 : 0, 'Every expected caught worker diagnostic is retained, and no unrelated error is hidden');
      for (const error of worker) assert.ok(result.proof.settled.status.includes(error.text.split('\n')[0]), 'Original caught worker diagnostic remains canonical');
      for (const error of consoleErrors.filter(error => !worker.includes(error))) assert.ok(httpErrors.some(response => response.url === error.location.url && response.status === 503));
      result.passed = true;
    } catch (error) { result.failure = error.stack; await shot(cdp, directory, 'FAILED').catch(error => { result.failureScreenshot = error.message; }); }
    finally {
      for (const gate of gates.values()) gate.released = true;
      await page.close(); result.video = native?.video || await page.video().path();
      if (native) { await browser.close(); await native.stop(); } else { await context.close(); await browser.close(); }
      await proxy.close();
      fs.writeFileSync(path.join(output, 'results.json'), JSON.stringify({ stage: process.env.SOURCE_STAGE, base: process.env.BASE_URL, fixture: { realControlledByteLimit: 64 * 1024 * 1024, threshold: 30000, morphMilliseconds: 1100, dpr: 'real contexts 1 mobile, .5 desktop' }, results }, null, 2));
    }
    console.log(JSON.stringify({ name, passed: !!result.passed, failure: result.failure }));
  }
  assert.ok(results.every(result => result.passed), 'Actual Source startup proof failed; preserve diagnostics and video');
})().catch(error => { console.error(error); process.exitCode = 1; });
