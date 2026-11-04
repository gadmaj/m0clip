#!/usr/bin/env node
// Prepare a hosted R1 or G1 catalog and individual packs from an existing bundle.
// Usage: node scripts/host-default-packs.mjs /path/to/r1-all.zip   (or g1-all.zip)
// Weights stay outside Git. Catalog entries download their weights on selection.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { unzipSync, strFromU8 } from 'fflate';
import { load } from 'js-yaml';
const bundle = process.argv[2];
if (!bundle) throw new Error('Pass the path to your r1-all.zip or g1-all.zip bundle');
const destination = resolve('public/assets/packs');
const entries = unzipSync(new Uint8Array(readFileSync(bundle)));
const family = robot => robot.startsWith('r1') ? 'r1' : robot.startsWith('g1') ? 'g1' : robot;
const packs = [];
let robot;
for (const [name, bytes] of Object.entries(entries)) {
  if (!name.endsWith('.zip')) continue;
  const files = unzipSync(bytes);
  const manifest = JSON.parse(strFromU8(files['pack.json']));
  const packRobot = family(manifest.robot);
  if (packRobot !== 'r1' && packRobot !== 'g1') throw new Error(`Not an R1 or G1 pack: ${name}`);
  robot ??= packRobot;
  if (packRobot !== robot) throw new Error(`Mixed ${robot} and ${packRobot} packs: ${name}`);
  packs.push({ file: basename(name), bytes, manifest, config: load(strFromU8(files[manifest.config])) });
}
if (!robot) throw new Error(`No policy packs in ${bundle}`);
mkdirSync(`${destination}/${robot}`, {recursive:true});
const catalog = [];
for (const { file, bytes, manifest, config } of packs) {
  writeFileSync(`${destination}/${robot}/${file}`, bytes);
  catalog.push({id:manifest.baseName, manifest, config, files:{}, downloadUrl:`/assets/packs/${robot}/${file}`});
}
catalog.sort((a,b)=>a.id.localeCompare(b.id));
writeFileSync(`${destination}/${robot}-default-v1.json`, JSON.stringify(catalog));
console.log(`Prepared ${catalog.length} default ${robot.toUpperCase()} policy choices; weights load on selection.`);
