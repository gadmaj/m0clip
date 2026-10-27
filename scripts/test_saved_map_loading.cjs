/** Ghost restore waits for both simulation navigation and the actual map / native-body assets. */
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright'),assert=require('node:assert/strict');
(async()=>{
  const browser=await chromium.launch({headless:false,args:['--no-sandbox','--ozone-platform=x11']});
  try{
    const page=await browser.newPage({viewport:{width:1440,height:1000}}),errors=[];page.on('pageerror',e=>errors.push(e.message));
    await page.route('**/{src/main.ts*,assets/main-*.js}',async r=>{const response=await r.fetch();await r.fulfill({response,body:require('./expose-app.cjs')(await response.text())});});
    await page.route('**/assets/main-*.js',async r=>{const response=await r.fetch(),original=await response.text(),body=require('./expose-app.cjs')(original);await r.fulfill({response,body});});
    await page.goto((process.env.BASE_URL||'http://127.0.0.1:5176')+'/?plain').then(() => require('./launch-scene.cjs').launchScene(page,{terrain:'flat'}));await page.waitForFunction(()=>window.__app?.lastFrame&&document.querySelector('#overlay').classList.contains('hidden'),null,{timeout:120000});
    let release,held;const gate=new Promise(resolve=>release=resolve),intercepted=new Promise(resolve=>held=resolve);
    await page.route('**/assets/maps/nt_ghost_ctg/visual.glb',async r=>{held();await gate;await r.continue();});
    await page.evaluate(()=>{
      const a=window.__app,v=a.captureView();v.terrain='map:nt_ghost_ctg';v.appearance={colorway:'grey',sourceBody:'dog',sourceBodyColorway:'model',parts:{},robotLight:{brightness:0,color:0xffffff,range:8,dull:false}};v.look.preset='auto';v.noclip=true;v.fov=73;v.flight={speed:42,hover:true};window.__saved=v;
      window.__settled=false;window.__restoreError=null;
      window.__restore=a.restoreView(v);
      void window.__restore.then(()=>{window.__settled=true;},error=>{window.__restoreError=String(error);});
    });
    await intercepted;
    const preparing=await page.evaluate(()=>{const a=window.__app;return{pending:!!a.pendingViewRestore,preparing:a.mapPreparing,terrain:a.model.terrain,source:a.view.mapSource?.id??null,settled:window.__settled};});
    assert.deepEqual(preparing,{pending:true,preparing:true,terrain:'flat',source:null,settled:false},'Map preparation keeps the actual prior scene installed');
    await page.evaluate(()=>window.__app.startRecording());assert.equal(await page.evaluate(()=>!!window.__app.rec||window.__app.recordStarting),false);
    await page.waitForTimeout(100);assert.equal(await page.evaluate(()=>window.__settled),false);
    release();await page.waitForFunction(()=>window.__settled||window.__restoreError,null,{timeout:180000});
    assert.equal(await page.evaluate(()=>window.__restoreError),null);
    const result=await page.evaluate(()=>{const a=window.__app,v=a.captureView(),promise=a.view.waitForTerrainVisuals();return{loaded:!!a.view.terrainVisual,body:a.view.getBodyVisualState().applied,appearance:v.appearance,expected:window.__saved.appearance,noclip:v.noclip,fov:v.fov,flight:v.flight,preset:v.look.preset,settled:window.__settled,sourceLighting:a.view.sourceLighting,loadingHidden:document.getElementById('map-loading').hidden,pending:!!a.pendingViewRestore||!!a.viewRestoreAbort,sameRequest:a.view.setTerrainVisual(a.view.mapSource)===promise};});
    assert.deepEqual(result.appearance,result.expected);assert.ok(result.loaded&&result.settled&&result.loadingHidden&&result.sourceLighting&&result.sameRequest);assert.equal(result.pending,false);assert.equal(result.body,'dog');assert.equal(result.noclip,true);assert.equal(result.fov,73);assert.deepEqual(result.flight,{speed:42,hover:true});assert.equal(result.preset,'auto');assert.deepEqual(errors,[]);console.log(JSON.stringify({...result,errors}));
  }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
