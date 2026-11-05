/** Policy gallery order from real hosted pack metadata: the running Air or EDU body's policies lead each
 * activity section, every other policy stays listed after them in its previous relative order. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { build } from 'esbuild';

const result = await build({ stdin: { contents: "export {policyInfo} from './src/worker/robot-policy'; export {packEntries} from './src/packs'; export {policySections, policyVariantRank} from './src/ui/policy-names';", resolveDir: process.cwd() }, bundle: true, platform: 'node', format: 'cjs', write: false });
const module = { exports: {} };
new Function('module', 'exports', 'require', result.outputFiles[0].text)(module, module.exports, createRequire(import.meta.url));
const { policyInfo, packEntries, policySections, policyVariantRank } = module.exports;

const summary = {};
for (const [family, specs] of [['r1', ['r1', 'r1_air', 'r1_air_edu']], ['g1', ['g1', 'g1_air']]]) {
  const entries = JSON.parse(readFileSync(`public/assets/packs/${family}-default-v1.json`, 'utf8')).flatMap(packEntries);
  assert.ok(entries.length > 1, family);
  for (const spec of specs) {
    const infos = entries.map(entry => policyInfo(entry, spec, false));
    const air = spec.endsWith('_air');
    const current = info => info.previewRobot.endsWith('_air') === air;
    const base = policySections(infos);
    const ordered = policySections(infos, spec);
    assert.deepEqual(ordered.map(([section]) => section), base.map(([section]) => section), `${spec}: activity sections unchanged`);
    assert.deepEqual(ordered.flatMap(([, list]) => list.map(info => info.name)).sort(), infos.map(info => info.name).sort(),
      `${spec}: every policy stays listed`);
    let leading = 0;
    for (const [section, list] of ordered) {
      const flags = list.map(current);
      assert.deepEqual(flags, [...flags].sort((a, b) => Number(b) - Number(a)), `${spec} ${section}: running body first`);
      const before = base.find(([name]) => name === section)[1];
      for (const part of [true, false])
        assert.deepEqual(list.filter(info => current(info) === part).map(info => info.name),
          before.filter(info => current(info) === part).map(info => info.name), `${spec} ${section}: relative order kept`);
      if (flags[0]) leading++;
    }
    assert.ok(leading > 0, `${spec}: some section leads with a policy for the running body`);
    // Declared variants agree with the worker-resolved body for single-variant packs.
    for (const info of infos) {
      const rank = policyVariantRank(info.models);
      if (rank === 0) assert.equal(current(info), air, `${spec} ${info.name}: Air-only`);
      if (rank === 2) assert.equal(current(info), !air, `${spec} ${info.name}: EDU-only`);
    }
    const locomotion = ordered.find(([section]) => section === 'Locomotion')[1];
    const unprioritized = base.find(([section]) => section === 'Locomotion')[1];
    summary[spec] = { policies: infos.length, firstLocomotion: locomotion[0].name, firstVariant: policyVariantRank(locomotion[0].models),
      unprioritizedFirstVariant: policyVariantRank(unprioritized[0].models) };
  }
}
// Unprioritized, Air-only led Locomotion even on EDU bodies; now EDU bodies lead with EDU-capable policies.
assert.equal(summary.r1.unprioritizedFirstVariant, 0);
assert.equal(summary.g1.unprioritizedFirstVariant, 0);
assert.notEqual(summary.r1.firstVariant, 0);
assert.notEqual(summary.g1.firstVariant, 0);
assert.equal(summary.r1_air.firstVariant, 0);
assert.equal(summary.g1_air.firstVariant, 0);
console.log(JSON.stringify(summary));
