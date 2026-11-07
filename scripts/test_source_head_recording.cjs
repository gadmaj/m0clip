/** Chromium regression for native Ghost head recording, review, take files and GLB/PNG export.
 * Run against an unmodified built preview: BASE_URL=http://127.0.0.1:PORT
 * PLAYWRIGHT_MODULE=/path/to/playwright node scripts/test_source_head_recording.cjs
 * Set HEADLESS=1 for Chromium without a visible window; LOW_DPR=1 uses DPR 0.5 for software graphics. */
const {chromium}=require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert=require('node:assert/strict');
const {chooseVisual}=require('./choose-visual.cjs');
const {readyApp}=require('./attach-ready-app.cjs');
const path=require('node:path'),buildFixture=require('./build-fixture.cjs');
(async()=>{
const fixture=await buildFixture({
  root:path.resolve(__dirname,'..'),
  source:`
    export { saveTake, loadTake } from './src/record/take';
    export { renderVideo } from './src/record/export-video';
    export { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
    export { unzipSync } from 'fflate';
  `,
  platform:'browser',format:'iife',globalName:'HeadRecordingFixture',
});
const browser=await chromium.launch({headless:process.env.HEADLESS === '1',...(process.env.CHROME_EXECUTABLE?{executablePath:process.env.CHROME_EXECUTABLE}:{}),args:['--no-sandbox','--ozone-platform=x11']});try{const page=await browser.newPage({viewport:{width:1440,height:1000},deviceScaleFactor:process.env.LOW_DPR ? 0.5 : 1});const errors=[];page.on('pageerror',e=>{errors.push(String(e));console.error('Head fixture browser error:',String(e))});
page.on('framenavigated',frame=>{if(frame===page.mainFrame())console.log('Head fixture navigation:',frame.url())});
page.on('response',response=>{if(response.status()>=400)console.error('Head fixture HTTP:',response.status(),response.url())});
// Keep this native-head export regression independent of the fresh default map;
// GLB export always includes terrain, even when its optional floor plane is off.
console.log('Head fixture: launching real scene');
// The release chunk stays byte-identical; the real Ready App is attached through CDP.
await page.goto(`${process.env.BASE_URL || 'http://127.0.0.1:5176'}/?plain`).then(() => require('./launch-scene.cjs').launchScene(page, { terrain: 'flat', controls: true }));await readyApp(page);
console.log('Head fixture: scene ready');
await page.getByText('Robot appearance',{exact:true}).click();const head=page.locator('#source-head-visual-trigger');
const gate=Promise.withResolvers(),started=Promise.withResolvers();
await page.route('**/assets/source-robots/neotokyo-girlbot/girlbot_head.glb',async route=>{started.resolve();await gate.promise;await route.continue();});
await chooseVisual(page,'source-head-visual','ghost');
await Promise.race([started.promise,page.waitForTimeout(10000).then(async()=>{
  throw new Error(`Ghost head request not observed: ${JSON.stringify(await page.evaluate(()=>({head:window.__app.view.getHeadVisualState(),appearance:window.__app.view.getAppearance()})))}`);
})]);
console.log('Head fixture: native asset request held');
await page.getByRole('button',{name:'Record V',exact:true}).click();
assert.equal(await head.isDisabled(),true);
assert.deepEqual(await page.evaluate(()=>({starting:window.__app.recordStarting,recording:!!window.__app.rec,applied:window.__app.view.getSourceHead()})),{starting:true,recording:false,applied:'stock'},'Capture must wait for requested cosmetic geometry');
gate.resolve();await page.waitForFunction(()=>!!window.__app.rec);assert.equal(await head.isDisabled(),true);
await page.waitForFunction(()=>window.__app.rec?.frames>=8,null,{timeout:120000});
await page.getByTitle('Stop recording and open the timeline (V)',{exact:true}).click();
await page.waitForFunction(()=>window.__app.timeline.isOpen&&window.__app.view.getSourceHead()==='ghost');
await page.addScriptTag({content:fixture.code});
if(fixture.css)await page.addStyleTag({content:fixture.css});
const takeProof=await page.evaluate(async()=>{const a=window.__app;const {saveTake,loadTake}=window.HeadRecordingFixture;const blob=await saveTake(a.take);const loaded=await loadTake(await blob.arrayBuffer());return{frames:a.take.n,duration:a.take.duration,head:a.take.meta.sourceHead,savedHead:loaded.meta.sourceHead,reviewHead:a.view.getSourceHead()};});assert.equal(takeProof.head,'ghost');assert.equal(takeProof.savedHead,'ghost');
console.log('Head fixture: native recording and ZIP passed');
const glbProof=await page.evaluate(async()=>{
  const a=window.__app;
  // Export live objects through their release-owned Three instance, not the parsing fixture.
  const previousRange=[a.timeline.rangeIn,a.timeline.rangeOut];let blob;
  try{
    a.timeline.rangeIn=0;a.timeline.rangeOut=Math.min(.4,a.take.duration);
    blob=await a.dialog.host.glb(10,false,false);
  }finally{
    [a.timeline.rangeIn,a.timeline.rangeOut]=previousRange;
  }
  const binary=await blob.arrayBuffer();
  const {GLTFLoader}=window.HeadRecordingFixture;
  const loaded=await new GLTFLoader().parseAsync(binary,'');
  let head;
  loaded.scene.traverse(o=>{if(o.userData.sourceModel==='models/nt/props_tech/girlbot_head.mdl')head=o;});
  const view=new DataView(binary);
  const json=JSON.parse(new TextDecoder().decode(new Uint8Array(binary,20,view.getUint32(12,true))));
  return{bytes:blob.size,source:head?.userData.sourceModel,base:!!head?.material.map,normal:!!head?.material.normalMap,
    animations:loaded.animations.length,exportedNode:json.nodes.find(n=>n.extras?.sourceModel==='models/nt/props_tech/girlbot_head.mdl')?.name};
});
assert.ok(glbProof.base&&glbProof.normal&&glbProof.exportedNode);
assert.equal(glbProof.source,'models/nt/props_tech/girlbot_head.mdl');
console.log('Head fixture: animated GLB passed');
const pngProof=await page.evaluate(async()=>{
  const a=window.__app;
  const {renderVideo}=window.HeadRecordingFixture;
  const blob=await renderVideo({width:240,height:180,fps:5,speed:1,t0:0,t1:.4,container:'png',codec:'avc',quality:'medium',transparent:false,floor:true},a.stage(),()=>{},new AbortController().signal);
  const {unzipSync}=window.HeadRecordingFixture;
  const files=unzipSync(new Uint8Array(await blob.arrayBuffer()));
  return{frames:Object.values(files).map(data=>{
    const header=new DataView(data.buffer,data.byteOffset,data.byteLength);
    return{signature:Array.from(data.subarray(0,8)),width:header.getUint32(16),height:header.getUint32(20)};
  }),head:a.view.getSourceHead()};
});
assert.equal(pngProof.frames.length,2);
for(const frame of pngProof.frames)assert.deepEqual(frame,{signature:[137,80,78,71,13,10,26,10],width:240,height:180});
assert.equal(pngProof.head,'ghost');
console.log('Head fixture: PNG sequence passed');
// Rebuilding live terrain must preserve the live Stock head across Ghost-take review.
await page.keyboard.press('Escape');await page.waitForFunction(()=>!window.__app.timeline.isOpen);
await chooseVisual(page,'source-head-visual','stock');
await chooseVisual(page,'terrain','stairs');
await page.waitForFunction(()=>window.__app.model.terrain==='stairs'&&window.__app.viewModel.terrain==='stairs'&&window.__app.view.getSourceHead()==='stock');
await page.getByRole('button',{name:'Timeline',exact:true}).click();
await page.waitForFunction(()=>window.__app.timeline.isOpen&&window.__app.view.getSourceHead()==='ghost');
await page.keyboard.press('Escape');
await page.waitForFunction(()=>window.__app.viewModel.terrain==='stairs'&&window.__app.view.getSourceHead()==='stock');
assert.equal(await page.evaluate(()=>window.__app.view.getHeadVisual()),'stock');
// An old take with no sourceHead uses stock, then recovers the live Ghost shell.
const oldProof=await page.evaluate(async()=>{
  const a=window.__app;await a.view.setSourceHead('ghost');
  window.__takeHead=a.take.meta.sourceHead;delete a.take.meta.sourceHead;
  a.openReview();await a.view.waitForSourceHead();
  return{review:a.view.getSourceHead()};
});
assert.equal(oldProof.review,'stock');
await page.evaluate(()=>window.__app.closeReview());
await page.waitForFunction(()=>window.__app.view.getSourceHead()==='ghost');
await page.evaluate(()=>window.__app.take.meta.sourceHead=window.__takeHead);
// A temporary Ghost take must not replace a deliberately chosen stock default.
await chooseVisual(page,'source-head-visual','stock');
await page.getByRole('button',{name:'Timeline',exact:true}).click();
await page.waitForFunction(()=>window.__app.timeline.isOpen&&window.__app.view.getSourceHead()==='ghost');
await page.evaluate(()=>window.__app.closeReview());
await page.waitForFunction(()=>window.__app.view.getSourceHead()==='stock');
await page.reload();
await require('./launch-scene.cjs').launchScene(page, { controls: true });
await readyApp(page);
assert.equal(await page.evaluate(()=>window.__app.view.getSourceHead()),'stock');
assert.deepEqual(errors,[]);
console.log(JSON.stringify({takeProof,glbProof,pngProof,oldProof,stockRestored:true,reloadPreference:'stock',errors}));
}finally{await browser.close();}})().catch(e=>{console.error(e);process.exitCode=1});
