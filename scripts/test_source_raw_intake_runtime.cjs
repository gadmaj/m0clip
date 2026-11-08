/** Actual built-App consumer for raw Source intake: owned BSP/GMA/ZIP conformance inputs pass
 * through the real local-map UI, Source inspection worker, assembly worker, worker finalizer and
 * live map commit; refusals, precedence, cancellation/stale selection and saved-shot reattachment
 * use only existing App lifecycles. Inputs are generated owned fixtures
 * (scripts/source_raw_map_fixture.cjs): this is conformance, not genuine-game fidelity or native acceptance.
 * BASE_URL=<immutable built preview> PLAYWRIGHT_MODULE=<playwright> QA_ARTIFACT_DIR=<private dir>
 *   [CHROMIUM_PATH=<chrome>] [HEADLESS=1] xvfb-run -a node scripts/test_source_raw_intake_runtime.cjs
 * The release is reached through the existing loopback proxy (test_startup_overlap.cjs), which
 * relays unchanged bodies and only holds the genuine assembly-worker root response when asked.
 * The release chunk stays byte-identical; the real Ready App is attached through CDP.
 */
'use strict';
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const { readyApp } = require('./attach-ready-app.cjs');
const { launchScene } = require('./launch-scene.cjs');
const artifactPath = require('./test-artifacts.cjs');
const { createProxy } = require('./test_startup_overlap.cjs');
const { makeSourceFixture } = require('./source_raw_map_fixture.cjs');

const base = process.env.BASE_URL;
// Existing local-map install bound (test_source_camera_runtime.cjs); not raised here.
const timeout = 180000;
const MODE = { bsp: 'Source BSP', gma: 'Source GMA', zip: 'Source ZIP' };
const RGBA = { red: [255, 0, 0, 255], green: [0, 255, 0, 255] };
const CHANNEL = { red: 0, green: 1 };
const sha = buffer => crypto.createHash('sha256').update(buffer).digest('hex');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const report = { check: 'test_source_raw_intake_runtime', complete: false,
  scope: 'Owned generated Source conformance fixtures through the actual built App; not genuine-game fidelity, native or release acceptance.',
  base, artifacts: artifactPath(), fixtures: {}, catalogue: null, cases: [],
  errors: { page: [], console: [], failedRequests: [] } };
let finished = false;
function recordFailure(error, phase) {
  const message = error.stack || String(error);
  report.complete = false; process.exitCode = 1;
  if (report.failure) {
    if (message !== report.failure) (report.additionalFailures ??= []).push({ phase, message });
    return;
  }
  report.failure = message; report.firstFailure = { phase, at: Date.now() };
  try {
    fs.writeFileSync(artifactPath('first-failure.json'), JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
  } catch (writeError) {
    report.failureWriteError = writeError.stack || String(writeError);
  }
}
process.once('beforeExit', () => {
  if (!finished) recordFailure(new Error('Raw Source consumer did not finish'), 'beforeExit');
});

async function waitFor(predicate, message, limit = 60000) {
  const deadline = Date.now() + limit;
  for (;;) {
    const value = predicate();
    if (value) return value;
    if (Date.now() >= deadline) throw new Error(message);
    await delay(50);
  }
}

/** Retain the exact owned inputs; assertions below inspect the real App, not fixture copies. */
function fixture(key, options) {
  const value = makeSourceFixture(options);
  const files = [value.selected, ...value.companions].map(file => ({ name: file.name, mimeType: file.mimeType, bytes: file.buffer.length, sha256: sha(file.buffer) }));
  report.fixtures[key] = { options, files, expected: value.expected };
  return value;
}

function watch(page, label) {
  page.on('pageerror', error => report.errors.page.push(`${label}: ${error.stack || error.message}`));
  page.on('console', message => { if (message.type() === 'error') report.errors.console.push({ label, text: message.text(), url: message.location().url }); });
  page.on('requestfailed', request => {
    let path = request.url();
    try { path = new URL(path).pathname; } catch { /* keep the raw URL */ }
    report.errors.failedRequests.push({ label, path, failure: request.failure()?.errorText ?? null });
  });
}

/** Passive observers only: the App's own worker listener and DOM stay untouched. */
async function observe(page) {
  await page.evaluate(() => {
    const a = window.__app;
    const intake = window.__rawIntake = { status: [], models: [{ terrain: a.model?.terrain ?? null, baseQadr: a.model?.baseQadr ?? -1, frames: [], frameCount: 0 }] };
    const ids = new WeakMap(), last = new WeakMap();
    let next = 0;
    const scan = () => {
      for (const dialog of document.querySelectorAll('dialog[data-local-map="true"]')) {
        if (dialog.dataset.gameContent) continue;
        if (!ids.has(dialog)) ids.set(dialog, ++next);
        const text = dialog.querySelector('.local-map-status')?.textContent ?? '';
        if (last.get(dialog) === text) continue;
        last.set(dialog, text);
        intake.status.push({ dialog: ids.get(dialog), title: dialog.getAttribute('aria-label'), text });
      }
    };
    new MutationObserver(scan).observe(document.body, { childList: true, subtree: true, characterData: true });
    a.worker.addEventListener('message', event => {
      const message = event.data;
      if (message?.t === 'model') {
        intake.models.at(-1).frames = [];
        intake.models.push({ terrain: message.desc.terrain ?? null, baseQadr: message.desc.baseQadr, frames: [], frameCount: 0 });
      } else if (message?.t === 'frame') {
        const model = intake.models.at(-1), q = model.baseQadr;
        model.frameCount++;
        model.frames.push([message.clock, q >= 0 && message.qpos?.length > q + 2 ? message.qpos[q + 2] : null]);
        if (model.frames.length > 4096) model.frames.splice(0, model.frames.length - 4096);
      }
    });
  });
}

const scene = page => page.evaluate(() => {
  const a = window.__app, v = a.view, intake = window.__rawIntake;
  return { terrain: a.model?.terrain ?? null, view: a.viewModel?.terrain ?? null, visual: a.mapVisualTerrain ?? null,
    source: v.mapSource?.id ?? null, identity: v.mapSource?.identity ? { ...v.mapSource.identity } : null,
    preparing: !!a.mapPreparing, pending: !!a.pendingMap, review: !!a.timeline?.isOpen,
    models: intake.models.length, frames: intake.models.at(-1).frameCount, resources: v.sourceMaterials.resources.size,
    sessionMaps: [...a.sessionMaps.keys()].sort(),
    options: [...new Set([...document.querySelectorAll('select:not(#launch-map) option')]
      .filter(option => /^map:local-[a-f0-9]{64}$/.test(option.value)).map(option => `${option.value}|${option.text}`))].sort() };
});
const remember = page => page.evaluate(() => { const v = window.__app.view; window.__priorMaterials = v.sourceMaterials; window.__priorTerrain = v.terrainObject; return v.sourceMaterials.resources.size; });
const statusMark = page => page.evaluate(() => window.__rawIntake.status.length);
const statusSince = (page, mark) => page.evaluate(mark => window.__rawIntake.status.slice(mark).map(entry => entry.text), mark);
const pickerClosed = page => page.waitForFunction(() => !document.querySelector('dialog[data-visual-picker="terrain"][open]'), null, { timeout });
async function framesAdvance(page, count = 30) {
  const start = await page.evaluate(() => window.__rawIntake.models.at(-1).frameCount);
  await page.waitForFunction(target => window.__rawIntake.models.at(-1).frameCount >= target, start + count, { timeout: 60000 });
}

async function openLiveDialog(page) {
  await page.locator('#terrain-trigger').click();
  await page.locator('dialog[data-visual-picker="terrain"]').getByRole('button', { name: 'Open local map…', exact: true }).click();
  const local = page.locator('dialog[data-local-map="true"][aria-label="Open local map"]');
  await local.waitFor({ state: 'visible', timeout });
  return local;
}
/** Real format choice and file input; the Source inspection worker lists the candidate map. */
async function chooseMap(local, format, value) {
  const mode = local.getByRole('button', { name: MODE[format], exact: true });
  if (await mode.getAttribute('aria-pressed') !== 'true') await mode.click();
  assert.equal(await mode.getAttribute('aria-pressed'), 'true');
  await local.getByLabel('Map file', { exact: true }).setInputFiles(value.selected);
  const candidates = local.locator('.local-map-candidates button');
  await candidates.first().waitFor({ state: 'visible', timeout });
  assert.equal(await candidates.count(), 1, `${format}: one owned BSP candidate`);
  const text = await candidates.first().textContent();
  await candidates.first().click();
  assert.equal(await candidates.first().getAttribute('aria-pressed'), 'true');
  return text;
}
/** The visible Add archives… action opens the real chooser; mount order is the chooser order. */
async function addCompanions(page, local, companions) {
  const chooser = page.waitForEvent('filechooser', { timeout });
  await local.getByRole('button', { name: 'Add archives…', exact: true }).click();
  await (await chooser).setFiles(companions);
  return local.locator('.local-map-mounts > li > span').allTextContents();
}
/** Click a real dialog action, optionally act while it is in flight, then wait for close or a shown failure. */
async function submit(page, local, name, inFlight) {
  const dialog = await local.elementHandle();
  try {
    await local.getByRole('button', { name, exact: true }).click();
    await inFlight?.();
    await page.waitForFunction(dialog => !dialog.isConnected
      || (!dialog.querySelector('button.primary')?.disabled && !!dialog.querySelector('.local-map-status > p')), dialog, { timeout });
    if (await dialog.evaluate(dialog => !dialog.isConnected)) return { closed: true };
  } finally { await dialog.dispose(); }
  return { closed: false, message: await local.locator('.local-map-status > p').textContent(),
    requirements: await local.locator('.local-map-status li').allTextContents(),
    loadEnabled: await local.locator('button.primary').isEnabled() };
}
async function cancelDialog(page, local) {
  await local.getByRole('button', { name: 'Cancel', exact: true }).click();
  await local.waitFor({ state: 'detached', timeout });
  await pickerClosed(page);
}

/** Commit is the worker's model for the requested local terrain, with its staged visual installed. */
async function waitCommit(page, before) {
  await page.waitForFunction(before => {
    const a = window.__app, v = a.view, model = window.__rawIntake.models.at(-1), terrain = model.terrain ?? '';
    return window.__rawIntake.models.length > before && /^map:local-[a-f0-9]{64}$/.test(terrain) && a.model?.terrain === terrain
      && a.viewModel === a.model && !a.mapPreparing && !a.pendingMap && a.mapVisualTerrain === terrain
      && v.mapSource?.id === terrain.slice(4) && !!v.terrainObject
      && document.querySelector('#overlay')?.classList.contains('hidden') && document.querySelector('#map-loading')?.hidden
      && !document.querySelector('dialog[data-visual-picker="terrain"][open]');
  }, before, { timeout });
}

/** Authored identity, manifest frame, floor material/texels and an actual offscreen draw of the shown map. */
async function proveVisual(page, expected, terrain, label) {
  const proof = await page.evaluate(async ({ expected, terrain }) => {
    const a = window.__app, v = a.view;
    await v.waitForTerrainVisuals();
    if (v.mapSource?.id !== terrain.slice(4)) throw new Error(`Shown map ${v.mapSource?.id} is not ${terrain}`);
    const manifest = await v.mapSource.json('manifest.json');
    const path = texture => texture?.userData?.sourceNativeTexture?.path ?? texture?.name ?? null;
    const texel = texture => { const data = texture?.mipmaps?.[0]?.data ?? texture?.image?.data; return data && data.length >= 4 ? [data[0], data[1], data[2], data[3]] : null; };
    const inside = object => { for (let node = object; node; node = node.parent) if (node === v.terrainObject) return true; return false; };
    const floor = [], materials = new Set();
    for (const entry of v.terrainMaterials) {
      if (!inside(entry.mesh)) continue;
      const geometry = entry.mesh.geometry, elements = geometry.index ? geometry.index.count : geometry.attributes.position.count;
      [entry.original].flat().forEach((material, index) => {
        materials.add(material.name);
        if (material.name !== expected.material) return;
        const triangles = Array.isArray(entry.original)
          ? geometry.groups.filter(group => group.materialIndex === index).reduce((sum, group) => sum + Math.min(group.count, elements - group.start), 0) / 3
          : elements / 3;
        floor.push({ triangles, texture: path(material.map), texel: texel(material.map) });
      });
    }
    const native = [...v.sourceMaterials.resources].filter(texture => texture?.isTexture && path(texture) === expected.texture)
      .map(texture => ({ texel: texel(texture), format: texture.userData.sourceNativeTexture?.format ?? null }));
    const display = v.getDisplay();
    let Perspective = v.camera.constructor;
    while (Object.getPrototypeOf(Perspective)?.prototype?.isPerspectiveCamera) Perspective = Object.getPrototypeOf(Perspective);
    const probe = new Perspective(90, 1, .01, 100);
    probe.up.set(0, 1, 0); probe.position.set(0, 0, .3); probe.lookAt(0, 0, 0); probe.updateProjectionMatrix(); probe.updateMatrixWorld(true);
    let pixel, png;
    v.setDisplay({ ...display, robot: false });
    try {
      v.beginOffscreen(32, 32, { floor: false });
      try {
        v.renderWith(probe);
        const canvas = document.createElement('canvas'); canvas.width = canvas.height = 32;
        const context = canvas.getContext('2d'); context.drawImage(v.renderer.domElement, 0, 0, 32, 32);
        pixel = Array.from(context.getImageData(16, 16, 1, 1).data); png = canvas.toDataURL('image/png');
      } finally { v.endOffscreen(); }
    } finally { v.setDisplay(display); }
    return { identity: v.mapSource.identity ? { ...v.mapSource.identity } : null,
      manifest: { name: manifest.name, game: manifest.game, spawn_source: manifest.spawn_source, spawn_yaw: manifest.spawn_yaw, visibility: manifest.visibility ?? null },
      floor, materials: [...materials].sort(), native, ambient: v.sourceAmbient.available, visibility: !!v.sourceVisibility, pixel, png };
  }, { expected, terrain });
  fs.writeFileSync(artifactPath(`${label}-floor-probe.png`), Buffer.from(proof.png.split(',')[1], 'base64'));
  delete proof.png;
  assert.match(terrain, /^map:local-[a-f0-9]{64}$/);
  assert.deepEqual(proof.identity, { id: terrain.slice(4), fingerprint: terrain.slice(10), name: expected.name, game: expected.game }, `${label}: committed map identity`);
  assert.deepEqual(proof.manifest.spawn_source, expected.origin, `${label}: authored spawn origin`);
  assert.equal(proof.manifest.spawn_yaw, expected.yaw, `${label}: authored spawn yaw`);
  assert.equal(proof.manifest.visibility, 'visibility.json', `${label}: authored visibility packaged`);
  assert.ok(proof.floor.length > 0, `${label}: authored floor material ${expected.material} is rendered (${proof.materials})`);
  assert.equal(proof.floor.reduce((sum, item) => sum + item.triangles, 0), expected.triangles, `${label}: authored floor triangles`);
  for (const item of proof.floor) {
    assert.equal(item.texture, expected.texture, `${label}: floor binds the authored VTF`);
    assert.deepEqual(item.texel, expected.rgba, `${label}: floor texel is the effective ${expected.effectiveColor} asset`);
  }
  assert.ok(proof.native.some(item => item.format !== null && JSON.stringify(item.texel) === JSON.stringify(expected.rgba)), `${label}: native VTF restored with authored texels`);
  assert.equal(proof.ambient, true, `${label}: authored ambient installed`);
  assert.equal(proof.visibility, true, `${label}: authored visibility installed`);
  const channel = CHANNEL[expected.effectiveColor];
  assert.ok(proof.pixel[channel] > 32 && [0, 1, 2].every(index => index === channel || proof.pixel[channel] > proof.pixel[index] + 16),
    `${label}: actual draw of the floor shows ${expected.effectiveColor}: ${proof.pixel}`);
  return proof;
}

/** Map physics is the only worldbody contact on a local map: the robot stays supported by its collision. */
async function proveSimulation(page, expected, terrain, label) {
  await page.waitForFunction(terrain => {
    const model = window.__rawIntake.models.at(-1), frames = model.frames;
    return model.terrain === terrain && frames.length > 1 && frames.at(-1)[0] - frames[0][0] >= 2;
  }, terrain, { timeout: 60000 });
  const proof = await page.evaluate(() => {
    const a = window.__app, m = a.model, frames = window.__rawIntake.models.at(-1).frames;
    let contacts = 0;
    for (let i = 0; i < m.ngeom; i++) if (m.bodyid[i] === 0 && m.contype[i] !== 0 && m.group[i] === 3) contacts++;
    const end = frames.at(-1)[0], settled = frames.filter(([clock]) => clock >= end - .5).map(([, z]) => z);
    return { terrain: m.terrain, hoist: a.hoistOn, contacts, simulated: end - frames[0][0], zStart: frames[0][1],
      zSettled: settled[0], zEnd: frames.at(-1)[1], zMin: Math.min(...settled), finite: settled.every(Number.isFinite) };
  });
  assert.equal(proof.terrain, terrain);
  assert.equal(proof.hoist, false, `${label}: no hoist support`);
  assert.equal(proof.contacts, expected.collision, `${label}: compiled map collision geoms`);
  assert.ok(proof.finite && proof.zMin > .05 && proof.zEnd >= proof.zSettled - .05,
    `${label}: robot base remains supported by the authored floor collision ${JSON.stringify(proof)}`);
  return proof;
}

/** Real live intake through the panel's local-map action, up to the dialog outcome. */
async function liveAttempt(page, { format, value, companions = [], reorder }) {
  const before = await scene(page), priorResources = await remember(page);
  const local = await openLiveDialog(page);
  const candidate = await chooseMap(local, format, value);
  let mounts = [];
  if (companions.length) {
    mounts = await addCompanions(page, local, companions);
    assert.deepEqual(mounts, companions.map(file => file.name.toLowerCase()), 'Mounts keep chooser order');
  }
  if (reorder) {
    await local.getByRole('button', { name: `Move ${reorder} earlier`, exact: true }).click();
    mounts = await local.locator('.local-map-mounts > li > span').allTextContents();
    assert.equal(mounts[0], reorder, 'Visible reorder moves the mount earlier');
  }
  const mark = await statusMark(page);
  const outcome = await submit(page, local, 'Load map');
  return { local, before, priorResources, candidate, mounts, mark, outcome };
}
async function liveCommit(page, label, attempt, expected) {
  assert.equal(attempt.outcome.closed, true, `${label}: ${attempt.outcome.message ?? ''} ${attempt.outcome.requirements ?? ''}`);
  await waitCommit(page, attempt.before.models);
  const statuses = await statusSince(page, attempt.mark);
  const after = await scene(page), terrain = after.terrain;
  assert.equal(after.models, attempt.before.models + 1, `${label}: one live commit`);
  assert.ok(after.sessionMaps.includes(terrain.slice(4)) && after.options.some(option => option.startsWith(`${terrain}|`)), `${label}: session map registered`);
  const priorDisposed = await page.evaluate(() => window.__priorMaterials.resources.size === 0);
  if (attempt.before.source && attempt.before.terrain !== terrain) assert.equal(priorDisposed, true, `${label}: replaced map resources disposed`);
  const visual = await proveVisual(page, expected, terrain, label);
  const simulation = await proveSimulation(page, expected, terrain, label);
  await page.screenshot({ path: artifactPath(`${label}.png`) });
  const result = { label, terrain, fingerprint: terrain.slice(10), candidate: attempt.candidate, mounts: attempt.mounts, statuses, visual, simulation,
    replaced: attempt.before.terrain, priorDisposed };
  report.cases.push(result);
  return result;
}
/** A real refusal leaves the dialog recoverable and the prior live scene, resources and simulation intact. */
async function liveRefusal(page, label, attempt, rows) {
  const { outcome, before } = attempt;
  assert.equal(outcome.closed, false, `${label}: refusal keeps the dialog`);
  assert.equal(outcome.loadEnabled, true, `${label}: user can resolve and retry`);
  for (const row of rows) assert.ok(outcome.requirements.some(text => text.includes(row)), `${label}: requirement ${row} in ${outcome.requirements}`);
  const statuses = await statusSince(page, attempt.mark);
  await framesAdvance(page);
  const after = await scene(page);
  assert.deepEqual({ ...after, frames: 0 }, { ...before, frames: 0 }, `${label}: prior live scene unchanged`);
  assert.ok(after.frames > before.frames, `${label}: prior simulation keeps running`);
  assert.equal(await page.evaluate(size => { const v = window.__app.view; return v.terrainObject === window.__priorTerrain
    && v.sourceMaterials === window.__priorMaterials && v.sourceMaterials.resources.size === size; }, attempt.priorResources), true,
    `${label}: prior visual and resources stay installed`);
  await page.screenshot({ path: artifactPath(`${label}.png`) });
  const result = { label, refused: true, message: outcome.message, requirements: outcome.requirements, statuses, prior: before.terrain };
  report.cases.push(result);
  return result;
}

async function releaseCatalogue(run) {
  const paths = [...new Set(run.resources.map(resource => resource.path).filter(path => /^\/startup-catalogue-[\w-]+\.json$/.test(path)))];
  assert.equal(paths.length, 1, `The release loads one startup catalogue: ${paths}`);
  const response = await fetch(new URL(paths[0], base));
  assert.equal(response.ok, true, 'Startup catalogue is readable from the immutable release');
  const catalogue = await response.json();
  // A realm root is the only executable in its own closure that no member imports.
  const root = group => {
    const files = catalogue.runtime[group];
    const roots = files.filter(key => /\.m?js$/.test(key) && !files.some(other => other !== key && (catalogue.dependencies[other] ?? []).includes(key)));
    assert.equal(roots.length, 1, `${group} has one worker root: ${roots}`);
    return roots[0];
  };
  return { path: paths[0], release: catalogue.release, runtime: new Set(Object.values(catalogue.runtime).flat()),
    metadataRoot: root('sourceMetadata'), assemblyRoot: root('sourceAssembly') };
}

async function lifecycle(browser, proxy, f) {
  const run = proxy.begin('lifecycle');
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 });
  const page = await context.newPage();
  watch(page, 'lifecycle');
  try {
    await page.goto(`${proxy.url}/?plain&body=stock`);
    await launchScene(page, { terrain: 'flat', controls: true });
    await readyApp(page);
    await observe(page);
    const catalogue = await releaseCatalogue(run);
    const initial = await scene(page);
    assert.equal(initial.terrain, 'flat'); assert.equal(initial.source, null);

    // BSP: embedded pak material, authored ambient and visibility.
    const bsp = await liveCommit(page, 'bsp-pak', await liveAttempt(page, { format: 'bsp', value: f.bspRed }), f.bspRed.expected);
    const metadata = run.resources.filter(resource => resource.path === catalogue.metadataRoot);
    const assembly = await waitFor(() => run.resources.find(resource => resource.path === catalogue.assemblyRoot && resource.done), 'Assembly worker root was not loaded from the release');
    assert.ok(metadata.some(resource => resource.status === 200) && assembly.status === 200 && assembly.sha256, 'Both actual Source worker roots come from the release');
    catalogue.assemblySha256 = assembly.sha256;
    catalogue.assemblyBytes = assembly.bytes;
    report.catalogue = { path: catalogue.path, release: catalogue.release, metadataRoot: catalogue.metadataRoot,
      assemblyRoot: catalogue.assemblyRoot, assemblySha256: assembly.sha256, assemblyBytes: assembly.bytes };

    // Actual missing authored ambient: every stage runs, the finalizer refuses, prior BSP stays live.
    const ambient = await liveAttempt(page, { format: 'bsp', value: f.noAmbient });
    await liveRefusal(page, 'missing-ambient', ambient, ['missing-ambient-probes']);
    await cancelDialog(page, ambient.local);
    await proveVisual(page, f.bspRed.expected, bsp.terrain, 'missing-ambient-prior');

    // Actual missing material, then the same dialog resolves it with a real companion archive.
    const material = await liveAttempt(page, { format: 'bsp', value: f.noMaterial });
    await liveRefusal(page, 'missing-material', material, ['missing-material', f.noMaterial.expected.material]);
    const recoveryMounts = await addCompanions(page, material.local, f.greenCompanion.companions);
    assert.deepEqual(recoveryMounts, ['m0clip-companion-green.zip']);
    const recoveryMark = await statusMark(page), recoveryBefore = await scene(page);
    await remember(page);
    await liveCommit(page, 'missing-material-recovered', { ...material, before: recoveryBefore, mark: recoveryMark, mounts: recoveryMounts,
      outcome: await submit(page, material.local, 'Load map') }, f.greenCompanion.expected);

    // The selected BSP's embedded pak wins over an explicit companion with the same paths.
    await liveCommit(page, 'pak-over-companion', await liveAttempt(page, { format: 'bsp', value: f.pakOverCompanion, companions: f.pakOverCompanion.companions }), f.pakOverCompanion.expected);
    // Without a pak, the first ordered companion wins; a visible reorder changes the effective asset.
    const ordered = await liveCommit(page, 'companions-ordered', await liveAttempt(page, { format: 'bsp', value: f.ordered, companions: f.ordered.companions }), f.ordered.expected);
    const reordered = await liveCommit(page, 'companions-reordered', await liveAttempt(page, { format: 'bsp', value: f.ordered, companions: f.ordered.companions,
      reorder: 'm0clip-companion-green.zip' }), f.reordered.expected);
    assert.notEqual(ordered.fingerprint, reordered.fingerprint, 'Mount order changes the converted map content');

    await liveCommit(page, 'gma-pak', await liveAttempt(page, { format: 'gma', value: f.gmaGreen }), f.gmaGreen.expected);
    const zip = await liveCommit(page, 'zip-pak', await liveAttempt(page, { format: 'zip', value: f.zipGreen }), f.zipGreen.expected);

    // Real recording on the live ZIP map persists as a saved shot with its local identity.
    await page.getByTitle("Record the robot's motion and your inputs (V)", { exact: true }).click();
    await page.waitForFunction(() => window.__app.rec?.frames >= 10, null, { timeout });
    await page.getByTitle('Stop recording and open the timeline (V)', { exact: true }).click();
    await page.waitForFunction(terrain => {
      const a = window.__app, state = a.take && a.storedTakes.get(a.take);
      return a.timeline.isOpen && a.take?.meta.terrain === terrain && !!state && state.created && !state.writing && !state.dirty
        && state.previewTimer === undefined && (state.previewFailed || !state.previewDirty) && state.thumbnail === undefined
        && a.shotWrites.size === 0 && /^Saved/.test(document.querySelector('.dk-autosave')?.textContent ?? '');
    }, zip.terrain, { timeout });
    const take = await page.evaluate(() => { const a = window.__app, state = a.storedTakes.get(a.take);
      return { id: state.id, name: state.name, terrain: a.take.meta.terrain, localMap: { ...a.take.meta.localMap }, frames: a.take.n,
        autosave: document.querySelector('.dk-autosave').textContent }; });
    assert.deepEqual(take.localMap, zip.visual.identity, 'Take records the committed local identity');

    // A new document has no session map; the saved shot reattaches through the real Shots → Reattach flow.
    await page.goto(`${proxy.url}/?plain&body=stock`);
    await launchScene(page, { terrain: 'flat', controls: true });
    await readyApp(page);
    await observe(page);
    const fresh = await scene(page);
    assert.deepEqual(fresh.sessionMaps, [], 'Reload drops session-local maps');
    await page.locator('#open-shots').click();
    await page.waitForFunction(() => document.querySelector('.shot-library-grid')?.getAttribute('aria-busy') === 'false', null, { timeout });
    const card = page.locator(`.shot-library-card[data-shot-id="${take.id}"]`);
    assert.match(await card.locator('.shot-library-scene').textContent(), new RegExp(` · ${take.terrain}$`));
    await card.locator('[data-shot-action="open"]').click();
    const reattach = page.locator('dialog[data-local-map="true"][aria-label="Reattach map"]');
    await reattach.waitFor({ state: 'visible', timeout });
    await chooseMap(reattach, 'zip', f.zipRed);
    const wrong = await submit(page, reattach, 'Reattach');
    assert.equal(wrong.closed, false, 'Wrong content cannot reattach the saved map');
    assert.match(wrong.message, /^Different map content\./, 'Wrong content reaches the fingerprint-mismatch guard');
    assert.equal(wrong.loadEnabled, true, 'Wrong content leaves the reattach dialog recoverable');
    const refused = await scene(page);
    assert.equal(refused.review, false); assert.equal(refused.source, null); assert.equal(refused.models, fresh.models);
    await chooseMap(reattach, 'zip', f.zipGreen);
    assert.equal((await submit(page, reattach, 'Reattach')).closed, true);
    await page.waitForFunction(({ terrain, fingerprint }) => {
      const a = window.__app, v = a.view;
      return a.timeline.isOpen && a.take?.meta.terrain === terrain && a.mapVisualTerrain === terrain && !!v.terrainObject
        && v.mapSource?.identity?.fingerprint === fingerprint && !document.querySelector('dialog.shot-library-dialog[open]');
    }, { terrain: take.terrain, fingerprint: take.localMap.fingerprint }, { timeout });
    const reviewVisual = await proveVisual(page, f.zipGreen.expected, take.terrain, 'saved-shot-reattached');
    const reviewed = await scene(page);
    assert.equal(reviewed.terrain, 'flat', 'Opening a saved shot reviews its map without replacing live physics');
    assert.ok(reviewed.sessionMaps.includes(take.terrain.slice(4)) && reviewed.options.some(option => option.startsWith(`${take.terrain}|`)));
    await page.screenshot({ path: artifactPath('saved-shot-reattached.png') });
    report.cases.push({ label: 'saved-shot-reattach', take, wrongContent: wrong.message, visual: reviewVisual, review: reviewed });
    return { catalogue, ordered: ordered.fingerprint, reordered: reordered.fingerprint };
  } catch (error) {
    recordFailure(error, 'lifecycle'); throw error;
  } finally { await context.close(); }
}

/** Fresh cache: the genuine assembly-worker root response is held, then continued unchanged. */
async function heldWorker(browser, proxy, gates, f, shared) {
  const run = proxy.begin('held-worker'), root = shared.catalogue.assemblyRoot;
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 });
  const page = await context.newPage();
  watch(page, 'held-worker');
  const gate = { released: false, afterBytes: 0, status: 200 };
  try {
    await page.goto(`${proxy.url}/?plain&body=stock`);
    await launchScene(page, { terrain: 'flat', controls: true });
    await readyApp(page);
    await observe(page);
    assert.equal(run.resources.filter(resource => resource.path === root).length, 0, 'Fresh context has not requested the assembly worker');
    gates.set(root, gate);
    const initial = await scene(page);

    // Cancellation while the real conversion worker cannot start.
    const local = await openLiveDialog(page);
    await chooseMap(local, 'bsp', f.bspRed);
    let clicked = Date.now();
    await local.getByRole('button', { name: 'Load map', exact: true }).click();
    await waitFor(() => run.resources.find(resource => resource.path === root && resource.held && resource.started >= clicked), 'Assembly worker root request was not held');
    await cancelDialog(page, local);
    const cancelled = await scene(page);
    assert.deepEqual({ ...cancelled, frames: 0 }, { ...initial, frames: 0 }, 'Cancelled conversion installs nothing');

    // Stale selection: reorder mounts while a held conversion is in flight; the replacement wins.
    const stale = await openLiveDialog(page);
    await chooseMap(stale, 'bsp', f.ordered);
    assert.deepEqual(await addCompanions(page, stale, f.ordered.companions), ['m0clip-companion-red.zip', 'm0clip-companion-green.zip']);
    clicked = Date.now();
    await stale.getByRole('button', { name: 'Load map', exact: true }).click();
    await waitFor(() => run.resources.find(resource => resource.path === root && resource.held && resource.started >= clicked), 'Stale assembly worker request was not held');
    await stale.getByRole('button', { name: 'Move m0clip-companion-green.zip earlier', exact: true }).click();
    assert.deepEqual(await stale.locator('.local-map-mounts > li > span').allTextContents(), ['m0clip-companion-green.zip', 'm0clip-companion-red.zip']);
    await remember(page);
    const outcome = await submit(page, stale, 'Load map', () => { gate.released = true; });
    assert.equal(outcome.closed, true, `Replacement conversion: ${outcome.message ?? ''} ${outcome.requirements ?? ''}`);
    await waitCommit(page, cancelled.models);
    const after = await scene(page);
    assert.equal(after.models, cancelled.models + 1, 'Exactly one commit from the replacement');
    assert.equal(after.terrain.slice(10), shared.reordered, 'Replacement mount order is committed');
    assert.notEqual(after.terrain.slice(10), shared.ordered, 'Stale mount order never commits');
    const visual = await proveVisual(page, f.reordered.expected, after.terrain, 'stale-replacement');
    await framesAdvance(page);
    assert.equal((await scene(page)).models, after.models, 'Continued held responses cause no later commit');
    const roots = run.resources.filter(resource => resource.path === root).map(({ started, held, heldAt, releasedAt, clientClosedAt, status, bytes, sha256, done }) =>
      ({ started, held: !!held, heldAt, releasedAt, clientClosedAt, status, bytes, sha256, done }));
    assert.ok(roots.filter(resource => resource.held).length >= 2, 'Both cancellation and stale conversions were genuinely held');
    // HTTP 206 hashes cover a requested range, not the complete worker body.
    const complete = roots.filter(resource => resource.status === 200);
    assert.ok(complete.some(resource => resource.done && resource.bytes === shared.catalogue.assemblyBytes), 'A complete genuine worker body was delivered');
    for (const resource of complete) assert.equal(resource.sha256, shared.catalogue.assemblySha256, 'Complete worker body is unchanged');
    await page.screenshot({ path: artifactPath('stale-replacement.png') });
    report.cases.push({ label: 'held-cancel-and-stale', cancelled: { terrain: cancelled.terrain, models: cancelled.models },
      committed: after.terrain, visual, roots });
  } catch (error) {
    recordFailure(error, 'held-worker'); throw error;
  } finally {
    gate.released = true; gates.delete(root);
    await context.close();
  }
}

(async () => {
  assert.ok(base, 'BASE_URL must identify the explicit immutable built App');
  const f = {
    bspRed: fixture('bspRed', { format: 'bsp', pakColor: 'red' }),
    noAmbient: fixture('noAmbient', { format: 'bsp', pakColor: 'red', ambient: false }),
    noMaterial: fixture('noMaterial', { format: 'bsp', pakColor: null }),
    greenCompanion: fixture('greenCompanion', { format: 'bsp', pakColor: null, companionColors: ['green'] }),
    pakOverCompanion: fixture('pakOverCompanion', { format: 'bsp', pakColor: 'red', companionColors: ['green'] }),
    ordered: fixture('ordered', { format: 'bsp', pakColor: null, companionColors: ['red', 'green'] }),
    reordered: fixture('reordered', { format: 'bsp', pakColor: null, companionColors: ['green', 'red'] }),
    gmaGreen: fixture('gmaGreen', { format: 'gma', pakColor: 'green' }),
    zipGreen: fixture('zipGreen', { format: 'zip', pakColor: 'green' }),
    zipRed: fixture('zipRed', { format: 'zip', pakColor: 'red' }),
  };

  const gates = new Map();
  const proxy = await createProxy(base, { gates, timing: { engineHoldMs: 0, engineStreamMs: 0, selectedZipStreamMs: 0, selectedMapStreamMs: 0, steps: 1 } });
  let browser;
  try {
    browser = await chromium.launch({ headless: process.env.HEADLESS === '1', executablePath: process.env.CHROMIUM_PATH, args: ['--no-sandbox', '--ozone-platform=x11'] });
    const shared = await lifecycle(browser, proxy, f);
    await heldWorker(browser, proxy, gates, f, shared);
    assert.deepEqual(report.errors.page, [], 'No page errors');
    assert.deepEqual(report.errors.console.filter(entry => /shader|WebGLProgram/.test(entry.text)), [], 'No shader errors');
    const runtimeFailures = report.errors.failedRequests.filter(entry => shared.catalogue.runtime.has(entry.path)
      && !(entry.label === 'held-worker' && entry.path === shared.catalogue.assemblyRoot && entry.failure === 'net::ERR_ABORTED'));
    assert.deepEqual(runtimeFailures, [], 'Only deliberately held, cancelled worker roots may abort');
    report.complete = true;
  } catch (error) {
    recordFailure(error, 'main');
  } finally {
    const cleanup = await Promise.allSettled([browser?.close(), proxy.close()]);
    for (const result of cleanup) if (result.status === 'rejected') recordFailure(result.reason, 'cleanup');
    report.proxy = proxy.runs.map(run => ({ name: run.name, requests: run.resources.length,
      held: run.resources.filter(resource => resource.held).map(({ path, heldAt, releasedAt, clientClosedAt }) => ({ path, heldAt, releasedAt, clientClosedAt })) }));
    const resultsPath = artifactPath('results.json');
    fs.writeFileSync(resultsPath, JSON.stringify(report, null, 2) + '\n');
    console.log(JSON.stringify({ check: report.check, complete: report.complete, cases: report.cases.map(item => item.label),
      resultsPath, artifacts: report.artifacts, failure: report.failure }));
    finished = true;
  }
})();
