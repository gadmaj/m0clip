/** Bounded serializer + actual GLB/lightstyle consumer regressions.
 * Run: node scripts/test_raw_source_json.mjs
 * Small CPU-only fixtures; no downloads, native assets or graphics context. */
import assert from 'node:assert/strict';
import { build } from 'esbuild';
const compiled = await build({ stdin: { contents: `
  export * from './src/maps/raw-source-json';
  export * from './src/maps/raw-source-gltf';
  export * from './src/render/source-lightstyles';`, resolveDir: process.cwd(), loader: 'ts' },
  bundle: true, platform: 'browser', format: 'esm', write: false });
const { preflightSourceJson, encodeSourceJson, preflightSourceJsonBytes, parseSourceJson, SourceGlb, SourceLightStyles } =
  await import('data:text/javascript;base64,' + Buffer.from(compiled.outputFiles[0].text).toString('base64'));
const utf8 = new TextEncoder();
const data = Object.assign(Object.create(null), {
  'quote"\\\n': '"\\\b\t\n\f\r\u0000\u001f/ café 水 😀 \ud800 X \udfff',
  numbers: [0, -0, 1e-7, 1e21, NaN, Infinity, -Infinity],
  omitted: undefined, list: [undefined, , null, true, false],
  nested: { toJSON: 'ordinary data', value: '🦀' },
});
const previous = utf8.encode(JSON.stringify(data));
assert.deepEqual(encodeSourceJson(data), previous, 'valid internal graphs preserve exact JSON UTF-8 bytes');
assert.equal(preflightSourceJson(data).byteLength, previous.length);
assert.deepEqual(encodeSourceJson(data, { maxBytes: previous.length }), previous);
assert.throws(() => encodeSourceJson(data, { maxBytes: previous.length - 1 }));
for (const text of ['\u0000', '\b\t\n\f\r', '\\"', 'é水😀', '\ud800', '\udfff', '\ud800\ud800', '\udfff\ud800']) {
  assert.deepEqual(encodeSourceJson({ [text]: text }), utf8.encode(JSON.stringify({ [text]: text })));
}
const shared = { label: 'x'.repeat(128) }, repeated = { materials: Array(16).fill(shared) };
let stringifies = 0;
const stringify = JSON.stringify;
try {
  JSON.stringify = (...args) => { stringifies++; return stringify(...args); };
  assert.throws(() => encodeSourceJson(repeated, { maxBytes: 256 }));
  const glb = new SourceGlb(512); glb.json.extras = repeated;
  assert.throws(() => glb.finish());
  assert.equal(stringifies, 0, 'amplification is rejected before JSON.stringify');
} finally { JSON.stringify = stringify; }
assert.equal(preflightSourceJson([shared, shared]).byteLength, utf8.encode(JSON.stringify([shared, shared])).length);
assert.throws(() => preflightSourceJson([shared, shared], { maxNodes: 3 }));
assert.throws(() => preflightSourceJson({ a: undefined, b: undefined }, { maxMembers: 1 }));
assert.throws(() => preflightSourceJson({ a: { b: 1 } }, { maxDepth: 2 }));
const cycle = {}; cycle.self = cycle;
assert.throws(() => encodeSourceJson(cycle));
let getterCalls = 0, hookCalls = 0;
assert.throws(() => encodeSourceJson({ get value() { getterCalls++; return 'bad'; } }));
assert.throws(() => encodeSourceJson({ toJSON() { hookCalls++; return 'bad'; } }));
assert.equal(getterCalls + hookCalls, 0, 'preflight does not run accessor or serialization hooks');
assert.throws(() => encodeSourceJson({ value: 1n }));
const aborted = new AbortController(); aborted.abort(new Error('JSON cancelled'));
assert.throws(() => encodeSourceJson(data, { signal: aborted.signal }));
assert.throws(() => parseSourceJson(previous, { signal: aborted.signal }));

// Read the genuine GLB JSON and BIN chunks, not a serializer-only echo.
const glb = new SourceGlb();
glb.json.extras = data;
glb.json.nodes.push({ name: 'unicode 水😀', translation: [1, 2, 3] });
glb.json.scenes[0].nodes.push(0);
glb.view(Uint8Array.of(10, 20, 30));
const snapshot = { ...glb.json, buffers: [{ byteLength: 4 }] };
for (const [key, value] of Object.entries(snapshot)) if (Array.isArray(value) && !value.length) delete snapshot[key];
const expected = utf8.encode(JSON.stringify(snapshot));
const blob = glb.finish(), bytes = new Uint8Array(await blob.arrayBuffer()), header = new DataView(bytes.buffer);
assert.equal(header.getUint32(0, true), 0x46546c67);
assert.equal(header.getUint32(8, true), blob.size);
assert.deepEqual(bytes.subarray(20, 20 + expected.length), expected);
const jsonLength = header.getUint32(12, true), binStart = 20 + jsonLength;
assert.equal(header.getUint32(binStart + 4, true), 0x004e4942);
assert.deepEqual([...bytes.subarray(binStart + 8)], [10, 20, 30, 0]);
const exact = new SourceGlb(blob.size);
exact.json.extras = data;
exact.json.nodes.push({ name: 'unicode 水😀', translation: [1, 2, 3] });
exact.json.scenes[0].nodes.push(0);
exact.view(Uint8Array.of(10, 20, 30));
assert.equal(exact.finish().size, blob.size);

const valid = { size: 4, pages: {}, patterns: {}, patches: [] };
const validBytes = utf8.encode(JSON.stringify(valid));
const parsed = parseSourceJson(validBytes);
assert.deepEqual(parsed.value, valid);
const unknown = utf8.encode(JSON.stringify({ ...valid, unused: [{}, {}, {}] }));
let parses = 0;
const parse = JSON.parse;
try {
  JSON.parse = (...args) => { parses++; return parse(...args); };
  for (const limits of [{ maxNodes: 6 }, { maxMembers: 4 }, { maxDepth: 2 }, { maxAllocationBytes: 64 }]) {
    assert.throws(() => parseSourceJson(unknown, limits));
  }
  assert.equal(parses, 0, 'unknown-subtree structure is rejected before JSON.parse');
} finally { JSON.parse = parse; }
for (const text of ['{"a":}', '[1,]', '{"a":1,}', '01', '1.', '1e', 'true false', '"\u0001"', '"\\x"']) {
  assert.throws(() => parseSourceJson(utf8.encode(text)), SyntaxError, text);
}
for (const encoded of [[34, 0xc0, 0x80, 34], [34, 0xed, 0xa0, 0x80, 34], [34, 0xf4, 0x90, 0x80, 0x80, 34], [34, 0xe2]]) {
  assert.throws(() => parseSourceJson(Uint8Array.from(encoded)), SyntaxError);
}
assert.deepEqual(parseSourceJson(utf8.encode('\ufeff{"water":"水😀","lone":"\\ud800"}')).value, { water: '水😀', lone: '\ud800' });
assert.equal(preflightSourceJsonBytes(utf8.encode('{"a":{},"a":{}}')).nodes, 3, 'duplicate-key subtrees are charged too');
function source(metadata) {
  return { has: file => file === 'lightstyles.json', read: async () => new Response(metadata, { headers: { 'content-type': 'application/json' } }) };
}
for (const limits of [{ maxJsonNodes: 6 }, { maxJsonMembers: 4 }, { maxJsonDepth: 2 }]) {
  await assert.rejects(SourceLightStyles.load(source(unknown), { maxBytes: 4096, ...limits }));
}
assert.deepEqual(parseSourceJson(previous).value, JSON.parse(JSON.stringify(data)));
assert.equal(parseSourceJson(utf8.encode(' \n -12.5e+3 \t')).value, -12500);
assert.throws(() => parseSourceJson(validBytes, { maxBytes: validBytes.length - 1 }));
console.log('Raw Source JSON serialization, structural ownership, GLB and lightstyle consumers passed');
