/** Pure camera framing used by export setup: genuine live poses, no synthetic take. */
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdir, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import * as THREE from 'three';

const dir = resolve('node_modules/.cache'), file = resolve(dir, 'export-setup-test.mjs');
await mkdir(dir, { recursive: true });
try {
  await build({ stdin: { contents: "export {applyStaticShot,grabShotView,defaultShot,vfov} from './src/record/shot';export {ExportDialog,defaultPrefs} from './src/record/export-dialog';", resolveDir: process.cwd() },
    bundle: true, packages: 'external', format: 'esm', platform: 'node', outfile: file });
  const { applyStaticShot, grabShotView, defaultShot, vfov, ExportDialog, defaultPrefs } = await import(file);
  const shot = { ...defaultShot(.73), distance: 4.25, azimuth: -37, elevation: 22, focal: 85, sensor: 24.89 };
  const base = [17, -8, 2.4], target = new THREE.Vector3(base[0], base[1], shot.height);
  const az = shot.azimuth * Math.PI / 180, el = shot.elevation * Math.PI / 180;
  const expected = new THREE.Vector3(target.x + shot.distance * Math.cos(el) * Math.cos(az),
    target.y + shot.distance * Math.cos(el) * Math.sin(az), target.z + shot.distance * Math.sin(el));
  const camera = new THREE.PerspectiveCamera();
  for (const mode of ['follow', 'fixed', 'orbit']) for (const aspect of [16 / 9, 9 / 16, 1]) {
    const settings = { ...shot, mode };
    applyStaticShot(camera, settings, base, aspect);
    assert.ok(camera.position.distanceTo(expected) < 1e-12, mode + ' uses real scene position and phase-zero framing');
    assert.ok(camera.getWorldDirection(new THREE.Vector3()).angleTo(target.clone().sub(expected)) < 1e-7);
    assert.equal(camera.aspect, aspect);
    assert.equal(camera.fov, vfov(shot.focal, shot.sensor, aspect));
    assert.deepEqual(camera.up.toArray(), [0, 0, 1]);
    assert.ok(camera.projectionMatrix.elements.every(Number.isFinite));
    assert.deepEqual(settings, { ...shot, mode }, 'preview does not change settings');
  }
  assert.deepEqual(base, [17, -8, 2.4], 'live pose is not mutated');
  assert.deepEqual(grabShotView(expected, target), { distance: 4.25, azimuth: -37, elevation: 22, height: .73 });
  assert.deepEqual(grabShotView(expected, target, .25), { distance: 4.25, azimuth: -37, elevation: 22, height: .48 });
  assert.deepEqual(grabShotView(target, target), { distance: 1, azimuth: 0, elevation: 0, height: .73 });

  const viewport = new THREE.PerspectiveCamera(61, 1.4, .05, 500);
  viewport.up.set(0, 0, 1); viewport.position.set(-9, 3, 1.7); viewport.lookAt(2, -1, .9);
  viewport.rotateZ(.43); viewport.updateMatrixWorld();
  const original = { position: viewport.position.toArray(), quaternion: viewport.quaternion.toArray(), fov: viewport.fov };
  applyStaticShot(camera, { ...shot, mode: 'viewport' }, base, 9 / 16, viewport);
  assert.deepEqual(camera.position.toArray(), original.position);
  assert.ok(camera.quaternion.angleTo(viewport.quaternion) < 1e-7, 'genuine viewport bank is retained');
  assert.equal(camera.fov, vfov(shot.focal, shot.sensor, 9 / 16), 'configured lens applies to the real viewport transform');
  assert.deepEqual({ position: viewport.position.toArray(), quaternion: viewport.quaternion.toArray(), fov: viewport.fov }, original);
  const position = camera.position.toArray(), quaternion = camera.quaternion.toArray();
  applyStaticShot(camera, { ...shot, mode: 'viewport' }, base, 1);
  assert.deepEqual(camera.position.toArray(), position, 'without a viewport argument the existing genuine transform remains');
  assert.deepEqual(camera.quaternion.toArray(), quaternion);

  // A pending capability result belongs to the newest controls, not an old tab's detached select.
  const dialog = Object.create(ExportDialog.prototype), out = defaultPrefs();
  let finishProbe;
  const result = new Promise(resolve => { finishProbe = resolve; });
  Object.assign(dialog, { root: { hidden: false }, out, renderVersion: 1, tab: 'video', busy: null,
    probeRequest: { key: `${out.width}x${out.height}@${out.fps}`, result }, supported: null, say() {} });
  let staleRefills = 0, currentRefills = 0;
  const staleProbe = dialog.probe(() => { staleRefills++; });
  dialog.renderVersion++;
  const currentProbe = dialog.probe(() => { currentRefills++; });
  finishProbe(new Set(['avc']));
  await Promise.all([staleProbe, currentProbe]);
  assert.equal(staleRefills, 0, 'Detached codec controls never receive the async result');
  assert.equal(currentRefills, 1, 'The newest rendered fields receive the same pending result');
  assert.deepEqual([...dialog.supported], ['avc']);
  dialog.busy = new AbortController();
  await dialog.probe(() => { currentRefills++; });
  assert.equal(currentRefills, 1, 'Capability results do not thaw encoding controls');
  dialog.busy = null;dialog.renderVersion++;
  await dialog.probe(() => { currentRefills++; });
  assert.equal(currentRefills, 2, 'Rebuilding after encoding applies already-resolved support');

  // Live camera preferences and a reviewed camera are separate even when output preferences change.
  let stored = JSON.stringify({ out: defaultPrefs(), shot });
  globalThis.localStorage = { getItem() { return stored; }, setItem(key, value) { stored = value; } };
  Object.assign(dialog, { host: { take: () => ({}), shot: { ...shot, focal: 135 } } });
  dialog.out.width = 128;dialog.persist();
  assert.deepEqual(JSON.parse(stored).shot, shot, 'Review output edits retain the live camera recipe');
  dialog.host.take = () => null;dialog.host.shot = { ...shot, focal: 50 };dialog.persist();
  assert.equal(JSON.parse(stored).shot.focal, 50, 'Genuine no-take camera setup persists its own recipe');
  console.log('PASS: take-free live framing, fixed/follow/orbit phase-zero preview, lens/aspect, viewport bank, grab height correction and input immutability');
} finally {
  await rm(file, { force: true });
}
