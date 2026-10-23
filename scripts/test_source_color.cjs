/** Chromium pixel evidence for Source's final gamma/LUT and linear-light transparency. */
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright'),assert=require('node:assert/strict');
const encode=v=>v<=.0031308?v*12.92:1.055*v**(1/2.4)-.055;
const decode=v=>v<=.04045?v/12.92:((v+.055)/1.055)**2.4;
const quantize=v=>decode(Math.round(Math.max(0,Math.min(1,encode(v)))*255)/255);
const lut=v=>{const p=Math.max(0,Math.min(1,v))*31,i=Math.floor(p),a=Math.floor(i*255/31),b=Math.floor(Math.min(i+1,31)*255/31);return(a+(b-a)*(p-i))/255};
const output=v=>Math.round(lut(Math.max(0,v)**(1/2.2))*255);
(async()=>{const browser=await chromium.launch({headless:false,args:['--no-sandbox','--ozone-platform=x11']});try{
  const page=await browser.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));page.on('console',m=>{if(m.type()==='error')errors.push(m.text())});
  const base=process.env.BASE_URL||'http://127.0.0.1:5176';await page.route(base+'/?color-test',r=>r.fulfill({contentType:'text/html',body:'<body></body>'}));await page.goto(base+'/?color-test');
  const proof=await page.evaluate(async()=>{
    const THREE=await import('/node_modules/.vite/deps/three.js'),{SourceColor,sourceIdentityLut}=await import('/src/render/source-color.ts'),{sourceVertexMaterial}=await import('/src/render/source-lighting.ts');
    const renderer=new THREE.WebGLRenderer({alpha:true,preserveDrawingBuffer:true});document.body.append(renderer.domElement);renderer.setPixelRatio(2);renderer.setSize(64,64);renderer.setClearColor(0,0);renderer.toneMapping=THREE.NoToneMapping;
    const post=new SourceColor(),linear={value:0},scene=new THREE.Scene(),camera=new THREE.OrthographicCamera(-1,1,1,-1,.1,10);camera.position.z=3;camera.up.set(0,1,0);camera.lookAt(0,0,0);const plane=new THREE.PlaneGeometry(2,2);
    const make=(rgb,z,opacity=1,add=false)=>{const original=new THREE.MeshStandardMaterial({color:new THREE.Color(...rgb),transparent:opacity<1,opacity,depthWrite:opacity===1});original.userData.sourceUnlit=true;const material=sourceVertexMaterial(original,1,{value:1},linear);if(add)material.blending=THREE.AdditiveBlending;const mesh=new THREE.Mesh(plane,material);mesh.position.z=z;scene.add(mesh);return mesh};
    const back=make([.2,.4,.6],0),front=make([.8,.1,.05],1,.5);
    const target=new THREE.WebGLRenderTarget(64,64);renderer.setRenderTarget(target);
    const read=()=>{const bytes=new Uint8Array(4);renderer.readRenderTargetPixels(target,32,32,1,1,bytes);return Array.from(bytes)};
    const render=transparent=>post.render(renderer,()=>renderer.render(scene,camera),linear,transparent);
    render(false);const blend=read();front.visible=false;render(false);const opaque=read();back.visible=false;front.visible=true;render(true);const transparent=read();front.visible=false;render(true);const empty=read();
    back.visible=true;front.visible=true;front.material.blending=THREE.AdditiveBlending;render(false);const additive=read();front.material.blending=THREE.NormalBlending;
    target.viewport.set(7,9,32,24);target.scissor.set(8,10,22,18);target.scissorTest=true;renderer.setRenderTarget(target);renderer.autoClear=false;
    const snapshot=()=>({target:renderer.getRenderTarget()===target,viewport:renderer.getViewport(new THREE.Vector4()).toArray(),physical:renderer.getCurrentViewport(new THREE.Vector4()).toArray(),scissor:renderer.getScissor(new THREE.Vector4()).toArray(),box:Array.from(renderer.getContext().getParameter(renderer.getContext().SCISSOR_BOX)),scissorTest:renderer.getContext().isEnabled(renderer.getContext().SCISSOR_TEST),targetViewport:target.viewport.toArray(),targetScissor:target.scissor.toArray(),autoClear:renderer.autoClear,linear:linear.value});
    const before=snapshot();render(false);const after=snapshot();let caught=false;try{post.render(renderer,()=>{throw new Error('fixture')},linear)}catch(e){caught=e.message==='fixture'}const failed=snapshot();
    renderer.setRenderTarget(null);renderer.autoClear=true;renderer.setScissorTest(false);renderer.setViewport(0,0,64,64);renderer.setClearColor(0xff00ff,1);renderer.clear();renderer.setViewport(8,6,32,40);renderer.setScissor(10,8,24,32);renderer.setScissorTest(true);renderer.setClearColor(0,0);render(false);
    const canvas=document.createElement('canvas');canvas.width=128;canvas.height=128;const ctx=canvas.getContext('2d');ctx.drawImage(renderer.domElement,0,0);const bar=Array.from(ctx.getImageData(1,1,1,1).data),inside=Array.from(ctx.getImageData(64,64,1,1).data);
    const lut=sourceIdentityLut();let exact=true;for(let z=0;z<32;z++)for(let y=0;y<32;y++)for(let x=0;x<32;x++){const i=((z*32+y)*32+x)*4;if(lut[i]!==Math.floor(x*255/31)||lut[i+1]!==Math.floor(y*255/31)||lut[i+2]!==Math.floor(z*255/31)||lut[i+3]!==255)exact=false;}
    const grading=new Uint8Array(32*32*32*3);for(let i=0;i<grading.length;i+=3)grading[i]=255;
    target.viewport.set(0,0,64,64);target.scissorTest=false;renderer.setRenderTarget(target);
    post.setColorCorrections([{origin:[0,0,0],enabled:true,minfalloff:-1,maxfalloff:-1,data:grading}]);render(false);const graded=read();
    post.setColorCorrections([]);render(false);const gradingReset=read();
    post.dispose();target.dispose();renderer.dispose();return{blend,opaque,transparent,empty,additive,before,after,failed,caught,bar,inside,lutExact:exact,graded,gradingReset};
  });
  const baseColor=[.2,.4,.6],front=[.8,.1,.05];const expected={opaque:baseColor.map(v=>output(quantize(v))),blend:baseColor.map((v,i)=>output(quantize(quantize(v)*.5+front[i]*.5))),additive:baseColor.map((v,i)=>output(quantize(quantize(v)+front[i]*.5))),transparent:front.map(v=>Math.round(output(quantize(v*.5)/(.5))*128/255))};
  for(const key of ['opaque','blend','additive','transparent'])for(let i=0;i<3;i++)assert.ok(Math.abs(proof[key][i]-expected[key][i])<=2,`${key}: ${proof[key]} != ${expected[key]}`);
  assert.equal(proof.transparent[3],128);assert.deepEqual(proof.empty,[0,0,0,0]);assert.deepEqual(proof.before,proof.after);assert.deepEqual(proof.before,proof.failed);assert.ok(proof.caught&&proof.lutExact);assert.deepEqual(proof.bar,[255,0,255,255]);assert.ok(proof.inside[1]>0);assert.deepEqual(proof.graded,[255,0,0,255]);assert.deepEqual(proof.gradingReset,proof.blend);assert.deepEqual(errors,[]);console.log(JSON.stringify({...proof,expected,errors}));
}finally{await browser.close()}})().catch(e=>{console.error(e);process.exitCode=1});
