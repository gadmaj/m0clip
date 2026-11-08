/** Actual Ghost sprites: original tint pixels, noclip distance fade, all cameras and cleanup. */
const artifactPath=require('./test-artifacts.cjs');
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright'),assert=require('node:assert/strict'),{readyApp}=require('./attach-ready-app.cjs');
(async()=>{const browser=await chromium.launch({headless:process.env.HEADLESS==='1',executablePath:process.env.CHROMIUM_PATH,args:['--no-sandbox','--ozone-platform=x11']});try{
 const page=await browser.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));page.on('console',m=>{if(m.type()==='error'&&/shader|WebGLProgram/.test(m.text()))errors.push(m.text())});
 // The release chunk stays byte-identical; the real Ready App is attached through CDP.
 await page.goto((process.env.BASE_URL||'http://127.0.0.1:5176')+'/?plain&map=nt_ghost_ctg&body=stock').then(() => require('./launch-scene.cjs').launchScene(page));await readyApp(page,{until:()=>window.__app.view.terrainObject,timeout:180000});
 const proof=await page.evaluate(()=>{
  const v=window.__app.view,sprites=v.sourceSprites,chosen=sprites.find(s=>s.material.color.b<.6),camera=v.camera.clone();camera.up.set(0,1,0);camera.aspect=1;camera.fov=5;camera.updateProjectionMatrix();
  const display={...v.display};v.setDisplay({...display,robot:false});const visible=new Map();v.scene.traverse(o=>{if(o.isMesh){visible.set(o,o.visible);o.visible=o===chosen}});
  const sky=v.sourceSky3D,skyFaces=v.sourceSky,background=v.scene.background;v.sourceSky3D=null;v.sourceSky=[];v.scene.background=background.clone().setRGB(0,0,0);
  camera.position.copy(chosen.position).z+=200*.0254;camera.lookAt(chosen.position);v.beginOffscreen(256,256);v.renderWith(camera);
  const cv=document.createElement('canvas');cv.width=cv.height=256;const ctx=cv.getContext('2d');ctx.drawImage(v.renderer.domElement,0,0);const pixel=Array.from(ctx.getImageData(128,128,1,1).data),png=cv.toDataURL();
  const tex=chosen.material.map.image,pixels=tex.data;let center;
  // Native VTF images expose lazy RGBA; keep the same central 2x2 sample.
  if(pixels){
   const x=Math.trunc(tex.width/2-1),y=Math.trunc(tex.height/2-1);center=new Array(16);
   for(let row=0;row<2;row++){const offset=((y+row)*tex.width+x)*4;for(let channel=0;channel<8;channel++)center[row*8+channel]=pixels[offset+channel];}
  }else{cv.width=tex.width;cv.height=tex.height;ctx.drawImage(tex,0,0);center=Array.from(ctx.getImageData(tex.width/2-1,tex.height/2-1,2,2).data);}
  const tint=chosen.material.color.toArray(),alpha=chosen.material.opacity;
  const near={alpha,scale:chosen.scale.x};camera.position.copy(chosen.position).z+=2400*.0254;camera.lookAt(chosen.position);v.renderWith(camera);const far={alpha:chosen.material.opacity,scale:chosen.scale.x};v.endOffscreen();
  v.renderFramed(camera,1);const framedAlpha=chosen.material.opacity;v.sourceSky3D=sky;v.sourceSky=skyFaces;v.scene.background=background;for(const[o,on]of visible)o.visible=on;v.setDisplay(display);v.render();
  return{count:sprites.length,pixel,tint,center,near,far,framedAlpha,authoredAlpha:chosen.userData.sourceSpriteAlpha,post:v.sourceColorMap,robot:v.getBodyVisualState().applied,png};
 });
 const dec=v=>v<=.04045?v/12.92:((v+.055)/1.055)**2.4,enc=v=>v<=.0031308?v*12.92:1.055*v**(1/2.4)-.055;
 const expected=proof.tint.map((t,c)=>{let sample=0;for(let i=0;i<4;i++)sample+=dec(proof.center[i*4+c]/255)/4;const linear=dec(Math.round(enc(sample*t)*255)/255),g=linear**(1/2.2),p=g*31,i=Math.floor(p),a=Math.floor(i*255/31),b=Math.floor(Math.min(31,i+1)*255/31);return Math.round(a+(b-a)*(p-i));});
 assert.equal(proof.count,150);for(let i=0;i<3;i++)assert.ok(Math.abs(proof.pixel[i]-expected[i])<=3,JSON.stringify({actual:proof.pixel,expected,tint:proof.tint,center:proof.center}));assert.equal(proof.pixel[3],255);assert.deepEqual(proof.near,{alpha:1,scale:1});assert.ok(Math.abs(proof.far.alpha-.25)<1e-9);assert.equal(proof.far.scale,1);assert.equal(proof.framedAlpha,proof.far.alpha);assert.ok(proof.authoredAlpha<1&&proof.post);assert.equal(proof.robot,'stock');assert.deepEqual(errors,[]);require('node:fs').writeFileSync(artifactPath('ghost-native-glow.png'),Buffer.from(proof.png.split(',')[1],'base64'));delete proof.png;console.log(JSON.stringify({...proof,expected,errors}));
}finally{await browser.close()}})().catch(e=>{console.error(e);process.exitCode=1});
