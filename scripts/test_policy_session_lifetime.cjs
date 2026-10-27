/** Real R1 inference sessions must be reused on terrain switches and released when packs close. */
const assert=require('node:assert/strict'),{chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
(async()=>{const browser=await chromium.launch({headless:true,args:['--no-sandbox']});try{
 const context=await browser.newContext(),page=await context.newPage(),errors=[];
 page.on('pageerror',e=>errors.push(e.message));const base=process.env.BASE_URL||'http://127.0.0.1:5176';
 await context.route('**/src/core/policy.ts*',async route=>{
  const response=await route.fetch(),original=await response.text();
  const body=original.replaceAll('ort.InferenceSession.create','self.__countOrtCreate');assert.notEqual(body,original);
  await route.fulfill({response,body:body+`\nself.__ortStats={created:0,released:0};self.__countOrtCreate=async(...args)=>{self.__ortStats.created++;const session=await ort.InferenceSession.create(...args);const release=session.release.bind(session);session.release=async()=>{self.__ortStats.released++;return release();};return session;};`});
 });
 await context.route('**/src/worker/sim.worker.ts*',async route=>{
  const response=await route.fetch(),original=await response.text();
  const hook=`\nself.addEventListener('message',async({data:m})=>{if(m.t==='test:stats')self.postMessage({t:'test:reply',request:m.request,...self.__ortStats});if(m.t==='test:probe'){try{const net=sim.driver.net,meta=net.sess.inputMetadata[0],dims=meta.shape.map(n=>typeof n==='number'?n:1),length=dims.reduce((a,b)=>a*b,1),data=Float32Array.from({length},(_,i)=>Math.sin(i)*.05),values=await net.run({[net.inputNames[0]]:{data,dims}});self.postMessage({t:'test:reply',request:m.request,values:Array.from(values)});}catch(e){self.postMessage({t:'test:reply',request:m.request,error:String(e)})}}});`;
  const body=original.replace('const sim = new SimWorker();','const sim = new SimWorker();'+hook);assert.notEqual(body,original);await route.fulfill({response,body});
 });
 await page.route(base+'/__policy-lifetime',r=>r.fulfill({contentType:'text/html',headers:{'Cross-Origin-Opener-Policy':'same-origin','Cross-Origin-Embedder-Policy':'require-corp'},body:'<body></body>'}));
 await page.goto(base+'/__policy-lifetime');await page.evaluate(()=>{
  window.frames=0;window.terrain='';window.workerErrors=[];window.replies={};window.request=0;
  window.worker=new Worker('/src/worker/sim.worker.ts?worker_file&type=module',{type:'module'});
  worker.onmessage=({data:m})=>{if(m.t==='terrainPrepared')worker.postMessage({t:'terrain',terrain:m.scene.terrain,request:m.request,commit:true});if(m.request!==undefined)replies[m.request]=m;if(m.t==='model')terrain=m.desc.terrain;if(m.t==='error'||m.t==='terrainFailed')workerErrors.push(m.msg);if(m.t==='frame'){frames++;if(!m.qpos.every(Number.isFinite))workerErrors.push('Non-finite frame')}};
  worker.postMessage({t:'init',robot:'r1',terrain:'flat'});
 });
 const rpc=async(t)=>{const request=await page.evaluate(t=>{const request=++window.request;worker.postMessage({t,request});return request},t);await page.waitForFunction(request=>replies[request],request,{timeout:120000});return page.evaluate(request=>replies[request],request)};
 const paused=async()=>{await page.evaluate(()=>worker.postMessage({t:'pause',on:true}));await rpc('viewReady')};
 await page.waitForFunction(()=>frames>=5,null,{timeout:120000});await page.evaluate(()=>worker.postMessage({t:'hoist',on:true}));
 await paused();const initial=await rpc('test:stats'),reference=await rpc('test:probe');assert.ok(!reference.error&&reference.values.length===24);
 const rows=[];
 for(const terrain of ['rough','slope','stairs','park','flat']){
  const before=await page.evaluate(terrain=>{const frames=window.frames;worker.postMessage({t:'pause',on:false});worker.postMessage({t:'terrain',terrain,request:++window.request});return frames},terrain);
  await page.waitForFunction(({terrain,before})=>window.terrain===terrain&&frames>before,{terrain,before},{timeout:120000});
  await paused();const stats=await rpc('test:stats'),probe=await rpc('test:probe');assert.deepEqual(probe.values,reference.values);rows.push({terrain,created:stats.created,released:stats.released});
 }
 const baseline=process.env.EXPECT_RECREATE==='1';
 if(baseline)assert.ok(rows.at(-1).created>initial.created&&rows.at(-1).released===0);
 else for(const row of rows)assert.deepEqual([row.created,row.released],[initial.created,0]);
 await page.evaluate(()=>worker.postMessage({t:'deleteAllPacks'}));await rpc('viewReady');const closed=await rpc('test:stats');
 if(!baseline)assert.equal(closed.released,closed.created);
 assert.deepEqual(await page.evaluate(()=>workerErrors),[]);assert.deepEqual(errors,[]);
 console.log(JSON.stringify({initial,rows,closed,identicalOutputs:true,baseline,errors}));
}finally{await browser.close()}})().catch(e=>{console.error(e);process.exitCode=1});
