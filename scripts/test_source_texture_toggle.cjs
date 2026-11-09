/** Chromium: diffuse-only mode preserves alpha, masks, animation and lossless exports. */
const{chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright'),assert=require('node:assert/strict');
const captureGlb=require('./capture-glb.cjs');
const{fixture,materialView,install}=require('./source_material_fixture.cjs'),{bundle}=require('./source_map_fixture.cjs'),{readyApp}=require('./attach-ready-app.cjs');
(async()=>{const browser=await chromium.launch({headless:process.env.HEADLESS==='1',executablePath:process.env.CHROMIUM_PATH,args:['--no-sandbox','--ozone-platform=x11']});try{
 // Component-only material matrix: each owned mode is a verified local bundle installed in the real renderer.
 const errors=[],harness=await materialView(browser,errors);
 const results={};
 for(const mode of['cutout-bare','cutout-generic','animated','animated-cutout','reflect-detail','emissive-detail','phong-base-mask']){
  await install(harness,`Source texture ${mode}`,fixture(mode));
  results[mode]=await harness.evaluate(async mode=>{
   const v=window.__view;v.setSourceLighting(true);v.sourceColorMap=false;v.sourceAmbient.linearOutput.value=1;v.setSourceTime(0);
   v.setFlashlight(false);v.setDisplay({...v.getDisplay(),textures:true});
   const camera=v.camera;camera.position.set(0,0,0);camera.quaternion.set(0,0,0,1);camera.fov=60;camera.aspect=1;camera.updateProjectionMatrix();
   const material=[v.terrainMaterials[0].source].flat()[0],map=material.map,canvas=document.createElement('canvas');canvas.width=64;canvas.height=64;const ctx=canvas.getContext('2d');
   const read=()=>{v.renderWith(camera);ctx.clearRect(0,0,64,64);ctx.drawImage(v.renderer.domElement,0,0);return[8,32,56].map(x=>Array.from(ctx.getImageData(x,32,1,1).data))};
   v.beginOffscreen(64,64,{transparent:true,floor:false});const normal=read(),version=material.version;
   v.setDisplay({...v.getDisplay(),textures:false});const gray=read(),mapRetained=material.map===map,sameVersion=material.version===version;
   v.setSourceTime(.5);const next=read();if(mode==='phong-base-mask')v.setFlashlight(true);const lit=read();v.setFlashlight(false);
   v.setDisplay({...v.getDisplay(),textures:true});const restored=read();v.endOffscreen();return{normal,gray,next,lit,restored,mapRetained,sameVersion};
  },mode);
 }
 await harness.close();
 const close=(actual,expected,label)=>{for(let i=0;i<4;i++)assert.ok(Math.abs(actual[i]-expected[i])<=1,`${label}: ${actual} vs ${expected}`)};
 for(const mode of['cutout-bare','cutout-generic']){const r=results[mode];close(r.normal[0],[0,0,0,0],mode+' original hole');close(r.gray[0],[0,0,0,0],mode+' gray hole');close(r.gray[1],[128,128,128,255],mode+' gray center');close(r.restored[1],r.normal[1],mode+' restored')}
 for(const mode of['animated','animated-cutout']){const r=results[mode];close(r.gray[1],mode==='animated'?[128,128,128,255]:[0,0,0,0],mode+' first frame');close(r.next[1],[128,128,128,255],mode+' next gray frame');close(r.restored[1],[0,255,0,255],mode+' latest colored frame')}
 close(results['reflect-detail'].gray[1],[32,16,8,255],'reflection mask');close(results['emissive-detail'].gray[1],[16,8,4,255],'glow mask');close(results['phong-base-mask'].lit[1],[40,20,10,255],'Phong mask');
 assert.ok(Object.values(results).every(r=>r.mapRetained&&r.sameVersion));
 // Real App: install the owned cutout map through the real local-bundle UI, drive the real checkbox,
 // record a take and export it. Native Ghost requests are never substituted.
 const page=await browser.newPage({deviceScaleFactor:1});page.on('pageerror',e=>errors.push(e.message));page.on('console',m=>{if(m.type()==='error'&&/shader|WebGLProgram/.test(m.text()))errors.push(m.text())});
 await page.goto((process.env.BASE_URL||'http://127.0.0.1:5176')+'/?plain&body=stock').then(() => require('./launch-scene.cjs').launchScene(page,{terrain:'flat',controls:true}));
 await readyApp(page);
 await page.locator('#terrain-trigger').click();
 await page.locator('dialog[data-visual-picker="terrain"]').getByRole('button',{name:'Open local map…',exact:true}).click();
 const local=page.locator('dialog[data-local-map="true"]');
 await local.locator('input[type="file"]:visible').setInputFiles({name:'source-texture-toggle.map.zip',mimeType:'application/zip',buffer:bundle(fixture('cutout-bare'),{name:'Source texture toggle fixture'})});
 await local.getByRole('button',{name:'Load map',exact:true}).click();
 await local.waitFor({state:'detached',timeout:180000});
 await readyApp(page,{until:()=>window.__app.view.terrainObject&&window.__app.model.terrain.startsWith('map:local-'),timeout:180000});
 await page.getByText('Render controls',{exact:true}).click();await page.getByLabel('Textures',{exact:true}).uncheck();
 await page.evaluate(()=>window.__app.startRecording());await page.waitForFunction(()=>window.__app.rec?.frames>=10);await page.evaluate(()=>window.__app.stopRecording());await page.waitForFunction(()=>window.__app.timeline.isOpen);
 // Snapshot the live material and map before the actual dialog export, then compare after it completes.
 await page.evaluate(async()=>{const v=window.__app.view;await v.waitForTerrainVisuals();const material=[v.terrainMaterials[0].source].flat()[0];window.__textureLive={material,map:material.map}});
 const exportedGlb=await captureGlb(page,{fps:5,camera:true,floor:false,file:'source-texture-toggle.glb'});
 const exported=await page.evaluate(async()=>{
  const a=window.__app,v=a.view,{material:live,map}=window.__textureLive,blob=window.__exportedGlb;delete window.__textureLive;if(!(blob instanceof Blob))throw new Error('The actual GLB export did not retain its saved Blob.');
  const buffer=await blob.arrayBuffer(),view=new DataView(buffer),length=view.getUint32(12,true),json=JSON.parse(new TextDecoder().decode(new Uint8Array(buffer,20,length))),material=json.materials.find(m=>m.name==='Source texture probe');
  const texture=json.textures[material.pbrMetallicRoughness.baseColorTexture.index],image=json.images[texture.source],slice=json.bufferViews[image.bufferView],bytes=new Uint8Array(buffer,28+length+(slice.byteOffset||0),slice.byteLength);
  return{png:Array.from(bytes),bytes:blob.size,alphaMode:material.alphaMode,cutoff:material.alphaCutoff,liveMaterialRetained:[v.terrainMaterials[0].source].flat()[0]===live,liveMapRetained:live.map===map,textureEnabled:a.explore.getDisplay().textures};
 });
 const image=Buffer.from(exported.png),chunks=[];for(let at=8;at+12<=image.length;){const size=image.readUInt32BE(at),type=image.toString('ascii',at+4,at+8);if(type==='IDAT')chunks.push(image.subarray(at+8,at+8+size));if(type==='IEND')break;at+=size+12}
 const rgba=require('fflate').unzlibSync(Buffer.concat(chunks));assert.deepEqual([...rgba],[0,188,188,188,0,188,188,188,128,188,188,188,255]);
 delete exported.png;assert.equal(exported.alphaMode,'MASK');assert.equal(exported.cutoff,.5);assert.ok(exported.liveMaterialRetained&&exported.liveMapRetained&&!exported.textureEnabled);assert.deepEqual(errors,[]);
 console.log(JSON.stringify({results,exported,exportedGlb,rgba:[...rgba],errors}));
}finally{await browser.close()}})().catch(e=>{console.error(e);process.exitCode=1});
