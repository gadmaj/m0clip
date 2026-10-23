/** Chromium: native $nocull overrides legacy cutout culling in world/prop materials. */
const assert=require('node:assert/strict'),{build}=require('esbuild');
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
(async()=>{
 const bundle=await build({stdin:{contents:"export * as THREE from 'three';export * from './src/render/source-lighting';export {patchSourceMaterial} from './src/render/source-materials';",resolveDir:process.cwd()},bundle:true,format:'iife',globalName:'testCulling',write:false});
 const browser=await chromium.launch({headless:true,args:['--no-sandbox']});
 try{
  const page=await browser.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));page.on('console',m=>{if(m.type()==='error')errors.push(m.text())});
  await page.addScriptTag({content:bundle.outputFiles[0].text});
  const proof=await page.evaluate(()=>{
   const {THREE:T,sourceMaterial,sourceVertexMaterial,patchSourceMaterial}=testCulling;
   const renderer=new T.WebGLRenderer({alpha:true}),target=new T.WebGLRenderTarget(1,1),scene=new T.Scene(),camera=new T.PerspectiveCamera(60,1,.1,10);
   const geometry=new T.PlaneGeometry(2,2);geometry.setAttribute('uv1',geometry.getAttribute('uv').clone());
   geometry.setAttribute('color',new T.Float32BufferAttribute(Array(12).fill(1),3));
   const lightmap=new T.DataTexture(new Uint8Array([255,255,255,255]),1,1);lightmap.needsUpdate=true;
   const mesh=new T.Mesh(geometry);scene.add(mesh);renderer.setRenderTarget(target);renderer.setClearColor(0,0);
   const sample=(material,z)=>{mesh.material=material;camera.position.set(0,0,z);camera.lookAt(0,0,0);renderer.render(scene,camera);const pixel=new Uint8Array(4);renderer.readRenderTargetPixels(target,0,0,1,1,pixel);return [...pixel]};
   const results=[];
   for(const kind of ['world','prop'])for(const nocull of [false,true]){
    const original=new T.MeshStandardMaterial({alphaTest:.7,side:nocull?T.FrontSide:T.DoubleSide});
    original.userData.sourceMaterial={nocull};
    const source=kind==='world'?sourceMaterial(original,lightmap,{value:1}):sourceVertexMaterial(original,1,{value:1});
    patchSourceMaterial(source,original,{});
    results.push({kind,nocull,side:source.side,originalSide:original.side,alphaTest:source.alphaTest,front:sample(source,1),back:sample(source,-1)});
    source.dispose();original.dispose();
   }
   geometry.dispose();lightmap.dispose();target.dispose();renderer.dispose();return results;
  });
  for(const value of proof){assert.equal(value.side,value.nocull?2:0);assert.equal(value.originalSide,value.side);assert.equal(value.alphaTest,.7);assert.equal(value.front[3],255);assert.equal(value.back[3],value.nocull?255:0)}
  assert.deepEqual(errors,[]);console.log(JSON.stringify({results:proof,errors}));
 }finally{await browser.close()}
})().catch(error=>{console.error(error);process.exitCode=1});
