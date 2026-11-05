/** A map change keeps the robot it was compiled for: one physics compile, no silent G1 Air → EDU swap. */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createContext, runInContext } from 'node:vm';
import { build } from 'esbuild';

const root = process.cwd();
const enginePath = JSON.stringify(resolve(root, 'src/sim/engine.ts'));
const controlled = {
  engine: `export * from ${enginePath};
    export class Engine { static async create(...args){fixture.creates.push(args[0]);return {dispose(){fixture.disposed++;}};} }`,
  defaults: 'export async function installDefaultPacks(family,packs){return packs;}',
  inference: `export const env={wasm:{}};export class Tensor{};export const InferenceSession={create(){throw new Error('Inference is not part of this test');}};`,
};
const worker = await readFile('src/worker/sim.worker.ts', 'utf8');
const [body] = worker.split('const sim = new SimWorker();');
assert.ok(body.length < worker.length, 'The worker still creates its SimWorker at module level');
const compiled = await build({ stdin: { contents: `${body}\nself.SimWorker = SimWorker;`, loader: 'ts', resolveDir: resolve(root, 'src/worker'), sourcefile: 'sim.worker.ts' },
  bundle: true, platform: 'browser', format: 'iife', write: false,
  plugins: [{ name: 'worker-boundaries', setup(builder) {
    builder.onResolve({ filter: /^\.\.\/sim\/engine$/ }, () => ({ path: 'engine', namespace: 'controlled' }));
    builder.onResolve({ filter: /^\.\.\/packs\/defaults$/ }, () => ({ path: 'defaults', namespace: 'controlled' }));
    builder.onResolve({ filter: /^onnxruntime-web\/wasm$/ }, () => ({ path: 'inference', namespace: 'controlled' }));
    builder.onLoad({ filter: /.*/, namespace: 'controlled' }, args => ({ contents: controlled[args.path], loader: 'js', resolveDir: root }));
  } }] });

function changeMap(robot, models) {
  const fixture = { creates: [], disposed: 0 }, messages = [];
  const realm = { fixture, location: { href: 'https://scene.test/src/worker/sim.worker.ts', origin: 'https://scene.test' },
    URL, Blob, Response, Request, Headers, TextDecoder, TextEncoder, Uint8Array, Int32Array, Uint32Array, Float32Array, Float64Array,
    ArrayBuffer, structuredClone, DOMException, performance, setTimeout, clearTimeout, console: { ...console, error() {} },
    postMessage(message) { messages.push(structuredClone(message)); } };
  realm.self = realm;
  runInContext(compiled.outputFiles[0].text, createContext(realm));
  const sim = new realm.SimWorker(), builds = [];
  sim.robot = robot; sim.terrain = 'flat';
  sim.policies = [{ name: 'dual/actor', robot: 'g1', models, packId: 'dual' }]; sim.polIdx = 0;
  // Only the compiler, scene description and driver loading are controlled; the terrain transaction and
  // loadDriver's variant decision run as written.
  sim.sceneIdentity = (_engine, compiledRobot, terrain) => ({ mode: 'robot', robot: compiledRobot, terrain, ngeom: 1, nq: 7, baseQadr: 0, hinges: [] });
  sim.buildEngine = async (_prepared, _current, engine) => { builds.push({ robot: sim.robot, staged: !!engine }); };
  sim.cfgFor = async () => { throw new Error('Driver configuration reached'); };
  sim.reenter = () => {}; sim.sendStatus = () => {};
  return { sim, fixture, messages, builds, async run() {
    await sim.onMessage({ t: 'terrain', terrain: 'map:test_map', request: 1 }, () => true);
    assert.ok(messages.some(m => m.t === 'terrainPrepared' && m.request === 1), JSON.stringify(messages));
    await sim.onMessage({ t: 'terrain', terrain: 'map:test_map', request: 1, commit: true }, () => true);
  } };
}

for (const [robot, models] of [['g1_air', ['air', 'edu']], ['g1', ['air', 'edu']], ['g1', ['edu']], ['g1_air', ['air']]]) {
  const scene = changeMap(robot, models);
  await scene.run();
  const label = `${robot} with ${models.join('+')} policy`;
  assert.equal(scene.fixture.creates.length, 1, `${label}: the map compiles once`);
  assert.deepEqual(scene.builds, [{ robot, staged: true }], `${label}: only the staged engine is installed`);
  assert.equal(scene.sim.robot, robot, `${label}: the robot variant is kept`);
  assert.equal(scene.sim.terrain, 'map:test_map');
  assert.ok(scene.messages.some(m => m.t === 'error' && m.msg.includes('Driver configuration reached')), `${label}: the driver loads after install`);
}
console.log('PASS: map change keeps G1 Air/EDU variants with one physics compile');
