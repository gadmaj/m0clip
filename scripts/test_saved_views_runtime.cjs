/** Chromium: saved views restore native visuals, camera roll and navigation after model loading. */
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const assert=require('node:assert/strict');
const {chooseVisual}=require('./choose-visual.cjs');
(async()=>{
  const browser=await chromium.launch({headless:false,args:['--no-sandbox','--ozone-platform=x11']});
  const errors=[];
  async function pageIn(context){
    const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));
    const renderLoop=body=>process.env.RENDER_ON_DEMAND?body.replaceAll('this.renderLoop()','void 0'):body;
    await page.route('**/{src/main.ts*,assets/main-*.js}',async route=>{const response=await route.fetch();await route.fulfill({response,body:renderLoop(require('./expose-app.cjs')(await response.text()))});});
    await page.route('**/assets/main-*.js',async route=>{const response=await route.fetch(),original=await response.text();const body=renderLoop(require('./expose-app.cjs')(original));await route.fulfill({response,body});});
    return page;
  }
  const base=process.env.BASE_URL||'http://127.0.0.1:5176';
  async function ready(page){await page.waitForFunction(()=>window.__app?.lastFrame&&document.querySelector('#overlay').classList.contains('hidden'),null,{timeout:120000});}
  async function restored(page){await page.waitForFunction(()=>!window.__app.pendingViewRestore,null,{timeout:120000});}
  async function matches(page,view){
    const actual=await page.evaluate(()=>window.__app.captureView());
    assert.equal(await page.evaluate(()=>window.__app.view.sourceColor.antialiasing),view.look.antialiasing??'fxaa');
    for(const key of ['robot','terrain','appearance','sourceHead','noclip','flight','flashlight','look','display'])assert.deepEqual(actual[key],view[key],key);
    for(const key of ['position','target','orientation'])for(let i=0;i<view[key].length;i++)assert.ok(Math.abs(actual[key][i]-view[key][i])<1e-6,`${key}[${i}]: ${actual[key][i]} != ${view[key][i]}`);
    assert.equal(actual.fov,view.fov);
  }
  try{
    const context=await browser.newContext({viewport:{width:1440,height:1000},deviceScaleFactor:Number(process.env.TEST_DPR||1)}),page=await pageIn(context);
    await page.goto(base+'/?plain').then(() => require('./launch-scene.cjs').launchScene(page, { terrain: 'flat', controls: true }));await ready(page);
    const saved=await page.evaluate(async()=>{
      const a=window.__app;a.setNoclip(true);a.flight.stop();a.heldView=true;
      a.look.setState({...a.look.getState(),antialiasing:'msaa4'});
      a.look.restoreAppearance(a.viewModel.robot,{colorway:'grey',sourceBody:'dog',sourceBodyColorway:'model',parts:{left_elbow_link:{color:0x23aaff,finish:'metal',roughness:.2}},robotLight:{brightness:70,color:0xffddbb,range:19,dull:false}});
      await a.view.waitForRobotVisuals();a.flight.speed=84;a.flight.hover=true;a.setFlashlight(true);
      a.view.camera.position.set(2,3,4);a.view.controls.target.set(-1,0,1);a.view.camera.lookAt(a.view.controls.target);a.view.camera.rotateZ(.37);a.view.camera.fov=72;a.view.camera.updateProjectionMatrix();a.flight.setActive(true);
      a.explore.setDisplay({textures:true,wireframe:false,map:true,robot:true,decals:false});return a.captureView();
    });
    await page.getByText('Saved views',{exact:true}).click();await page.getByRole('textbox',{name:/^View name\b/}).fill('Dog inspection');await page.getByRole('button',{name:'Save view',exact:true}).click();
    await page.evaluate(()=>{const a=window.__app;a.look.setState({...a.look.getState(),antialiasing:'none'});a.look.restoreAppearance(a.viewModel.robot,{colorway:'product',sourceBody:'stock',parts:{},robotLight:{brightness:0,color:0xffffff,range:5,dull:true}});a.setNoclip(false);a.setFlashlight(false);a.flight.speed=12;a.flight.hover=false;a.view.camera.position.set(8,8,8);});
    await page.getByRole('button',{name:'Dog inspection',exact:true}).click();await restored(page);await page.waitForTimeout(150);await matches(page,saved);
    assert.equal(await page.evaluate(()=>window.__app.view.getBodyVisualState().applied),'dog');
    const viewLink=await page.evaluate(async()=>{const a=window.__app;await a.explore.share(a.captureView());return document.querySelector('[aria-label="Shareable view link"]').value;});assert.equal(new URL(viewLink).searchParams.get('body'),'dog');
    // A fresh receiver's robot, lighting and paint preferences must not replace the shared view.
    const receiver=await browser.newContext({viewport:{width:1440,height:1000},deviceScaleFactor:Number(process.env.TEST_DPR||1)});await receiver.addInitScript(()=>{localStorage.setItem('ume-prefs',JSON.stringify({robot:'go2',terrain:'park',policy:'does-not-exist'}));localStorage.setItem('ume-appearance',JSON.stringify({r1:{colorway:'product',sourceBody:'stock',parts:{}}}));});
    const fresh=await pageIn(receiver);await fresh.goto(viewLink).then(() => require('./launch-scene.cjs').launchScene(fresh, { controls: true }));await ready(fresh);await restored(fresh);await matches(fresh,saved);
    const head={...saved,appearance:{...saved.appearance,sourceBody:'stock'},sourceHead:'ghost'};
    await page.evaluate(view=>window.__app.explore.restoreView(view),head);await restored(page);await matches(page,head);assert.equal(await page.evaluate(()=>window.__app.view.getSourceHead()),'ghost');
    // Crossing robots and terrain exercises the worker barrier and restores each model's own paint.
    const go2={...saved,robot:'go2',terrain:'park',appearance:{colorway:'product',sourceBody:'stock',parts:{},robotLight:{brightness:0,color:0xffffff,range:5,dull:true}},sourceHead:'stock',noclip:false,orientation:undefined};
    await page.evaluate(view=>window.__app.explore.restoreView(view),go2);await restored(page);assert.equal(await page.evaluate(()=>window.__app.viewModel.robot),'go2');assert.equal(await page.evaluate(()=>window.__app.viewModel.terrain),'park');
    await page.evaluate(view=>window.__app.explore.restoreView(view),saved);await restored(page);await matches(page,saved);
    // Recording and review protect the current take from a bookmark changing its model or materials.
    await page.evaluate(()=>window.__app.startRecording());await page.waitForFunction(()=>window.__app.rec?.frames>=10);
    const recordingGuard=await page.evaluate(async view=>{
      const a=window.__app,before=a.captureView(),model=a.viewModel,recording=a.rec;
      await a.explore.restoreView(view);
      return{before,after:a.captureView(),modelKept:a.viewModel===model,recordingKept:!!recording&&a.rec===recording};
    },go2);
    assert.deepEqual(recordingGuard.after,recordingGuard.before);assert.ok(recordingGuard.modelKept&&recordingGuard.recordingKept);
    await page.evaluate(()=>window.__app.stopRecording());await page.waitForFunction(()=>window.__app.timeline.isOpen);
    const reviewGuard=await page.evaluate(async view=>{
      const a=window.__app,before=a.captureView(),model=a.viewModel,take=a.take;
      await a.explore.restoreView(view);
      return{before,after:a.captureView(),modelKept:a.viewModel===model,takeKept:a.timeline.isOpen&&a.take===take};
    },go2);
    assert.deepEqual(reviewGuard.after,reviewGuard.before);assert.ok(reviewGuard.modelKept&&reviewGuard.takeKept);
    await page.evaluate(()=>window.__app.closeReview());
    const exportGuard=await page.evaluate(async view=>{
      const a=window.__app,before=a.captureView(),model=a.viewModel;a.exporting=true;
      try{await a.explore.restoreView(view)}finally{a.exporting=false}
      return{before,after:a.captureView(),modelKept:a.viewModel===model};
    },go2);
    assert.deepEqual(exportGuard.after,exportGuard.before);assert.ok(exportGuard.modelKept);
    // Old camera-only bookmarks remain readable without overwriting the robot appearance.
    const legacy={...saved,look:{...saved.look}};delete legacy.look.antialiasing;for(const key of ['appearance','sourceHead','orientation','noclip','flight'])delete legacy[key];
    await page.evaluate(view=>window.__app.explore.restoreView(view),legacy);await restored(page);assert.deepEqual(await page.evaluate(()=>window.__app.view.getAppearance()),saved.appearance);
    assert.equal(await page.evaluate(()=>window.__app.view.sourceColor.antialiasing),'fxaa');
    // Latest selection wins even while the first view is waiting for a native model download.
    const raceContext=await browser.newContext({deviceScaleFactor:Number(process.env.TEST_DPR||1)}),race=await pageIn(raceContext);await race.goto(base+'/?plain').then(() => require('./launch-scene.cjs').launchScene(race, { terrain: 'flat', controls: true }));await ready(race);
    let release,started;const gate=new Promise(resolve=>release=resolve),requested=new Promise(resolve=>started=resolve);
    await race.route('**/assets/source-robots/halflife2-dog/dog.glb',async route=>{started();await gate;await route.continue();});
    await race.evaluate(view=>{void window.__app.explore.restoreView(view)},saved);await requested;
    const stock={...saved,appearance:{colorway:'grey',sourceBody:'stock',parts:{},robotLight:{brightness:0,color:0xffffff,range:8,dull:false}},position:[5,6,7],target:[2,3,4]};
    await race.evaluate(view=>window.__app.explore.restoreView(view),stock);await restored(race);await matches(race,stock);assert.equal(await race.evaluate(()=>window.__app.view.getBodyVisualState().applied),'stock');
    await race.evaluate(view=>{void window.__app.explore.restoreView(view)},saved);await race.waitForFunction(()=>window.__app.view.getBodyVisualState().loading);
    await chooseVisual(race,'robot','go2');assert.equal(await race.evaluate(()=>!!window.__app.pendingViewRestore),false);release();
    await race.waitForFunction(()=>window.__app.viewModel?.robot==='go2');await race.waitForTimeout(150);assert.equal(await race.evaluate(()=>window.__app.noclip),false);assert.equal(await race.evaluate(()=>window.__app.view.getBodyVisualState().applied),'stock');
    if(!process.env.SKIP_SCREENSHOTS){await page.getByRole('textbox',{name:/^View name\b/}).scrollIntoViewIfNeeded();await page.screenshot({path:'/tmp/saved-views-desktop.png'});await page.setViewportSize({width:390,height:844});await page.getByRole('textbox',{name:/^View name\b/}).scrollIntoViewIfNeeded();await page.screenshot({path:'/tmp/saved-views-mobile.png'});}
    const bounds=await page.getByRole('button',{name:'Dog inspection',exact:true}).boundingBox();assert.ok(bounds.x>=0&&bounds.x+bounds.width<= (process.env.SKIP_SCREENSHOTS?1440:390));
    assert.deepEqual(errors,[]);console.log(JSON.stringify({savedAppearance:true,sourceHead:true,robotLight:true,roll:true,flight:true,freshLink:true,crossModelTerrain:true,recordingGuard:true,reviewGuard:true,exportGuard:true,legacy:true,latestSelection:true,manualNavigationCancels:true,bounds,errors}));
  }finally{await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1});
