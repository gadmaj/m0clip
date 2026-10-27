/** Final serving entities, selected closures and transformed development graphs. */
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { gzipSync } from 'node:zlib';
import { buildStartupCatalogue, buildRuntimeGraph, buildDevelopmentCatalogue, writeStartupCatalogue, moduleReferences, captureRuntimeChunks } from './build_startup_catalogue.mjs';

const root = await mkdtemp(resolve(tmpdir(), 'm0clip-startup-catalogue-'));
async function put(name, body) {
  const path = resolve(root, name);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, typeof body === 'object' && !Buffer.isBuffer(body) ? JSON.stringify(body) : body);
}
function glb(document) {
  const json = Buffer.from(JSON.stringify(document)), padded = Buffer.alloc(Math.ceil(json.length / 4) * 4, 0x20);
  json.copy(padded);
  const header = Buffer.alloc(20);
  header.writeUInt32LE(0x46546c67, 0); header.writeUInt32LE(2, 4); header.writeUInt32LE(20 + padded.length, 8);
  header.writeUInt32LE(padded.length, 12); header.writeUInt32LE(0x4e4f534a, 16);
  return Buffer.concat([header, padded]);
}
function chunk(url, role, imports = [], css = [], dynamicImports = [], assets = []) {
  return { url, role, imports, css, dynamicImports, assets };
}
try {
  await put('wasm/mujoco.js', 'export default function(){}'); await put('wasm/mujoco.wasm', Buffer.from([0, 97, 115, 109]));
  await put('assets/shell.js', 'import "./common.js"; import("./main.js"); import("./bundle.js");');
  await put('assets/common.js', 'export const common = 1;');
  await put('assets/main.js', 'import "./common.js"; import "./three.js"; import "./browser.js"; import("./GLTFExporter.js");');
  await put('assets/three.js', 'export const renderer = 1;'); await put('assets/main.css', 'body { color: white; }');
  await put('assets/GLTFExporter.js', 'export const exporter = 1;');
  await put('assets/bundle.js', 'import "./common.js"; import "./browser.js"; export const inspect = () => {};');
  await put('assets/browser.js', 'export const inflate = value => value;');
  const intakeChunks = captureRuntimeChunks({
    intake: { type: 'chunk', fileName: 'assets/bundle.js', facadeModuleId: null,
      moduleIds: ['/fixture/src/maps/bundle.ts'], imports: ['assets/common.js', 'assets/browser.js'], dynamicImports: [] },
  });
  await put('assets/sim.worker.js', 'new URL("./ort.wasm", import.meta.url); new URL("./not-emitted.mjs", import.meta.url);');
  await put('assets/ort.wasm', Buffer.alloc(41)); await put('wasm/old-unused-runtime.wasm', Buffer.alloc(999));
  const graph = await buildRuntimeGraph(root, [
    chunk('/assets/shell.js', 'shell', ['/assets/common.js']),
    chunk('/assets/common.js'), chunk('/assets/three.js'),
    chunk('/assets/main.js', 'page', ['/assets/common.js', '/assets/three.js', '/assets/browser.js'], ['/assets/main.css'], ['/assets/GLTFExporter.js']),
    chunk('/assets/sim.worker.js', 'worker'), chunk('/assets/GLTFExporter.js'), chunk('/assets/browser.js'), ...intakeChunks,
  ]);
  assert.deepEqual(graph.runtime.page, ['/assets/browser.js', '/assets/main.css', '/assets/main.js', '/assets/three.js']);
  assert.deepEqual(graph.dependencies['/assets/main.js'], ['/assets/browser.js', '/assets/main.css', '/assets/three.js']);
  assert.deepEqual(graph.runtime.localMap, ['/assets/browser.js', '/assets/bundle.js'],
    'The real optional intake graph includes shared page dependencies, not preloaded shell files');
  assert(!graph.runtime.page.includes('/assets/bundle.js'), 'Deferred intake itself is never a scene download root');
  assert.deepEqual(graph.runtime.worker, ['/assets/sim.worker.js', '/wasm/mujoco.js', '/wasm/mujoco.wasm']);
  assert.deepEqual(graph.runtime.inference, ['/assets/ort.wasm']);
  assert(!Object.values(graph.runtime).flat().includes('/wasm/old-unused-runtime.wasm'));
  assert(!Object.values(graph.runtime).flat().includes('/assets/GLTFExporter.js'));

  const map = 'assets/maps/selected/';
  await put(map + 'manifest.json', {
    visual: 'visual.glb', native_textures: { visual: 'visual-native.glb', props: 'props-native.glb' },
    props: { visual: 'props.glb' }, files: ['map.xml'], visibility: 'visibility.json',
    color_corrections: [{ file: 'source-color-0.rgb', origin: [0, 0, 0], enabled: true, minfalloff: 0, maxfalloff: 10 }],
  });
  for (const name of ['visual.glb', 'props.glb', 'visual-native.glb', 'props-native.glb']) await put(map + name, glb({ asset: { version: '2.0' } }));
  await put(map + 'map.xml', '<mujoco/>'); await put(map + 'lighting.json', { ambient: [] });
  await put(map + 'lightstyles.json', { pages: { 0: 'styles-0.rgba.gz', 1: 'styles-1.rgba.gz' } });
  await put(map + 'visibility.json', { visibility: 'AA==' }); await put(map + 'source-color-0.rgb', Buffer.alloc(93));
  const explicitGzip = gzipSync(Buffer.alloc(10000));
  await put(map + 'styles-0.rgba.gz', explicitGzip); await put(map + 'styles-1.rgba.gz', explicitGzip);
  await put('assets/models/robot/scene.xml.manifest.json', { files: ['scene.xml', 'parts/shared.xml', 'meshes/chosen.STL'], gzipFiles: ['meshes/chosen.STL'] });
  await put('assets/models/robot/scene.xml', '<mujoco/>'); await put('assets/models/robot/parts/shared.xml', '<mujoco/>');
  await put('assets/models/robot/meshes/chosen.STL', Buffer.alloc(10000));
  await put('assets/models/robot/meshes/chosen.STL.gz', explicitGzip);
  await put('assets/models/robot/meshes/unselected.STL', Buffer.alloc(80));
  await put('assets/characters/authored/body.glb', glb({ asset: { version: '2.0' }, buffers: [{ uri: '../shared/body.bin' }], images: [{ uri: 'skin.png' }, { uri: 'data:image/png;base64,AA==' }] }));
  await put('assets/characters/shared/body.bin', Buffer.alloc(17)); await put('assets/characters/authored/skin.png', Buffer.alloc(19));
  await put('assets/characters/authored/definition.json', { preview: '/assets/characters/authored/gallery-poster.png' });
  await put('assets/characters/authored/gallery-poster.png', Buffer.alloc(71));
  await put('assets/characters/authored/preview.min.png', Buffer.alloc(73));
  await put('assets/previews/manifest.json', { baseURL: 'private-capture-origin', console: ['private capture notes'] });
  await put('assets/previews/character.webp', Buffer.alloc(79));
  for (const name of ['source-upgrade.json', 'props-report.json']) await put(map + name, { internal: true });
  await put('assets/characters/authored/analysis.json', { internal: 'conversion provenance' });
  const catalogue = await buildStartupCatalogue(root, graph.runtime, { dependencies: graph.dependencies });
  assert.deepEqual(catalogue.mapVisuals.selected, [
    'lighting.json', 'lightstyles.json', 'manifest.json', 'props-native.glb', 'source-color-0.rgb',
    'styles-0.rgba.gz', 'styles-1.rgba.gz', 'visibility.json', 'visual-native.glb',
  ].map(name => '/' + map + name).sort());
  assert.deepEqual(catalogue.modelBundles['/assets/models/robot/scene.xml.manifest.json'], [
    '/assets/models/robot/meshes/chosen.STL.gz', '/assets/models/robot/parts/shared.xml',
    '/assets/models/robot/scene.xml', '/assets/models/robot/scene.xml.manifest.json',
  ]);
  assert.equal(catalogue.sizes['/' + map + 'styles-0.rgba.gz'], explicitGzip.length, 'Explicit gzip files count their served bytes, not inflated atlas memory');
  assert.equal(catalogue.sizes['/assets/models/robot/meshes/chosen.STL.gz'], explicitGzip.length);
  assert.deepEqual(catalogue.dependencies['/assets/characters/authored/body.glb'], ['/assets/characters/authored/skin.png', '/assets/characters/shared/body.bin']);
  for (const key of ['/assets/characters/authored/gallery-poster.png', '/assets/characters/authored/preview.min.png', '/assets/previews/manifest.json', '/assets/previews/character.webp']) {
    assert(!(key in catalogue.sizes), 'Preview-only media and capture receipts do not enter the runtime inventory');
  }
  for (const name of ['source-upgrade.json', 'props-report.json']) {
    assert(!('/' + map + name in catalogue.sizes), 'Conversion-only receipts must not be advertised by the public catalogue');
  }
  assert(!('/assets/characters/authored/analysis.json' in catalogue.sizes),
    'Conversion-only character analysis must not be advertised by the public catalogue');
  const first = await writeStartupCatalogue(root, graph.runtime, { dependencies: graph.dependencies, fileName: 'startup-catalogue-release.json' });
  await put(map + 'source-color-0.rgb', Buffer.alloc(101));
  const final = await writeStartupCatalogue(root, graph.runtime, { dependencies: graph.dependencies, fileName: 'startup-catalogue-release.json' });
  assert.notEqual(first.release, final.release);
  assert.equal(final.sizes['/' + map + 'source-color-0.rgb'], 101, 'Reindex final postprocessed files');
  assert(!('/startup-catalogue-release.json' in final.sizes), 'The catalogue cannot budget itself');
  const previous = await readFile(resolve(root, 'startup-catalogue-release.json'));
  await unlink(resolve(root, 'assets/models/robot/meshes/chosen.STL.gz'));
  await assert.rejects(writeStartupCatalogue(root, graph.runtime, { dependencies: graph.dependencies, fileName: 'startup-catalogue-release.json' }), /absent from final output/);
  assert.deepEqual(await readFile(resolve(root, 'startup-catalogue-release.json')), previous, 'A failed regeneration must preserve the last complete catalogue');
  await put('assets/models/robot/meshes/chosen.STL.gz', explicitGzip);

  const bodies = new Map([
    ['/src/start.ts', 'import "/src/shell.ts"; import("/src/main.ts");'],
    ['/src/shell.ts', 'export const launch = "Choose map";'],
    ['/src/main.ts', 'import "/src/shell.ts"; import "/src/render.ts"; import "/src/browser.ts"; import("/src/unused-exporter.ts");'],
    ['/src/render.ts', 'export const renderer = "transformed ✓";'],
    ['/src/maps/bundle.ts', 'import "/src/shell.ts"; import "/src/browser.ts"; export const inspect = () => {};'],
    ['/src/browser.ts', 'export const inflate = value => value;'],
    ['/src/worker/sim.worker.ts?worker_file&type=module', 'import "/src/policy.ts";'],
    ['/src/policy.ts', 'new URL("/runtime/ort.wasm", import.meta.url);'],
    ['/runtime/ort.wasm', Buffer.alloc(37)],
  ]);
  const loaded = [];
  const dev = await buildDevelopmentCatalogue(root, async key => { loaded.push(key); return bodies.get(key) ?? null; });
  assert.deepEqual(dev.runtime.page, ['/src/browser.ts', '/src/main.ts', '/src/render.ts']);
  assert.deepEqual(dev.runtime.localMap, ['/src/browser.ts', '/src/maps/bundle.ts']);
  assert.equal(dev.sizes['/src/render.ts'], Buffer.byteLength(bodies.get('/src/render.ts')));
  assert.deepEqual(dev.runtime.inference, ['/runtime/ort.wasm']);
  assert.equal(dev.sizes['/runtime/ort.wasm'], 37);
  assert(!loaded.includes('/src/unused-exporter.ts'));
  assert.deepEqual(moduleReferences('const text="import(\\"fake.js\\")"; export { value } from "./real.js"; import("./lazy.js");'), { imports: ['./real.js'], dynamic: ['./lazy.js'], assets: [] });
  console.log('Startup catalogue selected closures, final payload sizes, runtime gating and transformed dev responses PASS');
} finally { await rm(root, { recursive: true, force: true }); }
