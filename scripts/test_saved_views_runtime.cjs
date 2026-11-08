/** Chromium: saved views restore native visuals, camera roll and navigation after model loading. */
const artifactPath=require('./test-artifacts.cjs');
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const assert=require('node:assert/strict');
const {chooseVisual}=require('./choose-visual.cjs');
const {readyApp}=require('./attach-ready-app.cjs');
(async()=>{
  const browser=await chromium.launch({headless:process.env.HEADLESS==='1',executablePath:process.env.CHROMIUM_PATH,args:['--no-sandbox','--ozone-platform=x11']});
  const errors=[];
  async function pageIn(context){
    const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));
    return page;
  }
  const base=process.env.BASE_URL||'http://127.0.0.1:5176';
  // The release chunk stays byte-identical; the real Ready App is attached through CDP after launch.
  const ready=page=>readyApp(page);
  async function restored(page){await page.waitForFunction(()=>!window.__app.pendingViewRestore,null,{timeout:120000});}
  async function matches(page,view){
    const actual=await page.evaluate(()=>window.__app.captureView());
    assert.equal(await page.evaluate(()=>window.__app.view.sourceColor.antialiasing),view.look.antialiasing??'fxaa');
    for(const key of ['robot','terrain','appearance','sourceHead','noclip','flight','flashlight','look','display'])assert.deepEqual(actual[key],view[key],key);
    for(const key of ['position','target','orientation'])for(let i=0;i<view[key].length;i++)assert.ok(Math.abs(actual[key][i]-view[key][i])<1e-6,`${key}[${i}]: ${actual[key][i]} != ${view[key][i]}`);
    assert.equal(actual.fov,view.fov);
  }
  try{
    const context=await browser.newContext({viewport:{width:1440,height:1000},deviceScaleFactor:1}),page=await pageIn(context);
    await page.goto(base+'/?plain').then(() => require('./launch-scene.cjs').launchScene(page, { terrain: 'flat', controls: true }));await ready(page);
    const saved=await page.evaluate(async()=>{
      const a=window.__app;a.setNoclip(true);a.flight.stop();a.heldView=true;
      a.look.setState({...a.look.getState(),antialiasing:'msaa4'});
      a.look.restoreAppearance(a.viewModel.robot,{colorway:'grey',sourceBody:'dog',sourceBodyColorway:'model',parts:{left_elbow_link:{color:0x23aaff,finish:'metal',roughness:.2}},robotLight:{brightness:70,color:0xffddbb,range:19,dull:false}});
      await a.view.waitForRobotVisuals();a.flight.speed=84;a.flight.hover=true;a.setFlashlight(true);
      a.view.camera.position.set(2,3,4);a.view.controls.target.set(-1,0,1);a.view.camera.lookAt(a.view.controls.target);a.view.camera.rotateZ(.37);a.view.camera.fov=72;a.view.camera.updateProjectionMatrix();a.flight.setActive(true);
      a.explore.setDisplay({textures:true,wireframe:false,map:true,robot:true,decals:false});return a.captureView();
    });
    await page.getByText('Saved views',{exact:true}).click();await page.getByLabel('View name',{exact:true}).fill('Dog inspection');await page.getByRole('button',{name:'Save view',exact:true}).click();
    await page.evaluate(()=>{const a=window.__app;a.look.setState({...a.look.getState(),antialiasing:'none'});a.look.restoreAppearance(a.viewModel.robot,{colorway:'product',sourceBody:'stock',parts:{},robotLight:{brightness:0,color:0xffffff,range:5,dull:true}});a.setNoclip(false);a.setFlashlight(false);a.flight.speed=12;a.flight.hover=false;a.view.camera.position.set(8,8,8);});
    await page.getByRole('button',{name:'Dog inspection',exact:true}).click();await restored(page);await page.waitForTimeout(150);await matches(page,saved);
    assert.equal(await page.evaluate(()=>window.__app.view.getBodyVisualState().applied),'dog');
    await context.grantPermissions(['clipboard-read','clipboard-write'],{origin:new URL(base).origin});
    const share=page.getByRole('button',{name:'Share Dog inspection',exact:true});
    await share.click();
    const viewLink=await page.getByLabel('Shareable view link',{exact:true}).inputValue();
    await page.waitForFunction(expected=>navigator.clipboard.readText().then(value=>value===expected),viewLink);
    assert.equal(new URL(viewLink).searchParams.get('body'),'dog');
    assert.ok(await share.evaluate(button=>document.activeElement===button),'Sharing must keep focus on its button');
    await page.keyboard.press('Tab');
    assert.ok(await page.getByRole('button',{name:'Rename Dog inspection',exact:true}).evaluate(button=>document.activeElement===button),'Tab must continue within the saved-view row');
    // A short nested library must hand its wheel to the containing Scene panel.
    const viewport=page.viewportSize();
    await page.setViewportSize({width:390,height:844});
    await page.getByRole('navigation',{name:'Advanced panels'}).getByRole('button',{name:'Scene',exact:true}).click();
    await page.getByRole('button',{name:'Dog inspection',exact:true}).hover();
    const wheelStart=await page.locator('#saved-view-list').evaluate(list=>({
      top:list.closest('.floating-body').scrollTop,overflow:list.scrollHeight>list.clientHeight,
    }));
    assert.equal(wheelStart.overflow,false,'Exercise the non-overflowing nested library');
    assert.ok(wheelStart.top>0,'The Scene panel must be scrolled before wheeling up');
    await page.mouse.wheel(0,-120);
    await page.waitForFunction(top=>document.getElementById('saved-view-list').closest('.floating-body').scrollTop<top,wheelStart.top);
    await page.setViewportSize(viewport);
    const expandScene=page.getByRole('button',{name:'Expand Scene panel',exact:true});
    if(await expandScene.isVisible())await expandScene.click();
    // A fresh receiver's robot, lighting and paint preferences must not replace the shared view.
    const receiver=await browser.newContext({viewport:{width:1440,height:1000},deviceScaleFactor:1});await receiver.addInitScript(()=>{localStorage.setItem('ume-prefs',JSON.stringify({robot:'go2',terrain:'park',policy:'does-not-exist'}));localStorage.setItem('ume-appearance',JSON.stringify({r1:{colorway:'product',sourceBody:'stock',parts:{}}}));});
    const fresh=await pageIn(receiver);await fresh.goto(viewLink).then(() => require('./launch-scene.cjs').launchScene(fresh, { controls: true }));await ready(fresh);await restored(fresh);await matches(fresh,saved);
    await receiver.close();
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
    // Hold genuine export preparation, not the App's exporting flag (same boundary as export-setup).
    await page.evaluate(()=>{
      const a=window.__app,d=a.dialog,stage=d.host.stage,out={...d.out};let release;
      const gate=new Promise(resolve=>{release=resolve});
      const task=window.__savedViewExport={waiting:false,release,restore:()=>{d.host.stage=stage;Object.assign(d.out,out)}};
      Object.assign(d.out,{res:'custom',width:240,height:160,fps:5,speed:1,container:'png',transparent:true});
      a.openExport('video');
      d.host.stage=()=>{const value=stage();return{...value,prepare:async()=>{task.waiting=true;await gate;await value.prepare?.()}}};
      task.job=d.renderVideoJob();
    });
    let exportGuard,guardFailure;
    try{
      await page.waitForFunction(()=>window.__savedViewExport.waiting);
      exportGuard=await page.evaluate(async view=>{
        const a=window.__app,before=a.captureView(),model=a.viewModel,take=a.take;
        const active=a.exporting&&a.dialog.busy,readOnly=a.explore.readOnly;
        await a.explore.restoreView(view);
        return{before,after:a.captureView(),modelKept:a.viewModel===model,takeKept:a.take===take,active,readOnly};
      },go2);
      assert.ok(exportGuard.active&&exportGuard.readOnly&&exportGuard.takeKept);
      assert.deepEqual(exportGuard.after,exportGuard.before);assert.ok(exportGuard.modelKept);
    }catch(error){guardFailure=error;throw error}
    finally{
      try{
        await page.locator('#export').getByRole('button',{name:'Cancel',exact:true}).click();
        await page.evaluate(async()=>{
          const task=window.__savedViewExport;task.release();
          try{await task.job}finally{task.restore();delete window.__savedViewExport}
        });
      }catch(error){if(!guardFailure)throw error;console.error('Export guard cleanup failed:',error)}
    }
    assert.equal(await page.evaluate(()=>window.__app.exporting||window.__app.dialog.busy||window.__app.explore.readOnly),false);
    await page.evaluate(()=>{window.__app.dialog.close();window.__app.closeReview()});
    // Old camera-only bookmarks remain readable without overwriting the robot appearance.
    const legacy={...saved,look:{...saved.look}};delete legacy.look.antialiasing;for(const key of ['appearance','sourceHead','orientation','noclip','flight'])delete legacy[key];
    await page.evaluate(view=>window.__app.explore.restoreView(view),legacy);await restored(page);assert.deepEqual(await page.evaluate(()=>window.__app.view.getAppearance()),saved.appearance);
    assert.equal(await page.evaluate(()=>window.__app.view.sourceColor.antialiasing),'fxaa');
    // Latest selection wins even while the first view is waiting for a native model download.
    const raceContext=await browser.newContext({deviceScaleFactor:1}),race=await pageIn(raceContext);await race.goto(base+'/?plain').then(() => require('./launch-scene.cjs').launchScene(race, { terrain: 'flat', controls: true }));await ready(race);
    const raceScene=race.locator('#workspace-panels button[aria-controls="scene-window"]');
    if(await raceScene.getAttribute('aria-expanded')!=='true')await raceScene.click();
    await race.getByText('Saved views',{exact:true}).click();
    const pendingName=race.getByLabel('View name',{exact:true});await pendingName.fill('Partial restore');
    let release,started;const gate=new Promise(resolve=>release=resolve),requested=new Promise(resolve=>started=resolve);
    await race.route('**/assets/source-robots/halflife2-dog/dog.glb',async route=>{started();await gate;await route.continue();});
    await race.evaluate(view=>{void window.__app.explore.restoreView(view)},saved);await requested;
    // A genuine held model restore cannot save a mixture of old scene and new camera settings.
    assert.equal(await race.evaluate(()=>!!window.__app.pendingViewRestore||!!window.__app.viewRestoreAbort),true);
    await pendingName.press('Enter');
    assert.equal(await pendingName.inputValue(),'Partial restore');
    assert.equal(await race.getByRole('button',{name:'Partial restore',exact:true}).count(),0);
    assert.equal(await race.evaluate(()=>JSON.parse(localStorage.getItem('ume-saved-views-v1')||'[]').some(bookmark=>bookmark.name==='Partial restore')),false);
    const stock={...saved,appearance:{colorway:'grey',sourceBody:'stock',parts:{},robotLight:{brightness:0,color:0xffffff,range:8,dull:false}},position:[5,6,7],target:[2,3,4]};
    await race.evaluate(view=>window.__app.explore.restoreView(view),stock);await restored(race);await matches(race,stock);assert.equal(await race.evaluate(()=>window.__app.view.getBodyVisualState().applied),'stock');
    await race.evaluate(view=>{void window.__app.explore.restoreView(view)},saved);await race.waitForFunction(()=>window.__app.view.getBodyVisualState().loading);
    await chooseVisual(race,'robot','go2');assert.equal(await race.evaluate(()=>!!window.__app.pendingViewRestore),false);release();
    await race.waitForFunction(()=>window.__app.viewModel?.robot==='go2');await race.waitForTimeout(150);assert.equal(await race.evaluate(()=>window.__app.noclip),false);assert.equal(await race.evaluate(()=>window.__app.view.getBodyVisualState().applied),'stock');
    await raceContext.close();
    // A restored Flight view must not put its HUD above the library's pointer targets.
    await page.getByRole('button',{name:'Dog inspection',exact:true}).click();await restored(page);
    for(const width of [320,390]){
      await page.setViewportSize({width,height:844});
      await page.getByRole('navigation',{name:'Advanced panels'}).getByRole('button',{name:'Scene',exact:true}).click();
      assert.ok(await page.locator('#flight-hud').isVisible(),'Exercise saved actions while Flight is active');
      for(const name of ['Dog inspection','Share Dog inspection','Rename Dog inspection','Delete Dog inspection']){
        const target=page.getByRole('button',{name,exact:true});await target.scrollIntoViewIfNeeded();
        assert.ok(await target.evaluate(button=>{
          const r=button.getBoundingClientRect();
          return button.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2));
        }),`${name} must receive pointer input at ${width}px`);
      }
      await share.click();
      await page.getByRole('button',{name:'Rename Dog inspection',exact:true}).click();
      await page.getByLabel('New name for Dog inspection',{exact:true}).press('Escape');
    }
    await page.setViewportSize(viewport);
    if(await expandScene.isVisible())await expandScene.click();
    // Compact layouts show one advanced panel at a time; Saved views lives in Scene.
    if(!process.env.SKIP_SCREENSHOTS){await page.getByLabel('View name',{exact:true}).scrollIntoViewIfNeeded();await page.screenshot({path:artifactPath('saved-views-desktop.png')});await page.setViewportSize({width:390,height:844});await page.getByRole('navigation',{name:'Advanced panels'}).getByRole('button',{name:'Scene',exact:true}).click();await page.getByLabel('View name',{exact:true}).scrollIntoViewIfNeeded();await page.screenshot({path:artifactPath('saved-views-mobile.png')});}
    const bounds=await page.getByRole('button',{name:'Dog inspection',exact:true}).boundingBox();assert.ok(bounds.x>=0&&bounds.x+bounds.width<= (process.env.SKIP_SCREENSHOTS?1440:390));
    assert.deepEqual(errors,[]);console.log(JSON.stringify({savedAppearance:true,sourceHead:true,robotLight:true,roll:true,flight:true,freshLink:true,crossModelTerrain:true,recordingGuard:true,reviewGuard:true,exportGuard:true,partialRestoreGuard:true,legacy:true,latestSelection:true,manualNavigationCancels:true,bounds,errors}));
  }finally{await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1});
