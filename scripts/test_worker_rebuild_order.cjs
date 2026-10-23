/** Chromium: a model rebuild must wait for an outstanding policy inference. */
const assert=require('node:assert/strict'),{chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
(async()=>{const browser=await chromium.launch({headless:true,args:['--no-sandbox']});try{
 const context=await browser.newContext(),page=await context.newPage(),errors=[];
 page.on('pageerror',e=>errors.push(e.message));
 const base=process.env.BASE_URL||'http://127.0.0.1:5176';
 await context.route('**/src/worker/sim.worker.ts*',async route=>{
  const response=await route.fetch(),original=await response.text();
  const hook=`
   let testArmed=false,testRelease;
   const testEvent=event=>self.postMessage({t:'test-event',event});
   const testCreate=Engine.create.bind(Engine);
   Engine.create=async(...args)=>{if(testArmed)testEvent('compile-start');const result=await testCreate(...args);if(testArmed)testEvent('compile-finish');return result;};
   self.addEventListener('message',({data})=>{
    if(data.t==='test:arm'){
     testArmed=true;let once=true;const step=sim.driver.step.bind(sim.driver);
     sim.driver.step=async command=>{if(!once)return step(command);once=false;const result=step(command);testEvent('infer-start');await new Promise(resolve=>testRelease=resolve);const value=await result;testEvent('infer-finish');return value;};
    }else if(data.t==='test:release')testRelease?.();
   });`;
  const body=original.replace('const sim = new SimWorker();','const sim = new SimWorker();'+hook);
  assert.notEqual(body,original,'Worker instrumentation must match');await route.fulfill({response,body});
 });
 await page.route(base+'/__worker-rebuild',r=>r.fulfill({contentType:'text/html',headers:{'Cross-Origin-Opener-Policy':'same-origin','Cross-Origin-Embedder-Policy':'require-corp'},body:'<body></body>'}));
 await page.goto(base+'/__worker-rebuild');
 await page.evaluate(()=>{
  window.events=[];window.frames=0;window.workerErrors=[];window.terrain=null;
  window.worker=new Worker('/src/worker/sim.worker.ts?worker_file&type=module',{type:'module'});
  worker.onmessage=({data:m})=>{if(m.t==='test-event')events.push(m.event);if(m.t==='error')workerErrors.push(m.msg);if(m.t==='model')terrain=m.desc.terrain;if(m.t==='frame'){frames++;if(!m.qpos.every(Number.isFinite))workerErrors.push('Non-finite physics frame')}};
  worker.postMessage({t:'init',robot:'r1',terrain:'flat'});
 });
 await page.waitForFunction(()=>frames>=5,null,{timeout:120000});
 await page.evaluate(()=>worker.postMessage({t:'test:arm'}));
 await page.waitForFunction(()=>events.includes('infer-start'));
 await page.evaluate(()=>worker.postMessage({t:'terrain',terrain:'rough'}));
 await page.waitForTimeout(500);
 const overlap=await page.evaluate(()=>events.includes('compile-start'));
 await page.evaluate(()=>worker.postMessage({t:'test:release'}));
 await page.waitForFunction(()=>terrain==='rough'&&events.includes('compile-finish'),null,{timeout:120000});
 const proof=await page.evaluate(()=>({events,frames,workerErrors,terrain,isolated:crossOriginIsolated}));
 assert.equal(overlap,process.env.EXPECT_OVERLAP==='1',JSON.stringify(proof));
 if(!overlap)assert.ok(proof.events.indexOf('infer-finish')<proof.events.indexOf('compile-start'));
 assert.deepEqual(proof.workerErrors,[]);assert.deepEqual(errors,[]);assert.ok(proof.isolated);
 console.log(JSON.stringify({...proof,overlap,errors}));
}finally{await browser.close()}})().catch(e=>{console.error(e);process.exitCode=1});
