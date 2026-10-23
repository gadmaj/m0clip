/** Chromium: real worker launch respects Air intent; unavailable live selection preserves its active engine/driver. */
const assert = require('node:assert/strict');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const { readFileSync } = require('node:fs');

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROME_BIN || '/usr/bin/google-chrome', headless: true, args: ['--no-sandbox'] });
  const base = process.env.BASE_URL || 'http://127.0.0.1:5176';
  const catalog = JSON.parse(readFileSync('public/assets/packs/r1-default-v1.json', 'utf8'));
  const walk = 'amp_locomotion/amp_locomotion';
  const contexts = [];
  try {
    async function fixture(packs) {
      const context = await browser.newContext(); contexts.push(context);
      const page = await context.newPage(), pageErrors = [], weightRequests = [];
      page.on('pageerror', error => pageErrors.push(error.message));
      page.on('request', request => { if (/\/assets\/packs\/.*\.zip(?:\?|$)/.test(request.url())) weightRequests.push(request.url()); });
      await context.route('**/src/worker/sim.worker.ts*', async route => {
        const response = await route.fetch(), original = await response.text();
        // Observe identities around real operations; do not replace engines, drivers, policy data or resolution.
        const hook = `
          let identityBefore, identityCompiles = 0;
          const identityCreate = Engine.create.bind(Engine);
          Engine.create = (...args) => { identityCompiles++; return identityCreate(...args); };
          self.addEventListener('message', ({data}) => {
            if(data.t !== 'test:identity') return;
            void serializeWork(() => {
              if(data.tag === 'before') identityBefore = {robot:sim.robot,policies:sim.policies,index:sim.polIdx,driver:sim.driver,engine:sim.eng,fsm:sim.fsm,playback:sim.playback};
              const prior = identityBefore;
              self.postMessage({t:'test-identity',tag:data.tag,robot:sim.robot,policy:sim.policies[sim.polIdx]?.name,index:sim.polIdx,driver:!!sim.driver,compiles:identityCompiles,
                unchanged:prior ? {robot:sim.robot===prior.robot,policies:sim.policies===prior.policies,index:sim.polIdx===prior.index,driver:sim.driver===prior.driver,engine:sim.eng===prior.engine,fsm:sim.fsm===prior.fsm,playback:sim.playback===prior.playback} : null});
            });
          });`;
        const body = original.replace('const sim = new SimWorker();', 'const sim = new SimWorker();' + hook);
        assert.notEqual(body, original, 'Worker identity observation hook must attach');
        await route.fulfill({ response, body });
      });
      await page.route(base + '/__robot-identity', route => route.fulfill({ contentType: 'text/html', headers: { 'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'require-corp' }, body: '<body></body>' }));
      await page.goto(base + '/__robot-identity');
      await page.evaluate(async packs => {
        const { storePack } = await import('/src/packs/index.ts');
        for (const pack of packs) await storePack({ ...pack, files: {} });
        const db = await new Promise((resolve, reject) => {
          const request = indexedDB.open('ume-default-packs', 1);
          request.onupgradeneeded = () => request.result.createObjectStore('settings');
          request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
        });
        await new Promise((resolve, reject) => {
          const tx = db.transaction('settings', 'readwrite'); tx.objectStore('settings').put(true, 'r1-default-v1');
          tx.oncomplete = resolve; tx.onerror = () => reject(tx.error);
        }); db.close();
        window.workerErrors = []; window.models = []; window.identities = {}; window.identityFrames = 0; window.workerStatus = null;
        window.worker = new Worker('/src/worker/sim.worker.ts?worker_file&type=module', { type: 'module' });
        worker.onmessage = ({data:m}) => {
          if (m.t === 'error' || m.t === 'notice') workerErrors.push(m.msg);
          if (m.t === 'model') models.push({robot:m.desc.robot,nq:m.desc.nq});
          if (m.t === 'status') window.workerStatus = m;
          if (m.t === 'frame') { identityFrames++; if (!m.qpos.every(Number.isFinite)) workerErrors.push('Non-finite frame'); }
          if (m.t === 'test-identity') identities[m.tag] = m;
        };
        worker.onerror=event=>workerErrors.push(event.message||'Worker module failed to load');
      }, packs);
      return { page, pageErrors, weightRequests };
    }

    const air = await fixture(catalog);
    await air.page.evaluate(walk => worker.postMessage({t:'init',robot:'r1_air',robotExplicit:true,policy:walk,terrain:'flat'}), walk);
    try {
      await air.page.waitForFunction(() => workerErrors.length || identityFrames >= 3 && window.workerStatus?.dof === 20, null, {timeout:180000});
    } catch(error) {
      console.error(await air.page.evaluate(()=>({models,status:window.workerStatus,workerErrors,frames:identityFrames})));throw error;
    }
    const airProof = await air.page.evaluate(() => ({models,status:window.workerStatus,workerErrors,frames:identityFrames}));
    assert.deepEqual(airProof.workerErrors, []);
    assert.deepEqual(airProof.models.map(model => model.robot), ['r1_air']);
    assert.equal(airProof.models[0].nq, 27);
    assert.notEqual(airProof.status.policy, walk);
    assert.equal(airProof.status.policies.length, catalog.flatMap(pack => pack.manifest.checkpoints).length);
    assert.deepEqual(airProof.workerErrors, []); assert.deepEqual(air.pageErrors, []);
    await air.page.evaluate(() => worker.terminate());
    await contexts[0].close();

    const edu = await fixture(catalog.filter(pack => pack.id === walk));
    // Explicit init must fail before compiling a model or requesting any weight pack.
    await edu.page.evaluate(walk => worker.postMessage({t:'init',robot:'r1_air',robotExplicit:true,policy:walk,terrain:'flat'}), walk);
    await edu.page.waitForFunction(() => workerErrors.length === 1);
    await edu.page.evaluate(() => worker.postMessage({t:'test:identity',tag:'rejected-init'}));
    await edu.page.waitForFunction(() => identities['rejected-init']);
    const rejectedInit = await edu.page.evaluate(() => ({identity:identities['rejected-init'],models,errors:workerErrors}));
    assert.equal(rejectedInit.identity.compiles, 0); assert.equal(rejectedInit.identity.driver, false);
    assert.deepEqual(rejectedInit.models, []); assert.deepEqual(edu.weightRequests, []);

    // Recover into a real learned EDU controller, then reject unavailable Air without poisoning it.
    await edu.page.evaluate(walk => worker.postMessage({t:'init',robot:'r1',robotExplicit:true,policy:walk,terrain:'flat'}), walk);
    await edu.page.waitForFunction(() => identityFrames >= 3 && window.workerStatus?.policy === 'amp_locomotion/amp_locomotion', null, {timeout:180000});
    await edu.page.evaluate(() => { worker.postMessage({t:'pause',on:true}); worker.postMessage({t:'test:identity',tag:'before'}); });
    await edu.page.waitForFunction(() => identities.before);
    const downloadsBefore = edu.weightRequests.length;
    await edu.page.evaluate(() => worker.postMessage({t:'robot',robot:'r1_air'}));
    await edu.page.waitForFunction(() => workerErrors.length === 2);
    await edu.page.evaluate(() => worker.postMessage({t:'test:identity',tag:'after'}));
    await edu.page.waitForFunction(() => identities.after);
    const live = await edu.page.evaluate(() => ({before:identities.before,after:identities.after,models,errors:workerErrors}));
    assert.equal(live.before.driver, true); assert.equal(live.after.robot, 'r1'); assert.equal(live.after.policy, walk);
    assert.deepEqual(live.after.unchanged, {robot:true,policies:true,index:true,driver:true,engine:true,fsm:true,playback:true});
    assert.equal(live.after.compiles, live.before.compiles);
    assert.deepEqual(live.models.map(model => model.robot), ['r1']);
    assert.equal(edu.weightRequests.length, downloadsBefore);
    assert.deepEqual(edu.pageErrors, []);
    console.log(JSON.stringify({air:{robot:airProof.models[0].robot,nq:airProof.models[0].nq,policy:airProof.status.policy,frames:airProof.frames},explicitInitPreflight:rejectedInit.identity,livePreflight:live.after}));
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
