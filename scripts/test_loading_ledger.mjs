/** Fixed unique payload maximum, selected preflight bodies, retries and real rate estimates. */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { build } from 'esbuild';

globalThis.location = new URL('https://scene.test/');
const result = await build({ stdin: { resolveDir: process.cwd(), sourcefile: 'loading-ledger-fixture.ts', contents: `
  export { SceneProgress } from './src/loading/progress';
  export { plannedAssets, priorIntakeAssets } from './src/loading/catalogue';
  export { inspectLocalMap, localMapIntakeState } from './src/ui/local-map';
` }, bundle: true, platform: 'node', format: 'cjs', write: false });
const module = { exports: {} };
new Function('module', 'require', result.outputFiles[0].text)(module, createRequire(import.meta.url));
const { SceneProgress, plannedAssets, priorIntakeAssets, inspectLocalMap, localMapIntakeState } = module.exports;
const transfer = (id, url, loaded, total, state = 'loading') => ({ id, url, loaded, total, state });
const progress = new SceneProgress();
const first = progress.begin(0);
progress.update(first, [transfer('metadata', '/metadata.json', 100, 100, 'done')], 100);
assert.equal(progress.snapshot(500).frozen, false);
assert.equal(progress.snapshot(1500).etaSeconds, null, 'Planning cannot estimate an unknown final payload');
progress.prepared(first, [{ url: 'https://external.test/model.mdl', bytes: 200 }], 1600);
progress.freeze(first, [{ url: '/map.glb', bytes: 4_000_000 }, { url: '/model.zip', bytes: 8_000_000 },
  { url: 'https://external.test/model.mdl', bytes: 200 }], 1600);
let value = progress.snapshot(1600);
assert.equal(value.knownTotal, 12_000_300, 'Actual preflight metadata joins the selected fixed payload exactly once');
assert.equal(value.loaded, 300, 'Retained external bytes already count as consumed');
assert.equal(value.frozen, true);
assert.equal([...progress.transfers()].length, 2, 'Planning must not invent transfer records for unrequested model/map URLs');
assert.equal(value.active, 0, 'Planned inventory is not an active HTTP transaction');
assert.throws(() => progress.freeze(first, [], 1700), /already fixed/);
progress.update(first, [transfer('page:map', '/map.glb', 1_000_000, null),
  transfer('worker:model', '/model.zip', 2_000_000, null)], 2000);
value = progress.snapshot(2000);
assert.equal(value.loaded, 3_000_300);
assert.equal(value.knownTotal, 12_000_300, 'Unknown HTTP length cannot grow or shrink the catalogue maximum');
progress.update(first, [transfer('page:map', '/map.glb', 2_000_000, null),
  transfer('worker:model', '/model.zip', 4_000_000, null)], 4000);
value = progress.snapshot(4000);
assert.ok(value.etaSeconds > 0, 'Exact selected payload permits ETA even for compressed/chunked response headers');
progress.update(first, [transfer('duplicate:map', 'https://scene.test/map.glb#same-entity', 2_000_000, 4_000_000)], 4200);
assert.equal(progress.snapshot(4200).loaded, 6_000_300, 'Page/worker/cache/retry observations cannot count an entity twice');
progress.update(first, [transfer('page:map', '/map.glb', 4_000_000, 4_000_000, 'done'),
  transfer('worker:model', '/model.zip', 5_000_000, null, 'failed')], 4500);
value = progress.snapshot(4500);
assert.equal(value.loaded, 9_000_300);
assert.equal(value.knownTotal, 12_000_300, 'Failed optional entities retain their frozen unreceived remainder');
assert.equal(value.remaining, 3_000_000);
progress.update(first, [transfer('worker:model', '/model.zip', 9_000_000, 10_000_000)], 4600);
assert.equal(progress.snapshot(4600).loaded, 9_000_300, 'Late batches cannot resurrect terminal requests');
progress.update(first, [transfer('retry:model', '/model.zip', 8_000_000, 8_000_000, 'done')], 5000);
value = progress.snapshot(5000);
assert.equal(value.loaded, 12_000_300, 'A real successful retry completes the same entity, not another payload');
assert.equal(value.active, 0);
assert.equal(value.etaSeconds, null, 'Completed asset bytes never invent compilation/material ETA');
assert.equal(value.unexpected, 0);
assert.equal([...progress.transfers()].length, 4, 'Details expose one row per selected entity');

const second = progress.begin(6000);
progress.update(first, [transfer('old:late', '/old.bin', 50_000_000, 100_000_000)], 6100);
progress.freeze(second, [{ url: '/current.bin', bytes: 1000 }], 6100);
progress.update(second, [transfer('current', '/current.bin', 100, null)], 6500);
progress.snapshot(6500);
progress.update(second, [transfer('current', '/current.bin', 600, null)], 8000);
value = progress.snapshot(8000);
assert.equal(value.loaded, 600, 'A new scene rejects previous-generation bytes');
assert.equal(value.knownTotal, 1000);
assert.ok(value.etaSeconds > 0);
value = progress.snapshot(11501);
assert.equal(value.stalled, true);
assert.equal(value.etaSeconds, null, 'Stalled bytes expire their stale estimate');
progress.update(second, [transfer('current', '/current.bin', 800, null)], 12000);
value = progress.snapshot(12000);
assert.equal(value.stalled, false);
assert.ok(value.etaSeconds > 0 && Number.isFinite(value.etaSeconds));
progress.update(second, [transfer('optional:pending', '/optional.json', 0, null)], 12100);
assert.equal(progress.hasCatalogueMismatch, false, 'A probe without consumed payload cannot contradict the fixed payload maximum');
progress.update(second, [transfer('optional:pending', '/optional.json', 0, null, 'failed')], 12200);
value = progress.snapshot(12200);
assert.equal(value.knownTotal, 1000);
assert.equal(value.loaded, 800);
assert.equal(value.unexpected, 0, 'An absent optional zero-byte resource is not an unplanned successful payload');
assert.equal(progress.hasCatalogueMismatch, false);
assert.equal([...progress.transfers()].find(resource => resource.url === '/optional.json').state, 'failed',
  'The failed probe stays useful in observed Details without becoming budget inventory');
progress.update(second, [transfer('unexpected', '/unplanned.bin', 4000, 4000, 'done')], 12500);
value = progress.snapshot(12500);
assert.equal(value.knownTotal, 1000, 'Unexpected observations must not silently expand the fixed maximum');
assert.equal(value.loaded, 800);
assert.equal(value.unexpected, 1, 'Catalogue mismatches remain observable instead of invented completion');
assert.equal(progress.hasCatalogueMismatch, true, 'Release/entity mismatches must be available to the canonical launch failure path');

const third = progress.begin(13000);
progress.update(third, [transfer('external', 'https://external.test/unknown', 10, null)], 13100);
assert.throws(() => progress.freeze(third, [], 13200), /missing an exact payload size/,
  'Unknown selected preflight bodies must complete before freeze');
progress.update(third, [transfer('external', 'https://external.test/unknown', 20, 20, 'done')], 13300);
progress.freeze(third, [], 13400);
assert.equal(progress.snapshot(13400).knownTotal, 20);

const fourth = progress.begin(14000);
progress.freeze(fourth, [{ url: '/shared.bin', bytes: 1000 }], 14001);
progress.update(fourth, [transfer('shared:a', '/shared.bin', 100, null),
  transfer('shared:b', '/shared.bin', 200, null)], 14500);
progress.update(fourth, [transfer('shared:a', '/shared.bin', 300, null, 'failed')], 15000);
assert.equal(progress.snapshot(15000).active, 1, 'One failed duplicate cannot hide another real in-flight reader');
assert.equal(progress.snapshot(15000).loaded, 300, 'Overlapping readers contribute their unique consumed prefix once');
progress.update(fourth, [transfer('shared:b', '/shared.bin', 1000, 1000, 'done')], 15500);
assert.equal(progress.snapshot(15500).active, 0);
assert.equal(progress.snapshot(15500).loaded, 1000);

const fifth = progress.begin(16000);
progress.freeze(fifth, [{ url: '/required.bin', bytes: 1000 }], 16001);
progress.update(fifth, [transfer('required:empty', '/required.bin', 0, 0, 'done')], 16500);
assert.equal(progress.hasCatalogueMismatch, true, 'An empty successful planned asset must not hide a real declared-size mismatch');
assert.equal(progress.snapshot(16500).knownTotal, 1000);

// Validation failure does not unload a successful import; later imports cannot
// rewrite the pre-Load snapshot or turn local ZIP bytes into HTTP receipts.
const beforeIntake = localMapIntakeState();
assert.equal(beforeIntake, undefined);
const rejectedFile = assert.rejects(inspectLocalMap(new Blob([])));
const pendingIntake = localMapIntakeState();
assert.equal(pendingIntake.complete, false, 'Intake records its import before awaiting it');
const pendingBeforeLoad = { complete: pendingIntake.complete, before: 100 };
await rejectedFile;
assert.equal(localMapIntakeState().complete, true, 'Rejected local data still leaves a successfully imported graph');
assert.equal(pendingBeforeLoad.complete, false, 'Completion inside Load cannot rewrite its pre-Load scope');
assert.equal(beforeIntake, undefined);

const catalogue = { version: 1, release: 'intake-scope', sizes: {
  '/main.js': 100, '/browser.js': 19_144, '/bundle.js': 15_422, '/model.bin': 700,
}, dependencies: { '/main.js': ['/browser.js'], '/bundle.js': ['/browser.js'] },
  runtime: { page: ['/main.js', '/browser.js'], worker: [], inference: [], localMap: ['/bundle.js', '/browser.js'] },
  mapVisuals: {}, modelBundles: {} };
const completeBeforeLoad = { complete: true, before: 100 };
const receipt = { name: 'https://scene.test/browser.js', startTime: 10, responseEnd: 20, decodedBodySize: 19_144, responseStatus: 200 };
assert.deepEqual(priorIntakeAssets(catalogue, undefined, [receipt]), [], 'No prior intake means no past-byte exclusion');
assert.deepEqual(priorIntakeAssets(catalogue, completeBeforeLoad, []), catalogue.runtime.localMap,
  'A fulfilled pre-Load import proves its whole graph available even without cached body-size timing');
for (const invalid of [
  { ...receipt, decodedBodySize: 19_143 }, { ...receipt, decodedBodySize: 0 },
  { ...receipt, responseEnd: 0 }, { ...receipt, startTime: 100 },
  { ...receipt, responseStatus: undefined }, { ...receipt, responseStatus: 0 }, { ...receipt, responseStatus: 304 },
  { ...receipt, responseStatus: 404 }, { ...receipt, name: 'https://scene.test/model.bin', decodedBodySize: 700 },
]) assert.deepEqual(priorIntakeAssets(catalogue, pendingBeforeLoad, [invalid]), [],
  'A pending/failed import cannot exclude partial, unfinished, later, uncertain, failed or unrelated bodies');
const overlapReceipt = { ...receipt, responseEnd: 200 };
assert.deepEqual(priorIntakeAssets(catalogue, pendingBeforeLoad, [overlapReceipt]), ['/browser.js'],
  'An exact completed shared body is prior work even if its unrelated bundle entry fails or remains pending');
const scoped = new SceneProgress();
for (const [intake, entries, independentSharedRoot] of [
  [undefined, [receipt], false], [completeBeforeLoad, [], false],
  [pendingBeforeLoad, [], false], [pendingBeforeLoad, [overlapReceipt], false],
  [pendingBeforeLoad, [{ ...receipt, startTime: 101 }], false],
  [completeBeforeLoad, [], true], [pendingBeforeLoad, [receipt], true],
]) {
  const prior = priorIntakeAssets(catalogue, intake, entries);
  const page = plannedAssets(catalogue, catalogue.runtime.page, [], prior);
  const generation = scoped.begin(0);
  const selected = plannedAssets(catalogue, ['/model.bin', ...(independentSharedRoot ? ['/browser.js'] : [])], []);
  scoped.freeze(generation, [...page, ...selected], 1);
  const sharedRequired = !prior.includes('/browser.js') || independentSharedRoot;
  const required = ['/main.js', '/model.bin', ...(sharedRequired ? ['/browser.js'] : [])];
  const expected = 800 + (sharedRequired ? 19_144 : 0);
  assert.equal(scoped.snapshot(1).knownTotal, expected);
  scoped.update(generation, required.map(url => transfer(url, url, catalogue.sizes[url], catalogue.sizes[url], 'done')), 2);
  const snapshot = scoped.snapshot(2);
  assert.equal(snapshot.loaded, expected);
  assert.equal(snapshot.knownTotal, expected, 'Actual later reads never grow or shrink the selected fixed maximum');
  assert.equal(snapshot.remaining, 0);
  assert.equal(snapshot.unexpected, 0);
  assert.equal(scoped.hasCatalogueMismatch, false);
  assert.equal([...scoped.transfers()].some(asset => asset.url === '/bundle.js'), false,
    'A pre-Load ZIP reader cannot be credited as a selected HTTP download');
}
console.log(JSON.stringify({ fixedMaximum: true, uniqueEntities: true, retainedPreflight: true,
  retryIsolation: true, generationIsolation: true, realRate: true, stalledEstimate: true, catalogueMismatch: true }));
