/** Resolve real hosted/registry policy metadata without fetching weights or starting physics. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
import { load as yamlLoad } from 'js-yaml';

const result = await build({ stdin: { contents: "export * from './src/worker/robot-policy'; export {packEntries} from './src/packs'; export {getSpec} from './src/robots';", resolveDir: process.cwd() }, bundle: true, platform: 'node', format: 'cjs', write: false });
const module = { exports: {} };
new Function('module', 'exports', 'require', result.outputFiles[0].text)(module, module.exports, createRequire(import.meta.url));
const { selectRobotPolicy, specFor, modelKey, packEntries, getSpec } = module.exports;
const packs = JSON.parse(readFileSync('public/assets/packs/r1-default-v1.json', 'utf8'));
const entries = packs.flatMap(packEntries);
const walk = 'amp_locomotion/amp_locomotion';
const airDance = 'dances_air/601_dance1_subject2_segment1';
const eduDance = 'dances/601_dance1_subject2_segment1';
const dual = 'locomotion_gait/locomotion_gait';
const chosen = selection => selection.policies[selection.index];

// A remembered EDU checkpoint must not override Air, with or without explicit launch intent.
for (const explicit of [false, true]) {
  for (const preferred of [undefined, walk]) {
    const air = selectRobotPolicy('r1_air', entries, preferred, explicit);
    assert.equal(air.robot, 'r1_air');
    assert.equal(chosen(air).dof, 20);
    assert.equal(specFor(chosen(air), air.robot, true), 'r1_air');
    assert.equal(air.policies.length, entries.length, 'All family policies remain available for deliberate selection');
    assert.equal(getSpec(air.robot).scene, 'air_scene.xml');
  }
}
const savedAir = selectRobotPolicy('r1_air', entries, dual, true);
assert.equal(chosen(savedAir).name, dual);
assert.equal(savedAir.robot, 'r1_air');
const savedEdu = selectRobotPolicy('r1', entries, eduDance, true);
assert.equal(chosen(savedEdu).name, eduDance, 'Compatible saved policy wins over walking AMP');
assert.equal(chosen(selectRobotPolicy('r1', entries, airDance, true)).name, walk, 'Incompatible saved Air policy yields to compatible walking AMP');

// R1 EDU 20 and EDU 24 share a compiled scene, not a controlled-joint spec.
const partial = selectRobotPolicy('r1_air_edu', entries, walk, true);
assert.equal(partial.robot, 'r1_air_edu');
assert.equal(chosen(partial).dof, 20);
assert.equal(specFor(chosen(partial), partial.robot, true), 'r1_air_edu');
assert.equal(modelKey(getSpec('r1')), modelKey(getSpec('r1_air_edu')));
assert.notEqual(modelKey(getSpec('r1_air')), modelKey(getSpec('r1_air_edu')));
assert.equal(getSpec(partial.robot).joint_names.length, 20);
assert.equal(getSpec('r1').joint_names.length, 24);
assert.equal(specFor(entries.find(entry => entry.name === walk), 'r1_air'), 'r1', 'Deliberate policy selection can still change hardware');

// Build the same metadata entries a real G1 pack importer produces from registry configs.
const g1Registry = JSON.parse(readFileSync('registry/g1/index.json', 'utf8')).policies;
const g1 = ['cpy_walk_run_29dofs/actor', 'cpy_run_29dofs/actor'].flatMap(name => {
  const source = g1Registry.find(entry => entry.name === name);
  assert.ok(source, name);
  return packEntries({ id: name, manifest: { robot: source.robot, family: source.family, baseName: name, group: name.split('/')[0], checkpoints: [{ id: 'actor', file: 'checkpoints/actor.onnx' }] }, config: yamlLoad(readFileSync(source.config, 'utf8')), files: {} });
});
const g1Air = selectRobotPolicy('g1_air', g1, 'cpy_walk_run_29dofs/actor', true);
assert.equal(chosen(g1Air).name, 'cpy_run_29dofs/actor');
assert.equal(g1Air.robot, 'g1_air');
assert.equal(specFor(chosen(g1Air), 'g1_air', true), 'g1_air');
assert.equal(specFor(chosen(g1Air), 'g1_air'), 'g1', 'Ordinary deliberate G1 policy selection keeps its existing semantics');

const airOnly = entries.filter(entry => entry.name === airDance);
const fallback = selectRobotPolicy('r1', airOnly);
assert.equal(fallback.robot, 'r1_air', 'Nonexplicit legacy Air-only import adopts its real Air scene');
assert.equal(chosen(fallback).name, airDance);
assert.throws(() => selectRobotPolicy('r1', airOnly, undefined, true));
const eduOnly = entries.filter(entry => entry.name === walk);
assert.throws(() => selectRobotPolicy('r1_air', eduOnly, walk, true));
assert.deepEqual(selectRobotPolicy('go2', entries, undefined, true), { robot: 'go2', policies: [], index: -1 }, 'Empty families retain honest idle preview');
console.log(JSON.stringify({ airSavedAndDefault: true, edu20NotEdu24: true, g1DualKeepsAir: true, compatibleSavedWins: true, legacyAirOnlyFallback: true, explicitUnavailable: true, fullFamilyCatalog: entries.length }));
