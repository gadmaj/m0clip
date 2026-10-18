/** Chromium GPU regression for native Source detail blending, scale and linear sampling. */
const {chromium}=require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert=require('node:assert/strict');
(async()=>{const b=await chromium.launch({headless:true,args:['--no-sandbox']});try{
  const page=await b.newPage(),errors=[];
  page.on('pageerror',e=>errors.push(e.message));page.on('console',m=>{if(m.type()==='error')errors.push(m.text());});
  const origin=process.env.BASE_URL || 'http://127.0.0.1:5176';
  await page.route('**/__source-material-test',r=>r.fulfill({contentType:'text/html',body:'<!doctype html><html><body></body></html>'}));await page.goto(origin+'/__source-material-test');
  const proof=await page.evaluate(async()=>{
    const T=await import('/node_modules/.vite/deps/three.js');
    const {sourceMaterial}=await import('/src/render/source-lighting.ts');
    const {patchSourceMaterial}=await import('/src/render/source-materials.ts');
    const texture=(pixels,w=1)=>{const t=new T.DataTexture(new Uint8Array(pixels),w,1);t.minFilter=t.magFilter=T.NearestFilter;t.wrapS=t.wrapT=T.RepeatWrapping;t.needsUpdate=true;return t;};
    const base=texture([64,64,64,255]),lightmap=texture([32,32,32,255]),detail=texture([0,0,0,255,128,128,128,255,192,192,192,255,255,255,255,255],4);
    const scene=new T.Scene(),camera=new T.OrthographicCamera(-1,1,1,-1,.1,10);camera.position.z=1;
    const renderer=new T.WebGLRenderer();renderer.setSize(16,4);renderer.toneMapping=T.NoToneMapping;
    const target=new T.WebGLRenderTarget(16,4),geometry=new T.PlaneGeometry(2,2);geometry.setAttribute('uv1',geometry.getAttribute('uv').clone());
    const mesh=new T.Mesh(geometry);scene.add(mesh);
    const render=(scale,enabled=true)=>{
      const original=new T.MeshStandardMaterial({map:base});original.userData.sourceMaterial={detailscale:scale,detailblendfactor:.6};
      const m=sourceMaterial(original,lightmap,{value:1});patchSourceMaterial(m,original,enabled?{detail}:{});mesh.material=m;
      renderer.setRenderTarget(target);renderer.render(scene,camera);const bytes=new Uint8Array(16*4*4);renderer.readRenderTargetPixels(target,0,0,16,4,bytes);
      const values=[1,5,9,13].map(x=>bytes[(2*16+x)*4]);m.dispose();original.dispose();return values;
    };
    const normal=render(1),repeated=render(2),disabled=render(1,false);
    // Independent prediction from the Source equation, including final gamma 2.2.
    const expected=[0,128,192,255].map(v=>Math.round(255*((64/255)*(32/255*6)*(1-.6+.6*(v/255*2)))**(1/2.2)));
    renderer.dispose();target.dispose();return{normal,repeated,disabled,expected};
  });
  for(let i=0;i<4;i++){assert.ok(Math.abs(proof.normal[i]-proof.expected[i])<=2,JSON.stringify(proof));assert.ok(Math.abs(proof.repeated[i]-proof.expected[(2*i)%4])<=2,JSON.stringify(proof));}
  assert.ok(proof.normal[3]-proof.normal[0]>40);assert.ok(proof.disabled.every(v=>v===proof.disabled[0]));assert.deepEqual(errors,[]);console.log(JSON.stringify({...proof,errors}));
}finally{await b.close();}})().catch(e=>{console.error(e);process.exitCode=1;});
