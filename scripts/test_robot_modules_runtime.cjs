/** Chromium: character presets, mixed modules, persistence, takes and animated GLB export. */
const assert=require('node:assert/strict'),fs=require('node:fs/promises'),path=require('node:path');
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const {chooseVisual}=require('./choose-visual.cjs');
const {readyApp}=require('./attach-ready-app.cjs');
const artifactPath=require('./test-artifacts.cjs');
(async()=>{const browser=await chromium.launch({headless:process.env.HEADLESS==='1',executablePath:process.env.CHROMIUM_PATH,args:['--no-sandbox','--ozone-platform=x11']});try{
 const page=await browser.newPage({viewport:{width:1440,height:1000},deviceScaleFactor:1}),errors=[],requests=[];
 page.on('pageerror',e=>errors.push(e.message));page.on('console',m=>{if(m.type()==='error'&&/shader|WebGLProgram/.test(m.text()))errors.push(m.text())});page.on('request',r=>{if(r.url().includes('/source-robots/'))requests.push(r.url())});
 const base=process.env.BASE_URL||'http://127.0.0.1:5176',output=artifactPath();await fs.mkdir(output,{recursive:true});
 // Attach the real Ready App; explicit probes and the live loop both keep drawing.
 const ready=()=>readyApp(page);
 await page.goto(base+'/?plain&body=stock').then(() => require('./launch-scene.cjs').launchScene(page, { terrain:'flat',controls:true }));await ready();await page.getByText('Robot appearance',{exact:true}).click();
 const before=await page.evaluate(()=>{const a=window.__app;a.setHoist(true);return{ngeom:a.model.ngeom,robot:a.model.robot};});
 const snapshots=[];
 for(const style of ['boxy','round','prism']) {
  await chooseVisual(page,'character',style);
  const proof=await page.evaluate(()=>{
   const a=window.__app,v=a.view;v.camera.position.set(1.6,-2.4,1.5);v.controls.target.set(0,0,.7);v.camera.lookAt(v.controls.target);v.render();
   const parts=[...v.parts.values()].filter(p=>p.mesh.userData.robotModule);
   return{ngeom:a.model.ngeom,robot:a.model.robot,parts:parts.length,styles:[...new Set(parts.map(p=>p.mesh.userData.robotModule.style))],appearance:v.getAppearance()};
  });
  assert.equal(proof.ngeom,before.ngeom);assert.equal(proof.robot,before.robot);assert.deepEqual(proof.styles,[style]);snapshots.push(proof);
  await page.screenshot({path:path.join(output,style+'.png')});
 }
 await page.getByText('Mix robot parts',{exact:true}).click();await chooseVisual(page,'module-head','boxy');await chooseVisual(page,'module-arms','round');
 const saved=await page.evaluate(()=>window.__app.captureView());assert.equal(saved.appearance.modules.head,'boxy');assert.equal(saved.appearance.modules.arms,'round');assert.equal(saved.appearance.modules.torso,'prism');
 await page.reload().then(() => require('./launch-scene.cjs').launchScene(page, { terrain:'flat',controls:true }));await ready();assert.deepEqual(await page.evaluate(()=>window.__app.view.getAppearance().modules),saved.appearance.modules);
 await page.evaluate(()=>window.__app.startRecording());await page.waitForFunction(()=>window.__app.rec?.frames>=10);await page.evaluate(()=>window.__app.stopRecording());await page.waitForFunction(()=>window.__app.timeline.isOpen);
 assert.deepEqual(await page.evaluate(()=>window.__app.take.meta.appearance.modules),saved.appearance.modules);
 const motion=await page.evaluate(()=>{
  const a=window.__app,start=a.timeline.rangeIn,duration=a.timeline.rangeOut-start;
  const times=Float32Array.from({length:Math.max(2,Math.round(duration*24)+1)},(_,i)=>Math.min(i/24,duration)),geometry=a.take.sampleGeometry(times,start);
  return{times:Array.from(times),modules:[...a.view.exportParts()].filter(({mesh})=>mesh.userData.robotModule).map(({geom})=>({geom,poses:Array.from(times,(_,i)=>{const at=geometry.offset(i,geom);return Array.from(geometry.values.subarray(at,at+7))})}))};
 });
 // The real export action owns the renderer until the actual download completes.
 await page.evaluate(()=>window.__app.openExport('data'));
 await page.locator('.xf').filter({has:page.getByText('Key rate',{exact:true})}).getByRole('combobox').selectOption('24');
 await page.getByLabel('Shot camera (Video tab camera, lens and frame)',{exact:true}).uncheck();
 await page.getByLabel('Ground plane',{exact:true}).uncheck();
 const downloadReady=page.waitForEvent('download');await page.getByRole('button',{name:'Export .glb',exact:true}).click();
 const download=await downloadReady,buffer=await fs.readFile(await download.path()),length=buffer.readUInt32LE(12),document=JSON.parse(buffer.toString('utf8',20,20+length));
 await page.waitForFunction(()=>!window.__app.exporting&&!window.__app.dialog.busy);await page.keyboard.press('Escape');
 const channels=document.animations?.flatMap(animation=>animation.channels.map(channel=>({...channel,sampler:animation.samplers[channel.sampler]})))??[];
 const glb={bytes:buffer.length,modules:document.nodes.flatMap((node,index)=>node.extras?.robotModule?[{...node.extras.robotModule,geom:node.extras.geom,node:index,paths:channels.filter(channel=>channel.target.node===index).map(channel=>channel.target.path).sort()}]:[]),positionError:0,quaternionError:0};
 assert.ok(glb.modules.some(m=>m.region==='head'&&m.style==='boxy'));assert.ok(glb.modules.some(m=>m.region==='arms'&&m.style==='round'));
 assert.deepEqual(glb.modules.map(m=>m.geom).sort((a,b)=>a-b),motion.modules.map(m=>m.geom).sort((a,b)=>a-b));
 const readAccessor=(index,width)=>{
  const accessor=document.accessors[index],view=document.bufferViews[accessor.bufferView],start=28+length+(view.byteOffset||0)+(accessor.byteOffset||0),stride=view.byteStride||width*4;
  assert.equal(accessor.componentType,5126);assert.equal(accessor.count,motion.times.length);
  return Array.from({length:accessor.count},(_,i)=>Array.from({length:width},(_,k)=>buffer.readFloatLE(start+i*stride+k*4)));
 };
 for(const module of glb.modules){
  const node=document.nodes[module.node],recorded=motion.modules.find(m=>m.geom===module.geom),values={};
  for(const channel of channels.filter(c=>c.target.node===module.node)){
   const sampler=channel.sampler,times=readAccessor(sampler.input,1).flat();
   for(let i=0;i<times.length;i++)assert.ok(Math.abs(times[i]-motion.times[i])<1e-6);
   values[channel.target.path]=readAccessor(sampler.output,channel.target.path==='rotation'?4:3);
  }
  for(let i=0;i<recorded.poses.length;i++){
   const p=recorded.poses[i],position=values.translation?.[i]??node.translation??[0,0,0],rotation=values.rotation?.[i]??node.rotation??[0,0,0,1];
   const expectedPosition=[p[0],p[2],-p[1]],c=Math.SQRT1_2,expectedRotation=[c*(p[4]-p[3]),c*(p[5]+p[6]),c*(p[6]-p[5]),c*(p[3]+p[4])];
   glb.positionError=Math.max(glb.positionError,...position.map((v,k)=>Math.abs(v-expectedPosition[k])));
   const sign=rotation.reduce((sum,v,k)=>sum+v*expectedRotation[k],0)<0?-1:1;
   glb.quaternionError=Math.max(glb.quaternionError,...rotation.map((v,k)=>Math.abs(sign*v-expectedRotation[k])));
  }
 }
 assert.ok(Number.isFinite(glb.positionError)&&glb.positionError<1e-5,JSON.stringify(glb));
 assert.ok(Number.isFinite(glb.quaternionError)&&glb.quaternionError<1e-5,JSON.stringify(glb));
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
   const parts=[...v.parts.values()].filter(p=>p.mesh.userData.robotModule),styles=[...new Set(parts.map(p=>p.mesh.userData.robotModule.style))];
   a.look.restoreAppearance(a.viewModel.robot,{...v.getAppearance(),modules:{}});v.render();
   return{robot:a.model.robot,styles,restored:[...v.parts.values()].every(p=>!p.mesh.userData.robotModule)};
  });assert.deepEqual(proof.styles,['round']);assert.ok(proof.restored);crossRobot.push(proof);
 }
 assert.deepEqual(requests,[]);assert.deepEqual(errors,[]);console.log(JSON.stringify({characters:snapshots.map(s=>s.styles[0]),mixed:true,persistence:true,recorded:true,glb,stockRestored:true,crossRobot,additionalModelRequests:requests.length,errors}));
}finally{await browser.close()}})().catch(e=>{console.error(e);process.exitCode=1});
