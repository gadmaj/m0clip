/** CPU material boundaries. Synthetic authored fixtures only; no renderer fidelity claim.
 * Run: node scripts/test_raw_source_vmt.mjs
 * Optional real input: append --material NAME with ordered --bsp-pak BSP,
 * --vpk DIRECTORY_VPK [--chunk INDEX=FILE], or --file MATERIALS_PATH=FILE.
 * Each mount flag appends a lower-precedence mount. --chunk belongs to preceding VPK.
 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';


import { build } from 'esbuild';

const compiled = await build({ stdin: { contents: "export * from './src/maps/raw-source-vmt'; export * from './src/maps/raw-source-files';", resolveDir: process.cwd(), loader: 'ts' }, bundle: true, platform: 'node', format: 'cjs', write: false });
const module = { exports: {} };
new Function('module', 'require', compiled.outputFiles[0].text)(module, createRequire(import.meta.url));
const { SourceFileSystem, SourceMaterialBudget, parseSourceVmt, resolveSourceMaterial, createSourceMaterialResolver, sourceMaterialPath, parseSourceVector, parseSourceColor, parseSourceBoolean, parseSourceTextureTransform } = module.exports;
const lookup = (body, key) => body.entries.find(entry => entry.key === key);
const fsFor = async files => SourceFileSystem.create([{ kind: 'loose', files: Object.entries(files).map(([path, text]) => ({ path, blob: new Blob([text]) })) }]);
const originalFetch = globalThis.fetch;
globalThis.fetch = () => { throw new Error('Materials must not use HTTP'); };
try {
  const parsed = parseSourceVmt(`\ufeffLightmappedGeneric {
    "$basetexture" "Brick\\Wall" // real comment
    "$basetexture" "second"
    "$url" "https://host/a//b/*literal*/" /* comment { "ignored" */
    "Proxies" { "TextureScroll" { "rate" "1" } "TextureScroll" { "rate" "2" } }
    ">=DX90" { "$alpha" ".5" }
    "$linux" "yes" [$LINUX]
  } // no final newline`);
  assert.equal(parsed.shader, 'lightmappedgeneric');
  assert.equal(lookup(parsed.body, '$basetexture').value, 'Brick\\Wall');
  assert.equal(parsed.body.entries.filter(entry => entry.key === '$basetexture').length, 2);
  assert.equal(lookup(parsed.body, '$url').value, 'https://host/a//b/*literal*/');
  assert.equal(lookup(parsed.body, 'proxies').value.entries.length, 2);
  assert.deepEqual(lookup(parsed.body, '$linux').conditions, ['[$LINUX]']);
  const escaped = parseSourceVmt(String.raw`UnlitGeneric { "$quoted" "a\"b\nline\\tail\q" }`, { escapeSequences: true });
  assert.equal(lookup(escaped.body, '$quoted').value, 'a"b\nline\\tail\\q');
  for (const bad of ['Shader { "key" "unterminated }', 'Shader { key }', 'Shader { /* missing', 'Shader { key value', 'Shader {} Other {}', 'Shader { key value } }', 'Shader { key value [$LINUX }']) {
    assert.throws(() => parseSourceVmt(bad));
  }
  assert.throws(() => parseSourceVmt('S { a { b { c value } } }', { maxDepth: 1 }));
  assert.throws(() => parseSourceVmt('S { a one b two }', { maxEntries: 2 }));
  assert.throws(() => parseSourceVmt('S { a "long scalar" }', { maxStringBytes: 8 }));
  assert.throws(() => parseSourceVmt('S { a one }', { maxObjects: 3 }));
  assert.throws(() => parseSourceVmt('S { a one }', { maxObjectBytes: 200 }));
  const sharedFiles = await fsFor({
    'materials/shared.vmt': 'UnlitGeneric { "$alpha" ".25" "$alpha" ".75" }',
    'materials/w1.vmt': 'Patch { include shared }',
    'materials/w2.vmt': 'Patch { include shared }',
    'materials/w3.vmt': 'Patch { include shared }',
    'materials/change.vmt': 'Patch { include shared insert { "$alpha" ".5" "$new" "first" "$new" "second" } }',
  });
  // Three wrappers plus one unique base have exactly nine parsed entries.
  const sharedResolver = createSourceMaterialResolver(sharedFiles, { maxEntries: 9 });
  const wrappers = await Promise.all(['w1', 'w2', 'w3'].map(name => sharedResolver(name)));
  for (const wrapper of wrappers) {
    assert.equal(wrapper.body, wrappers[0].body);
    assert.equal(wrapper.sources[1].vmt, wrappers[0].sources[1].vmt);
    assert.equal(wrapper.parameters.$alpha, '.25');
    assert(Object.isFrozen(wrapper.body.entries));
  }
  const changed = await resolveSourceMaterial('change', sharedFiles);
  assert.deepEqual(changed.body.entries.filter(entry => entry.key === '$alpha').map(entry => entry.value), ['.5', '.75']);
  assert.deepEqual(changed.body.entries.filter(entry => entry.key === '$new').map(entry => entry.value), ['second']);
  // Conditioning visits seven entries; the merge must reserve its next five
  // operations before copying the destination or building the key index.
  await assert.rejects(() => resolveSourceMaterial('change', sharedFiles, { maxMergeWork: 7 }));
  await assert.rejects(() => resolveSourceMaterial('w1', sharedFiles, { maxResolvedEntries: 1 }));
  await assert.rejects(() => resolveSourceMaterial('w1', sharedFiles, { maxResolvedBytes: 1 }));
  const fallbackFs = await fsFor({ 'materials/fallback-budget.vmt': 'UnlitGeneric { ">=dx90" { "$alpha" ".5" "$surfaceprop" metal } }' });
  await assert.rejects(() => resolveSourceMaterial('fallback-budget', fallbackFs, { maxResolvedEntries: 5 }));
  const diagnosticText = `UnlitGeneric { ${Array.from({ length: 8 }, (_, i) => `"k${i}" "v" [$UNKNOWN_${i}]`).join(' ')} }`;
  const diagnosticFs = await fsFor({
    'materials/diagnostics.vmt': diagnosticText,
    'materials/d1.vmt': 'Patch { include diagnostics }',
    'materials/d2.vmt': 'Patch { include diagnostics }',
    'materials/d3.vmt': 'Patch { include diagnostics }',
  });
  const diagnosticResolver = createSourceMaterialResolver(diagnosticFs, { maxResolvedEntries: 180 });
  const diagnosticOne = await diagnosticResolver('d1'), diagnosticTwo = await diagnosticResolver('d2');
  assert.equal(diagnosticOne.body.entries.length, 0);
  assert.equal(diagnosticOne.capability.issues.length, 8);
  assert.deepEqual(diagnosticTwo.capability.issues, diagnosticOne.capability.issues);
  await assert.rejects(() => diagnosticResolver('d3'));
  const scalarText = Array(128).fill('1').join(' ');
  const scalarFs = await fsFor({
    'materials/scalar.vmt': `UnlitGeneric { "$alpha" "${scalarText}" }`,
    'materials/s1.vmt': 'Patch { include scalar }',
    'materials/s2.vmt': 'Patch { include scalar }',
    'materials/bad-scalar.vmt': `UnlitGeneric { "$alpha" "${scalarText} nope" }`,
  });
  const scalarResolver = createSourceMaterialResolver(scalarFs, { maxMergeWork: 500 });
  assert.equal((await scalarResolver('s1')).metadata.alpha, 1);
  await assert.rejects(() => scalarResolver('s2'));
  await assert.rejects(() => resolveSourceMaterial('bad-scalar', scalarFs));
  assert.throws(() => parseSourceVector(scalarText, new SourceMaterialBudget({ maxMergeWork: 100 })));
  assert.throws(() => parseSourceVector(scalarText, new SourceMaterialBudget({ maxResolvedBytes: 100 })));
  assert.deepEqual(parseSourceVector('{255 128 0}'), [1, 128 / 255, 0]);
  assert.deepEqual(parseSourceColor('[.25 .5 1}'), [.25, .5, 1]);
  assert.deepEqual(parseSourceColor('.125'), [.125, .125, .125]);
  assert.equal(parseSourceBoolean('-2'), true);
  assert.equal(parseSourceBoolean('false'), false);
  assert.throws(() => parseSourceVector('[1 nope 3]'));
  assert.equal(sourceMaterialPath('Materials\\Nested\\Sample.VMT'), 'materials/nested/sample.vmt');
  assert.equal(sourceMaterialPath('brick/a', 'vtf'), 'materials/brick/a.vtf');
  for (const bad of ['../escape', '//server/share', '\\\\server\\share', 'C:\\absolute', '/../escape', 'https://example/a', 'a/../b', 'a//b']) assert.throws(() => sourceMaterialPath(bad));
  const transform = parseSourceTextureTransform('center .5 .25 scale 2 3 rotate 90 translate .1 .2');
  const expected = [0, -3, .85, 2, 0, -.05, 0, 0, 1];
  transform.matrix.forEach((value, index) => assert(Math.abs(value - expected[index]) < 1e-12));
  assert.deepEqual(parseSourceTextureTransform('').matrix, [1, -0, 0, 0, 1, 0, 0, 0, 1]);
  assert.deepEqual(parseSourceTextureTransform('translate 1e-2 scale 2').translate, [.01, .01]);
  assert.throws(() => parseSourceTextureTransform('scale invalid'));

  const files = {
    'materials/base.vmt': `LightmappedGeneric {
      "$basetexture" "old" "$basetexture" "ignored-duplicate"
      "$alpha" ".2" "$color" "{255 128 0}"
      "$alphatest" "0" [$X360] "$alphatest" "1" [!$X360]
      "$inactive" [$LINUX] "linux-only"
      "$unknowncondition" "preserved" [$CUSTOM]
      "$unknowntransform" "opaque vendor syntax"
      ">=dx90" { "$alpha" ".6" }
      "proxies" { "TextureScroll" { "rate" "1" } "TextureScroll" { "rate" "2" } }
      "custom" { "keep" "yes" "change" "before" }
      "$conditional" "base" "ldr?$conditional" "ldr" "!hdr?$conditional" "not-hdr"
    }`,
    'materials/middle.vmt': `Patch { include "materials/base.vmt" replace { "$alpha" ".3" "$missing" "not-added" "custom" { "change" "after" "absent" "not-added" } } insert { "$alpha" ".4" "$added" "yes" "custom" { "new" "added" } } }`,
    'materials/outer.vmt': `Patch { include "middle" replace { "$basetexture" "Nested\\Final" } insert { "$nocull" "1" } }`,
  };
  const fs = await fsFor(files), material = await resolveSourceMaterial('outer', fs);
  assert.equal(material.shader, 'lightmappedgeneric');
  assert.deepEqual(material.materialDependencies, ['materials/outer.vmt', 'materials/middle.vmt', 'materials/base.vmt']);
  assert.equal(material.parameters.$basetexture, 'Nested\\Final');
  assert.deepEqual(material.body.entries.filter(entry => entry.key === '$basetexture').map(entry => entry.value), ['Nested\\Final', 'ignored-duplicate']);
  assert.equal(material.parameters.$missing, undefined);
  assert.equal(material.parameters.$added, 'yes');
  assert.equal(material.parameters.$alpha, '.6', 'selected fallback overrides patched main parameters');
  assert.equal(material.parameters.$conditional, 'not-hdr', 'distinct conditional parameter names apply in source order');
  assert.equal(material.metadata.alphatest, true);
  assert.equal(material.metadata.nocull, true);
  assert.deepEqual(material.metadata.color, [1, 128 / 255, 0]);
  assert.equal(material.parameters.$unknowncondition, undefined);
  assert(material.capability.issues.some(issue => issue.code === 'condition'));
  assert(material.capability.unknownParameters.includes('$unknowntransform'));
  assert.equal(material.selectedFallback, '>=dx90');
  assert.equal(material.proxies[0].value.entries.length, 2);
  const custom = lookup(material.body, 'custom').value;
  assert.equal(lookup(custom, 'keep').value, 'yes');
  assert.equal(lookup(custom, 'change').value, 'after');
  assert.equal(lookup(custom, 'absent'), undefined);
  assert.equal(lookup(custom, 'new').value, 'added');
  assert.deepEqual(material.textureDependencies, ['materials/nested/final.vtf']);
  assert.equal(material.textures[0].colorSpace, 'srgb');
  const noFallback = await resolveSourceMaterial('middle', fs, { materialDefines: [] });
  assert.equal(noFallback.parameters.$alpha, '.4', 'replace precedes insert, and insert overrides existing');
  const conditional = await resolveSourceMaterial('base', fs, { conditionSymbols: { LINUX: true, X360: true, CUSTOM: true } });
  assert.equal(conditional.parameters.$inactive, 'linux-only');
  assert.equal(conditional.metadata.alphatest, false);
  assert.equal(conditional.parameters.$unknowncondition, 'preserved');
  const separate = await resolveSourceMaterial('base', await fsFor({ 'materials/base.vmt': 'UnlitGeneric { "$basetexture" "separate" }' }));
  assert.equal(separate.metadata.basetexture, 'separate', 'no global material cache crosses imports');
  for (const [detailMode, decalMode, colorSpace] of [[1, 0, 'srgb'], [0, 1, 'linear']]) {
    const sampler = await resolveSourceMaterial('sampler', await fsFor({ 'materials/sampler.vmt': `LightmappedGeneric {
      "$basetexture" "base" "$frame" "2" "$detail" "detail" "$detailblendmode" "${detailMode}"
      "$decaltexture" "decal" "$decalblendmode" "${decalMode}" "$bumpmask" "mask"
      "$phongexponenttexture" "phong" "$selfillummask" "self" "$blendmodulatetexture" "blend"
    }` }));
    const texture = parameter => sampler.textures.find(entry => entry.parameter === parameter);
    assert.equal(texture('$basetexture').frame, 2);
    assert.equal(texture('$detail').colorSpace, colorSpace);
    assert.equal(texture('$decaltexture').colorSpace, colorSpace);
    for (const slot of ['$bumpmask', '$phongexponenttexture', '$selfillummask', '$blendmodulatetexture', '$decaltexture']) {
      assert.equal(texture(slot).frame, 0, `${slot} is independent of the animated base texture`);
    }
  }
  const undecidedDecal = await resolveSourceMaterial('decal', await fsFor({
    'materials/decal.vmt': 'LightmappedGeneric { "$decaltexture" "decal" }',
  }));
  assert.equal(undecidedDecal.textures.find(texture => texture.parameter === '$decaltexture').colorSpace, 'linear',
    'An omitted decal blend mode must not request sRGB sampling');
  assert.equal(await resolveSourceMaterial('absent', fs), undefined);
  await assert.rejects(resolveSourceMaterial('base', fs, { maxPatchDepth: 0 }));
  await assert.rejects(resolveSourceMaterial('outer', fs, { maxPatchDepth: 2 }));
  await assert.rejects(resolveSourceMaterial('bad', await fsFor({ 'materials/bad.vmt': 'Patch { include missing }' })));
  await assert.rejects(resolveSourceMaterial('a', await fsFor({ 'materials/a.vmt': 'Patch { include B }', 'materials/b.vmt': 'Patch { include "MATERIALS/A.VMT" }' })));
  const controller = new AbortController(); controller.abort();
  await assert.rejects(resolveSourceMaterial('base', fs, { signal: controller.signal }), { name: 'AbortError' });
  const opaque = await resolveSourceMaterial('opaque', await fsFor({ 'materials/opaque.vmt': 'Water { "$basetexture" "a" "$envmap" "env_cubemap" "$refracttexture" "_rt_WaterRefraction" "$vendor" "opaque" VendorBlock { x y } }' }));
  assert.equal(opaque.capability.shaderFamily, 'unsupported');
  assert.deepEqual(opaque.textures.map(texture => texture.kind), ['file', 'local-cubemap', 'runtime']);
  assert.equal(opaque.parameters.$vendor, 'opaque');
  assert(opaque.capability.unevaluatedBlocks.includes('vendorblock'));
  assert.equal(opaque.textures.find(texture => texture.kind === 'runtime').path, undefined);
  console.log('PASS quote/comment/escape/order/duplicate/condition/Patch/transform/dependency/isolation/cancellation boundaries');
} finally { globalThis.fetch = originalFetch; }
