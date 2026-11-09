/** Compact policy-card titles from real hosted pack metadata: distinct per gallery, no separate family word
 * segment, and every added tag is the variant and/or a part of the exact canonical checkpoint name. Leading
 * or trailing robot or own-variant tokens are trimmed only when titles stay distinct; otherwise the
 * checkpoint part is copied verbatim, so `r1air`/`g1` can remain inside it. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { build } from 'esbuild';

const result = await build({ stdin: { contents: "export {policyInfo} from './src/worker/robot-policy'; export {packEntries} from './src/packs'; export {compactPolicyTitles, policyPresentation, policyVariantLabel} from './src/ui/policy-names';", resolveDir: process.cwd() }, bundle: true, platform: 'node', format: 'cjs', write: false });
const module = { exports: {} };
new Function('module', 'exports', 'require', result.outputFiles[0].text)(module, module.exports, createRequire(import.meta.url));
const { policyInfo, packEntries, compactPolicyTitles, policyPresentation, policyVariantLabel } = module.exports;

/** Every compact title is the activity title plus, optionally, the variant and a verbatim part of the name. */
function assertIdentity(entries, titles, family) {
  assert.equal(titles.size, entries.length);
  assert.equal(new Set(titles.values()).size, entries.length, `${family}: titles are distinct`);
  for (const entry of entries) {
    const title = policyPresentation(entry.name).title, compact = titles.get(entry.name);
    assert.ok(compact === title || compact.startsWith(`${title} · `), `${entry.name}: ${compact}`);
    let tag = compact.slice(title.length + 3);
    const variant = policyVariantLabel(entry.models);
    if (variant && (tag === variant || tag.startsWith(`${variant} · `))) tag = tag.slice(variant.length + 3);
    assert.ok(entry.name.includes(tag), `${entry.name}: tag "${tag}" quotes the canonical name`);
    // No standalone family segment or `R1 Air`-style prefix; family text inside an exact checkpoint part stays.
    assert.ok(!compact.split(' · ').includes(family.toUpperCase()) && !compact.includes(`${family.toUpperCase()} `),
      `${entry.name}: no family word in ${compact}`);
  }
}

const samples = {};
for (const [family, specs] of [['r1', ['r1', 'r1_air']], ['g1', ['g1', 'g1_air']]]) {
  const entries = JSON.parse(readFileSync(`public/assets/packs/${family}-default-v1.json`, 'utf8')).flatMap(packEntries);
  for (const spec of specs) {
    const infos = entries.map(entry => policyInfo(entry, spec, false));
    const titles = compactPolicyTitles(infos, family.toUpperCase());
    assertIdentity(infos, titles, family);
    for (const info of infos) {
      const compact = titles.get(info.name);
      // Shorter than the full canonical label `Title (canonical/name)`.
      assert.ok(compact.length < policyPresentation(info.name).label.length, info.name);
      // The longest real title is 55 characters; anything longer is a derivation regression.
      assert.ok(compact.length <= 56, `${info.name}: ${compact.length} characters`);
    }
    // A searched subset keeps the titles it had: they are distinct across the whole gallery.
    const searched = infos.filter(info => /walk/.test(info.name));
    assert.ok(searched.length > 1);
    assert.equal(new Set(searched.map(info => titles.get(info.name))).size, searched.length);
    samples[spec] = Object.fromEntries(infos.slice(0, 4).map(info => [info.name, titles.get(info.name)]));
  }
}

const check = (entries, family, expected) => {
  const titles = compactPolicyTitles(entries, family);
  assertIdentity(entries, titles, family);
  assert.deepEqual(entries.map(entry => titles.get(entry.name)), expected);
};
// Only the variant differs: the variant tells them apart.
check([{ name: 'tangxia/tangxia_air', models: ['air'] }, { name: 'tangxia/tangxia_edu', models: ['edu'] }], 'R1',
  ['Lie down · Air', 'Lie down · EDU']);
// Only the checkpoint differs: the differing part of the leaf.
check([{ name: 'dances/607_gongfu', models: ['edu'] }, { name: 'dances/607_gongfu-new_urdf_50k', models: ['edu'] }], 'R1',
  ['Kung fu routine', 'Kung fu routine · new_urdf_50k']);
// The same leaf in two variants and two checkpoints: the variant, then the checkpoint within it.
check([
  { name: 'dances_air/602_dance1_subject2_segment2', models: ['air'] },
  { name: 'dances/602_dance1_subject2_segment2', models: ['edu'] },
  { name: 'dances/602_dance1_subject2_segment2-policy_37k', models: ['edu'] },
], 'R1', ['Dance routine · part 2 · Air', 'Dance routine · part 2 · EDU', 'Dance routine · part 2 · EDU · policy_37k']);
// The same leaf and variant in different groups: the differing part of the whole name.
check([{ name: 'cpy_walk_jump/actor', models: ['edu'] }, { name: 'zjx_walk_jump/actor', models: ['edu'] }], 'G1',
  ['Walk and jump · cpy', 'Walk and jump · zjx']);
// Family and own-variant words at the edges are implied by the selected robot; another variant's word is kept.
check([
  { name: 'locomotion_20dofs/r1_20dofs_loco', models: ['air'] },
  { name: 'locomotion_20dofs/r1_20dofs_loco_reset', models: ['air'] },
  { name: 'locomotion_20dofs/r1air_amp_walkrun10000', models: ['air'] },
  { name: 'locomotion_20dofs/amp6_cwdata_015', models: ['air'] },
], 'R1', ['Walking · 20dofs_loco', 'Walking · 20dofs_loco_reset', 'Walk and run', 'Walking · amp6_cwdata_015']);
check([{ name: 'dances_air/607_gongfu', models: ['air'] }, { name: 'dances_air/607_gongfu-edu_fix_15k', models: ['air'] }], 'R1',
  ['Kung fu routine', 'Kung fu routine · edu_fix_15k']);
// Trimming that would make two titles equal is not applied.
check([{ name: 'qishen/qishen_air', models: ['air'] }, { name: 'qishen/qishen_edu', models: ['edu'] }, { name: 'dances/qishen1', models: ['edu'] }],
  'R1', ['Get up · qishen_air', 'Get up · qishen_edu', 'Get up · qishen1']);
// An imported name whose readable title equals another compact title: both use exact names.
check([
  { name: 'tangxia/tangxia_air', models: ['air'] }, { name: 'tangxia/tangxia_edu', models: ['edu'] },
  { name: 'custom/lie down · EDU', models: ['edu'] },
], 'R1', ['Lie down · Air', 'Lie down · tangxia/tangxia_edu', 'Lie down · EDU · custom/lie down · EDU']);
// A lone policy keeps its activity title.
check([{ name: 'simple_motion/hello', models: ['edu'] }], 'R1', ['Greeting']);

console.log(JSON.stringify(samples));
