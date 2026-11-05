/** Saved-view restore timing: stable measures for the latest request, bounded buffers, never throws. */
import assert from 'node:assert/strict';
import buildFixture from './build-fixture.cjs';
const result = await buildFixture({ root: process.cwd(), source: "export {RestoreTiming,RESTORE_TIMING_PREFIX} from './src/core/restore-timing';", platform: 'node', format: 'es' });
const { RestoreTiming, RESTORE_TIMING_PREFIX: prefix } = await import('data:text/javascript;base64,' + Buffer.from(result.code).toString('base64'));
const own = type => performance.getEntriesByType(type).filter(entry => entry.name.startsWith(prefix));
const names = type => own(type).map(entry => entry.name).sort();

const first = new RestoreTiming(1);
first.note({ path: 'reattach', terrain: 'map:local-x' });
for (const phase of ['source', 'verify', 'scene', 'visual', 'physics', 'install', 'driver', 'visuals', 'camera']) { first.start(phase); first.end(phase); }
first.end('previous');                                 // never started: no measure
assert.ok(own('mark').length > 0);
first.finish('restored');
assert.deepEqual(own('mark'), [], 'A settled request leaves no marks');
assert.deepEqual(names('measure'), ['camera', 'driver', 'install', 'physics', 'scene', 'source', 'total', 'verify', 'visual', 'visuals'].map(p => prefix + p).sort());
const total = own('measure').find(entry => entry.name === prefix + 'total');
assert.deepEqual(total.detail, { request: 1, path: 'reattach', terrain: 'map:local-x', outcome: 'restored', phase: 'total' });

// A newer request replaces the previous measures; the superseded one records nothing more.
const stale = new RestoreTiming(2);
stale.start('scene');
const latest = new RestoreTiming(3);
assert.deepEqual(names('measure'), [], 'A new request clears earlier measures');
stale.end('scene'); stale.start('driver'); stale.finish('cancelled');
latest.note({ path: 'warm' }); latest.start('driver');
assert.ok(own('mark').every(entry => entry.detail.request === 3), 'Only the latest request marks');
latest.end('driver'); latest.finish('restored');
assert.deepEqual(names('measure'), [prefix + 'driver', prefix + 'total']);
assert.ok(own('measure').every(entry => entry.detail.request === 3 && entry.detail.path === 'warm'));

for (let request = 4; request < 200; request++) {
  const timing = new RestoreTiming(request);
  timing.start('scene'); timing.end('scene'); timing.start('driver');
  if (request % 2) timing.finish('failed');            // unfinished phases and abandoned requests are both bounded
}
new RestoreTiming(200).finish('restored');
assert.deepEqual(own('mark'), []);
assert.deepEqual(names('measure'), [prefix + 'total']);

// The timeline is diagnostic: a throwing or missing User Timing API never reaches the restore.
const { mark, measure } = performance;
performance.mark = () => { throw new Error('mark'); };
performance.measure = () => { throw new Error('measure'); };
const broken = new RestoreTiming(201); broken.start('scene'); broken.end('scene'); broken.finish('restored');
performance.mark = mark; performance.measure = measure;
const saved = Object.getOwnPropertyDescriptor(globalThis, 'performance');
Object.defineProperty(globalThis, 'performance', { value: undefined, configurable: true, writable: true });
const absent = new RestoreTiming(202); absent.start('scene'); absent.end('scene'); absent.finish('restored');
Object.defineProperty(globalThis, 'performance', saved);
console.log('PASS: restore phases measured per request, superseded requests silent, buffers bounded, failures contained');
