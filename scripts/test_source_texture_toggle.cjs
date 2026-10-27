/** Chromium: diffuse-only mode preserves alpha, masks, animation and lossless exports. */
const{chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright'),assert=require('node:assert/strict'),fs=require('node:fs');
const{fixture,png}=require('./source_material_fixture.cjs');
(async()=>{const browser=await chromium.launch({headless:false,args:['--no-sandbox','--ozone-platform=x11']});try{
 const page=await browser.newPage({deviceScaleFactor:.25}),errors=[];page.on('pageerror',e=>errors.push(e.message));page.on('console',m=>{if(m.type()==='error'&&/shader|WebGLProgram/.test(m.text()))errors.push(m.text())});
 const expose=source=>require('./expose-app.cjs')(source).replaceAll('this.renderLoop()','void 0');
 for(const pattern of['**/src/main.ts*','**/assets/main-*.js'])await page.route(pattern,async route=>{const response=await route.fetch();await route.fulfill({response,body:expose(await response.text())})});
 await page.addInitScript(()=>localStorage.setItem('ume-prefs',JSON.stringify({robot:'r1',terrain:'flat'})));
 await page.route('**/assets/source/flashlight.png',route=>route.fulfill({contentType:'image/png',body:png([64,64,64,255])}));
 let mode='cutout-bare';await page.route('**/nt_ghost_ctg/visual.glb*',route=>route.fulfill({contentType:'model/gltf+json',body:JSON.stringify(fixture(mode))}));
 const manifest=JSON.parse(fs.readFileSync('public/assets/maps/nt_ghost_ctg/manifest.json'));delete manifest.props;delete manifest.visibility;
 await page.route('**/nt_ghost_ctg/manifest.json',route=>route.fulfill({json:manifest}));for(const file of['lighting.json','lightstyles.json'])await page.route('**/nt_ghost_ctg/'+file,route=>route.fulfill({status:404,body:''}));
 const base=process.env.BASE_URL||'http://127.0.0.1:5176';await page.goto(base+'/?plain&body=stock').then(() => require('./launch-scene.cjs').launchScene(page, { controls: true }));await page.waitForFunction(()=>window.__app?.lastFrame&&window.__app.view.flashlight.ready,null,{timeout:120000});
 const results={};
 for(mode of['cutout-bare','cutout-generic','animated','animated-cutout','reflect-detail','emissive-detail','phong-base-mask']){
  results[mode]=await page.evaluate(async mode=>{
   const a=window.__app,v=a.view;await v.setTerrainVisual(null);await v.setTerrainVisual(window.__app.sourceForTerrain('map:nt_ghost_ctg'));v.setSourceLighting(true);v.sourceColorMap=false;v.sourceAmbient.linearOutput.value=1;v.setSourceTime(0);
   v.flashlight.cookie.value.colorSpace='';v.flashlight.cookie.value.needsUpdate=true;v.setFlashlight(false);a.explore.setDisplay({...a.explore.getDisplay(),textures:true,robot:false});
   const camera=v.camera;camera.position.set(0,0,0);camera.quaternion.set(0,0,0,1);camera.fov=60;camera.aspect=1;camera.updateProjectionMatrix();
   const material=[v.terrainMaterials[0].source].flat()[0],map=material.map,canvas=document.createElement('canvas');canvas.width=64;canvas.height=64;const ctx=canvas.getContext('2d');
   const read=()=>{v.renderWith(camera);ctx.clearRect(0,0,64,64);ctx.drawImage(v.renderer.domElement,0,0);return[8,32,56].map(x=>Array.from(ctx.getImageData(x,32,1,1).data))};
   v.beginOffscreen(64,64,{transparent:true,floor:false});const normal=read(),version=material.version;
   a.explore.setDisplay({...a.explore.getDisplay(),textures:false});const gray=read(),mapRetained=material.map===map,sameVersion=material.version===version;
   v.setSourceTime(.5);const next=read();if(mode==='phong-base-mask')v.setFlashlight(true);const lit=read();v.setFlashlight(false);
   a.explore.setDisplay({...a.explore.getDisplay(),textures:true});const restored=read();v.endOffscreen();return{normal,gray,next,lit,restored,mapRetained,sameVersion};
  },mode);
 }
 const close=(actual,expected,label)=>{for(let i=0;i<4;i++)assert.ok(Math.abs(actual[i]-expected[i])<=1,`${label}: ${actual} vs ${expected}`)};
 for(const mode of['cutout-bare','cutout-generic']){const r=results[mode];close(r.normal[0],[0,0,0,0],mode+' original hole');close(r.gray[0],[0,0,0,0],mode+' gray hole');close(r.gray[1],[128,128,128,255],mode+' gray center');close(r.restored[1],r.normal[1],mode+' restored')}
 for(const mode of['animated','animated-cutout']){const r=results[mode];close(r.gray[1],mode==='animated'?[128,128,128,255]:[0,0,0,0],mode+' first frame');close(r.next[1],[128,128,128,255],mode+' next gray frame');close(r.restored[1],[0,255,0,255],mode+' latest colored frame')}
 close(results['reflect-detail'].gray[1],[32,16,8,255],'reflection mask');close(results['emissive-detail'].gray[1],[16,8,4,255],'glow mask');close(results['phong-base-mask'].lit[1],[40,20,10,255],'Phong mask');
 assert.ok(Object.values(results).every(r=>r.mapRetained&&r.sameVersion));
 // Drive the real checkbox, record a take in Ghost and export the diagnostic map.
 mode='cutout-bare';await page.goto(base+'/?plain&map=nt_ghost_ctg&body=stock').then(() => require('./launch-scene.cjs').launchScene(page, { controls: true }));await page.waitForFunction(()=>window.__app?.lastFrame&&window.__app.view.terrainObject&&document.querySelector('#overlay').classList.contains('hidden'),null,{timeout:180000});
 await page.getByText('Render controls',{exact:true}).click();await page.getByLabel('Textures',{exact:true}).uncheck();
 await page.evaluate(()=>window.__app.startRecording());await page.waitForFunction(()=>window.__app.rec?.frames>=10);await page.evaluate(()=>window.__app.stopRecording());await page.waitForFunction(()=>window.__app.timeline.isOpen);
 const exported=await page.evaluate(async()=>{
  const a=window.__app,v=a.view;await v.waitForTerrainVisuals();const live=[v.terrainMaterials[0].source].flat()[0],map=live.map;
  const blob=await a.dialog.host.glb(5,true,false),buffer=await blob.arrayBuffer(),view=new DataView(buffer),length=view.getUint32(12,true),json=JSON.parse(new TextDecoder().decode(new Uint8Array(buffer,20,length))),material=json.materials.find(m=>m.name==='Source texture probe');
  const texture=json.textures[material.pbrMetallicRoughness.baseColorTexture.index],image=json.images[texture.source],slice=json.bufferViews[image.bufferView],bytes=new Uint8Array(buffer,28+length+(slice.byteOffset||0),slice.byteLength);
  return{png:Array.from(bytes),bytes:blob.size,alphaMode:material.alphaMode,cutoff:material.alphaCutoff,liveMapRetained:live.map===map,textureEnabled:a.explore.getDisplay().textures};
 });
 const image=Buffer.from(exported.png),chunks=[];for(let at=8;at+12<=image.length;){const size=image.readUInt32BE(at),type=image.toString('ascii',at+4,at+8);if(type==='IDAT')chunks.push(image.subarray(at+8,at+8+size));if(type==='IEND')break;at+=size+12}
 const rgba=require('fflate').unzlibSync(Buffer.concat(chunks));assert.deepEqual([...rgba],[0,188,188,188,0,188,188,188,128,188,188,188,255]);
 delete exported.png;assert.equal(exported.alphaMode,'MASK');assert.equal(exported.cutoff,.5);assert.ok(exported.liveMapRetained&&!exported.textureEnabled);assert.deepEqual(errors,[]);
 console.log(JSON.stringify({results,exported,rgba:[...rgba],errors}));
}finally{await browser.close()}})().catch(e=>{console.error(e);process.exitCode=1});
