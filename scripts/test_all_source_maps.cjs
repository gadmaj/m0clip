/** Chromium: select upgraded maps through the real worker and render their native assets. */
const artifactPath=require('./test-artifacts.cjs');
const assert=require('node:assert/strict'),fs=require('node:fs/promises'),path=require('node:path');
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const {readyApp}=require('./attach-ready-app.cjs');
(async()=>{
 const root=path.resolve('public/assets/maps'),index=JSON.parse(await fs.readFile(path.join(root,'index.json'),'utf8'));
 const maps=process.env.MAP_IDS?process.env.MAP_IDS.split(','):index.maps.map(m=>m.id);
 assert.ok(maps.length&&maps.every(id=>index.maps.some(m=>m.id===id)));
 const output=process.env.MAP_CHECK_OUTPUT||artifactPath();
 await fs.mkdir(output,{recursive:true});
 const browser=await chromium.launch({headless:process.env.HEADLESS==='1',executablePath:process.env.CHROMIUM_PATH,args:['--no-sandbox','--ozone-platform=x11']});
 const results=[],errors=[];
 try {
  const page=await browser.newPage({viewport:{width:1280,height:800},deviceScaleFactor:1});
  page.on('pageerror',e=>errors.push(e.message));
  page.on('console',m=>{if(m.type()==='error')console.log('Browser error: '+m.text());if(m.text().startsWith('[physics]'))console.log(m.text());if(m.type()==='error'&&/shader|WebGLProgram/.test(m.text()))errors.push(m.text())});
  await page.goto((process.env.BASE_URL||'http://127.0.0.1:5176')+'/?plain&body=stock').then(() => require('./launch-scene.cjs').launchScene(page));
  // The release chunk stays byte-identical; the real Ready App is attached through CDP.
  await readyApp(page,{timeout:180000});
  for(const id of maps) {
   console.log(`Loading ${id}`);
   const manifest=JSON.parse(await fs.readFile(path.join(root,id,'manifest.json'),'utf8'));
   assert.ok(manifest.props?.restored>0,`${id}: full prop upgrade required`);
   await page.evaluate(async id=>{const a=window.__app;window.__previousMaterials=a.view.sourceMaterials;await a.changeTerrain('map:'+id)},id);
   try { await page.waitForFunction(id=>{
    const overlay=document.querySelector('#overlay'),message=document.querySelector('#overlay-msg');
    if(!overlay.classList.contains('hidden')&&message.dataset.kind==='error')throw new Error(message.textContent);
    const a=window.__app;return a.model?.terrain==='map:'+id&&a.viewModel?.terrain==='map:'+id&&a.view.terrainObject
     &&a.view.mapSource?.id===id&&document.querySelector('#overlay').classList.contains('hidden')&&document.querySelector('#map-loading').hidden;
   },id,{timeout:240000}); }catch(error) {
    const state=await page.evaluate(()=>{const a=window.__app;return{live:a?.model?.terrain,view:a?.viewModel?.terrain,source:a?.view.mapSource?.id,terrain:!!a?.view.terrainObject,overlay:document.querySelector('#overlay')?.outerHTML,mapLoading:document.querySelector('#map-loading')?.outerHTML}});
    console.error(JSON.stringify({map:id,state,errors}));throw error;
   }
   console.log(`Rendering ${id}`);
   const proof=await page.evaluate(async()=>{
    const a=window.__app,v=a.view;await v.waitForTerrainVisuals();v.setSourceTime(0);v.setDisplay({...v.display,robot:false});
    v.beginOffscreen(320,200,{floor:false});v.render();const png=v.renderer.domElement.toDataURL('image/png');v.endOffscreen();
    const native=[...v.sourceMaterials.resources].filter(t=>t.isTexture&&!t.isCubeTexture&&t.userData.sourceNativeTexture);
    const identity=m=>JSON.stringify([m.path,m.frame,m.face]);
    const expected=new Set([...v.sourceMaterials.resources].filter(t=>t.isTexture&&t.userData.sourceVtf).map(t=>identity(t.userData.sourceVtf)));
    const restored=new Set(native.map(t=>identity(t.userData.sourceNativeTexture)));
    const meshes=[];v.terrainObject.traverse(o=>{if(o.isMesh)meshes.push(o)});
    return {terrain:a.model.terrain,sourceColor:v.sourceColorMap,antialiasing:v.sourceColor.antialiasing,
     near:v.camera.near,infinite:v.camera.far===Infinity,fog:v.scene.fog,toneMapping:v.renderer.toneMapping,
     addedLights:v.hemi.visible||v.sun.visible||v.fill.visible,previousDisposed:window.__previousMaterials.resources.size===0,
     nativeTextures:native.length,mipLevels:native.reduce((n,t)=>n+t.mipmaps.length,0),
     missingNative:[...expected].filter(key=>!restored.has(key)),
     sky:v.sourceSky.length,sprites:v.sourceSprites.length,details:v.sourceDetails.reduce((n,m)=>n+(m.isInstancedMesh?m.count:1),0),detailDraws:v.sourceDetails.length,sky3d:!!v.sourceSky3D,
     gradingLayers:v.sourceColor.layers.length,gradingWeights:v.sourceColor.weights,
     pvs:!!v.sourceVisibility,meshes:meshes.length,programs:v.renderer.info.programs.length,png};
   });
   assert.ok(proof.sourceColor&&proof.infinite&&proof.pvs&&proof.previousDisposed,JSON.stringify(proof));
   assert.equal(proof.near,.127);assert.equal(proof.antialiasing,'fxaa');assert.equal(proof.fog,null);assert.equal(proof.toneMapping,0);assert.equal(proof.addedLights,false);
   assert.ok(proof.nativeTextures>0&&proof.mipLevels>proof.nativeTextures&&proof.meshes>0&&proof.programs>1);
   assert.deepEqual(proof.missingNative,[]);
   assert.equal(proof.sky,manifest.props.sky_faces);assert.equal(proof.sprites,manifest.props.sprites);assert.equal(proof.details,manifest.props.detail_sprites);
   assert.equal(proof.gradingLayers,manifest.color_corrections?.length??0);
   const bytes=Buffer.from(proof.png.split(',')[1],'base64');delete proof.png;
   await fs.writeFile(path.join(output,id+'.png'),bytes);
   const {PNG}=require(path.resolve(process.env.NOCLIP_REFERENCE||'../noclip.website','node_modules/pngjs'));
   const pixels=PNG.sync.read(bytes),colors=new Set();for(let i=0;i<pixels.data.length;i+=4)colors.add(pixels.data.readUInt32LE(i));
   assert.ok(colors.size>100,`${id}: rendered image must contain map detail`);
   results.push({id,...proof,colors:colors.size});
   await fs.writeFile(path.join(output,'report.json'),JSON.stringify({results,errors},null,2)+'\n');
   console.log(JSON.stringify(results.at(-1)));
  }
  await page.evaluate(async()=>{const v=window.__app.view,previous=v.sourceMaterials;await v.setTerrainVisual(null);if(previous.resources.size||v.sourceColor.target||v.sourceColor.gammaTarget)throw new Error('Map GPU resources were retained')});
  assert.deepEqual(errors,[]);console.log(JSON.stringify({maps:results.length,cleanup:true,errors}));
 }finally{await browser.close()}
})().catch(e=>{console.error(e);process.exitCode=1});
