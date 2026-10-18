/** Chromium: geometry beyond 100m survives live, shot, PNG and animated glTF cameras. */
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright'),assert=require('node:assert/strict'),fs=require('node:fs');
const positions=new Float32Array([-30,150,-30,30,150,-30,30,150,30,-30,150,-30,30,150,30,-30,150,30]);
const fixture={asset:{version:'2.0'},scene:0,scenes:[{nodes:[0]}],nodes:[{mesh:0}],
 buffers:[{uri:'data:application/octet-stream;base64,'+Buffer.from(positions.buffer).toString('base64'),byteLength:positions.byteLength}],bufferViews:[{buffer:0,byteLength:positions.byteLength}],
 accessors:[{bufferView:0,componentType:5126,count:6,type:'VEC3',min:[-30,150,-30],max:[30,150,30]}],meshes:[{primitives:[{attributes:{POSITION:0},material:0}]}],
 materials:[{pbrMetallicRoughness:{baseColorFactor:[1,0,0,1]},extras:{sourceVertexLighting:1,sourceUnlit:true}}]};
(async()=>{const browser=await chromium.launch({headless:false,args:['--no-sandbox','--ozone-platform=x11']});try{
 const page=await browser.newPage({deviceScaleFactor:.25}),errors=[];page.on('pageerror',e=>errors.push(e.message));page.on('console',m=>{if(m.type()==='error'&&/shader|WebGLProgram/.test(m.text()))errors.push(m.text())});
 const expose=source=>source.replace('new App();','window.__app=new App();').replace(/new ([A-Za-z_$][\w$]*);export\{/,'window.__app=new $1;export{').replaceAll('this.renderLoop()','void 0');
 for(const pattern of['**/src/main.ts*','**/assets/main-*.js'])await page.route(pattern,async route=>{const response=await route.fetch();await route.fulfill({response,body:expose(await response.text())})});
 const manifest=JSON.parse(fs.readFileSync('public/assets/maps/nt_ghost_ctg/manifest.json'));delete manifest.props;delete manifest.visibility;
 await page.route('**/nt_ghost_ctg/visual.glb',route=>route.fulfill({contentType:'model/gltf+json',body:JSON.stringify(fixture)}));
 await page.route('**/nt_ghost_ctg/manifest.json',route=>route.fulfill({json:manifest}));
 for(const file of ['lighting.json','lightstyles.json'])await page.route('**/nt_ghost_ctg/'+file,route=>route.fulfill({status:404,body:''}));
 await page.goto((process.env.BASE_URL||'http://127.0.0.1:5176')+'/?plain&map=nt_ghost_ctg&body=stock');
 await page.waitForFunction(()=>window.__app?.lastFrame&&window.__app.view.terrainObject&&document.querySelector('#overlay').classList.contains('hidden'),null,{timeout:180000});
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
 assert.equal(proof.terrain,'map:nt_ghost_ctg');assert.deepEqual(proof.clipped,[0,0,0,0]);assert.deepEqual(proof.live,[255,0,0,255]);assert.deepEqual(proof.exported,[255,0,0,255]);assert.ok(proof.planes.every(p=>p.near===.127&&p.infinite&&p.finiteMatrix));
 await page.evaluate(()=>window.__app.startRecording());await page.waitForFunction(()=>window.__app.rec?.frames>=10);await page.evaluate(()=>window.__app.stopRecording());await page.waitForFunction(()=>window.__app.timeline.isOpen);
 await page.evaluate(()=>{const a=window.__app;a.shot.mode='viewport';a.shot.smooth=0;a.rebuildShot()});
 const gltf=await page.evaluate(async()=>{const a=window.__app,blob=await a.dialog.host.glb(5,true,false),buffer=await blob.arrayBuffer(),view=new DataView(buffer),length=view.getUint32(12,true),json=JSON.parse(new TextDecoder().decode(new Uint8Array(buffer,20,length)));return{bytes:blob.size,camera:json.cameras[0].perspective,keys:json.animations[0].channels.filter(c=>json.nodes[c.target.node].name==='shot_camera').length}});
 assert.equal(gltf.camera.znear,.127);assert.ok(!Object.hasOwn(gltf.camera,'zfar'));assert.ok(gltf.bytes>1000&&gltf.keys>=2);
 const video=await page.evaluate(async()=>{
  const a=window.__app,d=a.dialog;Object.assign(d.out,{res:'custom',width:96,height:64,fps:5,speed:1,container:'png',transparent:true,floor:false});a.openExport('video');const range=d.host.range,save=d.host.save;let blob;d.host.range=()=>[0,.2];d.host.save=b=>{blob=b};
  try{await d.renderVideoJob();if(!blob)throw new Error(d.status.textContent);return Array.from(new Uint8Array(await blob.arrayBuffer()))}finally{d.host.range=range;d.host.save=save}
 });
 const files=require('fflate').unzipSync(new Uint8Array(video)),png=Object.values(files)[0];
 const pngPixel=await page.evaluate(async bytes=>{const bitmap=await createImageBitmap(new Blob([new Uint8Array(bytes)],{type:'image/png'})),canvas=document.createElement('canvas');canvas.width=96;canvas.height=64;const ctx=canvas.getContext('2d');ctx.drawImage(bitmap,0,0);bitmap.close();return Array.from(ctx.getImageData(48,32,1,1).data)},Array.from(png));assert.deepEqual(pngPixel,[255,0,0,255]);
 const reset=await page.evaluate(async()=>{const a=window.__app,v=a.view;await v.setTerrainVisual(null);v.renderWith(a.exportCam);v.renderFramed(a.shotCam,1.5);return[v.camera,a.shotCam,a.exportCam].map(c=>[c.near,c.far])});assert.deepEqual(reset,[[.05,100],[.05,100],[.05,100]]);
 assert.deepEqual(errors,[]);console.log(JSON.stringify({...proof,gltf,pngPixel,reset,errors}));
}finally{await browser.close()}})().catch(e=>{console.error(e);process.exitCode=1});
