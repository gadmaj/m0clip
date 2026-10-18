/** Chromium: authored 2D/cube mip uploads and lossless native-texture exports. */
const assert=require('node:assert/strict'),{build}=require('esbuild'),{deflateSync}=require('node:zlib');
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const palette=[0xf800,0x07e0,0x001f,0xffff,0xffe0,0x07ff];
function fixture(format){
 const header=Buffer.alloc(96);header.write('VTF\0');header.writeUInt32LE(7,4);header.writeUInt32LE(5,8);header.writeUInt32LE(96,12);header.writeUInt16LE(4,16);header.writeUInt16LE(4,18);header.writeUInt32LE(0x4000|4|8,20);header.writeUInt16LE(1,24);header.writeUInt32LE(format,52);header[56]=3;header.writeUInt32LE(0xffffffff,57);header.writeUInt16LE(1,65);header.writeUInt32LE(1,68);header[80]=0x30;header.writeUInt32LE(96,84);
 const blocks=[];for(let mip=2;mip>=0;mip--)for(let face=0;face<6;face++){const block=Buffer.alloc(format===13?8:16);block.writeUInt16LE(palette[(mip+face)%palette.length],format===13?0:8);if(format===14)block.fill([255,119,0][mip],0,8);if(format===15)block[0]=[255,64,0][mip];blocks.push(block)}
 return [...deflateSync(Buffer.concat([header,...blocks]))];
}
function pngPixels(png){
 const image=Buffer.from(png),chunks=[];let width,height;
 for(let at=8;at+12<=image.length;){const size=image.readUInt32BE(at),type=image.toString('ascii',at+4,at+8);if(type==='IHDR'){width=image.readUInt32BE(at+8);height=image.readUInt32BE(at+12)}if(type==='IDAT')chunks.push(image.subarray(at+8,at+8+size));if(type==='IEND')break;at+=size+12}
 const raw=require('fflate').unzlibSync(Buffer.concat(chunks)),pixels=[];
 for(let y=0;y<height;y++){assert.equal(raw[y*(width*4+1)],0);pixels.push(...raw.subarray(y*(width*4+1)+1,(y+1)*(width*4+1)))}
 return pixels;
}
(async()=>{
 const bundle=await build({stdin:{contents:"export * as THREE from 'three';export * from './src/render/source-vtf';export {GLTFExporter} from 'three/examples/jsm/exporters/GLTFExporter.js';export {prepareLosslessTextures} from './src/record/lossless-textures';export {losslessImageWriter} from './src/record/lossless-images';export {encodeRgbaPNG} from './src/record/png';export {sourceTextureControl,setSourceTexturesEnabled} from './src/render/source-textures';",resolveDir:process.cwd()},bundle:true,format:'iife',globalName:'nativeVtfTest',write:false});
 const browser=await chromium.launch({headless:true,args:['--no-sandbox']});
 try{
  const page=await browser.newPage(),errors=[];page.on('pageerror',error=>errors.push(error.message));page.on('console',message=>{if(message.type()==='error')errors.push(message.text())});await page.addScriptTag({content:bundle.outputFiles[0].text});
  const proof=await page.evaluate(async bytes=>{
   const {THREE,SourceNativeTextures,sourceNativeCube,GLTFExporter,prepareLosslessTextures,losslessImageWriter,encodeRgbaPNG,sourceTextureControl,setSourceTexturesEnabled}=nativeVtfTest;
   const renderer=new THREE.WebGLRenderer({alpha:true}),target=new THREE.WebGLRenderTarget(1,1,{depthBuffer:false}),scene=new THREE.Scene(),camera=new THREE.Camera(),geometry=new THREE.PlaneGeometry(2,2);
   const rgba=new Uint8Array(64);for(let i=0;i<16;i++){rgba[i*4]=22+i;rgba[i*4+1]=45+i;rgba[i*4+2]=67+i;rgba[i*4+3]=[0,64,128,255][i%4]}
   const image=await createImageBitmap(new Blob([encodeRgbaPNG(4,4,rgba)],{type:'image/png'}),{premultiplyAlpha:'none',colorSpaceConversion:'none'}),originals=Array.from({length:6},()=>{const texture=new THREE.Texture(image);texture.flipY=false;return texture});
   const material=(cube)=>new THREE.RawShaderMaterial({glslVersion:THREE.GLSL3,depthTest:false,depthWrite:false,blending:THREE.NoBlending,uniforms:{inputImage:{value:null},lod:{value:0},direction:{value:new THREE.Vector3(1,0,0)}},vertexShader:'precision highp float;in vec3 position;void main(){gl_Position=vec4(position.xy,0,1);}',fragmentShader:`precision highp float;uniform ${cube?'samplerCube':'sampler2D'} inputImage;uniform float lod;uniform vec3 direction;out vec4 color;void main(){color=textureLod(inputImage,${cube?'direction':'vec2(.5)'},lod);}`});
   const flat=material(false),cubeMaterial=material(true),mesh=new THREE.Mesh(geometry,flat);scene.add(mesh);
   const sample=(texture,cube,lod,direction)=>{mesh.material=cube?cubeMaterial:flat;mesh.material.uniforms.inputImage.value=texture;mesh.material.uniforms.lod.value=lod;if(direction)mesh.material.uniforms.direction.value.fromArray(direction);renderer.setRenderTarget(target);renderer.render(scene,camera);const pixels=new Uint8Array(4);renderer.readRenderTargetPixels(target,0,0,1,1,pixels);return [...pixels]};
   const results=[],exports=[];
   for(const {format,data} of bytes)for(const fallback of [false,true]){
    let bufferReads=0;const owned=new Set(),context={own:value=>{owned.add(value);return value}},parser={json:{textures:originals.map((_,face)=>({extras:{sourceVtf:{path:'fixture/cube',bufferView:0,frame:0,face,compression:'zlib'}}}))},getDependency:async(kind,index)=>{if(kind==='texture')return originals[index];bufferReads++;return new Uint8Array(data).buffer}};
    const device=fallback?{extensions:{has:()=>false},capabilities:renderer.capabilities}:renderer,loader=new SourceNativeTextures(parser,context,device),textures=await Promise.all(originals.map((_,index)=>loader.get(index,THREE.SRGBColorSpace))),cube=sourceNativeCube(textures);
    const directions=[[1,0,0],[-1,0,0],[0,1,0],[0,-1,0],[0,0,1],[0,0,-1]],samples=[];
    for(let face=0;face<6;face++)for(let mip=0;mip<3;mip++)samples.push({face,mip,pixels:sample(cube,true,mip,directions[face])});
    const flatSamples=Array.from({length:3},(_,mip)=>sample(textures[0],false,mip));
    results.push({format,fallback,compressed:textures[0].userData.sourceNativeTexture.compressed,bufferReads,flatSamples,samples});
    // Both compressed and decoded textures export their retained original PNG,
    // including RGB under alpha=0. Gray diffuse keeps original normal/mask pixels.
    for(const gray of [false,true]){
     const live=new THREE.MeshStandardMaterial({map:textures[0],normalMap:textures[0]}),geo=new THREE.PlaneGeometry();geo.setAttribute('tangent',new THREE.Float32BufferAttribute([1,0,0,1,1,0,0,1,1,0,0,1,1,0,0,1],4));const a=new THREE.Mesh(geo,live),b=a.clone(),root=new THREE.Group();root.add(a,b);sourceTextureControl(live);setSourceTexturesEnabled(live,!gray);
     const cleanup=prepareLosslessTextures(root),copy=a.material,prepared=copy!==live&&b.material===copy&&!copy.map.isCompressedTexture&&copy.map.format===THREE.RGBAFormat&&copy.map.mipmaps.length===0&&!copy.map.userData.sourceNativeTexture&&(!gray||copy.map.image!==copy.normalMap.image);
     renderer.setRenderTarget(null);const writer=losslessImageWriter(renderer);let glb;try{glb=await new GLTFExporter().register(writer.plugin).parseAsync(root,{binary:true})}finally{writer.dispose();cleanup()}
     const header=new DataView(glb),length=header.getUint32(12,true),json=JSON.parse(new TextDecoder().decode(new Uint8Array(glb,20,length))),entry=json.materials[0],read=index=>{const image=json.images[json.textures[index].source],view=json.bufferViews[image.bufferView];return{mime:image.mimeType,png:[...new Uint8Array(glb,28+length+(view.byteOffset||0),view.byteLength)]}};
     exports.push({format,fallback,gray,prepared,restored:a.material===live&&b.material===live&&live.map===textures[0]&&textures[0].image===image&&textures[0].mipmaps.length===3,map:read(entry.pbrMetallicRoughness.baseColorTexture.index),normal:read(entry.normalTexture.index)});geo.dispose();live.dispose();
    }
    cube.dispose();for(const value of owned)value.dispose();
   }
   renderer.setRenderTarget(null);target.dispose();flat.dispose();cubeMaterial.dispose();geometry.dispose();for(const texture of originals)texture.dispose();image.close();renderer.dispose();return{results,exports,expected:[...rgba]};
  },[13,14,15].map(format=>({format,data:fixture(format)})));
  const colors=[[255,0,0,255],[0,255,0,255],[0,0,255,255],[255,255,255,255],[255,255,0,255],[0,255,255,255]];
  let samples=0;for(const result of proof.results){const expected=(face,mip)=>[...colors[(face+mip)%6].slice(0,3),result.format===14?[255,119,0][mip]:result.format===15?[255,64,0][mip]:255];assert.equal(result.bufferReads,1);if(result.fallback)assert.equal(result.compressed,false);else assert.equal(result.compressed,true,'Chromium must exercise native S3TC upload too');for(let mip=0;mip<3;mip++){assert.deepEqual(result.flatSamples[mip],expected(0,mip));samples++}for(const value of result.samples){assert.deepEqual(value.pixels,expected(value.face,value.mip),JSON.stringify({format:result.format,fallback:result.fallback,face:value.face,mip:value.mip}));samples++}}
  for(const result of proof.exports){assert.ok(result.prepared&&result.restored);assert.equal(result.map.mime,'image/png');assert.equal(result.normal.mime,'image/png');assert.deepEqual(pngPixels(result.normal.png),proof.expected);assert.deepEqual(pngPixels(result.map.png),result.gray?proof.expected.map((v,i)=>i%4===3?v:188):proof.expected)}
  assert.deepEqual(errors,[]);console.log(JSON.stringify({gpuSamples:samples,nativeS3TC:true,rgbaFallback:true,sharedVtfInflation:true,losslessExports:proof.exports.length,rgbUnderZeroAlpha:true,grayDiffuseOnly:true,liveRestored:true,errors}));
 }finally{await browser.close()}
})().catch(error=>{console.error(error);process.exitCode=1});
