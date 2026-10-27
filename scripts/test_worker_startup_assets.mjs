/** Exact selected closures, retained external bodies, and generation-owned planning barriers. */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { build } from 'esbuild';

const bundled = await build({ stdin: { contents: `
  export * from './src/core/prepared-assets';
  export * from './src/core/driver-assets';
  export * from './src/core/startup-gate';
  export {loadTraj} from './src/core/assets';
  export {loadRows} from './src/core/drivers/g1_vq137';
  export {packAssetUrls,packEntries,resolvePackConfig,revokePack} from './src/packs';
  export {Engine,MissingBundleError} from './src/sim/engine';
`, resolveDir: process.cwd() }, bundle: true, platform: 'node', format: 'cjs', write: false });
const module = { exports: {} };
new Function('module', 'exports', 'require', bundled.outputFiles[0].text)(module, module.exports, createRequire(import.meta.url));
const { PreparedAssets, httpAssetKey, fetchAsset, usePreparedAssets, selectedDriverAssets, driverAssetUrls,
  StartupGate, loadTraj, loadRows, packAssetUrls, packEntries, resolvePackConfig, revokePack, Engine, MissingBundleError } = module.exports;
const originalFetch = globalThis.fetch;
const originalLocation = Object.getOwnPropertyDescriptor(globalThis, 'location');
Object.defineProperty(globalThis, 'location', { configurable: true, value: { href: 'https://scene.test/src/worker/sim.worker.ts', origin: 'https://scene.test' } });
const requests = [];
const bodies = new Map();
const json = value => ({ body: JSON.stringify(value), headers: { 'content-type': 'application/json' } });
bodies.set('/models/air/scene-air.xml.manifest.json', json({ files: ['scene-air.xml', 'meshes/leg.stl'], gzipFiles: ['meshes/leg.stl'] }));
bodies.set('/maps/selected/manifest.json', json({ files: ['collision.xml', 'hulls.bin'] }));
bodies.set('https://policy.test/selected.csv?revision=7', { body: '1,2\n3,4\n', headers: { 'content-encoding': 'gzip', 'content-length': '3' } });
bodies.set('/missing/scene.xml.manifest.json', { body: '<html></html>', headers: { 'content-type': 'text/html' } });
globalThis.fetch = async value => {
  const key = httpAssetKey(String(value));
  requests.push(key);
  const fixture = bodies.get(key);
  if (!fixture) return new Response('not found', { status: 404 });
  return new Response(fixture.body, { headers: fixture.headers });
};
try {
  assert.equal(httpAssetKey('https://scene.test/a.bin?q=1#part'), '/a.bin?q=1');
  assert.equal(httpAssetKey('https://policy.test/a.bin?q=1#part'), 'https://policy.test/a.bin?q=1');
  assert.equal(httpAssetKey('blob:https://scene.test/local'), null);
  assert.equal(httpAssetKey('data:text/plain,local'), null);

  const assets = new PreparedAssets(), release = usePreparedAssets(assets);
  const external = 'https://policy.test/selected.csv?revision=7';
  await Promise.all([assets.prepare(external), assets.prepare(`${external}#again`)]);
  assert.equal(requests.filter(url => url === external).length, 1, 'Concurrent references prepare one HTTP entity');
  assert.deepEqual(assets.snapshot(), [{ url: external, bytes: 8 }], 'Measure the decoded body, not compressed Content-Length');
  assert.equal(await (await fetchAsset(external)).text(), '1,2\n3,4\n');
  assert.deepEqual(Array.from((await loadTraj(external)).data), [1, 2, 3, 4]);
  assert.deepEqual((await loadRows(external)).map(row => Array.from(row)), [[1, 2], [3, 4]]);
  assert.equal(requests.filter(url => url === external).length, 1, 'Real trajectory and first-step CSV loaders reuse preflight bytes');

  const physics = await Engine.prepare('/models/air', 'scene-air.xml', { dir: '/maps/selected', mount: '/work/map' }, url => assets.prepare(url));
  assert.deepEqual(physics.urls, ['/models/air/scene-air.xml.manifest.json', '/models/air/scene-air.xml', '/models/air/meshes/leg.stl.gz',
    '/maps/selected/manifest.json', '/maps/selected/collision.xml', '/maps/selected/hulls.bin']);
  assert.deepEqual(requests.slice(1), ['/models/air/scene-air.xml.manifest.json', '/maps/selected/manifest.json'], 'Metadata planning starts neither meshes nor WASM');
  assert.equal(physics.extra.manifest.files.length, 2);
  await assert.rejects(Engine.prepare('/missing'), error => error instanceof MissingBundleError);
  release();
  assert.deepEqual(assets.snapshot(), []);
  await fetchAsset(external);
  assert.equal(requests.filter(url => url === external).length, 2, 'Finished planning releases its retained body');

  const previous = new PreparedAssets(), releasePrevious = usePreparedAssets(previous);
  const current = new PreparedAssets(), releaseCurrent = usePreparedAssets(current);
  await current.prepare(external);
  releasePrevious();
  await fetchAsset(external);
  assert.equal(requests.filter(url => url === external).length, 3, 'An old lifetime cannot clear the current prepared cache');
  releaseCurrent();

  const base = { name: 'selected', robot: 'g1', family: 'g1_loco', control: { step_dt: .02, sim_dt: .002 }, policy: { path: 'net/main.mnn' },
    g1: { aux_models: { stance: 'net/stance.mnn' }, aux_files: { stance: 'data/stance.csv', dance: 'data/dance.csv', unused: 'data/unused.csv' } } };
  const vq = selectedDriverAssets({ ...base, g1: { ...base.g1, obs_scheme: 'vq', vq: { mode: 'dance', clips: ['dance'] } } });
  assert.deepEqual(driverAssetUrls(vq), ['/net/main.onnx', '/net/stance.onnx', '/data/stance.csv', '/data/dance.csv']);
  assert.equal(driverAssetUrls(vq).includes('/data/unused.csv'), false);
  const task = selectedDriverAssets({ ...base, g1: { ...base.g1, obs_scheme: 'vq', vq: { mode: 'task', motions: [{ file: 'dance' }, { file: 'dance' }] } } });
  assert.deepEqual(Object.keys(task.files), ['stance', 'dance']);
  const traj = selectedDriverAssets({ ...base, g1: { ...base.g1, obs_scheme: 'vq', fsm_id: 504 } });
  assert.deepEqual(traj.files, {}, 'Trajectory VQ has no latent CSV downloads');
  const getup = selectedDriverAssets({ ...base, g1: { ...base.g1, obs_scheme: 'bm_getup', aux_files: { faceup_motion: 'up.csv', facedown_motion: 'down.csv', unused: 'unused.csv' } } });
  assert.deepEqual(Object.keys(getup.files), ['faceup_motion', 'facedown_motion']);
  const faceup = selectedDriverAssets({ ...base, g1: { ...base.g1, obs_scheme: 'faceup', faceup: { latent: 'dance' } } });
  assert.deepEqual(Object.keys(faceup.files), ['dance']);
  const punch = selectedDriverAssets({ ...base, g1: { ...base.g1, obs_scheme: 'punch', punch: { trajs: { first: { file: 'dance' }, repeat: { file: 'dance' } } } } });
  assert.deepEqual(Object.keys(punch.files), ['dance']);
  const mimic = selectedDriverAssets({ ...base, family: 'g1_mimic', g1: { ...base.g1, motion_clip: external } });
  assert.deepEqual(driverAssetUrls(mimic), ['/net/main.onnx', external], 'Mimic consumes no unrelated aux networks');
  const squat = selectedDriverAssets({ ...base, g1: { ...base.g1, obs_scheme: 'squat2stand' } });
  assert.deepEqual(driverAssetUrls(squat), ['/net/main.onnx']);
  const r1 = selectedDriverAssets({ ...base, robot: 'r1', r1: { firmware: true, obs_scheme: 'track', aux_models: { down: 'down.mnn' }, aux_files: { clip: external } } });
  assert.deepEqual(driverAssetUrls(r1), ['/net/main.onnx', '/down.onnx', external]);
  const go2 = selectedDriverAssets({ ...base, robot: 'go2', go2: { firmware: true, aux_models: { recovery: 'recovery.mnn' }, aux_files: { unused: external } } });
  assert.deepEqual(driverAssetUrls(go2), ['/net/main.onnx', '/recovery.onnx']);

  const pack = { id: 'selected', config: { ...base, g1: { ...base.g1, obs_scheme: 'vq', vq: { mode: 'dance', clips: ['dance'] } } },
    manifest: { schemaVersion: 1, baseName: 'selected', group: 'selected', robot: 'g1', family: 'g1_loco', config: 'config.yaml',
      checkpoints: [{ id: 'main', file: 'main.onnx' }], aux: { stance: 'stance.onnx' }, auxFiles: { dance: 'dance.csv' } },
    downloadUrl: 'https://policy.test/selected.zip', files: { 'main.onnx': Uint8Array.of(1), 'stance.onnx': Uint8Array.of(2), 'dance.csv': new TextEncoder().encode('1,2\n') } };
  assert.deepEqual(packAssetUrls(pack), ['https://policy.test/selected.zip', '/data/stance.csv'], 'A hosted pack adds one ZIP, not HTTP requests for its embedded members');
  const { downloadUrl, ...local } = pack;
  assert.deepEqual(packAssetUrls(local), ['/data/stance.csv'], 'Cached/imported payloads do not invent pending ZIP downloads');
  const resolved = resolvePackConfig(local, packEntries(local)[0]);
  assert.deepEqual(driverAssetUrls(selectedDriverAssets(resolved)).filter(url => httpAssetKey(url)), ['/data/stance.csv']);
  revokePack(pack.id);

  const gate = new StartupGate();
  const first = gate.wait(10);
  let executed = false;
  const serializedInit = (async () => { if (await first.ready) executed = true; })();
  assert.equal(gate.proceed(9, first.token), false);
  assert.equal(gate.proceed(10, 'wrong'), false);
  await Promise.resolve();
  assert.equal(executed, false);
  assert.equal(gate.proceed(10, first.token), true);
  await serializedInit;
  assert.equal(executed, true, 'Out-of-queue proceed unblocks serialized init');
  assert.equal(gate.proceed(10, first.token), false, 'A plan can proceed only once');
  const stale = gate.wait(11), replacement = gate.wait(12);
  assert.equal(await stale.ready, false, 'A replacement cancels the prior wait');
  gate.finish(11);
  assert.equal(gate.proceed(12, replacement.token), true, 'Stale finished cannot cancel a replacement');
  assert.equal(await replacement.ready, true);
  const cancelled = gate.wait(13);
  gate.finish(13);
  assert.equal(await cancelled.ready, false);
  assert.equal(gate.proceed(13, cancelled.token), false);
  console.log(JSON.stringify({ selectedPhysics: true, exactDriverClosure: true, retainedExternalBodies: true, cachedPacks: true, generationOwnership: true }));
} finally {
  globalThis.fetch = originalFetch;
  if (originalLocation) Object.defineProperty(globalThis, 'location', originalLocation);
  else delete globalThis.location;
}
