/** Chromium check: actual Source surface illumination, dull finish, persistence and take replay. */
const artifactPath=require('./test-artifacts.cjs');
const {chromium} = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');
const {readyApp} = require('./attach-ready-app.cjs');
const path = require('node:path');
const buildFixture = require('./build-fixture.cjs');
(async () => {
  const fixture = await buildFixture({
    root: path.resolve(__dirname, '..'),
    source: "export { saveTake, loadTake } from './src/record/take';",
    platform: 'browser', format: 'iife', globalName: 'RobotLightFixture',
  });
  const browser = await chromium.launch({headless:process.env.HEADLESS === '1',executablePath:process.env.CHROMIUM_PATH,args:['--no-sandbox','--ozone-platform=x11']});
  try {
    const page = await browser.newPage({viewport:{width:1440,height:1000}}), errors=[];
    page.on('pageerror',e=>errors.push(e.message));
    page.on('console',m=>{if(m.type()==='error'&&/shader|WebGLProgram/.test(m.text()))errors.push(m.text());});
    const url=(process.env.BASE_URL || 'http://127.0.0.1:5176')+'/?plain&map=nt_ghost_ctg';
    await page.goto(url).then(() => require('./launch-scene.cjs').launchScene(page, { controls: true }));
    // The release chunk stays byte-identical; the real Ready App is attached through CDP.
    await readyApp(page,{until:()=>window.__app.view.terrainObject,timeout:180000});
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
    if (!process.env.SKIP_SCREENSHOTS) await page.screenshot({path:artifactPath('robot-light-desktop.png')});
    await page.locator('#robot-dull').check();
    const dull=await page.evaluate(async()=>{const v=window.__app.view;await v.setSourceHead('ghost');const mats=[...v.parts.values()].flatMap(p=>[p.mesh.material].flat());return {settings:v.getAppearance().robotLight,materials:mats.length,allDull:mats.every(m=>m.roughness===1&&m.metalness===0&&m.envMapIntensity===0&&m.emissiveIntensity===0&&(!('clearcoat'in m)||m.clearcoat===0)&&(!('specularIntensity'in m)||m.specularIntensity===0))};});assert.ok(dull.allDull);assert.equal(dull.settings.brightness,0);assert.equal(await page.locator('#robot-light-brightness').isDisabled(),true);
    if (!process.env.SKIP_SCREENSHOTS) await page.screenshot({path:artifactPath('robot-dull-desktop.png')});
    // Compact layouts select Scene; desktop layouts restore their remembered collapse state.
    const showScene=async()=>{const compact=page.getByRole('navigation',{name:'Advanced panels'}).getByRole('button',{name:'Scene',exact:true}),expand=page.getByRole('button',{name:'Expand Scene panel',exact:true});if(await compact.isVisible())await compact.click();else if(await expand.isVisible())await expand.click();};
    await page.setViewportSize({width:390,height:844});await showScene();await page.locator('#robot-dull').scrollIntoViewIfNeeded();if (!process.env.SKIP_SCREENSHOTS) await page.screenshot({path:artifactPath('robot-light-mobile.png')});
    await page.reload().then(() => require('./launch-scene.cjs').launchScene(page, { controls: true }));await readyApp(page,{timeout:180000});
    // The reload is a returning visit, so the optional storage notice can cover the compact panel.
    // Decline it through its real UI once its status check settles; never request storage permission.
    await page.waitForFunction(()=>{const notice=document.querySelector('.storage-consent');return !notice||notice.dataset.state!=='checking'&&notice.dataset.state!=='requesting';},null,{timeout:30000});
    const storageNotice=page.locator('.storage-consent');if(await storageNotice.isVisible()){await storageNotice.getByRole('button',{name:/^(Not now|Close)$/}).click();await storageNotice.waitFor({state:'hidden'});}
    assert.equal(await page.locator('#robot-dull').isChecked(),true);await showScene();await page.getByText('Robot appearance',{exact:true}).click();
    await page.setViewportSize({width:1440,height:1000});await showScene();await page.locator('#robot-dull').uncheck();await page.locator('#robot-light-brightness').evaluate(e=>e.value='25');await page.locator('#robot-light-brightness').dispatchEvent('input');
    await page.evaluate(()=>window.__app.startRecording());await page.waitForFunction(()=>!!window.__app.rec);assert.equal(await page.locator('#robot-dull').isDisabled(),true);await page.waitForTimeout(800);await page.evaluate(()=>window.__app.stopRecording());await page.waitForFunction(()=>window.__app.timeline.isOpen);
    await page.addScriptTag({content:fixture.code});
    if(fixture.css)await page.addStyleTag({content:fixture.css});
    const recorded=await page.evaluate(async()=>{const a=window.__app;const {saveTake,loadTake}=window.RobotLightFixture;const take=await loadTake(await (await saveTake(a.take)).arrayBuffer());a.closeReview();a.view.setAppearance({...a.view.getAppearance(),robotLight:{brightness:0,color:0xffffff,range:8,dull:true}});a.openReview();const review=a.view.getAppearance().robotLight;a.closeReview();return{saved:take.meta.appearance.robotLight,review,restored:a.view.getAppearance().robotLight};});assert.equal(recorded.saved.brightness,25);assert.equal(recorded.review.brightness,25);assert.equal(recorded.restored.dull,true);
    await page.evaluate(()=>{const v=window.__app.view;v.setAppearance({...v.getAppearance(),robotLight:{brightness:25,color:0xffffff,range:8,dull:false}});});
    await page.waitForFunction(()=>window.__app.view.robotLight.brightness.value===25);
    await page.evaluate(()=>window.__app.setNoclip(true));await page.waitForFunction(()=>window.__app.view.getRobotOpacity()===0);assert.equal(await page.evaluate(()=>window.__app.view.robotLight.brightness.value),0);
    assert.deepEqual(errors,[]);console.log(JSON.stringify({changed,added,surrounding,dull,recorded,persisted:true,hiddenLightOff:true,errors}));
  } finally {await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
