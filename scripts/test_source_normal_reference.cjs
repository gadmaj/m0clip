/** Compare imported materials with actual noclip GLSL on nonunit/interpolated normals. */
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const {fixture,png}=require('./source_material_fixture.cjs');
const root=process.env.NOCLIP_REFERENCE||path.resolve('../noclip.website');
const base=fs.readFileSync(path.join(root,'src/SourceEngine/Materials/MaterialBase.ts'),'utf8');
const generic=fs.readFileSync(path.join(root,'src/SourceEngine/Materials/Material_Generic.ts'),'utf8');
const library=fs.readFileSync(path.join(root,'src/gfx/helpers/GfxShaderLibrary.ts'),'utf8');
function section(source,start,end){const first=source.indexOf(start),last=source.indexOf(end,first);assert.ok(first>=0&&last>first,start);return source.slice(first,last)}
function fn(source,name){const start=source.search(new RegExp('(?:vec[234]|float|SpecularLightResult) '+name+'\\('));assert.ok(start>=0,name);let end=source.indexOf('{',start),depth=1;while(depth){end++;if(source[end]==='{')depth++;if(source[end]==='}')depth--;assert.ok(end<source.length,name)}return source.slice(start,end+1)}
const native=[section(library,'float saturate(float','\n`;'),section(library,'float invlerp(float','\n`;'),
 fn(base,'CalcReflection'),fn(base,'CalcTangentToWorld'),fn(base,'CalcFresnelTerm2'),fn(base,'CalcFresnelTerm2Ranges'),
 section(generic,'struct WorldLight {','\nlayout(std140)'),fn(generic,'ApplyAttenuation'),fn(generic,'WorldLightCalcAttenuation'),fn(generic,'WorldLightCalcDirection'),fn(generic,'WorldLightCalcVisibility'),fn(generic,'WorldLightCalcDiffuse'),fn(generic,'AmbientLight'),
 section(generic,'struct SpecularLightResult {','\nSpecularLightResult WorldLightCalcAllSpecular(')]
 .join('\n').replace(/\$\{ShaderWorldLightType\.(None|Point|Spot|Directional)\}/g,(_,name)=>({None:0,Point:1,Spot:2,Directional:3})[name]);
const projected=section(generic,'vec3 t_WorldToProjectedLight =','\n        if (any(greaterThan(t_ProjectedLightColor');
const projectedSpecular=section(generic,'vec3 t_Reflect = CalcReflection(t_SpecularLightInput.NormalWorld','\n            }');
const cases=[
 {name:'short-bump',world:true,bump:[128,128,191,255]},
 {name:'short-phong',phong:true,bump:[128,128,191,255],ambient:true},
 {name:'smooth-phong',phong:true,smooth:true,ambient:true},
 {name:'smooth-short-phong',phong:true,smooth:true,bump:[128,128,191,255],ambient:true},
 {name:'reflection-fresnel',world:true,bump:[128,128,191,255],reflection:true},
 {name:'phong-reflection-fresnel',phong:true,bump:[128,128,191,255],reflection:true,fresnel:[0,.25,1]},
 {name:'long-specular',phong:true,bump:[255,255,255,255],light:true},
];
function materialFixture(config){
 const data=fixture(config.world?'world':'phong'),meta=data.materials[0].extras.sourceMaterial;
 meta.phong=!!config.phong;meta.phongtint=[1,1,1];meta.phongfresnelranges=config.fresnel||(config.light?[1,1,1]:[0,0,0]);
 if(config.bump)data.images[0].uri='data:image/png;base64,'+png(config.bump).toString('base64');
 else{delete meta.bumpmapIndex;delete data.materials[0].normalTexture}
 if(config.smooth){const bytes=Buffer.from(data.buffers[0].uri.split(',')[1],'base64'),view=data.bufferViews[1];const normals=new Float32Array(bytes.buffer,bytes.byteOffset+view.byteOffset,18);for(let i=0;i<6;i++){normals[i*3]=[0,0,.8,0,.8,.8][i];normals[i*3+1]=0;normals[i*3+2]=[1,1,.6,1,.6,.6][i]}data.buffers[0].uri='data:application/octet-stream;base64,'+bytes.toString('base64')}
 if(!config.world){const lighting=data.nodes[0].extras.sourceLighting;lighting.cube=Array.from({length:6},()=>config.ambient?[1,1,1]:[0,0,0]);lighting.lights=config.light?[{kind:3,pos:[0,0,0],color:[.125,.0625,.03125],normal:[-2/3,-2/3,1/3],attenuation:[1,0,0],inner:0,outer:0,exponent:1}]:[]}
 if(config.reflection){Object.assign(meta,{envmap:'env_cubemap',envmapFaces:[5,5,5,5,5,5],envmaptint:[.25,.125,.0625],envmapfresnel:0});data.materials[0].pbrMetallicRoughness.baseColorFactor=[0,0,0,1]}
 return data;
}
(async()=>{
 const browser=await chromium.launch({headless:false,args:['--no-sandbox','--ozone-platform=x11']});
 try{
  const page=await browser.newPage({deviceScaleFactor:.25}),errors=[];
  page.on('pageerror',e=>errors.push(e.message));page.on('console',m=>{if(m.type()==='error'&&/shader|WebGLProgram/.test(m.text()))errors.push(m.text())});
  const expose=source=>require('./expose-app.cjs')(source).replaceAll('this.renderLoop()','void 0');
  for(const pattern of['**/src/main.ts*','**/assets/main-*.js'])await page.route(pattern,async route=>{const response=await route.fetch();await route.fulfill({response,body:expose(await response.text())})});
  await page.addInitScript(()=>localStorage.setItem('ume-prefs',JSON.stringify({robot:'r1',terrain:'flat'})));
  await page.route('**/assets/source/flashlight.png',route=>route.fulfill({contentType:'image/png',body:png([64,64,64,255])}));
  let config=cases[0];await page.route('**/nt_ghost_ctg/visual.glb*',route=>route.fulfill({contentType:'model/gltf+json',body:JSON.stringify(materialFixture(config))}));
  await page.route('**/nt_ghost_ctg/manifest.json',route=>route.fulfill({json:{}}));
  for(const file of['lighting.json','lightstyles.json'])await page.route('**/nt_ghost_ctg/'+file,route=>route.fulfill({status:404,body:''}));
  await page.goto((process.env.BASE_URL||'http://127.0.0.1:5176')+'/?plain&body=stock').then(() => require('./launch-scene.cjs').launchScene(page));await page.waitForFunction(()=>window.__app?.lastFrame&&window.__app.view.flashlight.ready,null,{timeout:120000});
  const results=[];
  for(config of cases){
   const result=await page.evaluate(async({config,native,projected,projectedSpecular})=>{
    const v=window.__app.view;await v.setTerrainVisual(null);await v.setTerrainVisual(window.__app.sourceForTerrain('map:nt_ghost_ctg'));v.setDisplay({...v.display,robot:false});v.setSourceLighting(true);v.sourceColorMap=false;v.sourceAmbient.linearOutput.value=1;v.flashlight.cookie.value.colorSpace='';v.flashlight.cookie.value.needsUpdate=true;
    const camera=v.camera;camera.position.set(0,0,0);camera.quaternion.set(0,0,0,1);camera.aspect=1;camera.fov=60;camera.updateProjectionMatrix();
    v.beginOffscreen(64,64,{transparent:true,floor:false});
    const read=()=>{const canvas=document.createElement('canvas');canvas.width=canvas.height=64;const ctx=canvas.getContext('2d');ctx.drawImage(v.renderer.domElement,0,0);return Array.from(ctx.getImageData(32,32,1,1).data)};
    v.setFlashlight(false);v.renderWith(camera);const off=read();v.setFlashlight(true);v.renderWith(camera);const on=read();v.setFlashlight(false);v.endOffscreen();
    // Execute the upstream functions unchanged on a separate WebGL2 context.
    const canvas=document.createElement('canvas');canvas.width=canvas.height=64;const gl=canvas.getContext('webgl2',{antialias:false,preserveDrawingBuffer:true});
    const compile=(kind,source)=>{const shader=gl.createShader(kind);gl.shaderSource(shader,source);gl.compileShader(shader);if(!gl.getShaderParameter(shader,gl.COMPILE_STATUS))throw new Error(gl.getShaderInfoLog(shader));return shader};
    const vs=`#version 300 es\nprecision highp float;uniform mat4 projection;in vec3 position,normal;out vec3 v_PositionWorld,v_Basis0,v_Basis1,v_Basis2;void main(){v_PositionWorld=position;v_Basis2=normalize(normal);v_Basis0=vec3(1,0,0);v_Basis1=cross(v_Basis2,v_Basis0);gl_Position=projection*vec4(position,1);}`;
    const bump=config.bump?config.bump.slice(0,3).map(v=>(v/255*2-1).toFixed(10)).join(','):null;
    const fs=`#version 300 es\nprecision highp float;uniform vec4 u_AmbientCube[6];uniform vec4 u_ProjectedLightOrigin;uniform bool flashlight;in vec3 v_PositionWorld,v_Basis0,v_Basis1,v_Basis2;out vec4 color;${native}\nvoid main(){
     vec3 t_NormalWorld=${bump?`CalcTangentToWorld(vec3(${bump}),v_Basis0,v_Basis1,v_Basis2)`:'v_Basis2'};
     vec3 eye=normalize(-v_PositionWorld),albedo=vec3(.25,.125,.0625);vec3 diffuse=vec3(0),t_SpecularLighting=vec3(0);
     SpecularLightInput t_SpecularLightInput;t_SpecularLightInput.PositionWorld=v_PositionWorld;t_SpecularLightInput.NormalWorld=t_NormalWorld;t_SpecularLightInput.WorldDirectionToEye=eye;t_SpecularLightInput.Fresnel=${config.light?'1.0':'0.0'};t_SpecularLightInput.SpecularExponent=5.0;t_SpecularLightInput.RimExponent=1.0;
     ${config.ambient?'diffuse+=AmbientLight(t_NormalWorld);':''}
     ${config.light?'WorldLight light;light.Position=vec4(0,0,0,3);light.Color=vec4(.125,.0625,.03125,1);light.Direction=vec4(-2.0/3.0,-2.0/3.0,1.0/3.0,0);light.DistAttenuation=vec4(1,0,0,0);diffuse+=WorldLightCalcDiffuse(v_PositionWorld,t_NormalWorld,false,1.0,light);t_SpecularLighting+=WorldLightCalcSpecular(t_SpecularLightInput,light).SpecularLight;':''}
     if(flashlight){vec3 t_ProjectedLightColor=vec3(64.0/255.0);${projected}diffuse+=t_ProjectedLightColor;${config.phong?projectedSpecular:''}}
     vec3 result=albedo*diffuse+t_SpecularLighting;
     ${config.reflection?`result=vec3(.25,.125,.0625)*${config.phong?`CalcFresnelTerm2Ranges(dot(t_NormalWorld,eye),vec3(${(config.fresnel||[0,0,0]).map(v=>v.toFixed(8)).join(',')}))`:'CalcFresnelTerm2(dot(t_NormalWorld,eye))'}+t_SpecularLighting;`:''}
     color=vec4(result,1);
    }`;
    const program=gl.createProgram(),vertex=compile(gl.VERTEX_SHADER,vs),fragment=compile(gl.FRAGMENT_SHADER,fs);gl.attachShader(program,vertex);gl.attachShader(program,fragment);gl.linkProgram(program);if(!gl.getProgramParameter(program,gl.LINK_STATUS))throw new Error(gl.getProgramInfoLog(program));gl.useProgram(program);
    gl.uniformMatrix4fv(gl.getUniformLocation(program,'projection'),false,camera.projectionMatrix.elements);gl.uniform4fv(gl.getUniformLocation(program,'u_AmbientCube[0]'),Array.from({length:6},()=>config.ambient?[1,1,1,0]:[0,0,0,0]).flat());gl.uniform4f(gl.getUniformLocation(program,'u_ProjectedLightOrigin'),0,0,-.254,25.4);
    let mesh;v.terrainObject.traverse(o=>{if(o.isMesh)mesh=o});const buffers=[];for(const name of['position','normal']){const buffer=gl.createBuffer();buffers.push(buffer);gl.bindBuffer(gl.ARRAY_BUFFER,buffer);gl.bufferData(gl.ARRAY_BUFFER,mesh.geometry.attributes[name].array,gl.STATIC_DRAW);const location=gl.getAttribLocation(program,name);gl.enableVertexAttribArray(location);gl.vertexAttribPointer(location,3,gl.FLOAT,false,0,0)}
    const draw=enabled=>{gl.uniform1i(gl.getUniformLocation(program,'flashlight'),enabled);gl.drawArrays(gl.TRIANGLES,0,6);const data=new Uint8Array(4);gl.readPixels(32,31,1,1,gl.RGBA,gl.UNSIGNED_BYTE,data);return Array.from(data)};
    const reference={off:draw(0),on:draw(1)};for(const buffer of buffers)gl.deleteBuffer(buffer);gl.deleteProgram(program);gl.deleteShader(vertex);gl.deleteShader(fragment);gl.getExtension('WEBGL_lose_context').loseContext();
    return{name:config.name,actual:{off,on},reference};
   },{config,native,projected,projectedSpecular});
   results.push(result);
  }
  console.log(JSON.stringify({results,errors}));
  assert.deepEqual(errors,[]);
  for(const result of results)for(const state of['off','on']){const actual=result.actual[state],expected=result.reference[state];for(let c=0;c<3;c++)assert.ok(Math.abs(actual[c]-expected[c])<=1,`${result.name} ${state}: ${actual} vs native ${expected}`);assert.equal(actual[3],255)}
 }finally{await browser.close()}
})().catch(e=>{console.error(e);process.exitCode=1});
