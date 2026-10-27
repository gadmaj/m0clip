/** Index final HTTP entities, not source masters or inflated native asset buffers. */
import { createHash } from 'node:crypto';
import { open, readFile, readdir, stat, writeFile, rename, unlink } from 'node:fs/promises';
import { resolve, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { isPrivateAssetReceipt } from './public_asset_policy.mjs';

const origin = 'https://startup.invalid';
export function assetKey(value, base = '/') {
  const url = new URL(value, new URL(base, origin));
  if (!['http:', 'https:'].includes(url.protocol)) return null;
  return url.origin === origin ? url.pathname + url.search : url.origin + url.pathname + url.search;
}
const unique = values => [...new Set(values)].sort();
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
function strings(value, label) {
  if (!Array.isArray(value) || !value.every(item => typeof item === 'string')) throw Error(`Invalid ${label}`);
  return value;
}

/** Only actual module edges; dynamic imports are recorded separately from startup imports. */
export function moduleReferences(source, name = 'module.js') {
  const tree = ts.createSourceFile(name, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const imports = [], dynamic = [], assets = [];
  function visit(node) {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteralLike(node.moduleSpecifier)) imports.push(node.moduleSpecifier.text);
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword && node.arguments[0] && ts.isStringLiteralLike(node.arguments[0])) dynamic.push(node.arguments[0].text);
    if (ts.isNewExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'URL' && node.arguments?.length === 2 && ts.isStringLiteralLike(node.arguments[0]) && node.arguments[1].getText(tree) === 'import.meta.url') assets.push(node.arguments[0].text);
    ts.forEachChild(node, visit);
  }
  visit(tree);
  return { imports: unique(imports), dynamic: unique(dynamic), assets: unique(assets) };
}

async function filesBelow(root) {
  const files = [];
  async function walk(directory) {
    for (const name of (await readdir(directory)).sort()) {
      const path = resolve(directory, name), key = '/' + relative(root, path).split(sep).join('/');
      if (isPrivateAssetReceipt(key)) continue;
      const info = await stat(path);
      if (info.isDirectory()) await walk(path);
      else if (info.isFile()) files.push({ path, key, bytes: info.size });
    }
  }
  await walk(root);
  return files;
}

async function gltfDocument(path) {
  if (path.endsWith('.gltf')) return JSON.parse(await readFile(path, 'utf8'));
  const handle = await open(path, 'r');
  try {
    const header = Buffer.alloc(20);
    if ((await handle.read(header, 0, 20, 0)).bytesRead !== 20 || header.readUInt32LE(0) !== 0x46546c67 || header.readUInt32LE(4) !== 2 || header.readUInt32LE(16) !== 0x4e4f534a) throw Error(`Invalid GLB: ${path}`);
    const size = header.readUInt32LE(12);
    if (size > (await handle.stat()).size - 20) throw Error(`Truncated GLB: ${path}`);
    const json = Buffer.alloc(size);
    if ((await handle.read(json, 0, size, 20)).bytesRead !== size) throw Error(`Truncated GLB JSON: ${path}`);
    return JSON.parse(json.toString('utf8').replace(/\0+$/, ''));
  } finally { await handle.close(); }
}

function collectPreviewUrls(value, base, previews) {
  if (Array.isArray(value)) { for (const child of value) collectPreviewUrls(child, base, previews); return; }
  if (!object(value)) return;
  for (const [name, child] of Object.entries(value)) {
    if ((name === 'preview' || name === 'thumbnail') && typeof child === 'string' && child.length > 0) {
      const key = assetKey(child, base);
      if (key) previews.add(key);
    } else if (object(child) || Array.isArray(child)) collectPreviewUrls(child, base, previews);
  }
}

/** runtime entries come from Rollup's actual page/worker output graphs. */
export async function buildStartupCatalogue(directory, runtime, options = {}) {
  const root = resolve(directory), files = await filesBelow(root);
  const sizes = {}, dependencies = {}, mapVisuals = {}, modelBundles = {};
  const byKey = new Map(files.map(file => [file.key, file]));
  // Gallery-only media are not scene payload, including authored previews stored
  // beside their models. Never ingest the preview generator's private QA receipt.
  const previews = new Set(files.filter(file => file.key.startsWith('/assets/previews/') || /\/preview(?:[.-][^/]*)?\.(?:png|webp|jpe?g|gif|avif)$/.test(file.key)).map(file => file.key));
  for (const file of files) {
    if (file.key.startsWith('/assets/previews/')) continue;
    if (/^\/assets\/characters\/.*\/(?:definition|catalog)\.json$/.test(file.key)) collectPreviewUrls(JSON.parse(await readFile(file.path, 'utf8')), file.key, previews);
    if (/\.(?:js|mjs)$/.test(file.key)) {
      const tree = ts.createSourceFile(file.key, await readFile(file.path, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
      function visit(node) {
        if (ts.isPropertyAssignment(node) && ['preview', 'thumbnail'].includes(node.name.getText(tree).replace(/^['\"]|['\"]$/g, '')) && ts.isStringLiteralLike(node.initializer) && node.initializer.text.length > 0) {
          const key = assetKey(node.initializer.text, file.key);
          if (key) previews.add(key);
        }
        ts.forEachChild(node, visit);
      }
      visit(tree);
    }
  }
  for (const file of files) {
    if (!file.key.startsWith('/.vite/') && !/^\/startup-catalogue[^/]*\.json$/.test(file.key)) sizes[file.key] = file.bytes;
  }
  function requireAsset(value, base) {
    const key = assetKey(value, base);
    if (!key) return null;
    if (key.startsWith('/') && sizes[key] === undefined) throw Error(`Catalogue dependency is absent from final output: ${key} (from ${base})`);
    return key;
  }
  function links(key, values) { dependencies[key] = unique(values.filter(Boolean)); }
  function expand(roots) {
    const result = new Set();
    function add(key) { if (result.has(key)) return; result.add(key); for (const child of dependencies[key] ?? []) add(child); }
    for (const key of roots) add(key);
    return [...result].sort();
  }
  // Read only GLB JSON chunks; embedded VTF/PNG pixels are not HTTP dependencies.
  for (const file of files.filter(file => !previews.has(file.key) && /\.(?:glb|gltf)$/.test(file.key))) {
    const document = await gltfDocument(file.path);
    const uris = [...(document.buffers ?? []), ...(document.images ?? [])].flatMap(item => typeof item.uri === 'string' ? [item.uri] : []);
    links(file.key, uris.map(uri => requireAsset(uri, file.key)));
  }
  for (const file of files.filter(file => file.key.startsWith('/assets/models/') && file.key.endsWith('.xml.manifest.json'))) {
    const index = JSON.parse(await readFile(file.path, 'utf8'));
    const compressed = new Set(index.gzipFiles === undefined ? [] : strings(index.gzipFiles, file.key + ' gzipFiles'));
    const native = strings(index.files, file.key + ' files');
    for (const name of compressed) if (!native.includes(name)) throw Error(`gzipFiles contains an unindexed file: ${file.key}: ${name}`);
    links(file.key, native.map(name => requireAsset(compressed.has(name) ? name + '.gz' : name, file.key)));
    modelBundles[file.key] = expand([file.key]);
  }
  for (const file of files.filter(file => /^\/assets\/maps\/[^/]+\/manifest\.json$/.test(file.key))) {
    const manifest = JSON.parse(await readFile(file.path, 'utf8'));
    const id = file.key.split('/')[3], roots = [file.key];
    const add = value => { if (typeof value === 'string') roots.push(requireAsset(value, file.key)); };
    add(manifest.native_textures?.visual ?? manifest.visual ?? 'visual.glb');
    if (manifest.props?.visual === 'props.glb') add(manifest.native_textures?.props ?? manifest.props.visual);
    // These two requests are unconditional in Scene.setTerrainVisual; absence is an
    // optional 404, not an invented successful HTTP entity.
    for (const name of ['lighting.json', 'lightstyles.json']) {
      const key = assetKey(name, file.key);
      if (byKey.has(key)) roots.push(key);
    }
    const stylesKey = assetKey('lightstyles.json', file.key), stylesFile = byKey.get(stylesKey);
    if (stylesFile) {
      const styles = JSON.parse(await readFile(stylesFile.path, 'utf8'));
      if (!object(styles.pages)) throw Error(`Invalid lightstyle pages: ${stylesKey}`);
      links(stylesKey, Object.values(styles.pages).map(name => {
        if (typeof name !== 'string') throw Error(`Invalid lightstyle page: ${stylesKey}`);
        return requireAsset(name, stylesKey);
      }));
    }
    if (manifest.visibility === 'visibility.json') add(manifest.visibility);
    for (const layer of manifest.color_corrections ?? []) add(layer.file);
    mapVisuals[id] = expand(roots);
  }
  // Runtime edges are static imports/CSS only. ORT URL assets are separately gated
  // by selected inference; never attach them to the worker's unconditional graph.
  for (const [key, values] of Object.entries(options.dependencies ?? {})) links(key, values);
  for (const group of ['page', 'worker', 'inference', 'localMap', 'localMapVerification']) {
    for (const key of runtime[group]) requireAsset(key, '/');
  }
  const sceneDependencies = new Set([...Object.values(dependencies).flat(), ...Object.values(runtime).flat(), ...Object.values(mapVisuals).flat(), ...Object.values(modelBundles).flat()]);
  for (const key of previews) if (!sceneDependencies.has(key)) delete sizes[key];
  const canonical = { version: 1, sizes, dependencies, runtime, mapVisuals, modelBundles };
  const hash = createHash('sha256').update(JSON.stringify(canonical));
  // Include final executable/metadata contents in the release identity, not just
  // their lengths. Large binary assets already have exact sizes and source URLs.
  for (const file of files.filter(file => /\.(?:js|mjs|css|json)$/.test(file.key) && !file.key.startsWith('/startup-catalogue') && !previews.has(file.key))) hash.update(file.key).update(await readFile(file.path));
  return { version: 1, release: hash.digest('hex'), sizes, dependencies, runtime, mapVisuals, modelBundles };
}

/** Record real Rollup chunks, including optimized dynamic entries without a facade.
 * @param {import('rollup').OutputBundle} bundle
 * @param {boolean} workerBuild
 * @returns {Array<{url: string, role?: 'page'|'worker'|'shell'|'localMap'|'localMapVerification', imports: string[], dynamicImports: string[], css: string[], assets: string[]}>}
 */
export function captureRuntimeChunks(bundle, workerBuild = false) {
  const chunks = [], url = file => '/' + file.replace(/^\//, '');
  for (const chunk of Object.values(bundle)) {
    if (chunk.type !== 'chunk') continue;
    const facade = chunk.facadeModuleId?.replaceAll('\\', '/') ?? '';
    const owns = pattern => pattern.test(facade) || chunk.moduleIds.some(id => pattern.test(id.replaceAll('\\', '/')));
    const role = workerBuild && owns(/\/src\/worker\/sim\.worker\.ts(?:\?|$)/) ? 'worker'
      : workerBuild && owns(/\/src\/maps\/bundle-verification\.worker\.ts(?:\?|$)/) ? 'localMapVerification'
      : owns(/\/src\/main\.ts(?:\?|$)/) ? 'page'
      : !workerBuild && chunk.isEntry ? 'shell'
      : !workerBuild && owns(/\/src\/maps\/bundle\.ts(?:\?|$)/) ? 'localMap' : undefined;
    chunks.push({ url: url(chunk.fileName), role, imports: chunk.imports.map(url),
      dynamicImports: chunk.dynamicImports.map(url),
      css: [...chunk.viteMetadata?.importedCss ?? []].map(url),
      assets: [...chunk.viteMetadata?.importedAssets ?? []].map(url) });
  }
  return chunks;
}

/** Rollup records both builds, including its separately bundled module worker. */
export async function buildRuntimeGraph(directory, chunks) {
  const files = await filesBelow(resolve(directory));
  const available = new Set(files.map(file => file.key));
  const records = new Map(chunks.map(chunk => [chunk.url, chunk]));
  const page = chunks.find(chunk => chunk.role === 'page');
  const worker = chunks.find(chunk => chunk.role === 'worker');
  const shell = chunks.find(chunk => chunk.role === 'shell');
  const localMap = chunks.find(chunk => chunk.role === 'localMap');
  const localMapVerification = chunks.find(chunk => chunk.role === 'localMapVerification');
  if (!page || !worker || !shell || !localMap || !localMapVerification)
    throw Error('Startup catalogue requires the launch, main, simulation worker, local-map intake and verification worker output graphs');
  const dependencies = {};
  for (const chunk of chunks) dependencies[chunk.url] = unique([...chunk.imports, ...chunk.css, ...chunk.assets.filter(key => !/\.(?:js|mjs|wasm)$/.test(key))]);
  function closure(roots) {
    const found = new Set();
    function add(key) {
      if (found.has(key)) return;
      if (!available.has(key)) throw Error(`Runtime output dependency is missing: ${key}`);
      found.add(key);
      for (const child of dependencies[key] ?? []) add(child);
    }
    for (const key of roots) add(key);
    return found;
  }
  const shellFiles = closure([shell.url]);
  const pageFiles = [...closure([page.url])].filter(key => !shellFiles.has(key));
  const localMapFiles = [...closure([localMap.url])].filter(key => !shellFiles.has(key));
  // An independent realm needs its full static graph, even shared page/shell URLs.
  const localMapVerificationFiles = closure([localMapVerification.url]);
  for (const key of pageFiles) if (dependencies[key]) dependencies[key] = dependencies[key].filter(child => !shellFiles.has(child));
  const workerFiles = closure([worker.url]);
  const inferenceFiles = new Set(), queue = [...workerFiles];
  for (let index = 0; index < queue.length; index++) {
    const key = queue[index], chunk = records.get(key);
    if (!chunk) continue;
    const refs = moduleReferences(await readFile(resolve(directory, key.slice(1)), 'utf8'), key);
    const targets = [...chunk.dynamicImports, ...chunk.assets.filter(key => /\.(?:wasm|mjs)$/.test(key))];
    for (const value of refs.assets) {
      const target = assetKey(value, key);
      // ORT includes an unused self-location .mjs string; require real emitted
      // files, rather than inventing an HTTP dependency from every string.
      if (target && available.has(target) && /\.(?:wasm|mjs)$/.test(target)) targets.push(target);
    }
    for (const target of closure(targets)) {
      if (!workerFiles.has(target) && !inferenceFiles.has(target)) { inferenceFiles.add(target); queue.push(target); }
    }
  }
  return {
    runtime: { page: unique(pageFiles), worker: unique([...workerFiles, '/wasm/mujoco.js', '/wasm/mujoco.wasm']),
      inference: unique([...inferenceFiles]), localMap: unique(localMapFiles),
      localMapVerification: unique([...localMapVerificationFiles]) },
    dependencies,
  };
}

export async function writeStartupCatalogue(directory, runtime, options = {}) {
  const catalogue = await buildStartupCatalogue(directory, runtime, options);
  const destination = resolve(directory, options.fileName ?? 'startup-catalogue.json'), temporary = destination + `.tmp-${process.pid}`;
  try {
    await writeFile(temporary, JSON.stringify(catalogue) + '\n', { flag: 'wx' });
    await rename(temporary, destination);
  } finally {
    await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; });
  }
  return catalogue;
}

/** Vite development responses are transformed module bodies, not source sizes. */
export async function buildDevelopmentCatalogue(publicDirectory, loadModule) {
  const sizes = {}, dependencies = {};
  const modules = new Map(), references = new Map();
  async function scan(key) {
    if (modules.has(key)) return;
    const response = await loadModule(key);
    if (!response) throw Error(`Development module is unavailable: ${key}`);
    sizes[key] = Buffer.byteLength(response);
    const refs = moduleReferences(response, key);
    const children = refs.imports.map(value => assetKey(value, key)).filter(Boolean);
    modules.set(key, children);
    dependencies[key] = children;
    references.set(key, refs);
    for (const child of children) await scan(child);
  }
  const page = '/src/main.ts', worker = '/src/worker/sim.worker.ts?worker_file&type=module', localMap = '/src/maps/bundle.ts';
  const localMapVerification = '/src/maps/bundle-verification.worker.ts?worker_file&type=module';
  await scan('/src/start.ts'); await scan(page); await scan(worker); await scan(localMap); await scan(localMapVerification);
  function closure(root) {
    const found = new Set();
    function add(key) { if (found.has(key)) return; found.add(key); for (const child of modules.get(key) ?? []) add(child); }
    add(root); return found;
  }
  const shell = closure('/src/start.ts');
  const workerFiles = closure(worker), inference = new Set(), queue = [...workerFiles];
  for (let index = 0; index < queue.length; index++) {
    const owner = queue[index], refs = references.get(owner);
    if (!refs) continue;
    const targets = [...refs.dynamic, ...refs.assets].map(value => assetKey(value, owner))
      .filter(key => key && /\.(?:wasm|mjs)(?:\?|$)/.test(key) && key.split('?')[0] !== owner.split('?')[0]);
    for (const key of targets) {
      if (workerFiles.has(key) || inference.has(key)) continue;
      if (/\.wasm(?:\?|$)/.test(key)) {
        const body = await loadModule(key, true);
        if (body === null) throw Error(`Development inference payload is unavailable: ${key}`);
        sizes[key] = Buffer.isBuffer(body) ? body.length : Buffer.byteLength(body);
        inference.add(key);
      } else {
        await scan(key);
        for (const child of closure(key)) if (!workerFiles.has(child) && !inference.has(child)) { inference.add(child); queue.push(child); }
      }
    }
  }
  const pageFiles = [...closure(page)].filter(key => !shell.has(key)).sort();
  const localMapFiles = [...closure(localMap)].filter(key => !shell.has(key)).sort();
  const localMapVerificationFiles = [...closure(localMapVerification)].sort();
  for (const key of pageFiles) dependencies[key] = dependencies[key].filter(child => !shell.has(child));
  const runtime = { page: pageFiles, worker: unique([...workerFiles, '/wasm/mujoco.js', '/wasm/mujoco.wasm']),
    inference: unique([...inference]), localMap: localMapFiles, localMapVerification: localMapVerificationFiles };
  const catalogue = await buildStartupCatalogue(publicDirectory, { page: [], worker: ['/wasm/mujoco.js', '/wasm/mujoco.wasm'],
    inference: [], localMap: [], localMapVerification: [] });
  Object.assign(catalogue.sizes, sizes);
  Object.assign(catalogue.dependencies, dependencies);
  catalogue.runtime = runtime;
  catalogue.release = 'dev-' + createHash('sha256').update(JSON.stringify(catalogue)).digest('hex');
  return catalogue;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [directory, graphFile, ...extra] = process.argv.slice(2);
  if (!directory || extra.length) throw Error('Usage: node scripts/build_startup_catalogue.mjs <final-output-directory> [runtime-graph.json]');
  // Reindex after any additional final-output asset processing, retaining the
  // exact URL already compiled into this release's application modules.
  const catalogues = (await readdir(directory)).filter(name => /^startup-catalogue(?:-[^/]+)?\.json$/.test(name));
  if (!graphFile && catalogues.length !== 1) throw Error('Expected exactly one release catalogue to reindex');
  const fileName = graphFile ? 'startup-catalogue.json' : catalogues[0];
  const graph = JSON.parse(await readFile(graphFile ?? resolve(directory, fileName), 'utf8'));
  const dependencies = Object.fromEntries(Object.entries(graph.dependencies).filter(([key]) => /\.(?:js|mjs|css)(?:\?|$)/.test(key)));
  await writeStartupCatalogue(directory, graph.runtime, { dependencies, fileName });
}
