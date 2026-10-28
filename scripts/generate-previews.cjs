'use strict';

/** Generate real scene images into explicit private staging.
 * BASE_URL=https://your-gallery-release.example PREVIEW_OUTPUT=/private/new-directory PLAYWRIGHT_MODULE=/path/to/playwright node scripts/generate-previews.cjs
 * PREVIEW_ONLY is an explicit filename regex for repairing failed items; existing successes
 * remain in the private manifest. Each scene owns one isolated Chrome process/storage profile.
 */
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const { chooseVisual } = require('./choose-visual.cjs');
const attachReadyApp = require('./attach-ready-app.cjs');
const root = path.resolve(__dirname, '..');
const out = process.env.PREVIEW_OUTPUT && path.resolve(process.env.PREVIEW_OUTPUT);
if (!out || out === path.join(root, 'public') || out.startsWith(path.join(root, 'public') + path.sep)) throw new Error('PREVIEW_OUTPUT must name private staging outside public assets');
const base = process.env.BASE_URL;
if (!base) throw new Error('BASE_URL must name a deployed gallery-enabled release');
const width = 320, height = 240, timeout = 300000;
const robots = ['r1', 'r1_air', 'r1_air_edu', 'g1', 'g1_air', 'go2'];
const styles = ['stock', 'boxy', 'round', 'prism'];
const builtins = ['flat', 'rough', 'slope', 'stairs', 'park'];
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const selected = filename => !process.env.PREVIEW_ONLY || new RegExp(process.env.PREVIEW_ONLY).test(filename);


async function launch(robot, terrain) {
  const args = process.env.PREVIEW_CHROME_ARGS ? JSON.parse(process.env.PREVIEW_CHROME_ARGS)
    : ['--no-sandbox', '--use-gl=angle', '--use-angle=gl', '--ignore-gpu-blocklist'];
  if (!Array.isArray(args) || !args.every(value => typeof value === 'string')) throw new Error('PREVIEW_CHROME_ARGS must be a JSON string array');
  const browser = await chromium.launch({
    headless: process.env.PREVIEW_HEADLESS !== '0', executablePath: process.env.CHROMIUM_PATH || '/usr/bin/google-chrome',
    args,
  });
  try {
    const context = await browser.newContext({ viewport: { width: 1280, height: 960 }, deviceScaleFactor: .25 });
    const page = await context.newPage(), errors = [], provenance = {};
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => {
      if (message.type() === 'error' && /shader|WebGLProgram|context.*lost/i.test(message.text())) errors.push(message.text());
    });
    const provenanceJobs = [];
    page.on('response', response => {
      if (!/\/assets\/main-[^/]+\.js$/.test(new URL(response.url()).pathname)) return;
      const pending = response.body().then(bytes => {
        (provenance.sources ??= []).push({ url: response.url(), bytes: bytes.length, sha256: hash(bytes), responseMutated: false });
      });
      provenanceJobs.push(pending);
      void pending.catch(error => errors.push('Source provenance: ' + error.message));
    });
    // Seed exact remembered identity and policy opt-out before application startup.
    // A fresh nonpersistent browser context means no visitor preferences are read or changed.
    await page.route('**/__preview_storage__', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Isolated preview storage</title>' }));
    await page.goto(base + '/__preview_storage__');
    await page.evaluate(async ({ robot, terrain }) => {
      await new Promise((resolve, reject) => {
        const request = indexedDB.open('ume-default-packs', 1);
        request.onupgradeneeded = () => request.result.createObjectStore('settings');
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
          const db = request.result, transaction = db.transaction('settings', 'readwrite');
          transaction.objectStore('settings').put(true, 'r1-default-v1');
          transaction.oncomplete = () => { db.close(); resolve(); };
          transaction.onerror = () => reject(transaction.error);
        };
      });
      localStorage.setItem('ume-source-body-default-v1', '1');
      localStorage.setItem('ume-prefs', JSON.stringify({ robot, terrain }));
    }, { robot, terrain });
    await page.goto(base + '/?plain&body=stock', { timeout });
    await page.locator('#launch-map-trigger').waitFor({ state: 'visible', timeout });
    await page.waitForFunction(terrain => [...document.querySelector('#launch-map').options].some(option => option.value === terrain), terrain, { timeout });
    await chooseVisual(page, 'launch-map', terrain);
    await page.locator('#launch-next').click();
    await chooseVisual(page, 'launch-robot', robot);
    await chooseVisual(page, 'launch-character', 'stock');
    await page.locator('#launch-load').click();
    await page.waitForFunction(() => {
      const message = document.querySelector('#overlay-msg');
      if (message?.dataset.kind === 'error') throw new Error(message.textContent);
      const enter = document.querySelector('#launch-enter');
      return enter && !enter.hidden && !enter.disabled;
    }, null, { timeout });
    provenance.app = await attachReadyApp(context, page);
    await Promise.all(provenanceJobs);
    await page.locator('#launch-enter').click();
    const identity = await page.evaluate(async () => {
      const a = window.__app;
      await Promise.all([a.view.waitForRobotVisuals(), a.view.waitForTerrainVisuals()]);
      a.view.sync(a.lastFrame.xpos, a.lastFrame.xmat);
      a.view.controls.enabled = false;
      a.view.highlight(null);
      a.view.setSourceTime(0);
      const gl = a.view.renderer.getContext();
      const debug = gl.getExtension('WEBGL_debug_renderer_info');
      return { robot: a.model.robot, viewRobot: a.viewModel.robot, terrain: a.model.terrain || a.panel.terrain,
        artwork: { viewport: { width: innerWidth, height: innerHeight }, dpr: devicePixelRatio,
          drawingBuffer: { width: gl.drawingBufferWidth, height: gl.drawingBufferHeight },
          vendor: String(gl.getParameter(debug ? debug.UNMASKED_VENDOR_WEBGL : gl.VENDOR)),
          renderer: String(gl.getParameter(debug ? debug.UNMASKED_RENDERER_WEBGL : gl.RENDERER)),
          offscreen: { width: 320, height: 240 }, nativeUIPerformanceQualification: false } };
    });
    if (identity.robot !== robot || identity.viewRobot !== robot || identity.terrain !== terrain) throw new Error('Scene identity mismatch: ' + JSON.stringify(identity));
    return { browser, page, errors, provenance, identity };
  } catch (error) { await browser.close(); throw error; }
}

async function capture(scene, request) {
  // Character presets must travel through the same visible UI as a visitor.
  // Reset capture state before choosing; never overwrite the selected preset afterward.
  if (request.kind === 'character') {
    await scene.page.evaluate(async () => {
      const v = window.__app.view;
      v.setAppearance({ colorway: 'grey', parts: {}, sourceBody: 'stock', modules: {} });
      await v.setSourceHead('stock');
      await v.waitForRobotVisuals();
    });
    if (await scene.page.locator('#toggle-menu').getAttribute('aria-expanded') === 'false') {
      await scene.page.locator('#toggle-menu').click();
    }
    const appearance = scene.page.locator('#panel details').filter({ has: scene.page.locator(':scope > summary', { hasText: /^Robot appearance$/ }) });
    if (await appearance.getAttribute('open') === null) await appearance.locator(':scope > summary').click();
    await chooseVisual(scene.page, 'character', request.style);
  }
  const result = await scene.page.evaluate(async ({ request, width, height }) => {
    const a = window.__app, v = a.view;
    const original = { colorway: 'grey', parts: {}, sourceBody: 'stock', modules: {} };
    if (request.kind === 'robot' || request.kind === 'character' || request.kind === 'body' || request.kind === 'head' || request.kind === 'policy') {
      if (request.kind !== 'character') {
        v.setAppearance(original);
        await v.setSourceHead('stock');
        await v.waitForRobotVisuals();
      }
      if (request.kind === 'body' && request.value === 'dog') v.setAppearance({ ...original, sourceBody: 'dog', sourceBodyColorway: 'model' });
      if (request.kind === 'head') await v.setSourceHead(request.value);
      await v.waitForRobotVisuals();
      v.sync(a.lastFrame.xpos, a.lastFrame.xmat);
      v.setRobotOpacityOverride(1);
      v.setDisplay({ textures: true, wireframe: false, map: true, robot: true, decals: true });
    } else v.setDisplay({ textures: true, wireframe: false, map: true, robot: false, decals: true });
    const camera = v.camera.clone();
    camera.aspect = width / height;
    camera.fov = request.kind === 'map' ? 75 : 38;
    camera.updateProjectionMatrix();
    const center = camera.position.clone().set(0, 0, 0);
    if (request.kind === 'map') {
      // The importer places the authored player spawn at local origin and rotates
      // its forward direction to +x. Keep every prop/material/detail enabled.
      camera.position.set(0, 0, 1.65);
      center.set(12, 0, 1.65);
      camera.lookAt(center);
    } else if (request.kind === 'terrain') {
      center.set(request.value === 'park' ? 2 : request.value === 'stairs' ? 1.8 : 0, request.value === 'park' ? 3 : 0, .2);
      camera.position.copy(center).add(camera.position.clone().set(7, -9, 7).multiplyScalar(request.value === 'park' ? 1.15 : .7));
      camera.lookAt(center);
    } else {
      v.scene.updateMatrixWorld(true);
      let bounds = null, count = 0;
      const include = mesh => {
        if (!mesh.isMesh || !mesh.geometry) return;
        mesh.geometry.computeBoundingBox();
        const box = mesh.geometry.boundingBox.clone().applyMatrix4(mesh.matrixWorld);
        if (bounds) bounds.union(box); else bounds = box;
        count++;
      };
      if (request.kind === 'head') {
        const head = v.parts.get('head_yaw_link');
        if (!head) throw new Error('R1 head geometry is unavailable');
        head.mesh.traverse(include);
      } else if (v.sourceBody) v.sourceBody.root.traverse(include);
      else for (const mesh of v.geomMeshes) if (mesh?.userData.robotGeom) mesh.traverse(include);
      if (!bounds || !count) throw new Error('No actual robot geometry to frame');
      bounds.getCenter(center);
      const size = bounds.getSize(center.clone());
      const distance = Math.max(size.z, size.x * .8, size.y) / (2 * Math.tan(camera.fov * Math.PI / 360)) * 1.5;
      camera.position.copy(center).add(center.clone().set(1, -1.45, .6).normalize().multiplyScalar(distance));
      camera.lookAt(center);
      if (request.angle !== undefined) {
        camera.position.copy(center).add(center.clone().set(Math.cos(request.angle), Math.sin(request.angle), .3).normalize().multiplyScalar(distance));
        camera.lookAt(center);
      }
    }
    camera.updateMatrixWorld(true);
    v.beginOffscreen(width, height);
    try {
      v.renderWith(camera);
      if (v.renderer.getContext().isContextLost()) throw new Error('WebGL context lost during capture');
      const format = request.format === 'png' ? 'png' : 'webp';
      const data = v.renderer.domElement.toDataURL(`image/${format}`, .88);
      if (!data.startsWith(`data:image/${format};base64,`)) throw new Error(`Chrome did not encode ${format}`);
      const bitmap = await createImageBitmap(await (await fetch(data)).blob());
      const canvas = document.createElement('canvas'); canvas.width = bitmap.width; canvas.height = bitmap.height;
      const context = canvas.getContext('2d'); context.drawImage(bitmap, 0, 0); bitmap.close();
      const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data, colors = new Set();
      for (let i = 0; i < pixels.length; i += 4) colors.add((pixels[i] << 16) | (pixels[i + 1] << 8) | pixels[i + 2]);
      if (canvas.width !== width || canvas.height !== height || colors.size < 100) throw new Error(`Invalid decoded scene: ${canvas.width}x${canvas.height}, ${colors.size} colors`);
      let mapMeshes = 0;
      v.terrainObject?.traverse(mesh => { if (mesh.isMesh) mapMeshes++; });
      return { data, width: canvas.width, height: canvas.height, colors: colors.size,
        camera: { position: camera.position.toArray(), target: center.toArray(), fov: camera.fov },
        appearance: v.getAppearance(), sourceHead: v.getSourceHead(), sourceBody: v.getBodyVisualState().applied,
        mapMeshes, sourceMaterials: v.sourceMaterials.resources.size, programs: v.renderer.info.programs.length };
    } finally { v.endOffscreen(); }
  }, { request, width, height });
  if (scene.errors.length) throw new Error(scene.errors.join('; '));
  const bytes = Buffer.from(result.data.split(',')[1], 'base64'); delete result.data;
  if (request.format !== 'png' && (bytes.toString('ascii', 0, 4) !== 'RIFF' || bytes.toString('ascii', 8, 12) !== 'WEBP')) throw new Error('Encoded file is not WebP');
  if (scene.beforeWrite) await scene.beforeWrite(bytes.length);
  await fs.writeFile(path.join(out, request.filename), bytes);
  return { ...request, ...result, bytes: bytes.length, sha256: hash(bytes), scene: scene.identity, release: scene.provenance, errors: [] };
}

module.exports = { launch, capture };

if (require.main === module) (async () => {
  await fs.mkdir(out, { recursive: true });
  const maps = JSON.parse(await fs.readFile(path.join(root, 'public/assets/maps/index.json'), 'utf8')).maps;
  const groups = robots.map(robot => ({ robot, terrain: 'flat', requests: [
    { kind: 'robot', robot, sourceId: robot, filename: `robot-${robot}.webp` },
    ...styles.map(style => ({ kind: 'character', robot, style, sourceId: `${robot}:${style}`, filename: `character-${robot}-${style}.webp` })),
    ...(robot === 'r1' ? ['stock', 'dog'].map(value => ({ kind: 'body', robot, value, sourceId: value === 'dog' ? 'halflife2-dog' : 'r1', filename: `body-${value}.webp` })) : []),
    ...(robot === 'r1' ? ['stock', 'ghost'].map(value => ({ kind: 'head', robot, value, sourceId: value === 'ghost' ? 'neotokyo-girlbot:girlbot_head.mdl' : 'r1:head_yaw_link', filename: `head-${value}.webp` })) : []),
  ] }));
  groups.push(...builtins.map(value => ({ robot: 'r1', terrain: value, requests: [{ kind: 'terrain', value, sourceId: value, filename: `terrain-${value}.webp` }] })));
  groups.push(...maps.map(map => ({ robot: 'r1', terrain: 'map:' + map.id, requests: [{ kind: 'map', value: map.id, sourceId: map.id, filename: `map-${map.id}.webp` }] })));
  const expected = groups.flatMap(group => group.requests.map(request => request.filename));
  if (expected.length !== 63 || new Set(expected).size !== 63) throw new Error('Gallery contract requires exactly 63 distinct images');
  const manifestPath = path.join(out, 'manifest.json');
  let previous = {};
  try { previous = JSON.parse(await fs.readFile(manifestPath, 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const entries = new Map((previous.images || []).filter(entry => expected.includes(entry.filename)).map(entry => [entry.filename, entry]));
  const save = async () => {
    const images = expected.map(filename => entries.get(filename)).filter(Boolean);
    const successful = images.filter(image => !image.error).length;
    await fs.writeFile(manifestPath, JSON.stringify({ generator: 'scripts/generate-previews.cjs', generatedAt: new Date().toISOString(), baseURL: base,
      encoding: 'image/webp', width, height, expected: expected.length, successful, complete: successful === expected.length,
      provenance: 'Actual app SceneView geometry, native Source materials/full props, isolated nonpersistent Chrome storage; only App exposure response instrumentation. Exact physics robot identities checked. Authored player-spawn map view, deterministic source time 0. The current generator uses visible launch and Character galleries; retained frozen-release images identify their original capture source by per-image release hashes. No model downloads outside existing hosted assets.',
      images }, null, 2) + '\n');
  };
  for (const group of groups) {
    const requests = group.requests.filter(request => selected(request.filename));
    if (!requests.length) continue;
    console.log(`Loading ${group.robot} / ${group.terrain}`);
    let scene;
    try { scene = await launch(group.robot, group.terrain); }
    catch (error) {
      for (const request of requests) entries.set(request.filename, { ...request, error: error.message });
      console.error(error.message); await save(); continue;
    }
    try {
      for (const request of requests) {
        try { entries.set(request.filename, await capture(scene, request)); console.log(`Rendered ${request.filename}`); }
        catch (error) { entries.set(request.filename, { ...request, error: error.message }); console.error(`${request.filename}: ${error.message}`); }
        await save();
      }
    } finally { await scene.browser.close(); }
  }
  await save();
  const missing = expected.filter(filename => !entries.has(filename) || entries.get(filename).error);
  console.log(JSON.stringify({ expected: expected.length, successful: expected.length - missing.length, missing, manifest: manifestPath }));
  if (missing.length) process.exitCode = 1;
})().catch(error => { console.error(error); process.exitCode = 1; });
