/** Chromium pixels: Source projected lighting and independent native masks. */
const assert=require('node:assert/strict'),{chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const {fixture,png}=require('./source_material_fixture.cjs');
(async()=>{const browser=await chromium.launch({headless:false,args:['--no-sandbox','--ozone-platform=x11']});try{
 const page=await browser.newPage({deviceScaleFactor:.25}),errors=[];page.on('pageerror',e=>errors.push(e.message));page.on('console',m=>{if(m.type()==='error'&&/shader|WebGLProgram/.test(m.text()))errors.push(m.text())});
 const expose=source=>require('./expose-app.cjs')(source).replaceAll('this.renderLoop()','void 0');
 for(const pattern of['**/src/main.ts*','**/assets/main-*.js'])await page.route(pattern,async route=>{const response=await route.fetch();await route.fulfill({response,body:expose(await response.text())})});
 await page.addInitScript(()=>localStorage.setItem('ume-prefs',JSON.stringify({robot:'r1',terrain:'flat'})));
 await page.route('**/assets/source/flashlight.png',route=>route.fulfill({contentType:'image/png',body:png([64,64,64,255])}));
 await page.goto((process.env.BASE_URL||'http://127.0.0.1:5176')+'/?plain&body=stock').then(() => require('./launch-scene.cjs').launchScene(page));await page.waitForFunction(()=>window.__app?.lastFrame&&window.__app.view.flashlight.ready,null,{timeout:120000});
 let mode='flat';await page.route('**/nt_ghost_ctg/visual.glb*',route=>route.fulfill({contentType:'model/gltf+json',body:JSON.stringify(fixture(mode))}));
 await page.route('**/nt_ghost_ctg/manifest.json',route=>route.fulfill({json:{}}));for(const file of['lighting.json','lightstyles.json'])await page.route('**/nt_ghost_ctg/'+file,route=>route.fulfill({status:404,body:''}));
 const results={};
 for(mode of['flat','world','sideways','frame-positive','frame-negative','bump-flat','bump-tilted','bump-disabled','phong','phong-point-falloff','phong-spot-falloff','phong-interpolated-falloff','phong-specular-falloff','phong-skinned-falloff','phong-masked','phong-base-mask','phong-mask-invert','phong-albedo','phong-exponent','emissive-full','emissive-partial','unlit','reflect-base','reflect-detail','reflect-detail-clear','reflect-secondary','reflect-cutout-detail','reflect-cutout-detail-clear','emissive-detail','phong-detail']){
  results[mode]=await page.evaluate(async mode=>{
   const v=window.__app.view;await v.setTerrainVisual('/assets/maps/nt_ghost_ctg/visual.glb?probe='+mode);v.setDisplay({...v.display,robot:false});v.setSourceLighting(true);
   // Read linear pixels directly, excluding the independently tested final color LUT.
   v.sourceColorMap=false;v.sourceAmbient.linearOutput.value=1;v.flashlight.cookie.value.colorSpace='';v.flashlight.cookie.value.needsUpdate=true;
   const camera=v.camera;camera.position.set(0,0,0);camera.quaternion.set(0,0,0,1);camera.aspect=1;camera.fov=60;camera.updateProjectionMatrix();
   const canvas=document.createElement('canvas');canvas.width=64;canvas.height=64;const ctx=canvas.getContext('2d');const read=()=>{ctx.clearRect(0,0,64,64);ctx.drawImage(v.renderer.domElement,0,0);return Array.from(ctx.getImageData(32,32,1,1).data)};
   v.beginOffscreen(64,64,{transparent:true,floor:false});v.setFlashlight(false);v.renderWith(camera);const off=read();v.setFlashlight(true);v.renderWith(camera);const on=read();
   let occluded,moved;
   if(mode==='phong'){
    let mesh;v.terrainObject.traverse(o=>{if(o.isMesh)mesh=o});const blocker=mesh.clone(false);blocker.position.z=1;v.scene.add(blocker);v.flashlight.renderDepth(v.renderer,v.scene,camera);blocker.visible=false;v.renderer.render(v.scene,camera);occluded=read();v.scene.remove(blocker);
   }
   if(mode==='phong-skinned-falloff'){
    let mesh;v.terrainObject.traverse(o=>{if(o.isSkinnedMesh)mesh=o});mesh.skeleton.bones[0].position.z=-2;
    v.setFlashlight(false);v.renderWith(camera);moved=read();
   }
   v.endOffscreen();v.setFlashlight(false);return{off,on,...occluded?{occluded}:{},...moved?{moved}:{}};
  },mode);
 }
 const close=(actual,expected,label)=>{for(let c=0;c<3;c++)assert.ok(Math.abs(actual[c]-expected[c])<=2,`${label}: ${actual} vs ${expected}`);assert.equal(actual[3],255)};
 close(results.flat.off,[0,0,0],'flat off');close(results.flat.on,[16,8,4],'diffuse');close(results.world.on,[16,8,4],'lightmapped diffuse');close(results.sideways.on,[0,0,0],'normal map');
 close(results['frame-positive'].on,[0,0,0],'authored positive handedness');close(results['frame-negative'].on,[15,8,4],'authored negative handedness');
 close(results['bump-flat'].off,[42,21,10],'directional brush layers');close(results['bump-tilted'].off,[72,0,0],'Source saturated bump weights');close(results['bump-disabled'].off,[0,0,0],'disabled diffuse bump lighting');
 close(results['phong-point-falloff'].off,[16,8,4],'vertex point attenuation');close(results['phong-spot-falloff'].off,[6,3,1],'vertex spotlight cone');close(results['phong-interpolated-falloff'].off,[17,8,4],'interpolated unequal vertex attenuation');close(results['phong-specular-falloff'].off,[16,8,4],'per-pixel specular attenuation');
 close(results['phong-skinned-falloff'].off,[16,8,4],'bind-pose falloff');close(results['phong-skinned-falloff'].moved,[8,4,2],'falloff follows the skinned pose');
 close(results.phong.on,[80,40,20],'Phong without world Fresnel');close(results['phong-masked'].on,[16,8,4],'Phong mask');close(results.phong.occluded,[0,0,0],'shadowed Phong');
 close(results['phong-base-mask'].on,[48,24,12],'base-alpha mask');close(results['phong-mask-invert'].on,[16,8,4],'inverted mask');close(results['phong-albedo'].on,[64,48,40],'albedo tint');close(results['phong-exponent'].on,[27,14,7],'exponent map');
 close(results['emissive-full'].on,[64,32,16],'self illumination');assert.deepEqual(results['emissive-full'].on,results['emissive-full'].off);
 close(results['emissive-partial'].off,[32,16,8],'masked emission off');close(results['emissive-partial'].on,[40,20,10],'masked emission on');assert.deepEqual(results.unlit.on,results.unlit.off);
 for(const mode of['reflect-base','reflect-detail','reflect-detail-clear','reflect-secondary','reflect-cutout-detail'])close(results[mode].off,[32,16,8],mode);
 assert.deepEqual(results['reflect-cutout-detail-clear'].off,[0,0,0,0]);
 close(results['emissive-detail'].off,[32,16,8],'detail glow mask');close(results['emissive-detail'].on,[40,20,10],'detail glow and projection');close(results['phong-detail'].on,[48,24,12],'detail Phong mask');
 assert.deepEqual(errors,[]);console.log(JSON.stringify({results,errors}));
}finally{await browser.close()}})().catch(e=>{console.error(e);process.exitCode=1});
