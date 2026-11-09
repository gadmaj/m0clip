/** Chromium: geometry beyond 100m survives live, shot, PNG and animated glTF cameras. */
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright'),assert=require('node:assert/strict'),{readyApp}=require('./attach-ready-app.cjs'),{bundle}=require('./source_map_fixture.cjs'),captureGlb=require('./capture-glb.cjs');
const positions=new Float32Array([-30,150,-30,30,150,-30,30,150,30,-30,150,-30,30,150,30,-30,150,30]);
const fixture={asset:{version:'2.0'},scene:0,scenes:[{nodes:[0]}],nodes:[{mesh:0}],
 buffers:[{uri:'data:application/octet-stream;base64,'+Buffer.from(positions.buffer).toString('base64'),byteLength:positions.byteLength}],bufferViews:[{buffer:0,byteLength:positions.byteLength}],
 accessors:[{bufferView:0,componentType:5126,count:6,type:'VEC3',min:[-30,150,-30],max:[30,150,30]}],meshes:[{primitives:[{attributes:{POSITION:0},material:0}]}],
 materials:[{pbrMetallicRoughness:{baseColorFactor:[1,0,0,1]},extras:{sourceVertexLighting:1,sourceUnlit:true}}]};
(async()=>{const browser=await chromium.launch({headless:process.env.HEADLESS==='1',executablePath:process.env.CHROMIUM_PATH,args:['--no-sandbox','--ozone-platform=x11']});try{
 const page=await browser.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));page.on('console',m=>{if(m.type()==='error'&&/shader|WebGLProgram/.test(m.text()))errors.push(m.text())});
 await page.goto((process.env.BASE_URL||'http://127.0.0.1:5176')+'/?plain&body=stock').then(() => require('./launch-scene.cjs').launchScene(page,{terrain:'flat',controls:true}));
 // Use real bundle verification/installation instead of corrupting native map receipts.
 await readyApp(page);
 const originalPlanes=await page.evaluate(()=>{const a=window.__app;return[a.view.camera,a.shotCam,a.exportCam].map(c=>[c.near,c.far])});
 await page.locator('#terrain-trigger').click();
 await page.locator('dialog[data-visual-picker="terrain"]').getByRole('button',{name:'Open local map…',exact:true}).click();
 const local=page.locator('dialog[data-local-map="true"]');
 await local.locator('input[type="file"]:visible').setInputFiles({name:'source-camera.map.zip',mimeType:'application/zip',buffer:bundle(fixture,{name:'Source camera fixture',manifest:{source_renderer:{version:1,color:'ldr-gamma-lut',antialiasing:'fxaa'}}})});
 await local.getByRole('button',{name:'Load map',exact:true}).click();
 await local.waitFor({state:'detached',timeout:180000});
 await readyApp(page,{until:()=>window.__app.view.terrainObject&&window.__app.model.terrain.startsWith('map:local-'),timeout:180000});
 const proof=await page.evaluate(()=>{
  const a=window.__app,v=a.view,camera=v.camera;v.setDisplay({...v.display,robot:false});
  camera.position.set(0,0,0);camera.up.set(0,0,1);v.controls.target.set(0,150,0);camera.lookAt(v.controls.target);camera.aspect=1.5;camera.fov=60;camera.updateProjectionMatrix();
  const PerspectiveCamera=Object.getPrototypeOf(camera.constructor),old=new PerspectiveCamera(60,1.5,.05,100);old.position.copy(camera.position);old.quaternion.copy(camera.quaternion);
  const pixel=()=>{const canvas=document.createElement('canvas');canvas.width=96;canvas.height=64;const ctx=canvas.getContext('2d');ctx.drawImage(v.renderer.domElement,0,0,96,64);return Array.from(ctx.getImageData(48,32,1,1).data)};
  v.beginOffscreen(96,64,{transparent:true,floor:false});v.renderWith(old);const clipped=pixel();v.render();const live=pixel();
  a.exportCam.position.copy(camera.position);a.exportCam.quaternion.copy(camera.quaternion);a.exportCam.aspect=1.5;a.exportCam.fov=60;a.exportCam.updateProjectionMatrix();v.renderWith(a.exportCam);const exported=pixel();v.endOffscreen();
  a.shotCam.position.copy(camera.position);a.shotCam.quaternion.copy(camera.quaternion);a.shotCam.aspect=1.5;a.shotCam.fov=60;a.shotCam.updateProjectionMatrix();v.renderFramed(a.shotCam,1.5);
  return{terrain:a.model.terrain,clipped,live,exported,planes:[camera,a.shotCam,a.exportCam].map(c=>({near:c.near,infinite:c.far===Infinity,finiteMatrix:c.projectionMatrix.elements.every(Number.isFinite)}))};
 });
 assert.match(proof.terrain,/^map:local-[a-f0-9]{64}$/);assert.deepEqual(proof.clipped,[0,0,0,0]);assert.deepEqual(proof.live,[255,0,0,255]);assert.deepEqual(proof.exported,[255,0,0,255]);assert.ok(proof.planes.every(p=>Number.isFinite(p.near)&&p.near>0&&p.infinite&&p.finiteMatrix));
 await page.evaluate(()=>window.__app.startRecording());await page.waitForFunction(()=>window.__app.rec?.frames>=10);await page.evaluate(()=>window.__app.stopRecording());await page.waitForFunction(()=>window.__app.timeline.isOpen);
 await page.evaluate(()=>{const a=window.__app;a.shot.mode='viewport';a.shot.smooth=0;a.rebuildShot()});
 const exportedGlb=await captureGlb(page,{fps:5,camera:true,floor:false,file:'source-camera-runtime.glb'});
 const gltf=await page.evaluate(async()=>{const blob=window.__exportedGlb;if(!(blob instanceof Blob))throw new Error('The actual export dialog did not save a GLB.');const buffer=await blob.arrayBuffer(),view=new DataView(buffer),length=view.getUint32(12,true),json=JSON.parse(new TextDecoder().decode(new Uint8Array(buffer,20,length)));return{bytes:blob.size,camera:json.cameras[0].perspective,keys:json.animations[0].channels.filter(c=>json.nodes[c.target.node].name==='shot_camera').length}});
 assert.ok(Number.isFinite(gltf.camera.znear)&&gltf.camera.znear>0);assert.ok(!Object.hasOwn(gltf.camera,'zfar'));assert.ok(gltf.keys>=2);
 const video=await page.evaluate(async()=>{
  const a=window.__app,d=a.dialog;Object.assign(d.out,{res:'custom',width:96,height:64,fps:5,speed:1,container:'png',transparent:true,floor:false});a.openExport('video');const range=d.host.range,save=d.host.save;let blob;d.host.range=()=>[0,.2];d.host.save=b=>{blob=b};
  try{await d.renderVideoJob();if(!blob)throw new Error(d.status.textContent);return Array.from(new Uint8Array(await blob.arrayBuffer()))}finally{d.host.range=range;d.host.save=save}
 });
 const files=require('fflate').unzipSync(new Uint8Array(video)),png=Object.values(files)[0];
 const pngPixel=await page.evaluate(async bytes=>{const bitmap=await createImageBitmap(new Blob([new Uint8Array(bytes)],{type:'image/png'})),canvas=document.createElement('canvas');canvas.width=96;canvas.height=64;const ctx=canvas.getContext('2d');ctx.drawImage(bitmap,0,0);bitmap.close();return Array.from(ctx.getImageData(48,32,1,1).data)},Array.from(png));assert.deepEqual(pngPixel,[255,0,0,255]);
 const reset=await page.evaluate(async()=>{const a=window.__app,v=a.view;await v.setTerrainVisual(null);v.renderWith(a.exportCam);v.renderFramed(a.shotCam,1.5);return[v.camera,a.shotCam,a.exportCam].map(c=>[c.near,c.far])});assert.deepEqual(reset,originalPlanes);
 assert.deepEqual(errors,[]);console.log(JSON.stringify({...proof,gltf,exportedGlb,pngPixel,reset,errors}));
}finally{await browser.close()}})().catch(e=>{console.error(e);process.exitCode=1});
