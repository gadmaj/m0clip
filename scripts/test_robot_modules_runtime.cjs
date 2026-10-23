/** Chromium: character presets, mixed modules, persistence, takes and animated GLB export. */
const assert=require('node:assert/strict'),fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os');
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const {chooseVisual}=require('./choose-visual.cjs');
(async()=>{const browser=await chromium.launch({headless:false,args:['--no-sandbox','--ozone-platform=x11']});try{
 const page=await browser.newPage({viewport:{width:1440,height:1000},deviceScaleFactor:.5}),errors=[],requests=[];
 page.on('pageerror',e=>errors.push(e.message));page.on('console',m=>{if(m.type()==='error'&&/shader|WebGLProgram/.test(m.text()))errors.push(m.text())});page.on('request',r=>{if(r.url().includes('/source-robots/'))requests.push(r.url())});
 for(const pattern of ['**/src/main.ts*','**/assets/main-*.js'])await page.route(pattern,async route=>{const response=await route.fetch(),original=await response.text(),body=require('./expose-app.cjs')(original).replaceAll('this.view.render()','void 0');await route.fulfill({response,body})});
 const base=process.env.BASE_URL||'http://127.0.0.1:5176',output=path.join(os.homedir(),'.local/state/unitree-renderer/robot-modules');await fs.mkdir(output,{recursive:true});
 const ready=()=>page.waitForFunction(()=>window.__app?.lastFrame&&document.querySelector('#overlay').classList.contains('hidden'),null,{timeout:120000});
 await page.goto(base+'/?plain&body=stock').then(() => require('./launch-scene.cjs').launchScene(page, { controls: true }));await ready();await page.getByText('Robot appearance',{exact:true}).click();
 const before=await page.evaluate(()=>{const a=window.__app;a.setHoist(true);return{ngeom:a.model.ngeom,robot:a.model.robot};});
 const snapshots=[];
 for(const style of ['boxy','round','prism']) {
  await chooseVisual(page,'character',style);
  const proof=await page.evaluate(()=>{
   const a=window.__app,v=a.view;v.camera.position.set(1.6,-2.4,1.5);v.controls.target.set(0,0,.7);v.camera.lookAt(v.controls.target);v.render();
   const parts=[...v.parts.values()].filter(p=>p.mesh.userData.robotModule);
   return{ngeom:a.model.ngeom,robot:a.model.robot,parts:parts.length,styles:[...new Set(parts.map(p=>p.mesh.userData.robotModule.style))],appearance:v.getAppearance()};
  });
  assert.equal(proof.ngeom,before.ngeom);assert.equal(proof.robot,before.robot);assert.ok(proof.parts>15);assert.deepEqual(proof.styles,[style]);snapshots.push(proof);
  await page.screenshot({path:path.join(output,style+'.png')});
 }
 await page.getByText('Mix robot parts',{exact:true}).click();await chooseVisual(page,'module-head','boxy');await chooseVisual(page,'module-arms','round');
 assert.match(await page.locator('#character-trigger').textContent(),/custom/i);
 const saved=await page.evaluate(()=>window.__app.captureView());assert.equal(saved.appearance.modules.head,'boxy');assert.equal(saved.appearance.modules.arms,'round');assert.equal(saved.appearance.modules.torso,'prism');
 await page.reload().then(() => require('./launch-scene.cjs').launchScene(page, { controls: true }));await ready();assert.deepEqual(await page.evaluate(()=>window.__app.view.getAppearance().modules),saved.appearance.modules);
 await page.evaluate(()=>window.__app.startRecording());await page.waitForFunction(()=>window.__app.rec?.frames>=10);await page.evaluate(()=>window.__app.stopRecording());await page.waitForFunction(()=>window.__app.timeline.isOpen);
 assert.deepEqual(await page.evaluate(()=>window.__app.take.meta.appearance.modules),saved.appearance.modules);
 const glb=await page.evaluate(async()=>{const a=window.__app,blob=await a.dialog.host.glb(5,false,false),buffer=await blob.arrayBuffer(),view=new DataView(buffer),length=view.getUint32(12,true),json=JSON.parse(new TextDecoder().decode(new Uint8Array(buffer,20,length)));return{bytes:blob.size,modules:json.nodes.filter(n=>n.extras?.robotModule).map(n=>n.extras.robotModule),animated:json.animations?.[0].channels.length??0}});
 assert.ok(glb.bytes>1000&&glb.modules.length>15&&glb.animated>0);assert.ok(glb.modules.some(m=>m.region==='head'&&m.style==='boxy'));assert.ok(glb.modules.some(m=>m.region==='arms'&&m.style==='round'));
 await page.evaluate(()=>window.__app.closeReview());
 await page.evaluate(()=>{const a=window.__app;a.look.restoreAppearance(a.viewModel.robot,{...a.view.getAppearance(),modules:{}})});
 assert.equal(await page.evaluate(()=>[...window.__app.view.parts.values()].filter(p=>p.mesh.userData.robotModule).length),0);
 const crossRobot=[];
 for(const robot of ['g1','go2']) {
  await chooseVisual(page,'robot',robot);
  await page.waitForFunction(robot=>window.__app.model?.robot===robot&&window.__app.viewModel?.robot===robot&&document.querySelector('#overlay').classList.contains('hidden'),robot,{timeout:120000});
  const proof=await page.evaluate(()=>{
   const a=window.__app,v=a.view;const modules=Object.fromEntries(['head','torso','arms','hands','legs','feet'].map(r=>[r,'round']));
   a.look.restoreAppearance(a.viewModel.robot,{...v.getAppearance(),modules});v.render();
   const count=[...v.parts.values()].filter(p=>p.mesh.userData.robotModule).length;
   a.look.restoreAppearance(a.viewModel.robot,{...v.getAppearance(),modules:{}});v.render();
   return{robot:a.model.robot,count,restored:[...v.parts.values()].every(p=>!p.mesh.userData.robotModule)};
  });assert.ok(proof.count>5&&proof.restored);crossRobot.push(proof);
 }
 assert.deepEqual(requests,[]);assert.deepEqual(errors,[]);console.log(JSON.stringify({characters:snapshots.map(s=>s.styles[0]),mixed:true,persistence:true,recorded:true,glb,stockRestored:true,crossRobot,additionalModelRequests:requests.length,errors}));
}finally{await browser.close()}})().catch(e=>{console.error(e);process.exitCode=1});
