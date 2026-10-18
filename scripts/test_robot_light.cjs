/** Chromium check: actual Source surface illumination, dull finish, persistence and take replay. */
const {chromium} = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');
(async () => {
  const browser = await chromium.launch({headless:process.env.HEADLESS === '1',args:['--no-sandbox','--ozone-platform=x11']});
  try {
    const page = await browser.newPage({viewport:{width:1440,height:1000}}), errors=[];
    page.on('pageerror',e=>errors.push(e.message));
    page.on('console',m=>{if(m.type()==='error'&&/shader|WebGLProgram/.test(m.text()))errors.push(m.text());});
    await page.route('**/src/main.ts*',async route=>{const response=await route.fetch();await route.fulfill({response,body:(await response.text()).replace('new App();','window.__app = new App();')});});
    const url=(process.env.BASE_URL || 'http://127.0.0.1:5176')+'/?plain&map=nt_ghost_ctg';
    await page.goto(url);
    await page.waitForFunction(()=>window.__app?.lastFrame&&window.__app.view.terrainObject&&document.querySelector('#overlay').classList.contains('hidden'),null,{timeout:180000});
    await page.getByText('Robot appearance',{exact:true}).click();
    await page.evaluate(()=>{const a=window.__app;a.send({t:'pause',on:true});const v=a.view;v.controls.enabled=false;v.camera.position.set(a.baseXY[0]+3,a.baseXY[1]-3,2.5);v.controls.target.set(...a.baseXY,.5);v.camera.lookAt(v.controls.target);v.camera.updateMatrixWorld();window.__pixels=()=>{v.render();const c=document.createElement('canvas');c.width=480;c.height=320;const ctx=c.getContext('2d');ctx.drawImage(v.renderer.domElement,0,0,c.width,c.height);return Array.from(ctx.getImageData(0,0,c.width,c.height).data);};});
    console.log('Ghost ready');
    const before=await page.evaluate(()=>window.__pixels());
    await page.locator('#robot-light-brightness').evaluate(e=>e.value='100');await page.locator('#robot-light-brightness').dispatchEvent('input');
    const after=await page.evaluate(()=>window.__pixels());
    console.log('Bright frame captured');
    let changed=0,added=0;for(let i=0;i<before.length;i+=4){const d=after[i]+after[i+1]+after[i+2]-before[i]-before[i+1]-before[i+2];if(d>10){changed++;added+=d;}}
    assert.ok(changed>1000,`Expected nearby surface lighting, got ${changed} brightened pixels`);
    // Hide only robot meshes; map lighting must remain, proving this is actual illumination.
    const surrounding=await page.evaluate(()=>{const v=window.__app.view;for(const m of v.geomMeshes)if(m?.userData.robotGeom)m.visible=false;v.renderer.render(v.scene,v.camera);const c=document.createElement('canvas');c.width=480;c.height=320;const ctx=c.getContext('2d');ctx.drawImage(v.renderer.domElement,0,0,c.width,c.height);const lit=ctx.getImageData(0,0,c.width,c.height).data;v.robotLight.brightness.value=0;v.renderer.render(v.scene,v.camera);ctx.drawImage(v.renderer.domElement,0,0,c.width,c.height);const dark=ctx.getImageData(0,0,c.width,c.height).data;let count=0;for(let i=0;i<lit.length;i+=4)if(lit[i]+lit[i+1]+lit[i+2]>dark[i]+dark[i+1]+dark[i+2]+10)count++;return count;});assert.ok(surrounding>1000,`Map surface pixels illuminated: ${surrounding}`);
    if (!process.env.SKIP_SCREENSHOTS) await page.screenshot({path:'/tmp/robot-light-desktop.png'});
    await page.locator('#robot-dull').check();
    const dull=await page.evaluate(async()=>{const v=window.__app.view;await v.setSourceHead('ghost');const mats=[...v.parts.values()].flatMap(p=>[p.mesh.material].flat());return {settings:v.getAppearance().robotLight,materials:mats.length,allDull:mats.every(m=>m.roughness===1&&m.metalness===0&&m.envMapIntensity===0&&m.emissiveIntensity===0&&(!('clearcoat'in m)||m.clearcoat===0)&&(!('specularIntensity'in m)||m.specularIntensity===0))};});assert.ok(dull.allDull);assert.equal(dull.settings.brightness,0);assert.equal(await page.locator('#robot-light-brightness').isDisabled(),true);
    if (!process.env.SKIP_SCREENSHOTS) await page.screenshot({path:'/tmp/robot-dull-desktop.png'});
    await page.setViewportSize({width:390,height:844});await page.locator('#robot-dull').scrollIntoViewIfNeeded();if (!process.env.SKIP_SCREENSHOTS) await page.screenshot({path:'/tmp/robot-light-mobile.png'});
    await page.reload();await page.waitForFunction(()=>window.__app?.lastFrame&&document.querySelector('#overlay').classList.contains('hidden'),null,{timeout:180000});assert.equal(await page.locator('#robot-dull').isChecked(),true);await page.getByText('Robot appearance',{exact:true}).click();
    await page.setViewportSize({width:1440,height:1000});await page.locator('#robot-dull').uncheck();await page.locator('#robot-light-brightness').evaluate(e=>e.value='25');await page.locator('#robot-light-brightness').dispatchEvent('input');
    await page.evaluate(()=>window.__app.startRecording());await page.waitForFunction(()=>!!window.__app.rec);assert.equal(await page.locator('#robot-dull').isDisabled(),true);await page.waitForTimeout(800);await page.evaluate(()=>window.__app.stopRecording());await page.waitForFunction(()=>window.__app.timeline.isOpen);
    const recorded=await page.evaluate(async()=>{const a=window.__app;const {saveTake,loadTake}=await import('/src/record/take.ts');const take=await loadTake(await (await saveTake(a.take)).arrayBuffer());a.closeReview();a.view.setAppearance({...a.view.getAppearance(),robotLight:{brightness:0,color:0xffffff,range:8,dull:true}});a.openReview();const review=a.view.getAppearance().robotLight;a.closeReview();return{saved:take.meta.appearance.robotLight,review,restored:a.view.getAppearance().robotLight};});assert.equal(recorded.saved.brightness,25);assert.equal(recorded.review.brightness,25);assert.equal(recorded.restored.dull,true);
    await page.evaluate(()=>{const v=window.__app.view;v.setAppearance({...v.getAppearance(),robotLight:{brightness:25,color:0xffffff,range:8,dull:false}});});
    await page.waitForFunction(()=>window.__app.view.robotLight.brightness.value===25);
    await page.evaluate(()=>window.__app.setNoclip(true));await page.waitForFunction(()=>window.__app.view.getRobotOpacity()===0);assert.equal(await page.evaluate(()=>window.__app.view.robotLight.brightness.value),0);
    assert.deepEqual(errors,[]);console.log(JSON.stringify({changed,added,surrounding,dull,recorded,persisted:true,hiddenLightOff:true,errors}));
  } finally {await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
