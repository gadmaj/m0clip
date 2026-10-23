/** Chromium: the lean production runtime drives a real R1 policy inside the simulation worker. */
const assert=require('node:assert/strict'),{chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
(async()=>{const browser=await chromium.launch({headless:true,args:['--no-sandbox']});try{
 const page=await browser.newPage({deviceScaleFactor:.25}),errors=[],wasm=[],downloads=[];
 page.on('pageerror',e=>errors.push(e.message));page.on('response',r=>{if(new URL(r.url()).pathname.endsWith('.wasm'))downloads.push(r.body().then(body=>wasm.push({url:r.url(),bytes:body.length,encoding:r.headers()['content-encoding']??'identity'})))});
 for(const pattern of ['**/src/main.ts*','**/assets/main-*.js'])await page.route(pattern,async route=>{
  const response=await route.fetch(),original=await response.text(),body=require('./expose-app.cjs')(original).replaceAll('this.view.render()','void 0');await route.fulfill({response,body});
 });
 await page.goto((process.env.BASE_URL||'http://127.0.0.1:4179')+'/?plain&body=stock').then(() => require('./launch-scene.cjs').launchScene(page));
 await page.waitForFunction(()=>window.__app?.lastFrame&&document.querySelector('#overlay').classList.contains('hidden'),null,{timeout:120000});
 await page.evaluate(()=>{
  const a=window.__app;window.__proof={frames:0,finite:true,workerErrors:[],inspect:null};
  a.worker.addEventListener('message',({data:m})=>{
   const p=window.__proof;if(m.t==='error')p.workerErrors.push(m.msg);
   if(m.t==='inspect'&&m.state==='policy')p.inspect=m;
   if(m.t==='frame'){p.frames++;p.finite=p.finite&&m.xpos.every(Number.isFinite)&&m.xmat.every(Number.isFinite)&&m.qpos.every(Number.isFinite);}
  });
  a.setHoist(true);a.send({t:'inspect',on:true});a.send({t:'state',state:'policy'});
 });
 await page.waitForFunction(()=>window.__app.status.state==='policy'&&window.__proof.frames>=60&&window.__proof.inspect?.actions.length>0,null,{timeout:120000});
 const proof=await page.evaluate(()=>({robot:window.__app.model.robot,policy:window.__app.status.policy,frames:window.__proof.frames,finite:window.__proof.finite,workerErrors:window.__proof.workerErrors,
  actions:window.__proof.inspect.actions.map(a=>a.value),isolated:crossOriginIsolated}));
 assert.equal(proof.robot,'r1');assert.ok(proof.finite&&proof.isolated);assert.equal(proof.actions.length,24);assert.ok(proof.actions.every(Number.isFinite)&&proof.actions.some(v=>Math.abs(v)>1e-6));
 assert.deepEqual(proof.workerErrors,[]);assert.deepEqual(errors,[]);
 await Promise.all(downloads);
 const runtime=wasm.find(r=>r.url.includes('ort-wasm'));assert.ok(runtime&&runtime.bytes>0&&runtime.bytes<14_000_000);assert.ok(wasm.every(r=>!r.url.includes('.jsep')));
 console.log(JSON.stringify({...proof,actions:proof.actions.length,runtime,errors}));
}finally{await browser.close()}})().catch(e=>{console.error(e);process.exitCode=1});
