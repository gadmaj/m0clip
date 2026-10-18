/** Chromium: complete/fresh screenshots, cancellation, recovery, review cameras and filenames. */
const{chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright'),assert=require('node:assert/strict'),fs=require('node:fs');
const{fixture}=require('./source_material_fixture.cjs');
(async()=>{const browser=await chromium.launch({headless:false,args:['--no-sandbox','--ozone-platform=x11']});try{
 const page=await browser.newPage({viewport:{width:1440,height:1000},deviceScaleFactor:.25}),errors=[],downloads=[];page.on('pageerror',e=>errors.push(e.message));page.on('download',d=>downloads.push(d));
 const expose=source=>source.replace('new App();','window.__app=new App();').replace(/new ([A-Za-z_$][\w$]*);export\{/,'window.__app=new $1;export{').replaceAll('this.renderLoop()','void 0');
 for(const pattern of['**/src/main.ts*','**/assets/main-*.js'])await page.route(pattern,async route=>{const response=await route.fetch();await route.fulfill({response,body:expose(await response.text())})});
 await page.addInitScript(()=>localStorage.setItem('ume-prefs',JSON.stringify({robot:'r1',terrain:'flat'})));
 const base=process.env.BASE_URL||'http://127.0.0.1:5176',ready=()=>page.waitForFunction(()=>window.__app?.lastFrame&&document.querySelector('#overlay').classList.contains('hidden'),null,{timeout:120000});
 await page.goto(base+'/?plain&body=stock');await ready();const button=page.locator('#capture-screenshot'),status=page.locator('#screenshot-status');
 // Encode the latest frame after both independent visual barriers resolve.
 await page.evaluate(()=>{
  const a=window.__app,v=a.view;window.__waitRobot=v.waitForRobotVisuals.bind(v);window.__waitMap=v.waitForTerrainVisuals.bind(v);
  v.scene.background.setHex(0x0000ff);v.render();v.scene.background.setHex(0xff0000);
  v.waitForRobotVisuals=()=>new Promise(resolve=>window.__robotReady=resolve);v.waitForTerrainVisuals=()=>new Promise(resolve=>window.__mapReady=resolve);
  window.__shot=a.takeScreenshot();void a.takeScreenshot();
 });
 assert.equal(await button.isDisabled(),true);assert.equal(await button.getAttribute('aria-busy'),'true');assert.ok(await status.getByText('Preparing scene visuals…',{exact:true}).count());
 await page.evaluate(()=>window.__mapReady());await page.waitForTimeout(40);assert.equal(downloads.length,0);
 const firstReady=page.waitForEvent('download');await page.evaluate(()=>window.__robotReady());const first=await firstReady;await first.saveAs('/tmp/screenshot-fresh.png');assert.match(first.suggestedFilename(),/^flat_r1_.*\.png$/);
 await page.evaluate(()=>{const v=window.__app.view;v.waitForRobotVisuals=window.__waitRobot;v.waitForTerrainVisuals=window.__waitMap});await page.waitForFunction(()=>!window.__app.screenshotPending);assert.equal(await button.isDisabled(),false);
 // Failed preparation and failed encoding remain recoverable and never download.
 await page.evaluate(async()=>{const a=window.__app,v=a.view;v.waitForTerrainVisuals=()=>Promise.reject(new Error('fixture'));await a.takeScreenshot();v.waitForTerrainVisuals=window.__waitMap});assert.match(await status.textContent(),/Scene visuals could not load/);assert.equal(downloads.length,1);
 await page.evaluate(async()=>{const a=window.__app,canvas=a.view.renderer.domElement,encode=canvas.toBlob;canvas.toBlob=callback=>callback(null);try{await a.takeScreenshot()}finally{canvas.toBlob=encode}});assert.match(await status.textContent(),/PNG could not be saved/);assert.equal(downloads.length,1);
 await page.evaluate(async()=>{const a=window.__app;a.exporting=true;try{await a.takeScreenshot()}finally{a.exporting=false}});assert.match(await status.textContent(),/Wait for the export/);
 await page.evaluate(async()=>{const a=window.__app;a.pendingViewRestore={id:999};try{await a.takeScreenshot()}finally{a.pendingViewRestore=null}});assert.match(await status.textContent(),/saved view to finish/);
 // A new scene cancels preparation promptly, even while an old load never resolves.
 await page.evaluate(()=>{const a=window.__app,v=a.view;v.waitForTerrainVisuals=()=>new Promise(()=>{});window.__cancelled=a.takeScreenshot();a.buildView(a.model);v.waitForTerrainVisuals=window.__waitMap});await page.evaluate(()=>window.__cancelled);assert.equal(await button.isDisabled(),false);assert.match(await status.textContent(),/scene changed/);assert.equal(downloads.length,1);
 // Once the bitmap is captured, cancel a delayed encoder callback and allow a new shot.
 await page.evaluate(()=>{
  const a=window.__app,canvas=a.view.renderer.domElement;window.__encode=canvas.toBlob;canvas.toBlob=function(callback,...args){return window.__encode.call(this,blob=>{window.__finishOldEncode=()=>callback(blob)},...args)};
  window.__encoding=a.takeScreenshot();
 });await page.waitForFunction(()=>!!window.__finishOldEncode);
 await page.evaluate(()=>{const a=window.__app;a.buildView(a.model);a.view.renderer.domElement.toBlob=window.__encode});await page.evaluate(()=>window.__encoding);
 const freshReady=page.waitForEvent('download');await page.evaluate(()=>window.__app.takeScreenshot());await freshReady;const saved=await status.textContent();
 await page.evaluate(()=>window.__finishOldEncode());await page.waitForTimeout(40);assert.equal(downloads.length,2);assert.equal(await status.textContent(),saved);
 // Real worker scene switching with a held glTF response must not save incomplete Ghost.
 const manifest=JSON.parse(fs.readFileSync('public/assets/maps/nt_ghost_ctg/manifest.json'));delete manifest.props;delete manifest.visibility;
 await page.route('**/nt_ghost_ctg/manifest.json',route=>route.fulfill({json:manifest}));for(const file of['lighting.json','lightstyles.json'])await page.route('**/nt_ghost_ctg/'+file,route=>route.fulfill({status:404,body:''}));
 let hold=true,held,notify;const requested=new Promise(resolve=>notify=resolve);
 await page.route('**/nt_ghost_ctg/visual.glb',route=>{if(hold){hold=false;held=()=>route.fulfill({contentType:'model/gltf+json',body:JSON.stringify(fixture('cutout-generic'))});notify();return}return route.fulfill({contentType:'model/gltf+json',body:JSON.stringify(fixture('cutout-generic'))})});
 await page.locator('#sel-terrain').selectOption('map:nt_ghost_ctg',{force:true});await requested;await ready();await page.waitForFunction(()=>window.__app.viewModel.terrain==='map:nt_ghost_ctg');
 await button.click();assert.equal(await button.isDisabled(),true);assert.equal(downloads.length,2);
 const ghostReady=page.waitForEvent('download');await held();const ghost=await ghostReady;assert.match(ghost.suggestedFilename(),/^nt_ghost_ctg_r1_.*\.png$/);
 // Preserve the optional Dog body: a screenshot waits for the actual native model.
 let bodyRelease,bodyRequested;const bodyGate=new Promise(resolve=>bodyRelease=resolve),bodyStarted=new Promise(resolve=>bodyRequested=resolve);
 await page.route('**/halflife2-dog/dog.glb',async route=>{bodyRequested();await bodyGate;await route.continue()});
 await page.evaluate(()=>{const a=window.__app;a.look.restoreAppearance(a.viewModel.robot,{...a.view.getAppearance(),sourceBody:'dog'})});await bodyStarted;
 await button.click();assert.equal(await button.isDisabled(),true);assert.equal(downloads.length,3);
 const dogReady=page.waitForEvent('download');bodyRelease();await dogReady;assert.equal(await page.evaluate(()=>window.__app.view.getBodyVisualState().applied),'dog');
 // A recorded Ghost view can be reviewed while the live map and picker are flat.
 await page.evaluate(()=>window.__app.startRecording());await page.waitForFunction(()=>window.__app.rec?.frames>=10);await page.evaluate(()=>{const a=window.__app;a.stopRecording();a.closeReview()});
 await page.locator('#sel-terrain').selectOption('flat',{force:true});await ready();await page.waitForFunction(()=>window.__app.model.terrain==='flat'&&window.__app.lastFrame);
 await page.evaluate(()=>{const a=window.__app;a.openReview();a.timeline.setPlaying(false);a.timeline.seek(a.take.duration*.5);a.setViewMode('recorded')});await page.waitForFunction(()=>window.__app.view.terrainObject);
 const reviewReady=page.waitForEvent('download');await button.click();const review=await reviewReady;assert.match(review.suggestedFilename(),/^nt_ghost_ctg_r1_.*\.png$/);assert.equal(await page.evaluate(()=>window.__app.panel.terrain),'flat');
 const recorded=await page.evaluate(()=>{const a=window.__app,q=a.view.camera.quaternion.clone().fromArray(a.take.camAt(a.timeline.time).orientation);return{mode:a.timeline.mode,error:a.view.camera.quaternion.angleTo(q)}});assert.ok(recorded.error<1e-6);
 await page.evaluate(()=>{const a=window.__app;a.setViewMode('shot');window.__framed=0;const draw=a.view.renderFramed.bind(a.view);a.view.renderFramed=(...args)=>{window.__framed++;return draw(...args)}});
 const shotReady=page.waitForEvent('download');await button.click();await shotReady;assert.equal(await page.evaluate(()=>window.__framed),1);
 if(!process.env.SKIP_SCREENSHOTS){
  await status.scrollIntoViewIfNeeded();await page.screenshot({path:'/tmp/screenshot-status-desktop.png'});await page.setViewportSize({width:390,height:844});await status.scrollIntoViewIfNeeded();await page.screenshot({path:'/tmp/screenshot-status-mobile.png'});
 }
 const bounds=await status.boundingBox();assert.ok(bounds.width>0);assert.deepEqual(errors,[]);
 console.log(JSON.stringify({fresh:first.suggestedFilename(),ghost:ghost.suggestedFilename(),review:review.suggestedFilename(),preparation:true,encodeRecovery:true,cancelPreparation:true,cancelEncoding:true,duplicateGuard:true,dog:true,recorded,shot:true,downloads:downloads.length,bounds,errors}));
}finally{await browser.close()}})().catch(e=>{console.error(e);process.exitCode=1});
