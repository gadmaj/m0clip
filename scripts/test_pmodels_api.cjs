/** Client-domain regression, no server/browser/network. Run after integration:
 * node scripts/test_pmodels_api.cjs
 * Uses real exported API behavior with controlled HTTP responses, not source pins.
 */
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');

const source = fs.readFileSync(path.join(__dirname, '../src/characters/pmodels.ts'), 'utf8');
const js = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 } }).outputText;
let moduleId = 0;
const calls = [];
let respond;
const originalFetch = global.fetch;
global.fetch = async (url, options) => {
  calls.push(String(url));
  assert.equal(options.mode, 'cors');
  assert.equal(options.credentials, 'omit');
  return respond(String(url), options);
};
async function fresh(handler) {
  calls.length = 0;
  respond = handler;
  const api = await import(`data:text/javascript;base64,${Buffer.from(js).toString('base64')}#${moduleId++}`);
  assert.equal(calls.length, 0, 'Import must not fetch indexes or binaries');
  return api;
}
const INDEX = 'https://wootguy.github.io/pmodels/database/';
const BETA = 'https://wootdata.github.io/hlmodels_data_29/models/player/betagordon/betagordon';
const LOCAL = '/assets/characters/picardia-v1sc/picardia_v1sc';
const response = (body, status = 200, headers = {}) => new Response(body, { status, headers });
const mdl = new Uint8Array([73, 68, 83, 84, 10, 0, 0, 0]);

(async () => {
  let api = await fresh(() => { throw new Error('Unexpected request'); });
  for (const name of ['!', '$', '--soldier assassin--', "a'b", 'été 人😀', 'literal%2Fname', 'file?#']) {
    const ref = { game: 'hl', name };
    assert.deepEqual(api.decodePmodelId(api.pmodelId(ref)), ref);
  }
  for (const name of ['', '.', '..', '../x', 'x/y', 'x\\y', 'x\0y', 'x\ny', 'x\u0085y', '\ud800']) {
    assert.throws(() => api.pmodelId({ game: 'hl', name }));
  }
  for (const id of [null, {}, 3, 'pmodels:tf:foo', 'pmodels:hl:', 'pmodels:hl:%', 'pmodels:hl:%2Fetc', 'pmodels:hl:%2e%2e', 'pmodels:hl:raw space', 'pmodels:hl:%61', 'pmodels:hl:%C3%A9%2f']) {
    assert.equal(api.decodePmodelId(id), null);
  }
  assert.match(api.pmodelRecord({ game: 'hl', name: 'été 人😀' }).thumbnail, /hlmodels_data_18\/models\/player\/%C3%A9t%C3%A9%20%E4%BA%BA%F0%9F%98%80\//);
  assert.equal(api.pmodelRecord({ game: 'hl', name: '--soldier assassin--' }).source, 'https://wootdata.github.io/hlmodels_data_17/models/player/--soldier%20assassin--/--soldier%20assassin--.json');
  assert.equal(calls.length, 0, 'Identity/thumbnail restoration must not fetch');

  const names = Array.from({ length: 86 }, (_, i) => `model-${String(i).padStart(2, '0')}`);
  api = await fresh(url => {
    if (url === `${INDEX}hl/model_names.txt`) return response(`!\r\n--soldier assassin--\r\nÉTÉ 人😀\r\n${names.join('\r\n')}\r\n`);
    if (url === `${INDEX}sc/model_names.txt`) return response('picardia\nmodel-sc\n');
    throw new Error(`Search downloaded a non-index file: ${url}`);
  });
  const first = await api.searchPmodels('');
  assert.equal(first.total, 91);
  assert.equal(first.limit, 40);
  assert.equal(first.results.length, 40);
  const next = await api.searchPmodels('', { offset: 40, limit: 999 });
  assert.equal(next.results.length, 40);
  assert.equal(new Set([...first.results, ...next.results].map(record => record.id)).size, 80);
  const tail = await api.searchPmodels('', { offset: 80 });
  assert.equal(tail.results.length, 11);
  assert.equal((await api.searchPmodels('ｅ́ｔｅ́ 人😀')).results[0].name, 'ÉTÉ 人😀');
  assert.equal((await api.searchPmodels('ASSASSIN soldier')).results[0].name, '--soldier assassin--');
  assert.equal((await api.searchPmodels('no matching name')).total, 0);
  assert.equal((await api.searchPmodels('picardia', { game: 'hl' })).total, 0);
  assert.equal(calls.length, 2, 'Paging/filtering must reuse in-memory names');

  let attempts = 0;
  api = await fresh(() => ++attempts === 1 ? response('unavailable', 503) : response('recovered\n'));
  await assert.rejects(api.searchPmodels('', { game: 'hl' }), /503/);
  assert.equal((await api.searchPmodels('', { game: 'hl' })).results[0].name, 'recovered');
  assert.equal(attempts, 2, 'Failed index loads must be retryable');

  let pendingResolve;
  let sharedSignal;
  api = await fresh((_url, options) => {
    sharedSignal = options.signal;
    return new Promise(resolve => { pendingResolve = resolve; });
  });
  const cancelled = new AbortController();
  const left = api.searchPmodels('', { game: 'hl', signal: cancelled.signal });
  const right = api.searchPmodels('', { game: 'hl' });
  const leftRejected = assert.rejects(left, { name: 'AbortError' });
  cancelled.abort();
  assert.equal(sharedSignal.aborted, false, 'One cancelled consumer must not cancel another');
  pendingResolve(response('shared\n'));
  await leftRejected;
  assert.equal((await right).total, 1);
  assert.equal(calls.length, 1);

  let abortCount = 0;
  attempts = 0;
  api = await fresh((_url, options) => {
    if (++attempts > 1) return response('fresh\n');
    return new Promise((_resolve, reject) => options.signal.addEventListener('abort', () => { abortCount++; reject(options.signal.reason); }, { once: true }));
  });
  const only = new AbortController();
  const abandoned = api.searchPmodels('', { game: 'hl', signal: only.signal });
  const abandonedRejected = assert.rejects(abandoned, { name: 'AbortError' });
  only.abort();
  const restarted = api.searchPmodels('', { game: 'hl' });
  await abandonedRejected;
  assert.equal((await restarted).results[0].name, 'fresh');
  assert.equal(abortCount, 1);
  assert.equal(attempts, 2);

  api = await fresh(url => {
    if (url === `${LOCAL}.mdl`) return response(mdl);
    if (url === `${LOCAL}.txt`) return response('Playermodel: TayKlor\nDesign and 3D Model: DAZ Productions, Inc.');
    throw new Error(`Local Picardia contacted upstream or an index: ${url}`);
  });
  const local = await api.loadPmodel({ game: 'hl', name: 'picardia_v1sc' });
  assert.deepEqual(new Uint8Array(local.model), mdl);
  assert.match(local.readme, /TayKlor/);
  assert.equal(local.source, `${LOCAL}.txt`);
  assert.deepEqual(calls, [`${LOCAL}.mdl`, `${LOCAL}.txt`]);

  api = await fresh(url => {
    if (url === `${BETA}.mdl` || url === `${BETA}t.mdl` || url === `${BETA}01.mdl`) return response(mdl);
    if (url === `${BETA}.json`) return response(JSON.stringify({ readme: true, t_model: true, seq_groups: '2', events: [{ options: 'sound/not-needed.wav' }] }));
    if (url === `${BETA}.txt`) return response('Original author retains copyright.');
    throw new Error(`Selected load fetched an unrelated file: ${url}`);
  });
  const selected = await api.loadPmodel({ game: 'hl', name: 'betagordon' });
  assert.deepEqual(calls, [`${BETA}.mdl`, `${BETA}.json`, `${BETA}.txt`], 'Metadata must not preload declared dependencies or sounds');
  await selected.loadDependency('betagordonT.MDL');
  await selected.loadDependency('betagordon01.mdl');
  await selected.loadDependency('betagordont.mdl');
  assert.deepEqual(calls.slice(3), [`${BETA}t.mdl`, `${BETA}01.mdl`], 'Declared dependencies are fetched lazily and deduplicated');
  for (const filename of ['../betagordont.mdl', 'other01.mdl', 'betagordon00.mdl', 'betagordon.txt', 'betagordon001.mdl']) assert.throws(() => selected.loadDependency(filename));

  api = await fresh(() => response('missing', 404));
  await assert.rejects(api.loadPmodel({ game: 'hl', name: 'betagordon' }), /404/);
  assert.equal(calls.length, 1, 'An essential MDL failure must not be hidden by metadata work');
  api = await fresh(url => url.endsWith('.mdl') ? response(mdl) : response('missing', 404));
  assert.equal((await api.loadPmodel({ game: 'hl', name: 'betagordon' })).readme, undefined);
  api = await fresh(url => url.endsWith('.mdl') ? response(mdl) : response('broken', 502));
  await assert.rejects(api.loadPmodel({ game: 'hl', name: 'betagordon' }), /502/);
  api = await fresh(() => response(mdl, 200, { 'content-length': String(65 * 1024 * 1024) }));
  await assert.rejects(api.loadPmodel({ game: 'hl', name: 'betagordon' }), /exceeds/);
  api = await fresh(() => response(new Uint8Array(2 * 1024 * 1024 + 1)));
  await assert.rejects(api.searchPmodels('', { game: 'hl' }), /exceeds/);
  console.log('PASS: Pmodels lazy indexes, bounded paging, Unicode IDs/shards, cancellation/retry, local selection, selected-only dependencies and response errors.');
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => { global.fetch = originalFetch; });
