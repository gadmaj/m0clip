/** Chromium pixels: batched foliage keeps camera-facing shapes, tint, masks and flashlight shadows. */
const assert=require('node:assert/strict'),{chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
(async()=>{const browser=await chromium.launch({headless:true,args:['--no-sandbox']});try{
 const page=await browser.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));page.on('console',m=>{if(m.type()==='error')errors.push(m.text())});
 const base=process.env.BASE_URL||'http://127.0.0.1:5176';await page.route(base+'/?detail-batches',r=>r.fulfill({contentType:'text/html',body:'<body></body>'}));await page.goto(base+'/?detail-batches');
 const proof=await page.evaluate(async()=>{
  const THREE=await import('/node_modules/.vite/deps/three.js');
  const {batchSourceDetails,prepareDetailBatch,patchDetailBatchMaterial,expandDetailBatches}=await import('/src/render/source-details.ts');
  const {sourceVertexMaterial}=await import('/src/render/source-lighting.ts');
  const {setSourceTexturesEnabled}=await import('/src/render/source-textures.ts');
  const {SourceMaterials}=await import('/src/render/source-materials.ts');
  const {SourceFlashlight}=await import('/src/render/source-flashlight.ts');
  THREE.Object3D.DEFAULT_UP.set(0,0,1);
  const renderer=new THREE.WebGLRenderer({alpha:true,preserveDrawingBuffer:true}),target=new THREE.WebGLRenderTarget(128,96);renderer.setSize(128,96);renderer.setRenderTarget(target);renderer.setClearColor(0,1);renderer.toneMapping=THREE.NoToneMapping;
  const scene=new THREE.Scene(),root=new THREE.Group(),camera=new THREE.PerspectiveCamera(55,128/96,.05,100);scene.add(root);camera.up.set(0,0,1);
  const owner=new SourceMaterials(),exposure={value:1},linear={value:0},light=new SourceFlashlight();
  await new Promise((resolve,reject)=>{const started=performance.now();const wait=()=>{if(light.ready)resolve();else if(performance.now()-started>15000)reject(new Error('Flashlight fixture did not load'));else setTimeout(wait,25)};wait()});
  const image=new Uint8Array([230,180,120,255, 80,150,240,0, 70,190,80,255, 200,90,130,255]);
  const texture=owner.own(new THREE.DataTexture(image,2,2));texture.colorSpace=THREE.SRGBColorSpace;texture.magFilter=texture.minFilter=THREE.NearestFilter;texture.needsUpdate=true;
  for(let i=0;i<12;i++) {
   const g=owner.own(new THREE.PlaneGeometry(.32+(i%2)*.13,.72));g.rotateX(Math.PI/2);g.translate(0,0,.36);
   const m=owner.own(new THREE.MeshStandardMaterial({map:texture,color:new THREE.Color(.25+i*.045,.9-i*.04,.35+i*.023),alphaTest:.5,side:THREE.DoubleSide}));m.userData={sourceVertexLighting:1,sourceUnlit:true};
   const mesh=new THREE.Mesh(g,m);mesh.position.set((i%4-1.5)*.53,Math.floor(i/4)*.47,0);mesh.userData.sourceDetail=true;mesh.name='detail:'+i;root.add(mesh);
  }
  const floorOriginal=new THREE.MeshStandardMaterial({color:new THREE.Color(.12,.12,.12)});floorOriginal.userData.sourceUnlit=true;
  const floorMaterial=sourceVertexMaterial(floorOriginal,1,exposure,linear);light.patch(floorMaterial);
  const floor=new THREE.Mesh(new THREE.PlaneGeometry(8,8),floorMaterial);floor.position.z=-.02;scene.add(floor);
  const cameras=[[2.1,-3,1.8],[-2.3,-2.7,1.2],[.2,2.7,2.1]];
  function variant(mesh){const old=mesh.material,material=owner.own(sourceVertexMaterial(old,1,exposure,linear));patchDetailBatchMaterial(mesh,material);mesh.material=material;}
  const originalMaterials=root.children.map(m=>m.material);root.children.forEach(variant);
  function draw(position,textures,flashlight){
   camera.position.fromArray(position);camera.lookAt(0,.45,.3);camera.updateMatrixWorld(true);
   for(const mesh of root.children) {
    if(!prepareDetailBatch(mesh,camera.position))mesh.rotation.z=Math.atan2(camera.position.y-mesh.position.y,camera.position.x-mesh.position.x)-Math.PI/2;
    setSourceTexturesEnabled(mesh.material,textures);
   }
   light.set(flashlight);light.renderDepth(renderer,scene,camera);renderer.render(scene,camera);
   const pixels=new Uint8Array(128*96*4);renderer.readRenderTargetPixels(target,0,0,128,96,pixels);return {pixels,calls:renderer.info.render.calls};
  }
  const cases=[];for(const position of cameras)for(const textures of [true,false])for(const flashlight of [false,true])cases.push({position,textures,flashlight});
  const before=cases.map(c=>draw(c.position,c.textures,c.flashlight));
  root.children.forEach((mesh,i)=>mesh.material=originalMaterials[i]);
  const batching=batchSourceDetails(root,owner);root.children.forEach(variant);
  const afterImages=[];
  const results=cases.map((c,i)=>{
   const after=draw(c.position,c.textures,c.flashlight),old=before[i].pixels;let sum=0,maximum=0,changed=0;
   afterImages.push(after.pixels);
   for(let j=0;j<old.length;j++){const delta=Math.abs(old[j]-after.pixels[j]);sum+=delta;maximum=Math.max(maximum,delta);changed+=delta!==0;}
   return {...c,mean:sum/old.length,maximum,changed,beforeDraws:before[i].calls,afterDraws:after.calls};
  });
  const clone=root.clone(true),cleanup=expandDetailBatches(clone),exports=clone.children.map(m=>({name:m.name,position:m.position.toArray(),color:m.material.color.toArray(),instanced:!!m.isInstancedMesh}));cleanup();
  const ownedBefore=owner.resources.size;owner.dispose();const disposed=owner.resources.size===0;
  target.dispose();renderer.dispose();return {batching,results,exports,ownedBefore,disposed,images:{before:Array.from(before[0].pixels),after:Array.from(afterImages[0])}};
 });
 const {PNG}=require(require('node:path').resolve(process.env.NOCLIP_REFERENCE||'../noclip.website','node_modules/pngjs'));
 for(const [name,data] of Object.entries(proof.images)){const png=new PNG({width:128,height:96});png.data=Buffer.from(data);require('node:fs').writeFileSync('/tmp/detail-batch-'+name+'.png',PNG.sync.write(png));}delete proof.images;
 assert.deepEqual(errors,[]);
 assert.equal(proof.batching.instances,12);assert.equal(proof.batching.batches,2);
 // GPU atan/rotation and CPU object matrices round differently at cutout and
 // 512px shadow edges. Main-pass differences stay below three pixels; shadows
 // may change at most 2% of channels by less than 0.2 / 255 on average.
 for(const row of proof.results){assert.ok(row.mean<(row.flashlight?.2:.02),JSON.stringify(row));assert.ok(row.changed<=(row.flashlight?128*96*4*.02:12),JSON.stringify(row));assert.ok(row.afterDraws<row.beforeDraws,JSON.stringify(row));}
 assert.equal(proof.exports.length,12);assert.ok(proof.exports.every(m=>!m.instanced));assert.equal(new Set(proof.exports.map(m=>m.name)).size,12);assert.ok(proof.disposed);assert.deepEqual(errors,[]);
 for(let i=0;i<12;i++){
  const mesh=proof.exports.find(m=>m.name==='detail:'+i);assert.ok(mesh);
  assert.deepEqual(mesh.position,[(i%4-1.5)*.53,Math.floor(i/4)*.47,0]);
  assert.deepEqual(mesh.color,[.25+i*.045,.9-i*.04,.35+i*.023]);
 }
 console.log(JSON.stringify({...proof,exports:proof.exports.length,errors}));
}finally{await browser.close()}})().catch(e=>{console.error(e);process.exitCode=1});
