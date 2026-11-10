/** Initially disabled Source props never draw: one renderable per animated map object.
 * node scripts/test_source_baseline.mjs [--maps public/assets/maps] [--bsp assets/bsp-cache]
 * --maps checks every converted map document the viewer loads; --bsp additionally
 * proves the released-data table equals the BSP entity lumps' studio models that stay
 * disabled after map start, using the raw-source importer's own map-start rule. */
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { build } from 'esbuild';
import * as THREE from 'three';

const bundle = async entry => {
  const result = await build({ entryPoints: [entry], bundle: true, platform: 'node', format: 'esm', write: false, external: ['three'] });
  return import('data:text/javascript;base64,' + Buffer.from(result.outputFiles[0].text).toString('base64'));
};
const { applySourceBaseline } = await bundle('src/render/source-baseline.ts');
const { sourceStartupInputs, sourceInitiallyDisabled } = await bundle('src/maps/raw-source-props.ts');
const option = name => { const i = process.argv.indexOf(name); return i < 0 ? undefined : process.argv[i + 1]; };

const FROG = 'models/nt/props_vehicles/rabbitfrog_dynamic.mdl';
function documentOf(nodes) {
  const scene = new THREE.Group(), json = { animations: [] }, animations = [];
  for (const { name, extras, position, clip } of nodes) {
    const object = new THREE.Group();
    object.userData = { ...extras, name }; object.position.fromArray(position); scene.add(object);
    if (clip) {
      json.animations.push({ name: `${name}:animation`, extras: { loop: clip.loop } });
      animations.push(new THREE.AnimationClip(`${name}:animation`, clip.duration, []));
    }
  }
  return { scene, animations, parser: { json } };
}
const visible = (document, name) => {
  let found; document.scene.traverse(object => { if (object.userData.name === name) found = object.visible; });
  return found;
};

// Raw-source importer: StartDisabled props stay disabled unless logic_auto enables them at map start.
{
  const entity = pairs => ({ pairs, values: Object.fromEntries(pairs) });
  const frog = (name, extra = [['StartDisabled', '1']]) => entity([['classname', 'prop_dynamic'], ['targetname', name], ['model', FROG], ...extra]);
  const entities = [
    frog('hop_takeoff'), frog('hop_idle', []), frog('hopperland'), frog('Bounced'), frog('spawned'), frog('wild'), frog('never'), frog('relayed'),
    entity([['classname', 'logic_auto'], ['OnNewGame', 'hop_takeoff,Enable,,10,1'], ['OnNewGame', 'HopperLand,Enable,,0,1'],
      ['OnMapSpawn', 'bounced\x1bTurnOn\x1b\x1b0\x1b-1'], ['OnMapSpawn', 'bounced,TurnOff,,0,-1'], ['onmapspawn', 'spawned,TurnOn,,,'],
      ['OnNewGame', 'wil*,Enable,,0,1'], ['OnNewGame', 'never,Enable,,0,0'], ['OnLoadGame', 'never,Enable,,0,1']]),
    entity([['classname', 'logic_relay'], ['OnTrigger', 'relayed,Enable,,0,1']]),
  ];
  const startup = sourceStartupInputs(entities);
  assert.deepEqual([...startup], [['hopperland', ['enable']], ['bounced', ['turnon', 'turnoff']], ['spawned', ['turnon']]]);
  assert.deepEqual(entities.slice(0, 8).map(e => sourceInitiallyDisabled(e, startup)), [true, false, false, true, false, true, true, true]);
}

// Rise: hop_takeoff (StartDisabled, enabled after 10 s) shares hop_idle's origin and model;
// hopperland is StartDisabled but enabled at delay 0, so the released-data table omits it.
const rise = (extra = {}) => documentOf([
  { name: 'prop_static:3:crate', extras: { sourceProp: 'models/crate.mdl', sourceClass: 'prop_static', ...extra }, position: [20.43245596, -2.511551999999999, 0.019507200000000016] },
  { name: 'prop_dynamic:813:rabbitfrog_dynamic', extras: { sourceProp: FROG, sourceClass: 'prop_dynamic', ...extra },
    position: [19.634845159999998, 32.007200399999995, 7.741112279999999], clip: { loop: false, duration: 8.666666984558105 } },
  { name: 'prop_dynamic:847:rabbitfrog_dynamic', extras: { sourceProp: FROG, sourceClass: 'prop_dynamic', ...extra },
    position: [20.43245596, -2.511551999999999, 0.019507200000000016], clip: { loop: false, duration: 9.966666221618652 } },
  { name: 'prop_dynamic:848:rabbitfrog_dynamic', extras: { sourceProp: FROG, sourceClass: 'prop_dynamic', ...extra },
    position: [20.43245596, -2.511551999999999, 0.019507200000000016], clip: { loop: true, duration: 0.03333333507180214 } },
]);
{
  const document = rise();
  assert.equal(applySourceBaseline('nt_rise_ctg', [document]), 1);
  assert.equal(visible(document, 'prop_dynamic:847:rabbitfrog_dynamic'), false, 'disabled take-off copy is hidden');
  assert.equal(visible(document, 'prop_dynamic:813:rabbitfrog_dynamic'), true, 'landing craft enabled at map start stays');
  assert.equal(visible(document, 'prop_dynamic:848:rabbitfrog_dynamic'), true, 'idle twin stays');
  assert.equal(visible(document, 'prop_static:3:crate'), true);
}
{
  const document = rise();
  assert.equal(applySourceBaseline(null, [document]), 0, 'local maps never use the released-data table');
  assert.equal(applySourceBaseline('nt_ghost_ctg', [document]), 0);
  assert.equal(visible(document, 'prop_dynamic:847:rabbitfrog_dynamic'), true);
}
{
  // Regenerated or different data must not hide a visible twin: swapped clips refuse and hide nothing.
  const document = rise();
  document.parser.json.animations[1].name = 'prop_dynamic:848:rabbitfrog_dynamic:animation';
  document.parser.json.animations[2].name = 'prop_dynamic:847:rabbitfrog_dynamic:animation';
  assert.throws(() => applySourceBaseline('nt_rise_ctg', [document]), /does not match its recorded disabled prop prop_dynamic:847/);
  for (const name of ['prop_dynamic:813:rabbitfrog_dynamic', 'prop_dynamic:847:rabbitfrog_dynamic', 'prop_dynamic:848:rabbitfrog_dynamic'])
    assert.equal(visible(document, name), true, name);
}
{
  // Converter-emitted flags win over the table; every prop must carry one.
  const document = rise({ sourceBaselineVisible: true });
  document.scene.children[3].userData.sourceBaselineVisible = false;
  assert.equal(applySourceBaseline('nt_rise_ctg', [document]), 1);
  assert.equal(visible(document, 'prop_dynamic:848:rabbitfrog_dynamic'), false);
  assert.equal(visible(document, 'prop_dynamic:847:rabbitfrog_dynamic'), true, 'flags, not the legacy table, decide');
  const incomplete = rise({ sourceBaselineVisible: true });
  delete incomplete.scene.children[0].userData.sourceBaselineVisible;
  assert.throws(() => applySourceBaseline('nt_rise_ctg', [incomplete]), /incomplete baseline visibility/);
  const invalid = rise({ sourceBaselineVisible: 'false' });
  assert.throws(() => applySourceBaseline('nt_rise_ctg', [invalid]), /Invalid Source prop baseline visibility/);
}
{
  // Raw-source documents: SourceProps applies sourcePlacement.baselineVisible itself.
  const document = rise({ sourcePlacement: {} });
  assert.equal(applySourceBaseline('nt_rise_ctg', [document]), 0);
  assert.equal(visible(document, 'prop_dynamic:847:rabbitfrog_dynamic'), true);
}
console.log('source baseline fixtures: ok');

const maps = option('--maps'), bsps = option('--bsp');
if (!maps) { console.log('converted map data: not requested (--maps)'); process.exit(0); }

function glbJson(file) {
  const bytes = readFileSync(file), length = bytes.readUInt32LE(12);
  assert.equal(bytes.readUInt32LE(16), 0x4e4f534a, `${file} JSON chunk`);
  return JSON.parse(bytes.subarray(20, 20 + length).toString('utf8'));
}
/** The viewer's own document: every scene root, its extras, origin and own clip. */
function loadedDocument(json) {
  const clips = new Map();
  for (const animation of json.animations ?? []) {
    const duration = Math.max(...animation.samplers.map(sampler => json.accessors[sampler.input].max[0]));
    clips.set(animation.name, { loop: animation.extras.loop, duration });
  }
  const matrix = new THREE.Matrix4(), position = new THREE.Vector3(), quaternion = new THREE.Quaternion(), scale = new THREE.Vector3();
  const box = new THREE.Box3(), sizes = [];
  const document = documentOf(json.scenes[json.scene ?? 0].nodes.map(index => {
    const node = json.nodes[index];
    if (node.matrix) matrix.fromArray(node.matrix).decompose(position, quaternion, scale); else position.fromArray(node.translation ?? [0, 0, 0]);
    // Model-space extent of the placement's own mesh nodes (identity children).
    box.makeEmpty();
    for (const child of [index, ...(node.children ?? [])]) for (const primitive of json.meshes[json.nodes[child].mesh]?.primitives ?? []) {
      const accessor = json.accessors[primitive.attributes.POSITION];
      box.expandByPoint(new THREE.Vector3().fromArray(accessor.min)).expandByPoint(new THREE.Vector3().fromArray(accessor.max));
    }
    sizes.push(box.isEmpty() ? 0 : box.getSize(new THREE.Vector3()).length() * scale.x);
    return { name: node.name, extras: node.extras ?? {}, position: position.toArray(), clip: clips.get(`${node.name}:animation`) };
  }));
  document.scene.children.forEach((object, i) => extents.set(object, sizes[i]));
  return document;
}
const extents = new WeakMap();
/** Visible animated placements of one model whose origins lie within a quarter of
 * its size: one drawn through the other. Authored neighbours (Dawn's butterfly pairs) are apart. */
function doubled(document) {
  const animated = new Set(document.parser.json.animations.map(animation => animation.name.slice(0, -':animation'.length)));
  const roots = document.scene.children.filter(object => object.visible && animated.has(object.userData.name));
  const pairs = [];
  for (let i = 0; i < roots.length; i++) for (let j = i + 1; j < roots.length; j++)
    if (roots[i].userData.sourceProp === roots[j].userData.sourceProp
      && roots[i].position.distanceTo(roots[j].position) < extents.get(roots[i]) / 4)
      pairs.push([roots[i].userData.name, roots[j].userData.name]);
  return pairs;
}
/** Raw-source SourceEntity records: ordered pairs (outputs included), last key wins in values. */
function bspEntities(bytes) {
  const offset = bytes.readInt32LE(8), length = bytes.readInt32LE(12), text = bytes.subarray(offset, offset + length).toString('latin1');
  return [...text.matchAll(/\{([^}]*)\}/g)].map(block => {
    const pairs = [...block[1].matchAll(/"([^"]*)"\s+"([^"]*)"/g)].map(m => [m[1], m[2]]);
    return { pairs, values: Object.fromEntries(pairs) };
  });
}
function staticPropCount(bytes) {
  const offset = bytes.readInt32LE(8 + 35 * 16), lumps = bytes.readInt32LE(offset);
  for (let i = 0; i < lumps; i++) {
    const p = offset + 4 + i * 16;
    if (bytes.toString('latin1', p, p + 4) !== 'prps') continue;
    let q = bytes.readInt32LE(p + 8);
    q += 4 + bytes.readUInt32LE(q) * 128; q += 4 + bytes.readUInt32LE(q) * 2;
    return bytes.readUInt32LE(q);
  }
  return 0;
}
const value = (entity, key) => Object.entries(entity.values).find(([name]) => name.toLowerCase() === key)?.[1]?.trim() || undefined;
/** The converters' baseline rule, with the raw-source importer's own map-start inputs. */
const baselineVisible = (entity, startup) => {
  const mode = Math.trunc(Number(value(entity, 'rendermode') ?? 0));
  return !sourceInitiallyDisabled(entity, startup) && mode !== 6 && mode !== 10 && (mode === 0 || (Math.trunc(Number(value(entity, 'renderamt') ?? 255)) & 255) !== 0);
};

let documents = 0, hiddenTotal = 0, doubledBefore = 0, startupEnabled = 0;
for (const id of readdirSync(maps).sort()) {
  const manifestFile = join(maps, id, 'manifest.json');
  if (!existsSync(manifestFile)) continue;
  const manifest = JSON.parse(readFileSync(manifestFile, 'utf8'));
  if (!manifest.props?.visual) continue;
  const json = glbJson(join(maps, id, manifest.native_textures?.props ?? manifest.props.visual));
  const before = loadedDocument(json), after = loadedDocument(json);
  doubledBefore += doubled(before).length;
  const hidden = applySourceBaseline(id, [after]);
  documents++; hiddenTotal += hidden;
  assert.deepEqual(doubled(after), [], `${id}: one renderable per animated object`);
  if (!bsps) continue;
  const bsp = join(bsps, `z.noclip.website_NeoTokyo_NeotokyoSource_maps_${id}.bsp`);
  assert(existsSync(bsp), `${id}: BSP missing from --bsp`);
  const bytes = readFileSync(bsp), base = staticPropCount(bytes), entities = bspEntities(bytes), startup = sourceStartupInputs(entities);
  const models = entities.filter(entity => (entity.values.model ?? '').toLowerCase().endsWith('.mdl'))
    .map((entity, k) => ({ entity, node: `${entity.values.classname}:${base + k}:${entity.values.model.toLowerCase().replaceAll('\\', '/').split('/').pop().slice(0, -4)}` }));
  const expected = models.filter(({ entity }) => !baselineVisible(entity, startup)).map(({ node }) => node);
  const actual = after.scene.children.filter(object => !object.visible).map(object => object.userData.name);
  assert.deepEqual(actual.sort(), expected.sort(), `${id}: hidden placements equal the BSP's studio entities disabled after map start`);
  // StartDisabled props logic_auto enables at delay 0 (landing craft, Bullet's train) must draw.
  for (const { entity, node } of models) {
    if (Number(value(entity, 'startdisabled') ?? 0) === 0 || sourceInitiallyDisabled(entity, startup)) continue;
    const object = after.scene.children.find(child => child.userData.name === node);
    assert(object?.visible, `${id}: ${node} is enabled at map start and must stay visible`);
    startupEnabled++;
  }
}
assert(documents > 0, 'no converted map documents found');
assert(doubledBefore > 0, 'the released data is expected to contain doubled animated placements before the baseline');
if (bsps) assert.equal(startupEnabled, 7, 'Bullet timer and six hopperland craft are enabled at map start');
console.log(`converted map data: ${documents} documents, ${doubledBefore} doubled animated pairs before, ${hiddenTotal} disabled placements hidden${bsps ? `, ${startupEnabled} map-start-enabled kept visible, table equals BSP entity lumps` : ''}: ok`);
