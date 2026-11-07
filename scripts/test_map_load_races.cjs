/** Chromium regression: superseded map loads never install, leak or dispose the current scene. */
const assert=require('node:assert/strict'),path=require('node:path'),{createHash}=require('node:crypto');
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const {unzipSync}=require('fflate');
const {readyApp}=require('./attach-ready-app.cjs'),buildFixture=require('./build-fixture.cjs'),{bundle}=require('./source_map_fixture.cjs');
const {buildSync}=require('esbuild');
const pngModule={exports:{}};
new Function('module','exports','require',buildSync({entryPoints:['src/record/png.ts'],bundle:true,platform:'node',format:'cjs',write:false}).outputFiles[0].text)(pngModule,pngModule.exports,require);
const png=Buffer.from(pngModule.exports.encodeRgbaPNG(1,1,new Uint8Array([255,160,40,255])));
const origin=process.env.BASE_URL||'http://127.0.0.1:5176';
// Owned bundles drive the actual loader and Source material conversion with a small glTF fixture.
function fixture(tag){
 const positions=new Float32Array([0,0,0,1,0,0,0,1,0]);
 return {asset:{version:'2.0'},scene:0,scenes:[{nodes:[0,1,2,3],extras:{loadGeneration:tag}}],
  nodes:[{mesh:0},{mesh:0,extras:{sourceSky:true}},{mesh:0,extras:{sourceSprite:true}},{mesh:0,extras:{sourceDetail:true}}],
  buffers:[{uri:'data:application/octet-stream;base64,'+Buffer.from(positions.buffer).toString('base64'),byteLength:36}],
  bufferViews:[{buffer:0,byteLength:36}],accessors:[{bufferView:0,componentType:5126,count:3,type:'VEC3',min:[0,0,0],max:[1,1,0]}],
  meshes:[{primitives:[{attributes:{POSITION:0},material:0}]}],
  materials:[{extras:{sourceVertexLighting:1,sourceUnlit:true,sourceMaterial:{shader:'unlitgeneric',unlit:true,animationfps:2,animationFrames:[0,1]}}}],
  textures:[{source:0},{source:1}],images:[{uri:'base-'+tag+'.png'},{uri:'frame-'+tag+'.png'}]};
}
function map(tag,frame=png){
 return bundle(fixture(tag),{name:'Map race '+tag,files:{['base-'+tag+'.png']:png,['frame-'+tag+'.png']:frame}});
}
const bundles={baseline:map('baseline'),a:map('a'),b:map('b'),bad:map('bad',Buffer.from('m0clip map race: deliberately undecodable PNG body'))};
// Owned HTTP map roots serve exactly the bundle bodies the page verifies, outside every catalogue map ID.
const served=Object.fromEntries(Object.entries(bundles).map(([tag,zip])=>{const files=unzipSync(new Uint8Array(zip));delete files['m0clip-map.json'];return [tag,files];}));
const ownedRoot=/^\/assets\/maps\/__m0clip-race-([a-z]+)\/(.+)$/;
const contentTypes={json:'application/json',xml:'application/xml',glb:'model/gltf-binary',png:'image/png'};
function deferred(){let resolve;const promise=new Promise(done=>resolve=done);return {promise,resolve};}
function assertRace(race,proof){
 assert.equal(proof.kept,true,'Preparing a map must keep the active scene installed');
 if(race.mode==='failed-texture')assert.ok(proof.outcome.rejected&&proof.outcome.name!=='AbortError','The undecodable retired texture must reject its own load: '+JSON.stringify(proof.outcome));
 else assert.deepEqual({rejected:proof.outcome.rejected,name:proof.outcome.name},{rejected:true,name:'AbortError'},'A superseded healthy load ends as cancellation');
 assert.equal(proof.id,race.current);assert.ok(proof.sameScene&&proof.sameContext&&proof.baselineDisposed&&proof.frame);assert.equal(proof.scenes,1);
 assert.equal(proof.sky,1);assert.equal(proof.sprites,1);assert.equal(proof.details,1);assert.equal(proof.activeDisposals,0);assert.equal(proof.baselineResources,0);assert.equal(proof.animated,1);assert.equal(proof.clock,.5);
}
(async()=>{
 const started=Date.now(),stage=name=>console.log(JSON.stringify({stage:name,elapsedMs:Date.now()-started}));
 const facade=await buildFixture({root:path.resolve(__dirname,'..'),source:`
  export { decodeMapBundle } from './src/maps/bundle';
  export { MapSource, registerLocalMap } from './src/maps/source';
 `,platform:'browser',format:'iife',globalName:'MapRaceFixture'});
 stage('fixture built');
 const browser=await chromium.launch({headless:process.env.HEADLESS==='1',executablePath:process.env.CHROMIUM_PATH||undefined,args:['--no-sandbox','--ozone-platform=x11']});
 let hold=null;
 try{
  const page=await browser.newPage({deviceScaleFactor:1}),errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.addInitScript(()=>localStorage.setItem('ume-prefs',JSON.stringify({robot:'r1',terrain:'flat'})));
  await page.goto(origin+'/?plain&body=stock');
  stage('launch document loaded');
  // Fixture prerequisites are verified while only the launch document is open, before the real App starts its scene.
  await page.addScriptTag({content:facade.code});
  if(facade.css)await page.addStyleTag({content:facade.css});
  // Every bundle passes the real local-map verification; local roots keep its MapSource.
  const verified={};
  for(const [tag,zip] of Object.entries(bundles)){
   verified[tag]=await page.evaluate(async([tag,base64])=>{
    const {decodeMapBundle,registerLocalMap}=window.MapRaceFixture;window.__maps??={};
    const decoded=await decodeMapBundle(new Blob([Uint8Array.from(atob(base64),c=>c.charCodeAt(0))],{type:'application/zip'}));
    window.__maps[tag]=registerLocalMap(decoded);
    return decoded.index.resources.map(({path,bytes,sha256})=>({path,bytes,sha256}));
   },[tag,zip.toString('base64')]);
   stage('verified bundle '+tag);
  }
  for(const [tag,resources] of Object.entries(verified)){
   assert.deepEqual(Object.keys(served[tag]).sort(),resources.map(resource=>resource.path).sort());
   for(const resource of resources){const body=served[tag][resource.path];assert.equal(body.length,resource.bytes);assert.equal(createHash('sha256').update(body).digest('hex'),resource.sha256);}
  }
  await require('./launch-scene.cjs').launchScene(page);
  stage('scene entered');
  // The release chunk stays byte-identical; the real Ready App is attached through CDP.
  await readyApp(page);
  stage('ready');
  assert.equal(await page.evaluate(()=>Object.keys(window.__maps).sort().join()),Object.keys(bundles).sort().join(),'Verified sources survive scene entry');
  // Only the owned roots are routed; absent optional sidecars are ordinary 404s.
  await page.route('**/assets/maps/__m0clip-race-*/**',async route=>{
   const match=ownedRoot.exec(new URL(route.request().url()).pathname),body=match&&served[match[1]]?.[match[2]];
   if(!body)return route.fulfill({status:404,body:''});
   if(hold&&!hold.seen&&match[1]===hold.tag&&match[2]===hold.path){hold.seen=true;hold.reached.resolve();await hold.release.promise;}
   await route.fulfill({status:200,contentType:contentTypes[match[2].slice(match[2].lastIndexOf('.')+1)]??'application/octet-stream',body:Buffer.from(body)});
  });
  const proofs=[];
  // The same local map is reselected while its world glTF is still parsing; both loads lease one MapSource.
  const world={mode:'world',retired:'a',current:'a'};
  const worldProof=await page.evaluate(async({retired,current})=>{
   const v=window.__app.view,maps=window.__maps;
   await v.setTerrainVisual(maps.baseline);
   const baselineScene=v.terrainObject,baselineContext=v.sourceMaterials,reselected=Promise.withResolvers();
   let kept=null;
   // The reselection arrives while the retired load is suspended after reading its world glTF.
   const retiredLoad=v.setTerrainVisual(maps[retired],phase=>{
    if(phase!=='local map resources'||kept!==null)return;
    kept=v.terrainObject===baselineScene&&v.sourceMaterials===baselineContext&&baselineScene.userData.loadGeneration==='baseline';
    queueMicrotask(()=>{void v.setTerrainVisual(null);reselected.resolve({load:v.setTerrainVisual(maps[current])});});
   });
   const settled=retiredLoad.then(()=>({rejected:false}),error=>({rejected:true,name:error.name,message:String(error.message)}));
   const {load}=await Promise.race([reselected.promise,settled.then(outcome=>{throw new Error('Retired load settled before its world glTF was read: '+JSON.stringify(outcome))})]);
   await load;
   const active=v.terrainObject,activeContext=v.sourceMaterials;let activeDisposals=0;
   for(const resource of activeContext.resources)resource.addEventListener?.('dispose',()=>activeDisposals++);
   const outcome=await settled;
   activeContext.update(.5);
   const animation=activeContext.animated[0];
   const result={kept,outcome,sameScene:v.terrainObject===active,sameContext:v.sourceMaterials===activeContext,id:active.userData.loadGeneration,
    scenes:v.scene.children.filter(o=>o.userData.loadGeneration).length,sky:v.sourceSky.length,sprites:v.sourceSprites.length,details:v.sourceDetails.length,
    activeDisposals,baselineDisposed:baselineContext.disposed,baselineResources:baselineContext.resources.size,
    animated:activeContext.animated.length,frame:animation?.material.map===animation?.frames[1],clock:activeContext.time.value};
   await v.setTerrainVisual(null);
   return result;
  },world);
  assertRace(world,worldProof);proofs.push({...world,...worldProof});stage('world race');
  // A retired owned HTTP map waits on its real frame-texture request until the current map is installed and observed.
  for(const race of [{mode:'texture',retired:'a',current:'b'},{mode:'failed-texture',retired:'bad',current:'b'}]){
   hold={tag:race.retired,path:'frame-'+race.retired+'.png',seen:false,reached:deferred(),release:deferred()};
   try{
    await page.evaluate(async retired=>{
     const v=window.__app.view,{MapSource}=window.MapRaceFixture;
     await v.setTerrainVisual(window.__maps.baseline);
     const race=window.__race={order:[],baselineScene:v.terrainObject,baselineContext:v.sourceMaterials};
     race.settled=v.setTerrainVisual(new MapSource('__m0clip-race-'+retired))
      .then(()=>({rejected:false}),error=>({rejected:true,name:error.name,message:String(error.message)}))
      .then(outcome=>{race.order.push('retired-settled');return outcome;});
    },race.retired);
    const early=await Promise.race([hold.reached.promise.then(()=>null),page.evaluate(()=>window.__race.settled)]);
    assert.equal(early,null,'The retired load settled before requesting its held texture: '+JSON.stringify(early));
    stage(race.mode+' retired texture held');
    const installed=await page.evaluate(async current=>{
     const v=window.__app.view,race=window.__race;
     race.kept=v.terrainObject===race.baselineScene&&v.sourceMaterials===race.baselineContext&&race.baselineScene.userData.loadGeneration==='baseline';
     await v.setTerrainVisual(window.__maps[current]);race.order.push('current-installed');
     race.active=v.terrainObject;race.activeContext=v.sourceMaterials;race.activeDisposals=0;
     for(const resource of race.activeContext.resources)resource.addEventListener?.('dispose',()=>race.activeDisposals++);
     return race.order.slice();
    },race.current);
    assert.deepEqual(installed,['current-installed'],'The retired load must still be waiting when the current map installs');
    stage(race.mode+' current installed');
    hold.release.resolve();
    const proof=await page.evaluate(async()=>{
     const v=window.__app.view,race=window.__race,outcome=await race.settled,c=race.activeContext;
     c.update(.5);
     const animation=c.animated[0];
     const result={kept:race.kept,order:race.order.slice(),outcome,sameScene:v.terrainObject===race.active,sameContext:v.sourceMaterials===c,id:race.active.userData.loadGeneration,
      scenes:v.scene.children.filter(o=>o.userData.loadGeneration).length,sky:v.sourceSky.length,sprites:v.sourceSprites.length,details:v.sourceDetails.length,
      activeDisposals:race.activeDisposals,baselineDisposed:race.baselineContext.disposed,baselineResources:race.baselineContext.resources.size,
      animated:c.animated.length,frame:animation?.material.map===animation?.frames[1],clock:c.time.value};
     await v.setTerrainVisual(null);delete window.__race;
     return result;
    });
    assert.deepEqual(proof.order,['current-installed','retired-settled'],'The retired load settles only after the current map installed');
    assertRace(race,proof);proofs.push({...race,...proof});stage(race.mode+' race');
   }finally{hold.release.resolve();hold=null;}
  }
  // A current load that fails leaves the installed context alone and does not wedge later requests.
  const failure=await page.evaluate(async()=>{
   const v=window.__app.view,maps=window.__maps,context=v.sourceMaterials,first=v.setTerrainVisual(maps.bad);
   let rejected=false;try{await first}catch(error){rejected=error.name!=='AbortError'}
   const result={rejected,preserved:!context.disposed&&v.sourceMaterials===context,scene:v.terrainObject};
   const again=v.setTerrainVisual(maps.bad);result.fresh=again!==first;
   try{await again;result.repeated=false}catch(error){result.repeated=error.name!=='AbortError'}
   await v.setTerrainVisual(maps.a);result.recovered=v.terrainObject?.userData.loadGeneration==='a'&&!v.sourceMaterials.disposed;
   await v.setTerrainVisual(null);return result;
  });
  assert.deepEqual(failure,{rejected:true,preserved:true,scene:null,fresh:true,repeated:true,recovered:true});stage('current failure');
  assert.deepEqual(errors,[]);console.log(JSON.stringify({proofs,failure,errors}));
 }finally{hold?.release.resolve();await browser.close()}
})().catch(e=>{console.error(e);process.exitCode=1});
