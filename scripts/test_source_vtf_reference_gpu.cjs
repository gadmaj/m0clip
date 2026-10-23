/** Compare actual Ghost normal/cube sampling through noclip's VTF/Gfx uploads and Three. */
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),{build}=require('esbuild');
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const reference=path.resolve(process.env.NOCLIP_REFERENCE||'../noclip.website');
const bytes=fs.readFileSync('public/assets/maps/nt_ghost_ctg/visual.glb'),jsonSize=bytes.readUInt32LE(12),document=JSON.parse(bytes.toString('utf8',20,20+jsonSize));
const fixtures=['wall/stealgirderwall01normal_ivy','maps/nt_ghost_ctg/c-434_4198_55'].map(name=>{
 const meta=document.textures.find(t=>t.extras?.sourceVtf?.path===name).extras.sourceVtf,view=document.bufferViews[meta.bufferView],at=28+jsonSize+(view.byteOffset||0);
 return {name,compressed:bytes.subarray(at,at+view.byteLength).toString('base64')};
});
(async()=>{
 const root=p=>JSON.stringify(path.join(reference,'src',p));
 const bundle=await build({stdin:{contents:`export * as THREE from 'three';export {unzlibSync} from 'fflate';export {SourceNativeTextures,sourceNativeCube} from './src/render/source-vtf';export {VTF} from ${root('SourceEngine/VTF.ts')};export {default as Slice} from ${root('ArrayBufferSlice.ts')};export {createSwapChainForWebGL2,GfxPlatformWebGL2Config} from ${root('gfx/platform/GfxPlatformWebGL2.ts')};`,resolveDir:process.cwd()},bundle:true,format:'iife',globalName:'vtfReferenceGpu',write:false,define:{'process.env.NODE_ENV':'"production"'}});
 const browser=await chromium.launch({headless:true,args:['--no-sandbox']});
 try{
  const page=await browser.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));page.on('console',m=>{if(m.type()==='error')errors.push(m.text())});
  await page.addScriptTag({content:bundle.outputFiles[0].text});
  const results=await page.evaluate(async fixtures=>{
   const {THREE:T,unzlibSync,SourceNativeTextures,sourceNativeCube,VTF,Slice,createSwapChainForWebGL2,GfxPlatformWebGL2Config}=vtfReferenceGpu;
   const size=64,canvas=document.createElement('canvas');canvas.width=canvas.height=size;
   const gl=canvas.getContext('webgl2',{antialias:false,preserveDrawingBuffer:true}),device=createSwapChainForWebGL2(gl,new GfxPlatformWebGL2Config()).getDevice();
   const renderer=new T.WebGLRenderer({antialias:false}),target=new T.WebGLRenderTarget(size,size,{depthBuffer:false}),scene=new T.Scene(),camera=new T.Camera(),geometry=new T.PlaneGeometry(2,2),mesh=new T.Mesh(geometry);scene.add(mesh);
   const uploads=[];
   for(const fixture of fixtures)for(const srgb of [false,true]){
    const raw=unzlibSync(Uint8Array.from(atob(fixture.compressed),c=>c.charCodeAt(0))),view=new DataView(raw.buffer),cube=!!(view.getUint32(20,true)&0x4000),width=view.getUint16(16,true),height=view.getUint16(18,true);
    const native=new VTF(device,{createSampler:d=>device.createSampler(d)},new Slice(raw.buffer),fixture.name,srgb),originals=Array.from({length:cube?6:1},()=>new T.Texture({width,height})),owned=[];
    const parser={json:{textures:Array.from({length:cube?6:1},(_,face)=>({extras:{sourceVtf:{bufferView:0,path:fixture.name,frame:0,face}}}))},getDependency:async (kind,index)=>kind==='texture'?originals[index]:raw.buffer};
    const loader=new SourceNativeTextures(parser,{own:value=>{owned.push(value);return value}},renderer),textures=await Promise.all(parser.json.textures.map((_,i)=>loader.get(i,srgb?T.SRGBColorSpace:T.NoColorSpace))),texture=cube?sourceNativeCube(textures):textures[0];texture.colorSpace=srgb?T.SRGBColorSpace:T.NoColorSpace;
    uploads.push({fixture,srgb,cube,native,texture,originals,owned});
   }
   const compile=(type,source)=>{const shader=gl.createShader(type);gl.shaderSource(shader,source);gl.compileShader(shader);if(!gl.getShaderParameter(shader,gl.COMPILE_STATUS))throw Error(gl.getShaderInfoLog(shader));return shader};
   const results=[];
   for(const upload of uploads){
    const {fixture,srgb,cube,native,texture}=upload;
    const vertex='precision highp float;in vec3 position;void main(){gl_Position=vec4(position.xy,0.,1.);}',fragment=`precision highp float;uniform ${cube?'samplerCube':'sampler2D'} tex;uniform float lod;uniform vec2 scale,offset;out vec4 color;void main(){vec2 uv=gl_FragCoord.xy/64.*scale+offset;${cube?'vec3 coord=vec3(1.,uv);':'vec2 coord=uv;'}color=lod<0.?texture(tex,coord):textureLod(tex,coord,lod);}`;
    const vs=compile(gl.VERTEX_SHADER,'#version 300 es\n'+vertex),fs=compile(gl.FRAGMENT_SHADER,'#version 300 es\n'+fragment),program=gl.createProgram();gl.attachShader(program,vs);gl.attachShader(program,fs);gl.linkProgram(program);if(!gl.getProgramParameter(program,gl.LINK_STATUS))throw Error(gl.getProgramInfoLog(program));
    gl.useProgram(program);const buffer=gl.createBuffer();gl.bindBuffer(gl.ARRAY_BUFFER,buffer);gl.bufferData(gl.ARRAY_BUFFER,new Float32Array([-1,-1,0,3,-1,0,-1,3,0]),gl.STATIC_DRAW);const position=gl.getAttribLocation(program,'position');gl.enableVertexAttribArray(position);gl.vertexAttribPointer(position,3,gl.FLOAT,false,0,0);
    gl.activeTexture(gl.TEXTURE0);gl.bindTexture(cube?gl.TEXTURE_CUBE_MAP:gl.TEXTURE_2D,native.gfxTextures[0].gl_texture);gl.bindSampler(0,native.gfxSampler.gl_sampler);gl.uniform1i(gl.getUniformLocation(program,'tex'),0);gl.viewport(0,0,size,size);gl.disable(gl.DEPTH_TEST);gl.disable(gl.CULL_FACE);gl.disable(gl.BLEND);
    const material=new T.RawShaderMaterial({glslVersion:T.GLSL3,vertexShader:vertex,fragmentShader:fragment,depthTest:false,depthWrite:false,blending:T.NoBlending,uniforms:{tex:{value:texture},lod:{value:0},scale:{value:new T.Vector2()},offset:{value:new T.Vector2()}}});mesh.material=material;
    for(const lod of [0,1.5,-1])for(const scale of [[1,1],[8,.5],[.1,7]]){
     const offset=[-.37,.29];gl.uniform1f(gl.getUniformLocation(program,'lod'),lod);gl.uniform2fv(gl.getUniformLocation(program,'scale'),scale);gl.uniform2fv(gl.getUniformLocation(program,'offset'),offset);gl.drawArrays(gl.TRIANGLES,0,3);const expected=new Uint8Array(size*size*4);gl.readPixels(0,0,size,size,gl.RGBA,gl.UNSIGNED_BYTE,expected);
     material.uniforms.lod.value=lod;material.uniforms.scale.value.fromArray(scale);material.uniforms.offset.value.fromArray(offset);renderer.setRenderTarget(target);renderer.render(scene,camera);const actual=new Uint8Array(expected.length);renderer.readRenderTargetPixels(target,0,0,size,size,actual);
     let maximum=0,different=0;for(let i=0;i<actual.length;i++){if(cube&&i%4===3)continue;const delta=Math.abs(actual[i]-expected[i]);maximum=Math.max(maximum,delta);if(delta)different++}
     results.push({name:fixture.name,srgb,cube,lod,scale,maximum,different});
    }
    material.dispose();gl.deleteBuffer(buffer);gl.deleteProgram(program);gl.deleteShader(vs);gl.deleteShader(fs);
   }
   for(const u of uploads){u.native.destroy(device);device.destroySampler(u.native.gfxSampler);if(u.cube)u.texture.dispose();for(const t of u.owned)t.dispose();for(const original of u.originals)original.dispose()}
   target.dispose();geometry.dispose();renderer.dispose();return results;
  },fixtures);
  console.log(JSON.stringify({results,errors}));assert.deepEqual(errors,[]);for(const result of results)assert.equal(result.maximum,0,JSON.stringify(result));
 }finally{await browser.close()}
})().catch(error=>{console.error(error);process.exitCode=1});
