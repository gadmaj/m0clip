/** Selected visual closure and real native preflight reuse; no browser/server/network. */
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const { build } = require('esbuild');

(async () => {
  const root = path.resolve(__dirname, '..');
  const bundle = await build({ stdin: { resolveDir: root, sourcefile: 'visual-plan-fixture.ts', contents: `
    export {planVisualAssets,resolveLaunchVisualSelection,OptionalVisualAssetError} from './src/loading/visual-plan';
    export {loadPreparedPmodelCharacter,discardPreparedPmodelCharacters} from './src/characters/prepared-pmodel';
    export {authoredCharacter} from './src/characters/catalog';
    export {plannedAssets} from './src/loading/catalogue';
    export {SceneProgress} from './src/loading/progress';
  ` }, bundle: true, platform: 'node', format: 'cjs', write: false, logLevel: 'silent' });
  const compiled = new Module(path.join(__dirname, 'visual-plan-memory.cjs'), module);
  compiled.filename = path.join(__dirname, 'visual-plan-memory.cjs'); compiled.paths = module.paths;
  compiled._compile(bundle.outputFiles[0].text, compiled.filename);
  const { planVisualAssets, resolveLaunchVisualSelection, OptionalVisualAssetError, loadPreparedPmodelCharacter, discardPreparedPmodelCharacters, authoredCharacter, plannedAssets, SceneProgress } = compiled.exports;
  const originalFetch = global.fetch, originalLocation = global.location;
  global.location = new URL('https://scene.test/');
  const cookie = '/assets/source/flashlight.png';
  const dog = '/assets/source-robots/halflife2-dog/dog.glb';
  const head = '/assets/source-robots/neotokyo-girlbot/girlbot_head.glb';
  const world = '/assets/maps/selected/visual-native.glb';
  const props = '/assets/maps/selected/props-native.glb';
  const manifest = '/assets/maps/selected/manifest.json';
  const image = '/assets/maps/selected/material.png';
  const style = '/assets/maps/selected/styles.rgba.gz';
  const authored = authoredCharacter('gingerbread-man').url;
  const catalogue = { version: 1, release: 'test', runtime: { page: [], worker: [], inference: [] },
    sizes: Object.fromEntries([cookie, dog, head, world, props, manifest, image, style, authored, '/assets/dog.bin'].map(url => [url, 17])),
    dependencies: { [world]: [image], [props]: [image], [dog]: ['/assets/dog.bin'], [authored]: [image] },
    mapVisuals: { selected: [manifest, world, props, style], unused: ['/unused.glb'] }, modelBundles: {} };
  const selection = { terrain: 'map:selected', robot: 'r1', body: 'stock', head: 'stock' };
  const sameSet = (actual, expected) => assert.deepEqual([...actual].sort(), [...expected].sort());
  let calls = [];
  global.fetch = async url => {
    calls.push(String(url));
    if (url === cookie) return new Response(new Uint8Array(17));
    throw new Error(`Unexpected asset ${url}`);
  };
  try {
    let plan = await planVisualAssets(selection, catalogue);
    sameSet(plan.urls, [cookie, manifest, world, props, image, style]);
    assert.equal(new Set(plan.urls).size, plan.urls.length, 'Shared texture entity is budgeted once');
    const progress = new SceneProgress();
    for (let index = 0; index < 2; index++) {
      const selected = await planVisualAssets({ ...selection, terrain: 'flat' }, catalogue);
      const generation = progress.begin(index * 100);
      progress.prepared(generation, selected.prepared, index * 100);
      progress.freeze(generation, plannedAssets(catalogue, selected.urls, selected.prepared), index * 100);
      const snapshot = progress.snapshot(index * 100);
      assert.equal(snapshot.loaded, 17, 'A fresh or retained decoded cookie body completes the same fixed budget');
      assert.equal(snapshot.loaded, snapshot.knownTotal);
      assert.equal(snapshot.remaining, 0);
    }
    assert.throws(() => plannedAssets({ ...catalogue, sizes: { ...catalogue.sizes, [cookie]: 18 } }, [cookie], plan.prepared));
    sameSet((await planVisualAssets({ ...selection, terrain: 'flat', body: 'dog', head: 'ghost' }, catalogue)).urls, [cookie, dog, '/assets/dog.bin']);
    sameSet((await planVisualAssets({ ...selection, terrain: 'flat', body: 'gingerbread-man' }, catalogue)).urls, [cookie, authored, image]);
    sameSet((await planVisualAssets({ ...selection, terrain: 'flat', head: 'ghost' }, catalogue)).urls, [cookie, head]);
    sameSet((await planVisualAssets({ ...selection, terrain: 'flat', robot: 'go2', body: 'dog', head: 'ghost' }, catalogue)).urls, [cookie]);
    await assert.rejects(planVisualAssets({ ...selection, terrain: 'map:missing', body: 'dog' }, catalogue), error => {
      assert.ok(!(error instanceof OptionalVisualAssetError)); assert.match(error.message, /no visual closure/); return true;
    });
    const missingSize = { ...catalogue, sizes: { ...catalogue.sizes } }; delete missingSize.sizes[image];
    await assert.rejects(planVisualAssets({ ...selection, body: 'dog' }, missingSize), error => {
      assert.ok(!(error instanceof OptionalVisualAssetError)); assert.match(error.message, /no exact visual payload size/); return true;
    });
    const missingCharacter = { ...catalogue, sizes: { ...catalogue.sizes } }; delete missingCharacter.sizes['/assets/dog.bin'];
    await assert.rejects(planVisualAssets({ ...selection, terrain: 'flat', body: 'dog' }, missingCharacter), error => {
      assert.ok(error instanceof OptionalVisualAssetError); assert.ok(error.cause instanceof Error);
      assert.equal(error.message, error.cause.message); assert.match(error.message, /dog\.bin/); return true;
    });
    assert.deepEqual(calls, [cookie], 'Planning reads the cookie body once, without prefetching heavy or unused models');

    const remembered = { colorway: 'product', sourceBody: 'dog', parts: { torso_link: { color: 123 } }, modules: { head: 'round' } };
    const shared = { colorway: 'grey', sourceBody: 'gingerbread-man', parts: {} };
    const input = { terrain: 'flat', robot: 'r1', character: null, rememberedAppearance: remembered, rememberedHead: 'ghost' };
    let resolved = resolveLaunchVisualSelection(input);
    assert.equal(resolved.body, 'dog'); assert.equal(resolved.head, 'ghost');
    assert.deepEqual(remembered.modules, { head: 'round' });
    resolved = resolveLaunchVisualSelection({ ...input, sharedAppearance: shared, queryBody: 'dog', sharedHead: 'stock' });
    assert.equal(resolved.body, 'gingerbread-man'); assert.equal(resolved.head, 'stock');
    assert.equal(resolveLaunchVisualSelection({ ...input, queryBody: 'stock' }).body, 'stock');
    resolved = resolveLaunchVisualSelection({ ...input, sharedAppearance: shared, character: 'stock', queryBody: 'dog' });
    assert.equal(resolved.body, 'stock'); assert.equal(resolved.head, 'stock');
    assert.deepEqual(Object.values(resolved.appearance.modules), Array(6).fill('stock'));
    resolved = resolveLaunchVisualSelection({ ...input, character: 'stock' });
    assert.deepEqual(resolved.appearance.parts, remembered.parts, 'Original preserves authored paint overrides');
    resolved = resolveLaunchVisualSelection({ ...input, character: 'boxy', partNames: ['torso_link', 'unclassified'] });
    assert.deepEqual(resolved.appearance.parts.torso_link, { color: 0xe1c991, finish: 'satin' });
    assert.equal(resolved.appearance.parts.unclassified, undefined);
    assert.equal(remembered.parts.torso_link.color, 123, 'Resolver never mutates saved settings');
    resolved = resolveLaunchVisualSelection({ ...input, robot: 'go2' });
    assert.equal(resolved.robot, 'go2'); assert.equal(resolved.body, 'stock'); assert.equal(resolved.head, 'ghost');
    resolved = resolveLaunchVisualSelection({ ...input, robot: 'go2', character: 'psx-dog' });
    assert.equal(resolved.body, 'psx-dog'); assert.equal(resolved.head, 'stock');

    // The real MDL decides its texture and sequence dependencies, not JSON flags.
    const bytes = fs.readFileSync(path.join(root, 'public/assets/characters/picardia-v1sc/picardia_v1sc.mdl'));
    const mdl = Buffer.alloc(bytes.length + 208); bytes.copy(mdl); mdl.writeInt32LE(mdl.length, 72);
    mdl.writeInt32LE(0, 180); mdl.writeInt32LE(2, 172); mdl.writeInt32LE(bytes.length, 176);
    mdl.writeInt32LE(1, bytes.readInt32LE(168) + 156); mdl.write('betagordon01.mdl', bytes.length + 104 + 32);
    const group = Buffer.from(bytes); group.write('IDSQ', 0);
    const base = 'https://wootdata.github.io/hlmodels_data_29/models/player/betagordon/betagordon';
    const metadata = JSON.stringify({ readme: true, t_model: false, seq_groups: 0, events: [{ options: 'unused.wav' }] });
    const bodies = new Map([[`${base}.mdl`, mdl], [`${base}.json`, metadata], [`${base}.txt`, 'Original authors'], [`${base}t.mdl`, bytes], [`${base}01.mdl`, group]]);
    calls = [];
    global.fetch = async url => {
      url = String(url); calls.push(url);
      assert.ok(bodies.has(url), `Unselected dependency requested: ${url}`);
      // Content-Length is deliberately not the decoded response length.
      return new Response(bodies.get(url), { headers: { 'content-length': '1', 'content-encoding': 'gzip' } });
    };
    const remote = { ...selection, terrain: 'flat', body: 'pmodels:hl:betagordon' };
    plan = await planVisualAssets(remote, catalogue);
    sameSet(plan.urls, [cookie, ...bodies.keys()]);
    sameSet(calls, [...bodies.keys()]);
    for (const asset of plan.prepared) assert.equal(asset.bytes, asset.url === cookie ? 17 : Buffer.byteLength(bodies.get(asset.url)), 'Use actual decoded response bytes');
    assert.deepEqual((await planVisualAssets(remote, catalogue)).prepared, plan.prepared);
    assert.equal(calls.length, bodies.size, 'Repeated planning reuses the same completed native preparation');
    global.fetch = async () => { throw new Error('Renderer redownloaded a prepared resource'); };
    const asset = await loadPreparedPmodelCharacter({ game: 'hl', name: 'betagordon' });
    assert.equal(typeof asset.create, 'function');
    discardPreparedPmodelCharacters(); // Ownership already transferred; scene retains the asset.
    asset.dispose();
    console.log('PASS: exact selected visual closures, authoritative appearance precedence, real native dependency preflight and renderer reuse.');
  } finally {
    discardPreparedPmodelCharacters(); global.fetch = originalFetch;
    if (originalLocation === undefined) delete global.location; else global.location = originalLocation;
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
