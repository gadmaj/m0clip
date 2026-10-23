/** Chromium: recorded-map review/export and restoration of the live world. */
const{chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright'),assert=require('node:assert/strict');
const {unzipSync}=require('fflate');
(async()=>{const browser=await chromium.launch({headless:false,args:['--no-sandbox','--ozone-platform=x11']});try{
 const page=await browser.newPage({deviceScaleFactor:.5}),errors=[];page.on('pageerror',e=>errors.push(e.message));
 for(const pattern of ['**/src/main.ts*','**/assets/main-*.js'])await page.route(pattern,async route=>{
  const response=await route.fetch();await route.fulfill({response,body:require('./expose-app.cjs')(await response.text())});
 });
 await page.goto((process.env.BASE_URL||'http://127.0.0.1:5176')+'/?plain&body=stock').then(() => require('./launch-scene.cjs').launchScene(page,{terrain:'flat'}));await page.waitForFunction(()=>window.__app?.lastFrame&&document.getElementById('overlay').classList.contains('hidden'),null,{timeout:120000});
 // Real Ghost assets / worker compilation: record there, leave, reopen the old take.
 await page.evaluate(()=>{const a=window.__app;a.panel.setTerrain('map:nt_ghost_ctg');a.send({t:'terrain',terrain:'map:nt_ghost_ctg'})});
 await page.waitForFunction(()=>window.__app.model?.terrain==='map:nt_ghost_ctg'&&window.__app.view.terrainObject&&document.getElementById('overlay').classList.contains('hidden'),null,{timeout:180000});
 await page.evaluate(()=>window.__app.startRecording());await page.waitForFunction(()=>window.__app.rec?.frames>=10);await page.evaluate(()=>window.__app.stopRecording());await page.waitForFunction(()=>window.__app.timeline.isOpen);assert.equal(await page.evaluate(()=>window.__app.take.meta.terrain),'map:nt_ghost_ctg');await page.evaluate(()=>window.__app.closeReview());
 await page.evaluate(()=>{const a=window.__app;a.panel.setTerrain('flat');a.send({t:'terrain',terrain:'flat'})});await page.waitForFunction(()=>window.__app.model?.terrain==='flat'&&!window.__app.view.terrainObject&&window.__app.lastFrame,null,{timeout:120000});
 await page.evaluate(()=>window.__app.openReview());await page.waitForFunction(()=>window.__app.view.terrainObject&&document.getElementById('map-loading').hidden,null,{timeout:180000});
 const review=await page.evaluate(()=>{const a=window.__app;return{view:a.viewModel.terrain,live:a.model.terrain,picker:a.panel.terrain,url:a.view.terrainUrl,light:!!a.look.mapLight,sourceColor:a.view.sourceColorMap,reviewing:a.timeline.isOpen}});assert.equal(review.view,'map:nt_ghost_ctg');assert.equal(review.live,'flat');assert.equal(review.picker,'flat');assert.equal(review.url,'/assets/maps/nt_ghost_ctg/visual.glb');assert.ok(review.light&&review.sourceColor&&review.reviewing);
 const pngExport=await page.evaluate(async()=>{
  const a=window.__app,d=a.dialog;
  Object.assign(d.out,{res:'custom',width:240,height:160,fps:10,speed:1,container:'png',transparent:false,floor:true});
  a.openExport('video');const range=d.host.range,save=d.host.save;let archive;
  d.host.range=()=>[0,.2];d.host.save=blob=>{archive=blob};
  try{
   await d.renderVideoJob();
   return{data:Array.from(new Uint8Array(await archive.arrayBuffer())),map:a.view.terrainUrl,live:a.model.terrain,error:d.status.classList.contains('err')};
  }finally{d.host.range=range;d.host.save=save}
 });
 const frames=Object.entries(unzipSync(Uint8Array.from(pngExport.data))).filter(([name])=>name.endsWith('.png'));
 assert.equal(frames.length,2,'A 0.2-second export at 10 fps must produce two actual PNG frames');
 for(const [,bytes] of frames){
  const png=Buffer.from(bytes);
  assert.deepEqual([...png.subarray(0,8)],[137,80,78,71,13,10,26,10]);
  assert.equal(png.toString('ascii',12,16),'IHDR');assert.equal(png.readUInt32BE(16),240);assert.equal(png.readUInt32BE(20),160);
 }
 assert.equal(pngExport.error,false);assert.equal(pngExport.live,'flat');assert.equal(pngExport.map,'/assets/maps/nt_ghost_ctg/visual.glb');
 await page.evaluate(()=>window.__app.closeReview());await page.waitForFunction(()=>!window.__app.view.terrainObject&&document.getElementById('map-loading').hidden);assert.equal(await page.evaluate(()=>window.__app.look.mapLight),null);assert.equal(await page.evaluate(()=>window.__app.viewModel.terrain),'flat');assert.deepEqual(errors,[]);console.log(JSON.stringify({recordedTerrain:true,review,liveRestored:true,pngFrames:frames.map(([name,bytes])=>({name,bytes:bytes.length,width:240,height:160})),errors}));
}finally{await browser.close()}})().catch(e=>{console.error(e);process.exitCode=1});
