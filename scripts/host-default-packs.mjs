#!/usr/bin/env node
// Prepare the hosted R1 catalog and individual packs from an existing bundle.
// Usage: node scripts/host-default-packs.mjs /path/to/r1-all.zip
// Weights stay outside Git. Catalog entries download their weights on selection.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { unzipSync, strFromU8 } from 'fflate';
import { load } from 'js-yaml';
const bundle = process.argv[2];
if (!bundle) throw new Error('Pass the path to your r1-all.zip bundle');
const destination = resolve('public/assets/packs');
mkdirSync(`${destination}/r1`, {recursive:true});
const entries = unzipSync(new Uint8Array(readFileSync(bundle)));
const catalog = [];
for (const [name, bytes] of Object.entries(entries)) {
  if (!name.endsWith('.zip')) continue;
  const files = unzipSync(bytes);
  const manifest = JSON.parse(strFromU8(files['pack.json']));
  if (!manifest.robot.startsWith('r1')) throw new Error(`Not an R1 pack: ${name}`);
  const config = load(strFromU8(files[manifest.config]));
  const file = basename(name);
  writeFileSync(`${destination}/r1/${file}`, bytes);
  catalog.push({id:manifest.baseName, manifest, config, files:{}, downloadUrl:`/assets/packs/r1/${file}`});
}
catalog.sort((a,b)=>a.id.localeCompare(b.id));
writeFileSync(`${destination}/r1-default-v1.json`, JSON.stringify(catalog));
console.log(`Prepared ${catalog.length} default policy choices; weights load on selection.`);
