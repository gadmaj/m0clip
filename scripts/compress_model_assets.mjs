#!/usr/bin/env node
/** Create fresh gzip mesh entities and declare them in compiler-derived scene indexes. */
import { createReadStream, createWriteStream, readdirSync, readFileSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, resolve, sep } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { createGzip } from 'node:zlib';

const [directory, ...extra] = process.argv.slice(2);
if (!directory || extra.length) throw Error('Usage: node scripts/compress_model_assets.mjs <build-directory>');
const root = realpathSync(resolve(directory));
const models = resolve(root, 'assets/models');
/** @type {Set<string>} */
const meshes = new Set();
/** @type {Array<{path:string,index:object,gzipFiles:string[]}>} */
const sceneIndexes = [];

for (const entry of readdirSync(models, { withFileTypes: true })) {
  if (!entry.isDirectory()) continue;
  const bundle = resolve(models, entry.name);
  for (const name of readdirSync(bundle).filter(name => name.endsWith('.xml.manifest.json'))) {
    /** @type {unknown} */
    const index = JSON.parse(readFileSync(resolve(bundle, name), 'utf8'));
    if (!index || typeof index !== 'object' || !('files' in index)
      || !Array.isArray(index.files) || !index.files.every(file => typeof file === 'string')) {
      throw Error(`Invalid model scene index: ${bundle}/${name}`);
    }
    /** @type {string[]} */
    const gzipFiles = [];
    for (const relative of index.files) {
      if (!/\.(?:stl|obj)$/i.test(relative)) continue;
      const mesh = resolve(bundle, relative);
      if (!mesh.startsWith(bundle + sep) || !realpathSync(dirname(mesh)).startsWith(root + sep)) {
        throw Error(`Indexed mesh must remain inside the build output: ${relative}`);
      }
      meshes.add(mesh);
      gzipFiles.push(relative);
    }
    if (gzipFiles.length) sceneIndexes.push({ path: resolve(bundle, name), index, gzipFiles });
  }
}
if (!meshes.size) throw Error('No indexed native STL/OBJ meshes found in the build output');

let originalBytes = 0, gzipBytes = 0;
for (const mesh of [...meshes].sort()) {
  const destination = mesh + '.gz';
  const temporary = destination + `.tmp-${process.pid}`;
  try {
    // Always regenerate: timestamps alone cannot prove an unchanged mesh.
    // Streams keep build memory bounded; rename never exposes a partial gzip.
    await pipeline(createReadStream(mesh), createGzip({ level: 6 }),
      createWriteStream(temporary, { flags: 'wx', mode: 0o644 }));
    renameSync(temporary, destination);
    originalBytes += statSync(mesh).size;
    gzipBytes += statSync(destination).size;
  } finally {
    try { unlinkSync(temporary); }
    catch (error) {
      if (!error || typeof error !== 'object' || !('code' in error) || error.code !== 'ENOENT') throw error;
    }
  }
}
for (const { path, index, gzipFiles } of sceneIndexes) {
  const temporary = path + `.tmp-${process.pid}`;
  try {
    // Publish the declaration only after every referenced gzip is complete.
    writeFileSync(temporary, JSON.stringify({ ...index, gzipFiles }, null, 2) + '\n', { flag: 'wx' });
    renameSync(temporary, path);
  } finally {
    try { unlinkSync(temporary); }
    catch (error) {
      if (!error || typeof error !== 'object' || !('code' in error) || error.code !== 'ENOENT') throw error;
    }
  }
}
console.log(JSON.stringify({ meshes: meshes.size, originalBytes, gzipBytes }));
