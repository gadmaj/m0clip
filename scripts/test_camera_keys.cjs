/** Chromium keyboard routing: dedicated camera controls, Num Lock, stop, editor focus and timeline. */
const {chromium}=require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert=require('node:assert/strict');
(async()=>{
  const browser=await chromium.launch({headless:process.env.HEADLESS==='1',args:['--no-sandbox','--ozone-platform=x11']});
  try {
    const page=await browser.newPage({viewport:{width:1440,height:1000}}),errors=[];
    if(process.env.LOW_DPR)await page.addInitScript(()=>Object.defineProperty(window,'devicePixelRatio',{get:()=>.25}));
    page.on('pageerror',e=>errors.push(e.message));
    await page.route('**/src/main.ts*',async route=>{const response=await route.fetch();await route.fulfill({response,body:(await response.text()).replace('new App();','window.__app = new App();')});});
    await page.route('**/assets/main-*.js',async route=>{const response=await route.fetch(),original=await response.text();const body=original.replace(/new ([A-Za-z_$][\w$]*);export\{/, 'window.__app=new $1;export{');if(body===original)throw new Error('Production App entry was not found');await route.fulfill({response,body});});
    await page.goto((process.env.BASE_URL||'http://127.0.0.1:5176')+'/?plain'+(process.env.TEST_MAP?'&map='+encodeURIComponent(process.env.TEST_MAP):''));
    await page.waitForFunction(()=>window.__app?.lastFrame&&document.querySelector('#overlay').classList.contains('hidden'),null,{timeout:120000});
    if(await page.locator('#policy-notice').count())await page.locator('#policy-notice button').first().click();
    const canvas=page.locator('#viewport canvas');await canvas.focus();
    await page.evaluate(()=>{const a=window.__app,old=a.send.bind(a);window.__sent=[];a.send=m=>{window.__sent.push(m);old(m);};window.__origin=a.view.camera.position.toArray();});
    await page.keyboard.down('ArrowUp');
    await page.waitForFunction(()=>{const a=window.__app,p=window.__origin;return a.noclip&&Math.hypot(...a.view.camera.position.toArray().map((v,i)=>v-p[i]))>.15;});
    await page.keyboard.up('ArrowUp');await page.keyboard.press('Numpad5');
    assert.deepEqual(await page.evaluate(()=>window.__app.command),[0,0,0]);
    assert.equal(await page.evaluate(()=>window.__sent.filter(m=>m.t==='state').length),0);
    // Every numpad movement key follows the camera basis; Num Lock off still uses physical codes.
    const directions=[];
    for(const [code,key,axis,sign] of [['Numpad8','8',0,1],['Numpad2','2',0,-1],['Numpad4','ArrowLeft',1,1],['Numpad6','ArrowRight',1,-1],['Numpad9','PageUp',2,1],['Numpad3','PageDown',2,-1]]){
      await page.evaluate(()=>{const a=window.__app;a.flight.stop();a.view.camera.position.set(0,0,3);a.view.controls.target.set(1,0,3);a.view.camera.lookAt(a.view.controls.target);a.view.camera.updateMatrixWorld();});
      await canvas.dispatchEvent('keydown',{code,key,location:3,bubbles:true});
      await page.waitForFunction(({axis,sign})=>(window.__app.view.camera.position.toArray()[axis]-(axis===2?3:0))*sign>.05,{axis,sign});
      directions.push({code,key,position:await page.evaluate(()=>window.__app.view.camera.position.toArray())});
      await canvas.dispatchEvent('keyup',{code,key,location:3,bubbles:true});await page.keyboard.press('Numpad5');
    }
    assert.equal(await page.evaluate(()=>window.__sent.filter(m=>m.t==='state').length),0);
    const shortcuts=await page.evaluate(()=>{const canvas=document.querySelector('#viewport canvas');return ['KeyW','KeyR','Digit4','ArrowLeft','Numpad4'].map(code=>{const e=new KeyboardEvent('keydown',{code,key:code==='KeyW'?'w':code==='KeyR'?'r':code==='ArrowLeft'?'ArrowLeft':'4',ctrlKey:true,bubbles:true,cancelable:true});canvas.dispatchEvent(e);return !e.defaultPrevented;});});assert.ok(shortcuts.every(Boolean),'Browser shortcuts pass through');
    const speed=await page.evaluate(()=>window.__app.flight.speed);await page.keyboard.press('NumpadAdd');assert.equal(await page.evaluate(()=>window.__app.flight.speed),speed+4);await page.keyboard.press('NumpadSubtract');assert.equal(await page.evaluate(()=>window.__app.flight.speed),speed);
    await page.evaluate(()=>window.__app.flight.stop());const z=await page.evaluate(()=>window.__app.view.camera.position.z);await canvas.dispatchEvent('keydown',{code:'Space',key:' ',ctrlKey:true,bubbles:true});await page.waitForFunction(z=>window.__app.view.camera.position.z<z-.05,z);await canvas.dispatchEvent('keyup',{code:'Space',key:' ',bubbles:true});await page.keyboard.press('Numpad5');
    // Stop latches until a fresh physical press, even if a held key repeats.
    await page.keyboard.down('Numpad8');await page.waitForFunction(()=>window.__app.flight.velocity.lengthSq()>0);await page.keyboard.press('Numpad5');
    const stopped=await page.evaluate(()=>window.__app.view.camera.position.toArray());await page.keyboard.down('Numpad8');await page.waitForTimeout(150);assert.deepEqual(await page.evaluate(()=>window.__app.view.camera.position.toArray()),stopped);await page.keyboard.up('Numpad8');
    await page.keyboard.down('Numpad8');await page.waitForFunction(()=>window.__app.flight.velocity.lengthSq()>0);await page.keyboard.up('Numpad8');await page.keyboard.press('Numpad5');
    await page.locator('#flight-place').click();await canvas.dispatchEvent('keydown',{code:'Numpad2',key:'2',bubbles:true});assert.equal(await page.evaluate(()=>window.__app.placingRobot&&!window.__app.flight.active),true);assert.equal(await page.evaluate(()=>window.__sent.filter(m=>m.t==='state').length),0);await page.keyboard.press('Escape');
    if(!process.env.SKIP_SCREENSHOTS)await page.screenshot({path:'/tmp/camera-keys-desktop.png'});
    // Main-row digits keep the robot state shortcuts; editors keep arrow navigation.
    await page.keyboard.press('n');await page.keyboard.press('2');await page.waitForFunction(()=>window.__app.status.state==='lock');
    const search=page.locator('#terrain-search');await search.focus();await page.keyboard.press('ArrowDown');await page.keyboard.press('Numpad2');assert.equal(await page.evaluate(()=>window.__app.noclip),false);assert.equal(await page.evaluate(()=>window.__app.status.state), 'lock');await page.keyboard.press('Escape');await canvas.focus();
    await page.keyboard.down('Shift');await page.keyboard.down('ArrowUp');await page.waitForFunction(()=>window.__app.flight.velocity.length()>5);await page.keyboard.up('ArrowUp');await page.keyboard.up('Shift');await page.keyboard.press('Numpad5');await page.keyboard.press('n');
    await page.keyboard.down('Numpad2');await page.waitForFunction(()=>window.__app.noclip);await page.keyboard.up('Numpad2');await page.keyboard.press('Numpad0');await page.keyboard.press('n');
    await page.keyboard.press('v');await page.waitForFunction(()=>window.__app.rec?.frames>=20);await page.keyboard.press('v');await page.waitForFunction(()=>window.__app.timeline.isOpen);
    await page.evaluate(()=>window.__app.timeline.seek(0));await page.keyboard.press('ArrowRight');assert.equal(await page.evaluate(()=>window.__app.noclip),false);assert.ok(await page.evaluate(()=>window.__app.timeline.time)>0);await page.evaluate(()=>window.__app.closeReview());
    await canvas.focus();await page.keyboard.press('ArrowUp');await page.keyboard.press('Numpad5');await page.setViewportSize({width:390,height:844});await page.locator('#toggle-panels').click();if(!process.env.SKIP_SCREENSHOTS)await page.screenshot({path:'/tmp/camera-keys-mobile.png'});
    const hud=await page.locator('#flight-hud').boundingBox();assert.ok(hud.x>=0&&hud.x+hud.width<=390&&hud.y>=0&&hud.y+hud.height<=844);assert.deepEqual(errors,[]);
    console.log(JSON.stringify({arrowsStartFlight:true,directions,numLockOff:true,noNumpadRobotStateChanges:true,stopRepeat:true,speedKeys:true,placementProtected:true,editorProtected:true,timelinePreserved:true,mainRowStates:true,browserShortcuts:true,heldShiftOnEntry:true,ctrlSpace:true,mobileHud:hud,errors}));
  } finally {await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
