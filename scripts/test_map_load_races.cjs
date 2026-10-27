/** Chromium regression: concurrent loads of one map source retain only the current scene. */
const assert=require('node:assert/strict');
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const {buildSync}=require('esbuild');
const pngModule={exports:{}};
new Function('module','exports','require',buildSync({entryPoints:['src/record/png.ts'],bundle:true,platform:'node',format:'cjs',write:false}).outputFiles[0].text)(pngModule,pngModule.exports,require);
const png=Buffer.from(pngModule.exports.encodeRgbaPNG(1,1,new Uint8Array([255,160,40,255])));
const base=process.env.BASE_URL||'http://127.0.0.1:5176';
// Use the actual loader and Source material conversion with a small glTF fixture.
function fixture(id){
 const positions=new Float32Array([0,0,0,1,0,0,0,1,0]);
 return {asset:{version:'2.0'},scene:0,scenes:[{nodes:[0,1,2,3],extras:{loadGeneration:id}}],
  nodes:[{mesh:0},{mesh:0,extras:{sourceSky:true}},{mesh:0,extras:{sourceSprite:true}},{mesh:0,extras:{sourceDetail:true}}],
  buffers:[{uri:'data:application/octet-stream;base64,'+Buffer.from(positions.buffer).toString('base64'),byteLength:36}],
  bufferViews:[{buffer:0,byteLength:36}],accessors:[{bufferView:0,componentType:5126,count:3,type:'VEC3',min:[0,0,0],max:[1,1,0]}],
  meshes:[{primitives:[{attributes:{POSITION:0},material:0}]}],
  materials:[{extras:{sourceVertexLighting:1,sourceUnlit:true,sourceMaterial:{shader:'unlitgeneric',unlit:true,animationfps:2,animationFrames:[0,1]}}}],
  textures:[{source:0},{source:1}],images:[{uri:'base-'+id+'.png'},{uri:'frame-'+id+'.png'}]};
}
(async()=>{
 const browser=await chromium.launch({headless:false,executablePath:process.env.CHROMIUM_PATH||undefined,args:['--no-sandbox','--ozone-platform=x11']});
 try{
  const page=await browser.newPage({deviceScaleFactor:.25}),errors=[];page.on('pageerror',e=>errors.push(e.message));
  for(const pattern of ['**/src/main.ts*','**/assets/main-*.js'])await page.route(pattern,async route=>{
   const response=await route.fetch();await route.fulfill({response,body:require('./expose-app.cjs')(await response.text())});
  });
  await page.addInitScript(()=>localStorage.setItem('ume-prefs',JSON.stringify({robot:'r1',terrain:'flat'})));
  if(process.env.DIRECT_SCENE){
   await page.route('**/__map-race-test',route=>route.fulfill({contentType:'text/html',body:'<style>html,body,#view{width:100%;height:100%;margin:0}</style><div id="view"></div><script type="module">import {SceneView} from "/src/render/scene.ts";import {mapSource} from "/src/maps/source.ts";window.__app={view:new SceneView(document.querySelector("#view")),sourceForTerrain:mapSource};</script>'}));
   await page.goto(base+'/__map-race-test');await page.waitForFunction(()=>window.__app?.view);
  }else{
   await page.goto(base+'/?plain&body=stock');
   await require('./launch-scene.cjs').launchScene(page);
   await page.waitForFunction(()=>window.__app?.lastFrame&&document.querySelector('#overlay').classList.contains('hidden'),null,{timeout:120000});
  }
  let request=0,holdWorld=false,holdFrame=false,fail=false,rejectCurrent=false,held,notifyHeld;
  let waiting=new Promise(resolve=>notifyHeld=resolve);
  await page.route('**/nt_ghost_ctg/**',async route=>{
   const path=new URL(route.request().url()).pathname;
   if(path.endsWith('/visual.glb')){
    const id=++request;
    if(holdWorld){holdWorld=false;held=()=>route.fulfill({contentType:'model/gltf+json',body:JSON.stringify(fixture(id))});notifyHeld();return}
    return route.fulfill({contentType:'model/gltf+json',body:JSON.stringify(fixture(id))});
   }
   if(path.endsWith('/manifest.json'))return route.fulfill({json:{}});
   if(path.endsWith('/lighting.json')||path.endsWith('/lightstyles.json'))return route.fulfill({status:404,body:''});
   if(path.includes('/frame-')&&rejectCurrent){rejectCurrent=false;return route.fulfill({status:404,body:''})}
   if(path.includes('/frame-')&&holdFrame){holdFrame=false;held=()=>fail?route.fulfill({status:404,body:''}):route.fulfill({contentType:'image/png',body:png});notifyHeld();return}
   return route.fulfill({contentType:'image/png',body:png});
  });
  const proofs=[];
  for(const mode of ['world','texture','failed-texture']){
   waiting=new Promise(resolve=>notifyHeld=resolve);holdWorld=mode==='world';holdFrame=mode!=='world';fail=mode==='failed-texture';
   await page.evaluate(()=>{
    const v=window.__app.view;
    window.__oldLoad=v.setTerrainVisual(window.__app.sourceForTerrain('map:nt_ghost_ctg'));window.__oldLoad.catch(()=>{});
    window.__oldContext=v.sourceMaterials;window.__oldScene=v.terrainObject;
   });
   await Promise.race([waiting,new Promise((_,reject)=>{const timeout=setTimeout(()=>reject(new Error('Fixture did not reach '+mode+' gate')),30000);timeout.unref()})]);
   assert.ok(await page.evaluate(()=>window.__app.view.terrainObject===window.__oldScene),'Preparing a map must keep the active scene installed');
   console.log('Held old request at '+mode);
   await page.evaluate(async()=>{
    const v=window.__app.view;await v.setTerrainVisual(null);window.__newLoad=v.setTerrainVisual(window.__app.sourceForTerrain('map:nt_ghost_ctg'));
   });
   // Both parses may complete after the held response; only the current stage may install.
   if(mode==='world')await held();
   await page.evaluate(()=>window.__newLoad);
   await page.evaluate(()=>{
    const v=window.__app.view;
    window.__active=v.terrainObject;window.__activeContext=v.sourceMaterials;window.__activeDisposals=0;
    for(const resource of v.sourceMaterials.resources)resource.addEventListener?.('dispose',()=>window.__activeDisposals++);
   });
   const expected=request;
   if(mode!=='world')await held();await page.evaluate(()=>window.__oldLoad.catch(error=>{if(error.name!=='AbortError'&&!String(error).includes('texture'))throw error;}));
   const proof=await page.evaluate(()=>{
    const v=window.__app.view,c=v.sourceMaterials;c.update(.5);
    return {sameScene:v.terrainObject===window.__active,sameContext:c===window.__activeContext,id:v.terrainObject.userData.loadGeneration,
     scenes:v.scene.children.filter(o=>o.userData.loadGeneration).length,sky:v.sourceSky.length,sprites:v.sourceSprites.length,details:v.sourceDetails.length,
     activeDisposals:window.__activeDisposals,oldDisposed:window.__oldContext.disposed,oldResources:window.__oldContext.resources.size,
     animated:c.animated.length,frame:c.animated[0].material.map===c.animated[0].frames[1],clock:c.time.value};
   });
   assert.equal(proof.id,expected);assert.ok(proof.sameScene&&proof.sameContext&&proof.oldDisposed&&proof.frame);assert.equal(proof.scenes,1);
   assert.equal(proof.sky,1);assert.equal(proof.sprites,1);assert.equal(proof.details,1);assert.equal(proof.activeDisposals,0);assert.equal(proof.oldResources,0);assert.equal(proof.animated,1);assert.equal(proof.clock,.5);
   proofs.push({mode,...proof});await page.evaluate(()=>window.__app.view.setTerrainVisual(null));
  }
  rejectCurrent=true;
  const failure=await page.evaluate(async()=>{
   const v=window.__app.view,promise=v.setTerrainVisual(window.__app.sourceForTerrain('map:nt_ghost_ctg')),context=v.sourceMaterials;
   let rejected=false;try{await promise}catch{rejected=true}
   const result={rejected,preserved:!context.disposed&&v.sourceMaterials===context,scene:v.terrainObject};
   await v.setTerrainVisual(null);await v.setTerrainVisual(window.__app.sourceForTerrain('map:nt_ghost_ctg'));result.retry=!!v.terrainObject&&!v.sourceMaterials.disposed;
   await v.setTerrainVisual(null);return result;
  });
  assert.deepEqual(failure,{rejected:true,preserved:true,scene:null,retry:true});
  assert.deepEqual(errors,[]);console.log(JSON.stringify({proofs,failure,errors}));
 }finally{await browser.close()}
})().catch(e=>{console.error(e);process.exitCode=1});
