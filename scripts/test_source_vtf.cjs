/** Compare every frame/face/mip with noclip's actual VTF loader, plus RGBA fallback. */
const assert=require('node:assert/strict'),path=require('node:path'),{buildSync}=require('esbuild'),THREE=require('three');
function moduleFrom(options){const state={exports:{}};new Function('module','exports','require',buildSync({bundle:true,platform:'node',format:'cjs',write:false,logLevel:'silent',...options}).outputFiles[0].text)(state,state.exports,require);return state.exports}
const own=moduleFrom({entryPoints:['src/render/source-vtf.ts'],external:['three']});
const root=process.env.NOCLIP_REFERENCE||path.resolve('../noclip.website');
const native=moduleFrom({stdin:{contents:`export {VTF} from ${JSON.stringify(path.join(root,'src/SourceEngine/VTF.ts'))};export {default as Slice} from ${JSON.stringify(path.join(root,'src/ArrayBufferSlice.ts'))};`,resolveDir:root,loader:'ts'}});
function makeVtf({format=15,width=4,height=4,mips=3,frames=2,cube=false,minor=2,resource=false,flags=0}={}){
 const header=Buffer.alloc(resource?96:80);header.write('VTF\0');header.writeUInt32LE(7,4);header.writeUInt32LE(minor,8);header.writeUInt32LE(header.length,12);header.writeUInt16LE(width,16);header.writeUInt16LE(height,18);header.writeUInt32LE(flags|(cube?0x4000:0),20);header.writeUInt16LE(frames,24);header.writeUInt32LE(format,52);header[56]=mips;header.writeUInt32LE(0xffffffff,57);header.writeUInt16LE(1,65);
 if(resource){header.writeUInt32LE(1,68);header[80]=0x30;header.writeUInt32LE(96,84)}
 const parts=[header],bpp=({0:4,1:4,2:3,3:3,5:1,12:4,16:4})[format],faces=cube?(minor<5?7:6):1;
 for(let mip=mips-1;mip>=0;mip--){const w=Math.max(1,width>>mip),h=Math.max(1,height>>mip),size=bpp?w*h*bpp:Math.ceil(w/4)*Math.ceil(h/4)*(format===13?8:16);
  for(let frame=0;frame<frames;frame++)for(let face=0;face<faces;face++){const data=Buffer.alloc(size);for(let i=0;i<size;i++)data[i]=(mip*47+frame*23+face*11+i*17)%256;parts.push(data)}
 }
 const bytes=Buffer.concat(parts);return bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength);
}
(async()=>{
 let levels=0;
 for(const config of[{format:13},{format:14},{format:15},{format:0,cube:true},{format:15,cube:true},{format:15,cube:true,minor:5,resource:true},{format:12,minor:5,resource:true},{format:1},{format:2},{format:3},{format:5},{format:16}]){
  const buffer=makeVtf(config),uploaded=[],device={createTexture:descriptor=>({descriptor}),setResourceName(){},uploadTextureData:(texture,first,data)=>uploaded.push(data)},cache={createSampler:descriptor=>descriptor};
  const reference=new native.VTF(device,cache,new native.Slice(buffer),'fixture',false);
  for(let frame=0;frame<2;frame++)for(let face=0;face<(config.cube?6:1);face++){
   const parsed=own.parseSourceVtf(buffer,frame,face);assert.equal(parsed.levels.length,3);
   for(let mip=0;mip<3;mip++){
    const actual=parsed.levels[mip],bytes=config.format>=13&&config.format<=15?actual.data:own.decodeSourceMip(actual,parsed.format).data;
    const expected=new Uint8Array(uploaded[frame][mip].buffer,uploaded[frame][mip].byteOffset+face*bytes.length,bytes.length);
    assert.deepEqual(bytes,expected,JSON.stringify({config,frame,face,mip}));levels++;
   }
  }
  assert.equal(reference.numLevels,3);assert.equal(reference.gfxSampler.maxAnisotropy,16);
 }
 const rgba=own.decodeSourceMip({width:1,height:1,data:new Uint8Array([32,0,0,255,0,0,0,0])},13);assert.deepEqual(Array.from(rgba.data),[0,4,0,255]);
 const transparent=own.decodeSourceMip({width:1,height:1,data:new Uint8Array([0,0,255,255,255,255,255,255])},13);assert.deepEqual(Array.from(transparent.data),[0,0,0,0]);
 const buffer=makeVtf({format:15,minor:5,resource:true,flags:4|8}),image={width:4,height:4},original=new THREE.Texture(image);original.colorSpace=THREE.SRGBColorSpace;
 const owned=new Set(),parser={json:{textures:[{extras:{sourceVtf:{bufferView:0,path:'probe',frame:1,face:0}}}]},getDependency:async kind=>kind==='texture'?original:buffer};
 const context={own:value=>{owned.add(value);return value}},renderer={extensions:{has:()=>true},capabilities:{getMaxAnisotropy:()=>16}};
 const loader=new own.SourceNativeTextures(parser,context,renderer),texture=await loader.get(0,THREE.SRGBColorSpace);
 assert.equal(texture.format,THREE.RGBA_S3TC_DXT5_Format);assert.equal(texture.image,image);assert.equal(texture.mipmaps.length,3);assert.equal(texture.generateMipmaps,false);assert.equal(texture.anisotropy,16);assert.equal(texture.wrapS,THREE.ClampToEdgeWrapping);
 assert.equal(await loader.get(0,THREE.SRGBColorSpace),texture);assert.notEqual(await loader.get(0,THREE.NoColorSpace),texture);assert.equal(texture.colorSpace,THREE.SRGBColorSpace);assert.equal(original.format,THREE.RGBAFormat);assert.equal(original.mipmaps.length,0);
 const fallback=await new own.SourceNativeTextures(parser,context,{...renderer,extensions:{has:()=>false}}).get(0,THREE.SRGBColorSpace);assert.equal(fallback.format,THREE.RGBAFormat);for(let i=0;i<3;i++)assert.deepEqual(fallback.mipmaps[i].data,own.decodeSourceMip(texture.mipmaps[i],15).data);
 const zipped=require('node:zlib').deflateSync(new Uint8Array(buffer)),compressedBuffer=zipped.buffer.slice(zipped.byteOffset,zipped.byteOffset+zipped.byteLength);
 const compressedParser={json:{textures:[{extras:{sourceVtf:{...parser.json.textures[0].extras.sourceVtf,compression:'zlib'}}}]},getDependency:async kind=>kind==='texture'?original:compressedBuffer};
 const transported=await new own.SourceNativeTextures(compressedParser,context,renderer).get(0,THREE.SRGBColorSpace);assert.deepEqual(transported.mipmaps,texture.mipmaps);
 const cube=own.sourceNativeCube(Array(6).fill(texture));assert.equal(cube.format,texture.format);assert.equal(cube.generateMipmaps,false);assert.equal(cube.image[0].mipmaps.length,3);
 assert.throws(()=>own.parseSourceVtf(buffer,2),/frame or face/);assert.throws(()=>own.parseSourceVtf(buffer.slice(0,buffer.byteLength-1)),/Truncated/);
 for(const value of owned)value.dispose();cube.dispose();
 console.log(JSON.stringify({nativeLevelsCompared:levels,frames:true,cubemapFaces:true,resourceHeaders:true,rgbaFallback:true,colorSpaceVariants:true,originalImagePreserved:true}));
})().catch(error=>{console.error(error);process.exitCode=1});
