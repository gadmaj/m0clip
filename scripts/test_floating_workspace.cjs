/** Actual headed-Chrome workspace consumer regression; no App exposure/source patches.
 * WORKSPACE_HANDOFF=1 WORKSPACE_STAGE=<immutable release> BASE_URL=<owner preview>
 * PLAYWRIGHT_MODULE=<installed playwright> QA_ARTIFACT_DIR=<proof directory>
 *   xvfb-run -a node scripts/test_floating_workspace.cjs
 * Optional WORKSPACE_SCENARIOS=desktop,legacy,mobile320,mobile390,legacy-small,landscape,source
 * All runtime methods remain real. One Chrome process/context at a time, live video,
 * actual pointer/touch/keyboard input, advancing frames, decoded PNGs and strict errors.
 */
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const { chooseVisual } = require('./choose-visual.cjs');
const { launchScene } = require('./launch-scene.cjs');
const { raf } = require('./test_loading_progress.cjs');
const { createProxy } = require('./test_startup_overlap.cjs');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const MAP = 'nt_bullet_tdm', mapVisual = `/assets/maps/${MAP}/visual.glb`;
const core = ['#terrain-trigger', '#robot-trigger', '#capture-screenshot'];
const transportTitles = ['Start of the range (Home)', 'Previous input (↑)', 'Play / pause (Space)', 'Next input (↓)', 'End of the range (End)', 'Loop the range (L)'];
const timelineTitles = [...transportTitles, 'Range start at the playhead (I)', 'Range end at the playhead (O)', 'The camera as it moved while recording', 'Render the range to MP4 / MOV / WebM / PNG', 'Save this take to reopen it later (.take.zip)', 'Close the timeline, back to the live sim (Esc)'];

async function until(predicate, message, timeout = 120000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { const value = await predicate(); if (value) return value; await delay(75); }
  throw new Error(message);
}
async function fileEventFrom(page, event, action) {
  const events = [], receive = value => events.push(value); page.on(event, receive);
  try { await action(); const value = await until(() => events[0], `Actual browser ${event} event must arrive`); assert.equal(events.length, 1); return value; }
  finally { page.off(event, receive); }
}
async function activate(locator, touch = false) {
  if (touch) await locator.tap(); else await locator.click();
}
function pointerGeometry(element) {
  const r = element.getBoundingClientRect(), target = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
  let clipped = r.x < 0 || r.y < 0 || r.right > innerWidth || r.bottom > innerHeight;
  for (let parent = element.parentElement; parent; parent = parent.parentElement) {
    const css = getComputedStyle(parent), box = parent.getBoundingClientRect();
    if (/auto|scroll|hidden|clip/.test(css.overflowY) && (r.top < box.top || r.bottom > box.bottom)) clipped = true;
    if (/auto|scroll|hidden|clip/.test(css.overflowX) && (r.left < box.left || r.right > box.right)) clipped = true;
  }
  return { x: r.x, y: r.y, width: r.width, height: r.height, hit: element.contains(target), disabled: !!element.disabled,
    viewportWidth: innerWidth, viewportHeight: innerHeight, clipped };
}
async function hit(locator) {
  let actual = await locator.evaluate(pointerGeometry);
  if (actual.clipped) { await locator.scrollIntoViewIfNeeded(); actual = await locator.evaluate(pointerGeometry); }
  assert.ok(actual.width > 0 && actual.height > 0 && actual.hit && !actual.disabled, `Real pointer target must be reachable: ${JSON.stringify(actual)}`);
  assert.ok(actual.x >= -1 && actual.y >= -1 && actual.x + actual.width <= actual.viewportWidth + 1 && actual.y + actual.height <= actual.viewportHeight + 1, 'Actual control must fit the consumer viewport');
  return actual;
}
async function dockProof(page) {
  const dock = page.locator('#scene-actions'); await dock.waitFor({ state: 'visible' });
  const rect = await dock.boundingBox(), view = await page.evaluate(() => ({ width: innerWidth, height: innerHeight, scroll: document.documentElement.scrollWidth }));
  assert.ok(rect.x >= 0 && rect.y >= 0 && rect.x + rect.width <= view.width + 1 && rect.y + rect.height <= view.height + 1, 'Core actions dock must fit the viewport');
  assert.ok(view.scroll <= view.width + 1, 'Workspace must not require horizontal document scrolling');
  const targets = [];
  for (const selector of core) targets.push({ selector, ...await hit(page.locator(selector)) });
  for (const title of ["Record the robot's motion and your inputs (V)", 'Open the last take on the timeline', 'Open a saved take (.take.zip)']) {
    const control = page.getByTitle(title, { exact: true });
    if (await control.isEnabled()) targets.push({ title, ...await hit(control) });
  }
  return { rect, view, targets };
}
async function galleryPictures(page, id, directory, touch) {
  await activate(page.locator(`#${id}-trigger`), touch);
  const dialog = page.locator(`dialog[data-visual-picker="${id}"]`); await dialog.waitFor({ state: 'visible' });
  const search = dialog.locator('input[type="search"]');
  if (await search.count()) await search.fill('');
  const expected = await page.locator(`#sel-${id}`).evaluate(select => [...select.options].map(option => option.value));
  const choices = dialog.locator('button[data-value]');
  const actual = await choices.evaluateAll(cards => cards.map(card => card.dataset.value));
  assert.deepEqual([...actual].sort(), [...expected].sort(), 'Complete unfiltered gallery must expose every actual canonical option');
  await page.screenshot({ path: path.join(directory, `${id}-gallery-top.png`) });
  const pictures = [];
  for (let index = 0; index < await choices.count(); index++) {
    const card = choices.nth(index); await card.scrollIntoViewIfNeeded();
    const image = card.locator('img').first(); await image.waitFor({ state: 'visible' });
    await page.waitForFunction(element => element.complete && element.naturalWidth > 0, await image.elementHandle());
    await image.evaluate(element => element.decode());
    const picture = await card.evaluate(element => {
      const image = element.querySelector('img'), card = element.getBoundingClientRect(), photo = image.getBoundingClientRect();
      return { value: element.dataset.value, label: element.textContent, src: image.currentSrc, attached: image.isConnected,
        naturalWidth: image.naturalWidth, naturalHeight: image.naturalHeight,
        card: { x: card.x, y: card.y, width: card.width, height: card.height },
        photo: { x: photo.x, y: photo.y, width: photo.width, height: photo.height } };
    });
    assert.ok(picture.attached && picture.naturalWidth > 0 && picture.naturalHeight > 0, 'Every actual option needs an attached decoded picture');
    assert.ok(picture.photo.width > 0 && picture.photo.height > 0 && picture.photo.x >= picture.card.x - 1 &&
      picture.photo.y >= picture.card.y - 1 && picture.photo.x + picture.photo.width <= picture.card.x + picture.card.width + 1 &&
      picture.photo.y + picture.photo.height <= picture.card.y + picture.card.height + 1, 'Every decoded preview must fit its own gallery card');
    pictures.push(picture);
  }
  await page.screenshot({ path: path.join(directory, `${id}-gallery-bottom.png`) });
  fs.writeFileSync(path.join(directory, `${id}-gallery.json`), JSON.stringify({ expected, actual, pictures }, null, 2));
  await page.keyboard.press('Escape'); await dialog.waitFor({ state: 'hidden' });
  return { expected, actual, pictures };
}

async function palette(page) {
  return page.evaluate(() => {
    const css = getComputedStyle(document.documentElement), tokens = {};
    for (const key of ['--bg', '--panel', '--raised', '--raised-hi', '--line', '--text', '--text-2', '--accent', '--danger', '--rec']) tokens[key] = css.getPropertyValue(key).trim();
    return tokens;
  });
}
async function pngCapture(page, directory, name, action) {
  const canvas = await page.locator('#viewport canvas').evaluate(element => ({ width: element.width, height: element.height }));
  const download = await fileEventFrom(page, 'download', action), filename = path.join(directory, name);
  await download.saveAs(filename); const png = fs.readFileSync(filename);
  assert.ok(png.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])));
  assert.equal(png.subarray(12, 16).toString('ascii'), 'IHDR'); assert.equal(png.readUInt32BE(8), 13);
  const encoded = { width: png.readUInt32BE(16), height: png.readUInt32BE(20) };
  assert.deepEqual(encoded, canvas, 'Consumer PNG dimensions must match the actual viewport canvas');
  return { suggested: download.suggestedFilename(), filename, canvas, encoded };
}
async function activateAdvancedPanel(page, id, touch = false, key = null) {
  const button = page.locator(`#workspace-panels button[aria-controls="${id}"]`);
  if (!await button.isVisible()) return null;
  const others = async () => page.locator('#panel .floating-window').evaluateAll((roots, chosen) => roots.filter(root => root.id !== chosen).map(root => ({ id: root.id, x: root.getBoundingClientRect().x, y: root.getBoundingClientRect().y, expanded: root.querySelector('.floating-collapse').getAttribute('aria-expanded'), hidden: root.hidden })), id);
  const before = await others(); await hit(button);
  if (key) { await button.focus(); await page.keyboard.press(key); } else await activate(button, touch);
  const root = page.locator(`#${id}`);
  assert.equal(await root.locator('.floating-collapse').getAttribute('aria-expanded'), 'true');
  assert.equal(await root.evaluate(element => element.contains(document.activeElement)), true, 'Native activator must focus the existing panel');
  assert.deepEqual(await others(), before, 'Choosing one panel must not reset/collapse/hide the other windows');
  return { id, input: key || (touch ? 'tap' : 'click'), focused: true, grip: await hit(root.locator('.floating-grip')), others: before };
}
async function openTools(page, touch = false) {
  if (await page.locator('#toggle-menu').getAttribute('aria-expanded') !== 'true') await activate(page.locator('#toggle-menu'), touch);
  const scene = page.locator('#scene-window');
  await activateAdvancedPanel(page, 'scene-window', touch);
  if (await scene.locator('.floating-collapse').getAttribute('aria-expanded') !== 'true') await activate(scene.locator('.floating-collapse'), touch);
  const details = scene.locator('details').filter({ has: page.locator('#reset-workspace') });
  if (!await details.evaluate(element => element.open)) await activate(details.locator(':scope > summary'), touch);
  for (const id of ['reset-workspace', 'toggle-inspector', 'toggle-panels']) await hit(page.locator(`#${id}`));
  if (await page.locator('#fullscreen').isVisible()) await hit(page.locator('#fullscreen'));
}
async function openSceneGroup(page, title, touch = false) {
  if (await page.locator('#toggle-menu').getAttribute('aria-expanded') !== 'true') await activate(page.locator('#toggle-menu'), touch);
  const scene = page.locator('#scene-window');
  await activateAdvancedPanel(page, 'scene-window', touch);
  if (await scene.locator('.floating-collapse').getAttribute('aria-expanded') !== 'true') await activate(scene.locator('.floating-collapse'), touch);
  const summary = scene.locator('summary').filter({ hasText: title }).first();
  if (!await summary.evaluate(element => element.parentElement.open)) await activate(summary, touch);
}
async function enter(page, base, robot, directory) {
  await page.goto(`${base}/?plain&body=stock`, { waitUntil: 'domcontentloaded' });
  const before = await palette(page);
  if (process.env.WORKSPACE_PUBLIC === '1') {
    await page.waitForFunction(() => document.querySelector('#launch-map')?.value === 'map:nt_ghost_ctg');
    assert.equal(await page.locator('#launch-map').inputValue(), 'map:nt_ghost_ctg', 'Fresh public selection retains the required Ghost default before the bounded Flat choice');
    await page.screenshot({ path: path.join(directory, 'public-default-selection.png') });
  }
  await chooseVisual(page, 'launch-map', 'flat'); await page.locator('#launch-next').click();
  await chooseVisual(page, 'launch-robot', robot); await chooseVisual(page, 'launch-character', 'stock');
  await page.locator('#launch-load').click(); await page.locator('#launch-enter:not([disabled])').waitFor({ timeout: 240000 });
  await page.locator('#launch-enter').click(); await page.waitForFunction(() => document.querySelector('#launch-screen').hidden);
  assert.equal(await page.locator('#app').evaluate(element => element.inert), false);
  const frames = await raf(page, 6), after = await palette(page); assert.deepEqual(after, before, 'One actual theme must survive heavy scene import');
  return { before, after, frames };
}
async function timeline(page, directory, { touch = false, small = false, smoke = false } = {}) {
  const beforeDock = await dockProof(page);
  const record = page.getByTitle("Record the robot's motion and your inputs (V)", { exact: true });
  await activate(record, touch); await page.getByTitle('Stop recording and open the timeline (V)', { exact: true }).waitFor();
  await delay(1400); assert.equal(await page.locator('#rec-badge').isVisible(), true, 'Actual recording state stays visible above the dock');
  await activate(page.getByTitle('Stop recording and open the timeline (V)', { exact: true }), touch);
  await page.locator('#deck').waitFor({ state: 'visible' });
  const takeStatus = await page.locator('#record-status').textContent();
  assert.equal(await page.locator('#record-status').isVisible(), true);
  const deck = await page.locator('#deck').boundingBox(), dock = await page.locator('#scene-actions').boundingBox();
  assert.ok(deck.y >= 0 && deck.y + deck.height <= dock.y + 1, 'Actual timeline must stay above core actions, including old bottom-edge placement');
  const play = page.getByTitle('Play / pause (Space)', { exact: true }); await hit(play);
  const accessibleBefore = await play.ariaSnapshot();
  if (await play.getAttribute('aria-pressed') !== 'true') await activate(play, touch);
  const accessiblePlaying = await play.ariaSnapshot(); assert.equal(await play.getAttribute('aria-pressed'), 'true');
  const clockBefore = await page.locator('.dk-clock').textContent();
  const playingFrames = await raf(page, 4);
  await page.waitForFunction(before => document.querySelector('.dk-clock').textContent !== before, clockBefore, { timeout: 30000 });
  const clockAfter = await page.locator('.dk-clock').textContent();
  await activate(play, touch); assert.equal(await play.getAttribute('aria-pressed'), 'false');
  if (smoke) {
    await activate(page.getByTitle('The camera as it moved while recording', { exact: true }), touch);
    const shot = await pngCapture(page, directory, 'public-review.png', () => activate(page.locator('#capture-screenshot'), touch));
    await activate(page.getByTitle('Close the timeline, back to the live sim (Esc)', { exact: true }), touch);
    await page.locator('#deck').waitFor({ state: 'hidden' }); await dockProof(page);
    const frames = await raf(page, 4); await page.screenshot({ path: path.join(directory, 'public-return.png') });
    return { beforeDock, deck, dock, takeStatus, accessibleBefore, accessiblePlaying, clockBefore, clockAfter, playingFrames, shot, frames };
  }
  const icons = [];
  for (const title of transportTitles) {
    const button = page.getByTitle(title, { exact: true }); await hit(button);
    const visual = await button.evaluate(element => {
      const svg = element.querySelector('svg'), rect = svg?.getBoundingClientRect(), css = getComputedStyle(element);
      return { title: element.title, svg: !!svg, width: rect?.width, height: rect?.height, hiddenFromAT: svg?.getAttribute('aria-hidden'), color: css.color, background: css.backgroundColor, pressed: element.getAttribute('aria-pressed') };
    });
    icons.push(visual);
  }
  const loop = page.getByTitle('Loop the range (L)', { exact: true }), wasLoop = await loop.getAttribute('aria-pressed');
  const loopColorBefore = await loop.evaluate(element => getComputedStyle(element).color);
  await activate(loop, touch); assert.notEqual(await loop.getAttribute('aria-pressed'), wasLoop);
  const loopColorToggled = await loop.evaluate(element => getComputedStyle(element).color);
  assert.notEqual(loopColorToggled, loopColorBefore, 'Actual active transport state must visibly differ from inactive state');
  await activate(loop, touch);
  const rangeBefore = await page.locator('.dk-range').textContent();
  for (const title of ['Start of the range (Home)', 'Next input (↓)', 'Previous input (↑)', 'End of the range (End)']) await activate(page.getByTitle(title, { exact: true }), touch);
  await activate(page.getByTitle('Start of the range (Home)', { exact: true }), touch);
  await page.keyboard.press('ArrowRight'); await activate(page.getByTitle('Range start at the playhead (I)', { exact: true }), touch);
  await activate(page.getByTitle('End of the range (End)', { exact: true }), touch);
  await page.keyboard.press('ArrowLeft'); await activate(page.getByTitle('Range end at the playhead (O)', { exact: true }), touch);
  const rangeAfter = await page.locator('.dk-range').textContent();
  assert.notEqual(rangeAfter, rangeBefore, 'Actual In/Out controls must edit the recorded range');
  await activate(page.getByTitle('Clear the range (X)', { exact: true }), touch);
  assert.equal(await page.locator('.dk-range').textContent(), rangeBefore, 'Actual clear-range action restores the complete take');
  await hit(page.getByTitle('The camera as it moved while recording', { exact: true }));
  await activate(page.getByTitle('The camera as it moved while recording', { exact: true }), touch);
  assert.equal(await page.getByRole('radio', { name: 'Recorded', exact: true }).getAttribute('aria-checked'), 'true');
  const shot = await pngCapture(page, directory, 'review-consumer.png', () => activate(page.locator('#capture-screenshot'), touch));
  assert.equal(await page.locator('#scene-actions').isVisible(), true, 'Review never hides the real screenshot/dock surface');
  const take = await fileEventFrom(page, 'download', () => activate(page.getByTitle('Save this take to reopen it later (.take.zip)', { exact: true }), touch));
  const takePath = path.join(directory, 'workspace-real.take.zip'); await take.saveAs(takePath);
  await activate(page.getByTitle('Render the range to MP4 / MOV / WebM / PNG', { exact: true }), touch);
  await page.locator('#export').waitFor({ state: 'visible' }); assert.equal(await page.locator('#scene-actions').isVisible(), false, 'Export owns the interaction surface instead of covering live dock actions');
  assert.equal(await page.locator('#workspace-panels').isVisible(), false, 'Export hides advanced activators alongside the live dock');
  await page.keyboard.press('Escape'); await page.locator('#export').waitFor({ state: 'hidden' });
  await dockProof(page);
  // Every wrapped toolbar action, including bottom-row Close/Save, must be truly reachable.
  const reachable = [];
  for (const title of timelineTitles) reachable.push({ title, ...await hit(page.getByTitle(title, { exact: true })) });
  await page.screenshot({ path: path.join(directory, small ? 'legacy-small-timeline.png' : 'timeline-controls.png') });
  await activate(page.getByTitle('Close the timeline, back to the live sim (Esc)', { exact: true }), touch);
  await page.locator('#deck').waitFor({ state: 'hidden' }); await dockProof(page);
  const chooser = await fileEventFrom(page, 'filechooser', () => activate(page.getByTitle('Open a saved take (.take.zip)', { exact: true }), touch));
  await chooser.setFiles(takePath);
  await page.locator('#deck').waitFor({ state: 'visible', timeout: 120000 }); await dockProof(page);
  await activate(page.getByTitle('Close the timeline, back to the live sim (Esc)', { exact: true }), touch);
  await page.locator('#deck').waitFor({ state: 'hidden' });
  const proof = { beforeDock, deck, dock, takeStatus, icons, accessibleBefore, accessiblePlaying, clockBefore, clockAfter, playingFrames, loopColorBefore, loopColorToggled, rangeBefore, rangeAfter, shot, takePath, reachable, frames: await raf(page, 6) };
  fs.writeFileSync(path.join(directory, 'timeline-proof.json'), JSON.stringify(proof, null, 2));
  return proof;
}

async function desktop(page, base, directory) {
  const launch = await enter(page, base, 'r1', directory), quiet = await dockProof(page);
  assert.equal(await page.locator('#panel').isVisible(), false, 'Fresh scene starts quiet, without advanced panels covering it');
  assert.equal(await page.locator('#inspector').isVisible(), false);
  assert.equal(await page.locator('#workspace-panels').isVisible(), false);
  await page.screenshot({ path: path.join(directory, 'fresh-quiet.png') });
  await page.locator('#terrain-trigger').click(); await page.locator('dialog[data-visual-picker="terrain"]').waitFor({ state: 'visible' });
  const flat = page.locator('dialog[data-visual-picker="terrain"] button[data-value="flat"]'); await flat.focus();
  await page.keyboard.down('Enter'); await page.keyboard.down('Enter'); await page.keyboard.up('Enter');
  assert.equal(await page.locator('dialog[data-visual-picker="terrain"]').isVisible(), false, 'Held selection key must not reopen the gallery');
  await chooseVisual(page, 'robot', 'r1'); await dockProof(page);
  await page.locator('.help-trigger').click(); const help = page.locator('.help-dialog'); await help.waitFor({ state: 'visible' });
  const takeBeforeHelp = await page.locator('#record-status').textContent();
  for (const key of ['v', 'n', 'Space', 'Tab', 'ArrowUp']) await page.keyboard.press(key);
  assert.equal(await help.isVisible(), true); assert.equal(await page.locator('#record-status').textContent(), takeBeforeHelp); assert.equal(await page.locator('#flight-hud').isVisible(), false);
  await page.keyboard.press('Escape'); await help.waitFor({ state: 'hidden' });
  const canvas = page.locator('#viewport canvas'), canvasBox = await canvas.boundingBox();
  await page.mouse.click(canvasBox.x + canvasBox.width * .55, canvasBox.y + canvasBox.height * .35);
  await page.keyboard.press('Tab'); assert.equal(await page.locator('#panel').isVisible(), true);
  await page.keyboard.press('Tab'); assert.equal(await page.locator('#panel').isVisible(), false); await dockProof(page);
  await page.locator('#toggle-menu').click();
  assert.equal(await page.locator('#workspace-panels').isVisible(), false, 'Tall desktop keeps the compact toolbar even with Controls open');
  await hit(page.locator('#policy-trigger'));
  await page.locator('#policy-trigger').click();
  const policies = page.locator('dialog[data-visual-picker="policy"]');
  await policies.waitFor({ state: 'visible' });
  await page.keyboard.press('Escape');
  await policies.waitFor({ state: 'hidden' });
  await page.locator('button[aria-controls="policy-manager"]').click();
  await page.locator('#policy-manager').waitFor({ state: 'visible' });
  const packCards = await page.locator('#policy-manager .pack-card').count();
  await page.getByRole('button', { name: 'Close policy packs', exact: true }).click();
  const referenceCollapse = page.locator('#capture-window .floating-collapse');
  if (await referenceCollapse.getAttribute('aria-expanded') !== 'true') await referenceCollapse.click();
  const csvChooser = await fileEventFrom(page, 'filechooser', () => page.getByRole('button', { name: 'Load CSV…', exact: true }).click());
  await csvChooser.setFiles([]);
  const damping = page.getByRole('radiogroup', { name: 'FSM state', exact: true }).getByRole('radio', { name: 'Damp', exact: true });
  await hit(damping); await damping.click();
  await until(async () => await damping.getAttribute('aria-checked') === 'true', 'Actual worker FSM selection must acknowledge the advanced control');
  await page.getByRole('radiogroup', { name: 'FSM state', exact: true }).getByRole('radio', { name: 'Policy', exact: true }).click();
  await openSceneGroup(page, 'Robot appearance'); await chooseVisual(page, 'robot-colorway', 'product'); await chooseVisual(page, 'robot-colorway', 'grey');
  await page.locator('#source-head-visual-trigger').click(); await page.locator('dialog[data-visual-picker="source-head-visual"]').waitFor({ state: 'visible' }); await page.keyboard.press('Escape');
  await openSceneGroup(page, 'Lighting'); await openSceneGroup(page, 'Render controls'); await openSceneGroup(page, 'Saved views');
  await page.getByRole('textbox', { name: /^View name\b/ }).fill('Workspace view'); await page.getByRole('button', { name: 'Save view', exact: true }).click();
  await page.getByRole('button', { name: 'Workspace view', exact: true }).waitFor();
  await openTools(page); await page.locator('#toggle-inspector').click(); assert.equal(await page.locator('#inspector').isVisible(), true);
  await openTools(page); await page.locator('#toggle-inspector').click(); assert.equal(await page.locator('#inspector').isVisible(), false);
  let fullscreenExercised = false;
  if (await page.locator('#fullscreen').isVisible()) {
    await page.locator('#fullscreen').click(); await page.waitForFunction(() => !!document.fullscreenElement);
    await page.locator('#fullscreen').click(); await page.waitForFunction(() => !document.fullscreenElement); fullscreenExercised = true;
  }
  const grip = page.getByRole('button', { name: 'Move Play panel', exact: true }), initial = await page.locator('#play-window').boundingBox(), gripBox = await grip.boundingBox();
  await page.mouse.move(gripBox.x + gripBox.width / 2, gripBox.y + gripBox.height / 2); await page.mouse.down();
  await page.mouse.move(gripBox.x + gripBox.width / 2 + 90, gripBox.y + gripBox.height / 2 + 40, { steps: 8 }); await page.mouse.up();
  const dragged = await page.locator('#play-window').boundingBox(); assert.ok(dragged.x > initial.x && dragged.y >= initial.y);
  await grip.focus(); await page.keyboard.press('ArrowRight'); await page.keyboard.press('Shift+ArrowDown');
  const keyed = await page.locator('#play-window').boundingBox(); assert.ok(keyed.x > dragged.x); assert.equal(await page.locator('#flight-hud').isVisible(), false);
  await page.getByRole('button', { name: 'Collapse Play panel', exact: true }).click(); await dockProof(page);
  await page.getByRole('button', { name: 'Expand Play panel', exact: true }).click();
  await page.reload(); await launchScene(page, { terrain: 'flat' });
  const restored = await page.locator('#play-window').boundingBox(); assert.ok(Math.abs(restored.x - keyed.x) < 1, 'Real dragged layout must survive reload');
  await openTools(page); await page.locator('#reset-workspace').click();
  await openTools(page); await page.locator('#toggle-panels').click(); assert.equal(await page.locator('#panel').isVisible(), false); await dockProof(page);
  await page.mouse.click(canvasBox.x + canvasBox.width * .55, canvasBox.y + canvasBox.height * .35); await page.keyboard.press('Tab');
  assert.equal(await page.locator('#panel').isVisible(), true, 'Map-focused Tab restores the remembered advanced visibility');
  await page.locator('#toggle-menu').click();
  const media = await timeline(page, directory);
  return { launch, quiet, policy, packCards, initial, dragged, keyed, restored, fullscreenExercised, media };
}
async function narrow(page, base, directory, small) {
  const launch = await enter(page, base, 'go2', directory), dock = await dockProof(page);
  assert.equal(await page.locator('#workspace-panels').isVisible(), false, 'Quiet mode keeps advanced panel navigation hidden');
  await page.screenshot({ path: path.join(directory, 'narrow-quiet.png') });
  const galleries = { terrain: await galleryPictures(page, 'terrain', directory, true), robot: await galleryPictures(page, 'robot', directory, true) };
  const media = await timeline(page, directory, { touch: true, small });
  await openTools(page, true); await page.locator('#reset-workspace').tap();
  assert.equal(await page.locator('#workspace-panels').isVisible(), true, 'Narrow/short Controls provide discoverable existing-panel activation');
  const activators = [];
  for (const [id, key] of [['play-window', null], ['scene-window', 'Enter'], ['capture-window', 'Space']]) {
    activators.push(await activateAdvancedPanel(page, id, true, key));
    const root = page.locator(`#${id}`), rect = await root.boundingBox(), actionDock = await page.locator('#scene-actions').boundingBox();
    assert.ok(rect.y + rect.height <= actionDock.y + 1);
  }
  fs.writeFileSync(path.join(directory, 'native-panel-activation.json'), JSON.stringify(activators, null, 2));
  await page.screenshot({ path: path.join(directory, 'native-panel-activation.png') });
  await openSceneGroup(page, 'Robot appearance', true);
  await page.locator('#robot-colorway-trigger').tap();
  await page.locator('dialog[data-visual-picker="robot-colorway"] button[data-value="product"]').tap();
  const play = page.locator('#play-window');
  await activateAdvancedPanel(page, 'play-window', true);
  if (await play.locator('.floating-collapse').getAttribute('aria-expanded') !== 'true') await play.locator('.floating-collapse').tap();
  await page.getByTitle('Fly the robot through walls; toggle physics (N)', { exact: true }).tap();
  await page.locator('#flight-hud').waitFor({ state: 'visible' });
  assert.equal(await page.locator('#panel').isVisible(), true, 'Flight HUD must remain usable with advanced Controls still open');
  const hud = await page.locator('#flight-hud').boundingBox(), currentDock = await page.locator('#scene-actions').boundingBox();
  assert.ok(hud.y + hud.height <= currentDock.y + 1, 'Actual flight HUD must not cover core actions');
  const hoverBefore = await page.locator('#flight-hover').getAttribute('aria-pressed'), hoverHit = await hit(page.locator('#flight-hover'));
  await page.locator('#flight-hover').tap(); const hoverAfter = await page.locator('#flight-hover').getAttribute('aria-pressed');
  assert.notEqual(hoverAfter, hoverBefore, 'Actual HUD touch must toggle level flight without hiding Controls');
  const exitHit = await hit(page.locator('#flight-exit')); await dockProof(page);
  const hudProof = { hud, currentDock, hoverBefore, hoverAfter, hoverHit, exitHit, controlsOpen: await page.locator('#panel').isVisible() };
  fs.writeFileSync(path.join(directory, 'hud-controls-open.json'), JSON.stringify(hudProof, null, 2));
  await page.screenshot({ path: path.join(directory, 'hud-controls-open.png') });
  await page.locator('#flight-exit').tap(); await page.locator('#flight-hud').waitFor({ state: 'hidden' });
  if (await play.locator('.floating-collapse').getAttribute('aria-expanded') === 'true') await play.locator('.floating-collapse').tap();
  await openTools(page, true); await page.locator('#toggle-panels').tap(); assert.equal(await page.locator('#panel').isVisible(), false); await dockProof(page);
  await page.screenshot({ path: path.join(directory, 'narrow-return.png') });
  return { launch, dock, galleries, media, hudProof, activators };
}
async function legacy(page, base, directory) {
  const launch = await enter(page, base, 'go2', directory);
  assert.equal(await page.locator('#inspector').isVisible(), true, 'Explicit old inspector intent must survive the new quiet default');
  assert.equal(await page.locator('#panel').isVisible(), false, 'Explicit old hidden-menu intent must survive');
  await dockProof(page); await page.locator('#toggle-menu').click();
  assert.equal(await page.locator('#play-window').locator('.floating-body').isVisible(), false, 'Old collapsed advanced panel stays collapsed while core actions remain reachable');
  const placement = await page.locator('#play-window').boundingBox(); assert.ok(Math.abs(placement.x - 84) < 1, 'Valid old horizontal position must not be reset');
  await page.getByRole('button', { name: 'Expand Play panel', exact: true }).click(); await dockProof(page);
  await page.getByRole('button', { name: 'Move Play panel', exact: true }).focus(); await page.keyboard.press('Home');
  await page.screenshot({ path: path.join(directory, 'legacy-intent.png') });
  return { launch, placement, media: await timeline(page, directory) };
}
async function source(page, directory, proxy, result) {
  const initial = proxy.begin('workspace-source-flat'), launch = await enter(page, proxy.url, 'go2', directory);
  proxy.begin('map-failure'); await chooseVisual(page, 'terrain', `map:${MAP}`);
  await page.locator('#map-loading button:not([hidden])').waitFor({ state: 'visible', timeout: 120000 });
  await page.locator('#capture-screenshot').click();
  await page.waitForFunction(() => !document.querySelector('#capture-screenshot').disabled && document.querySelector('#capture-screenshot').getAttribute('aria-busy') !== 'true');
  assert.equal(await page.locator('#screenshot-status').isVisible(), true, 'A real preparation error remains visible in quiet core actions'); await dockProof(page);
  await page.screenshot({ path: path.join(directory, 'real-map-error-dock.png') });
  const recovered = proxy.begin('ownership'); recovered.ownershipStage = 'rebuild';
  await page.locator('#map-loading button').click();
  await until(() => recovered.resources.some(resource => resource.path === mapVisual && resource.held), 'Real retried selected map must be held');
  let preparing;
  const shot = await pngCapture(page, directory, 'real-map-recovered.png', async () => {
    await page.locator('#capture-screenshot').click();
    preparing = { busy: await page.locator('#capture-screenshot').getAttribute('aria-busy'), status: await page.locator('#screenshot-status').textContent(), visible: await page.locator('#screenshot-status').isVisible() };
    assert.equal(preparing.busy, 'true'); assert.equal(preparing.visible, true, 'Actual held-asset preparation status must remain visible');
    recovered.releaseRebuild = true;
  });
  await page.locator('#map-loading').waitFor({ state: 'hidden', timeout: 120000 }); await dockProof(page); await raf(page, 6);
  result.deliberateFailures = proxy.runs.flatMap(run => run.resources.filter(resource => resource.expectedFailure && resource.status === 503).map(resource => resource.path));
  return { launch, preparing, shot, initialRequests: initial.resources.length, runs: proxy.runs };
}

(async () => {
  assert.equal(process.env.WORKSPACE_HANDOFF, '1', 'Actual candidate suite requires explicit owner handoff');
  assert.ok(process.env.BASE_URL && process.env.WORKSPACE_STAGE && process.env.QA_ARTIFACT_DIR, 'Explicit immutable stage, URL and artifact directory required');
  const output = process.env.QA_ARTIFACT_DIR; fs.mkdirSync(output, { recursive: true });
  const names = (process.env.WORKSPACE_SCENARIOS || 'desktop,legacy,mobile320,mobile390,legacy-small,landscape,source').split(','), results = [];
  for (const name of names) {
    assert.ok(['desktop', 'legacy', 'mobile320', 'mobile390', 'legacy-small', 'landscape', 'source', 'smoke'].includes(name));
    const mobile = name.startsWith('mobile') || name === 'legacy-small' || name === 'landscape', small = name === 'legacy-small';
    const viewport = name === 'landscape' ? { width: 844, height: 390 }
      : mobile ? { width: name === 'mobile320' ? 320 : 390, height: small ? 520 : 844 } : { width: 1280, height: 800 };
    const directory = path.join(output, name); fs.mkdirSync(directory, { recursive: true });
    const browser = await chromium.launch({ headless: false, executablePath: process.env.CHROME_EXECUTABLE || '/usr/bin/google-chrome', args: ['--no-sandbox', '--ozone-platform=x11', '--disable-dev-shm-usage', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding'] });
    const context = await browser.newContext({ viewport, deviceScaleFactor: mobile ? 1 : .5, isMobile: mobile, hasTouch: mobile, recordVideo: { dir: path.join(directory, 'video'), size: mobile ? viewport : { width: 960, height: 600 } } });
    if (name === 'legacy') await context.addInitScript(() => {
      localStorage.setItem('ume-panel-visibility', JSON.stringify({ inspector: true, menu: false, restore: { inspector: true, menu: false } }));
      localStorage.setItem('playpen-workspace-v1', JSON.stringify({ 'play-window': { x: 84, y: 114, collapsed: true }, inspector: { x: 470, y: 120, collapsed: false } }));
    });
    if (small) await context.addInitScript(() => {
      localStorage.setItem('playpen-workspace-v1', JSON.stringify({ deck: { x: 12, y: 800, collapsed: false } }));
      localStorage.setItem('ume-deck-h', '120');
    });
    const page = await context.newPage(), errors = [], networkErrors = [], httpErrors = [], consoleErrors = [], warnings = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('requestfailed', request => networkErrors.push({ url: request.url(), error: request.failure()?.errorText }));
    page.on('response', response => { if (response.status() >= 400) httpErrors.push({ url: response.url(), path: new URL(response.url()).pathname, status: response.status() }); });
    page.on('console', message => { if (['error', 'warning'].includes(message.type())) (message.type() === 'error' ? consoleErrors : warnings).push({ text: message.text(), location: message.location() }); });
    const result = { name, viewport, chrome: browser.version(), errors, networkErrors, httpErrors, consoleErrors, warnings, deliberateFailures: [] }; results.push(result);
    let proxy;
    try {
      if (name === 'desktop') result.proof = await desktop(page, process.env.BASE_URL, directory);
      else if (name === 'legacy') result.proof = await legacy(page, process.env.BASE_URL, directory);
      else if (name === 'source') { proxy = await createProxy(process.env.BASE_URL); result.proof = await source(page, directory, proxy, result); }
      else if (name === 'smoke') {
        const launch = await enter(page, process.env.BASE_URL, 'go2', directory);
        await page.locator('.help-trigger').click(); await page.locator('.help-dialog').waitFor({ state: 'visible' });
        const help = await page.locator('.help-dialog').textContent();
        await page.screenshot({ path: path.join(directory, 'smoke-help.png') });
        await page.keyboard.press('Escape'); await page.locator('.help-dialog').waitFor({ state: 'hidden' });
        result.proof = { launch, help, media: await timeline(page, directory, { smoke: true }) };
      }
      else result.proof = await narrow(page, process.env.BASE_URL, directory, small);
      assert.deepEqual(errors, [], 'Actual workspace has no unhandled page errors'); assert.deepEqual(networkErrors, [], 'No transport failures may be hidden');
      assert.ok(httpErrors.every(error => error.status === 503 && result.deliberateFailures.includes(error.path)), 'Only actual deliberately failed real map requests may fail HTTP');
      assert.ok(consoleErrors.every(error => error.location.url && result.deliberateFailures.includes(new URL(error.location.url).pathname) && httpErrors.some(response => response.url === error.location.url && response.status === 503)), 'No console error may be hidden or accepted by message wording');
      result.passed = true;
    } catch (error) {
      result.failure = error.stack;
      if (proxy) for (const run of proxy.runs) { run.releaseRebuild = true; run.releaseLate = true; }
      await page.screenshot({ path: path.join(directory, 'FAILED.png'), timeout: 10000 }).catch(error => { result.failureScreenshot = error.message; });
    } finally {
      await page.close(); result.video = await page.video().path(); await context.close(); await browser.close(); if (proxy) await proxy.close();
      fs.writeFileSync(path.join(output, 'results.json'), JSON.stringify({ stage: process.env.WORKSPACE_STAGE, base: process.env.BASE_URL, results }, null, 2));
    }
    console.log(JSON.stringify({ name, passed: !!result.passed, failure: result.failure }));
  }
  assert.ok(results.every(result => result.passed), 'Actual workspace consumer proof failed; inspect retained diagnostics/video');
})().catch(error => { console.error(error); process.exitCode = 1; });
