/** Real HTTP/filesystem privacy boundaries; no player or graphics simulation. */
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer, preview } from 'vite';
import { removePrivateAssetReceipts } from './public_asset_policy.mjs';

const root = await mkdtemp(resolve(tmpdir(), 'm0clip-public-asset-policy-'));
const project = resolve(root, 'project'), output = resolve(project, 'dist'), publicDir = resolve(project, 'public');
const configFile = fileURLToPath(new URL('../vite.config.ts', import.meta.url));
const runtime = 'assets/maps/selected/manifest.json';
const characterReceipts = ['analysis.json', 'conversion.json', 'rig-map.json', 'source-evidence.json', 'source-manifest.json'];
const sourceRobotReceipts = ['analysis.json', 'candidate-robots.json'];
const receipts = ['assets/maps/selected/props-report.json', 'assets/maps/selected/source-upgrade.json',
  ...characterReceipts.map(name => 'assets/characters/selected/' + name),
  ...sourceRobotReceipts.map(name => 'assets/source-robots/selected/' + name)];
async function put(path, body) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, body);
}
let development, published;
async function deny(base, paths) {
  for (const path of paths) {
    const response = await fetch(base + path, { redirect: 'manual' });
    assert.equal(response.status, 404, `Conversion receipt remains private: ${path}`);
    assert.equal(await response.text(), '');
  }
  const response = await fetch(base + '/' + runtime);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { files: ['map.xml'] });
  const character = await fetch(base + '/assets/characters/selected/definition.json');
  assert.equal(character.status, 200, 'Runtime character definitions remain public');
  assert.deepEqual(await character.json(), { model: 'body.glb' });
  const model = await fetch(base + '/assets/source-robots/selected/body.glb');
  assert.equal(model.status, 200, 'Source robot models remain public');
  assert.equal(await model.text(), 'runtime source model');
}
try {
  for (const directory of [output, publicDir]) {
    await put(resolve(directory, runtime), '{"files":["map.xml"]}');
    await put(resolve(directory, 'assets/characters/selected/definition.json'), '{"model":"body.glb"}');
    await put(resolve(directory, 'assets/source-robots/selected/body.glb'), 'runtime source model');
    for (const key of receipts) await put(resolve(directory, key), '{"private":"conversion provenance"}');
  }
  await symlink(fileURLToPath(new URL('../node_modules', import.meta.url)), resolve(project, 'node_modules'), 'dir');
  const common = { root: project, configFile, cacheDir: resolve(root, 'vite-cache'), logLevel: 'silent' };
  published = await preview({ ...common, build: { outDir: output }, preview: { host: '127.0.0.1', port: 0 } });
  const canonicalPaths = ['/assets/maps/selected/props-report.json', '/assets/maps/selected/%73ource-upgrade.json',
    '/assets/maps/selected//props-report.json', '//assets/maps/selected/source-upgrade.json',
    '/assets/maps/selected/source-upgrade.json/', ...characterReceipts.map(name => '/assets/characters/selected/' + name),
    '//assets/characters/selected/%61nalysis.json', '/assets/characters/selected/analysis.json/',
    ...sourceRobotReceipts.map(name => '/assets/source-robots/selected/' + name),
    '//assets/source-robots/selected/%61nalysis.json', '/assets/source-robots/selected/candidate-robots.json/'];
  await deny(`http://127.0.0.1:${published.httpServer.address().port}`, canonicalPaths);
  development = await createServer({ ...common, server: { host: '127.0.0.1', port: 0, fs: { allow: [project] } } });
  await development.listen();
  const fsPrefix = '/@fs/' + publicDir.replaceAll('\\', '/').replace(/^\/+/, '');
  await deny(`http://127.0.0.1:${development.httpServer.address().port}`, [...canonicalPaths,
    '/public/assets/maps/selected/source-upgrade.json', fsPrefix + '/assets/maps/selected/props-report.json',
    ...characterReceipts.flatMap(name => ['/public/assets/characters/selected/' + name, fsPrefix + '/assets/characters/selected/' + name]),
    ...sourceRobotReceipts.flatMap(name => ['/public/assets/source-robots/selected/' + name, fsPrefix + '/assets/source-robots/selected/' + name])]);

  await removePrivateAssetReceipts(output);
  for (const key of receipts) await assert.rejects(readFile(resolve(output, key)), { code: 'ENOENT' });
  assert.deepEqual(JSON.parse(await readFile(resolve(output, runtime), 'utf8')), { files: ['map.xml'] }, 'Runtime manifests remain intact');

  for (const family of ['maps', 'characters', 'source-robots']) {
    const borrowed = resolve(root, 'borrowed-' + family), linkedOutput = resolve(root, 'linked-output-' + family);
    const receipt = family === 'maps' ? 'source-upgrade.json' : 'analysis.json';
    await put(resolve(borrowed, 'selected', receipt), 'private original');
    await mkdir(resolve(linkedOutput, 'assets'), { recursive: true });
    await symlink(borrowed, resolve(linkedOutput, 'assets', family), 'dir');
    await assert.rejects(removePrivateAssetReceipts(linkedOutput), Error);
    assert.equal(await readFile(resolve(borrowed, 'selected', receipt), 'utf8'), 'private original', 'Borrowed immutable data is never pruned');
  }
  console.log('Public receipt HTTP access, owned-output removal and borrowed-data protection PASS');
} finally {
  if (development) await development.close();
  if (published?.httpServer.listening) {
    published.httpServer.closeAllConnections();
    await new Promise((done, fail) => published.httpServer.close(error => error ? fail(error) : done()));
  }
  await rm(root, { recursive: true, force: true });
}
