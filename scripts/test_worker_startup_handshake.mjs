/** Exercise the real worker dispatcher with controlled storage/compiler boundaries. */
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { createContext, runInContext } from 'node:vm';
import { performance } from 'node:perf_hooks';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { build } from 'esbuild';
import { zipSync, strToU8 } from 'fflate';

const root = process.cwd();
const packsPath = JSON.stringify(resolve(root, 'src/packs/index.ts'));
const enginePath = JSON.stringify(resolve(root, 'src/sim/engine.ts'));
const preparedPath = JSON.stringify(resolve(root, 'src/core/prepared-assets.ts'));
const controlled = {
  packs: `
    import {parsePack} from ${packsPath};
    import {fetchAsset} from ${preparedPath};
    export {packEntries,packAssetUrls,resolvePackConfig,revokePack,deletePack,deleteAllPacks,importAny} from ${packsPath};
    export async function listPacks(){fixture.listCalls++;return fixture.packs;}
    export async function loadPack(id,metadata){
      fixture.loadCalls.push(id);
      return metadata.downloadUrl ? parsePack(new Uint8Array(await (await fetchAsset(metadata.downloadUrl)).arrayBuffer())) : fixture.locals[id];
    }
  `,
  defaults: `export async function installDefaultPacks(packs,progress,fetchMetadata){
    fixture.installCalls++;
    if(fixture.installMetadata) await (await fetchMetadata('/default-catalogue.json')).json();
    return packs;
  }`,
  engine: `
    import {Engine as ActualEngine} from ${enginePath};
    export {MissingBundleError,GEOM_MESH} from ${enginePath};
    export class Engine {
      static prepare(...args){fixture.prepares++;return ActualEngine.prepare(...args);}
      static async create(...args){fixture.compiles.push(args);throw new Error('Selected compiler reached');}
    }
  `,
  inference: `export const env={wasm:{}};
    export class Tensor {constructor(){throw new Error('Inference ran before compiler');}}
    export const InferenceSession={create(){throw new Error('Inference ran before compiler');}};`,
};
const compiled = await build({ entryPoints: ['src/worker/sim.worker.ts'], bundle: true, platform: 'browser', format: 'iife', write: false,
  plugins: [{ name: 'worker-boundaries', setup(builder) {
    builder.onResolve({ filter: /^\.\.\/packs$/ }, () => ({ path: 'packs', namespace: 'controlled' }));
    builder.onResolve({ filter: /^\.\.\/packs\/defaults$/ }, () => ({ path: 'defaults', namespace: 'controlled' }));
    builder.onResolve({ filter: /^\.\.\/sim\/engine$/ }, () => ({ path: 'engine', namespace: 'controlled' }));
    builder.onResolve({ filter: /^onnxruntime-web\/wasm$/ }, () => ({ path: 'inference', namespace: 'controlled' }));
    builder.onLoad({ filter: /.*/, namespace: 'controlled' }, args => ({ contents: controlled[args.path], loader: 'js', resolveDir: root }));
  } }] });

const makePack = (id, remote = false) => ({
  id, downloadUrl: remote ? `https://policy.test/${id}.zip` : `/packs/${id}.zip`,
  manifest: { schemaVersion: 1, baseName: id, group: id, robot: 'r1', family: 'r1_fw', config: 'config.yaml', checkpoints: [{ id: 'main', file: 'main.onnx' }] },
  config: { name: id, robot: 'r1', family: 'r1_fw', control: { step_dt: .02, sim_dt: .002 }, policy: { path: 'main.mnn', num_act: 24 },
    r1: { firmware: true, obs_scheme: remote ? 'track' : 'amp_loco', joint_names: [],
      ...(remote ? { aux_files: { motion: 'https://policy.test/selected.csv' } } : {}) } },
});
const zipped = pack => zipSync({ 'pack.json': strToU8(JSON.stringify(pack.manifest)), 'config.yaml': strToU8(JSON.stringify(pack.config)), 'main.onnx': Uint8Array.of(1, 2, 3) });

function fixture(packs, { local = false, installMetadata = false } = {}) {
  const state = { packs: packs.map(pack => local ? (({ downloadUrl, ...metadata }) => metadata)(pack) : pack), locals: {},
    listCalls: 0, installCalls: 0, loadCalls: [], prepares: 0, compiles: [], installMetadata };
  const catalogue = { version: 1, release: 'test', sizes: {}, dependencies: {}, runtime: {
    page: [], worker: ['/runtime/worker.js'], inference: ['/runtime/inference.mjs', '/runtime/inference.wasm'], localMap: [],
  }, mapVisuals: {}, modelBundles: {} };
  const served = new Map(), requests = [], messages = [], listeners = new Set();
  const json = value => ({ body: JSON.stringify(value), headers: { 'content-type': 'application/json' } });
  for (const pack of packs) {
    const body = zipped(pack);
    served.set(pack.downloadUrl, { body });
    if (!pack.downloadUrl.startsWith('https:')) catalogue.sizes[pack.downloadUrl] = body.byteLength;
    const { downloadUrl, ...metadata } = pack;
    state.locals[pack.id] = { ...metadata, files: { 'main.onnx': Uint8Array.of(1, 2, 3) } };
  }
  served.set('/assets/models/r1/scene.xml.manifest.json', json({ files: ['scene.xml', 'selected.stl'] }));
  served.set('/default-catalogue.json', json(packs));
  served.set('https://policy.test/selected.csv', { body: '1,2\n3,4\n' });
  const known = ['/runtime/worker.js', '/runtime/inference.mjs', '/runtime/inference.wasm', '/wasm/mujoco.js', '/wasm/mujoco.wasm',
    '/assets/models/r1/scene.xml', '/assets/models/r1/selected.stl'];
  for (const url of known) catalogue.sizes[url] = 1;
  for (const [url, value] of served) if (url.startsWith('/')) catalogue.sizes[url] = typeof value.body === 'string' ? Buffer.byteLength(value.body) : value.body.byteLength;
  const realm = { fixture: state, location: { href: 'https://scene.test/src/worker/sim.worker.ts', origin: 'https://scene.test' },
    URL, Blob, Response, Request, Headers, TextDecoder, TextEncoder, Uint8Array, Int32Array, Uint32Array, Float32Array, Float64Array, ArrayBuffer, structuredClone,
    ReadableStream, DOMException, performance, setTimeout, clearTimeout, console: { ...console, error() {} },
    postMessage(message) { messages.push(structuredClone(message)); for (const listener of [...listeners]) listener(message); },
    async fetch(value) {
      const text = String(value);
      if (text.startsWith('blob:')) return fetch(text);
      const url = new URL(text, 'https://scene.test');
      const key = url.origin === 'https://scene.test' ? url.pathname + url.search : url.href;
      requests.push(key);
      const response = served.get(key);
      return response ? new Response(response.body, { headers: response.headers }) : new Response('not found', { status: 404 });
    },
  };
  realm.self = realm;
  const context = createContext(realm);
  runInContext(compiled.outputFiles[0].text, context);
  const send = message => realm.onmessage({ data: structuredClone(message) });
  const next = predicate => {
    const found = messages.find(predicate);
    if (found) return Promise.resolve(found);
    return new Promise((resolveMessage, reject) => {
      const timer = setTimeout(() => { listeners.delete(listener); reject(new Error('Worker message timeout: ' + JSON.stringify(messages))); }, 5000);
      const listener = message => { if (predicate(message)) { clearTimeout(timer); listeners.delete(listener); resolveMessage(message); } };
      listeners.add(listener);
    });
  };
  const close = () => { for (const generation of [1, 2, 3, 4, 5]) send({ t: 'loadingFinished', generation }); };
  return { state, catalogue, requests, messages, send, next, close };
}

const ordinary = makePack('amp_locomotion/amp_locomotion');
const known = fixture([ordinary], { installMetadata: true });
try {
  known.send({ t: 'init', robot: 'r1', robotExplicit: true, terrain: 'flat', policy: ordinary.id, loadingId: 1, catalogue: known.catalogue });
  const first = (await known.next(message => message.t === 'loadingPlan' && message.plan.generation === 1)).plan;
  assert.equal(first.robot, 'r1'); assert.equal(first.policy, ordinary.id); assert.equal(first.pack, ordinary.id); assert.equal(first.inference, true);
  assert.equal(known.state.listCalls, 1); assert.equal(known.state.installCalls, 1);
  assert.deepEqual(known.state.loadCalls, []); assert.deepEqual(known.state.compiles, []);
  assert.equal(known.requests.includes(ordinary.downloadUrl), false, 'Known hosted ZIP must wait for the frozen budget');
  assert.equal(known.requests.some(url => /\.stl$|\.wasm$|mujoco\.js$/.test(url)), false);
  assert.ok(first.urls.includes('/default-catalogue.json'));
  assert.ok(first.prepared.some(asset => asset.url === '/default-catalogue.json'));
  known.send({ t: 'loadingProceed', generation: 2, token: first.token });
  known.send({ t: 'loadingProceed', generation: 1, token: 'wrong' });
  await nextTurn();
  assert.deepEqual(known.state.compiles, []);

  known.send({ t: 'init', robot: 'r1', robotExplicit: true, terrain: 'flat', policy: ordinary.id, loadingId: 2, catalogue: known.catalogue });
  const second = (await known.next(message => message.t === 'loadingPlan' && message.plan.generation === 2)).plan;
  assert.notEqual(first.token, second.token);
  known.send({ t: 'loadingFinished', generation: 1 });
  known.send({ t: 'loadingProceed', generation: 1, token: first.token });
  await nextTurn();
  assert.deepEqual(known.state.compiles, []);
  known.send({ t: 'loadingProceed', generation: 2, token: second.token });
  await known.next(message => message.t === 'error' && message.msg.includes('Selected compiler reached'));
  assert.equal(known.state.compiles.length, 1, 'Proceed bypasses the waiting serialized init queue');
  assert.equal(known.requests.filter(url => url === ordinary.downloadUrl).length, 1);
  assert.deepEqual(known.state.loadCalls, [ordinary.id]);
  known.send({ t: 'loadingProceed', generation: 2, token: second.token });
  await nextTurn(); assert.equal(known.state.compiles.length, 1);
} finally { known.close(); }

const remotePack = makePack('external', true), remote = fixture([remotePack]);
try {
  remote.send({ t: 'init', robot: 'r1', robotExplicit: true, loadingId: 3, catalogue: remote.catalogue });
  const plan = (await remote.next(message => message.t === 'loadingPlan')).plan;
  assert.equal(remote.requests.filter(url => url === remotePack.downloadUrl).length, 1);
  assert.equal(remote.requests.filter(url => url === 'https://policy.test/selected.csv').length, 1);
  assert.deepEqual(remote.state.loadCalls, ['external']);
  assert.deepEqual(remote.state.compiles, []);
  assert.ok(plan.prepared.some(asset => asset.url === remotePack.downloadUrl && asset.bytes === zipped(remotePack).byteLength));
  assert.ok(plan.prepared.some(asset => asset.url === 'https://policy.test/selected.csv' && asset.bytes === 8));
  assert.equal(plan.urls.some(url => /unused|another/.test(url)), false);
  remote.send({ t: 'loadingProceed', generation: 3, token: plan.token });
  await remote.next(message => message.t === 'error');
  assert.deepEqual(remote.state.loadCalls, ['external'], 'The already resolved external pack/config is reused after proceed');
  assert.equal(remote.requests.filter(url => url === remotePack.downloadUrl).length, 1);
} finally { remote.close(); }

const cached = fixture([ordinary], { local: true });
try {
  cached.send({ t: 'init', robot: 'r1', robotExplicit: true, loadingId: 4, catalogue: cached.catalogue });
  const plan = (await cached.next(message => message.t === 'loadingPlan')).plan;
  assert.equal(plan.urls.includes(ordinary.downloadUrl), false);
  assert.equal(cached.requests.some(url => url.endsWith('.zip')), false);
  cached.send({ t: 'loadingFinished', generation: 4 });
  cached.send({ t: 'loadingProceed', generation: 4, token: plan.token });
  await nextTurn(); assert.deepEqual(cached.state.compiles, []);
} finally { cached.close(); }

const idle = fixture([]);
try {
  idle.send({ t: 'init', robot: 'r1', robotExplicit: true, loadingId: 5, catalogue: idle.catalogue });
  const plan = (await idle.next(message => message.t === 'loadingPlan')).plan;
  assert.equal(plan.policy, null); assert.equal(plan.pack, null); assert.equal(plan.inference, false);
  assert.equal(plan.urls.some(url => url.includes('inference')), false);
  assert.equal(idle.requests.some(url => /\.zip$|\.onnx$/.test(url)), false);
} finally { idle.close(); }

const direct = fixture([ordinary]);
try {
  direct.send({ t: 'init', robot: 'r1', robotExplicit: true });
  await direct.next(message => message.t === 'error' && message.msg.includes('Selected compiler reached'));
  assert.equal(direct.messages.some(message => message.t === 'loadingPlan'), false);
  assert.equal(direct.state.compiles.length, 1, 'Direct/headless startup retains an ungated execution path');
  assert.equal(direct.requests.filter(url => url === ordinary.downloadUrl).length, 1);
} finally { direct.close(); }
console.log(JSON.stringify({ beforeFreeze: true, selectedIdentity: true, outOfQueueProceed: true, externalReuse: true, cachedLocal: true, driverless: true, directHeadless: true }));
