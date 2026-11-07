/** Native Source texture levels. VTF layout and sampling follow noclip.website
 * SourceEngine/VTF.ts (Copyright Jasper St. Pierre; MIT, LICENSE.noclip). */
import * as THREE from 'three';
import type { GLTFLoaderPlugin, GLTFParser } from 'three/addons/loaders/GLTFLoader.js';
import type { SourceMaterials } from './source-materials';
import { unzlibSync } from 'fflate';
import { readSourceVtf, type SourceVtf as SourceVtfLayout, type SourceVtfInput, type SourceVtfColorSpace } from '../maps/raw-source-vtf';
import { decodeSourceVtfPixels, sourceVtfPixelKind } from '../maps/raw-source-vtf-codec';

export interface SourceMip { width:number; height:number; data:Uint8Array }
export interface SourceVtf { width:number; height:number; faces:1|6; flags:number; format:number; colorSpace:SourceVtfColorSpace; levels:SourceMip[] }
export interface SourceDecodedMip { width:number; height:number; data:Uint8Array|Float32Array }
interface SourceVtfMetadata {
  bufferView:number;frame:number;face:number;path:string;compression?:'zlib';
  image?:{name?:string;extras?:Record<string,unknown>};
}
interface SourceTextureDefinition {
  name?:string;
  extras?:{sourceVtf?:SourceVtfMetadata};
  extensions?:{M0CLIP_texture_vtf?:SourceVtfMetadata};
}

const blockFormats:Record<number,number>={13:8,14:16,15:16,20:8};

/** One frame/face of the shared layout; in-memory bytes are borrowed, never snapshotted. */
async function selectSourceVtf(layout:SourceVtfLayout,frame:number,face:number):Promise<SourceVtf> {
  const header=layout.header;
  if(header.depth!==1)throw new Error(`Source VTF: GPU 3D texture upload is unsupported (depth ${header.depth}, format ${header.format}); no volume slice selected`);
  const levels=await Promise.all(layout.levels.map(async level=>{
    const encoded=await layout.encoded({frame,face,mip:level.mip});
    return{width:encoded.width,height:encoded.height,data:encoded.data};
  }));
  return{width:header.width,height:header.height,faces:header.faces,flags:header.flags,format:header.format,colorSpace:header.colorSpace,levels};
}

/** Exact shared CPU fallback: authored BC/raw bytes, linear HDR and signed UV. */
export function decodeSourceMip(mip:SourceMip,format:number):SourceDecodedMip {
  return{width:mip.width,height:mip.height,data:decodeSourceVtfPixels(mip.data,format,mip.width,mip.height)};
}

export class SourceNativeTextures implements GLTFLoaderPlugin {
  readonly name='M0CLIP_texture_vtf';
  private variants=new WeakMap<THREE.Texture,Map<string,Promise<THREE.Texture>>>();
  private parsed=new Map<number,Promise<SourceVtf>>();
  /** Keyed by buffer view AND transport: the same bytes are a different layout when inflated. */
  private layouts=new Map<string,Promise<SourceVtfLayout>>();
  constructor(private parser:GLTFParser,private context:SourceMaterials,private renderer:THREE.WebGLRenderer){}
  loadTexture(index:number):Promise<THREE.Texture>|null {
    const definition=this.parser.json.textures[index] as SourceTextureDefinition|undefined;
    const meta=definition?.extensions?.M0CLIP_texture_vtf;
    if(!meta)return null;
    return this.vtf(index,meta).then(vtf=>{
      let pixels:Uint8Array|Float32Array|undefined;
      const texture=this.context.own(new THREE.DataTexture());
      texture.image={width:vtf.width,height:vtf.height,get data(){return pixels??=decodeSourceMip(vtf.levels[0],vtf.format).data;}};
      texture.type=sourceVtfPixelKind(vtf.format)==='byte'?THREE.UnsignedByteType:THREE.FloatType;
      texture.name=definition?.name??meta.image?.name??'';
      texture.userData={...meta.image?.extras,...(texture.type===THREE.UnsignedByteType?{mimeType:'image/png'}:{})};
      this.parser.associations.set(texture,{textures:index});
      return texture;
    });
  }
  private vtf(index:number,meta:SourceVtfMetadata):Promise<SourceVtf>{
    // Parsing is per frame/face, while GLTFParser shares the underlying VTF buffer.
    let parsed=this.parsed.get(index);
    if(!parsed){
      if(meta.compression!==undefined&&meta.compression!=='zlib')return Promise.reject(new Error(`Source VTF: unsupported buffer compression ${meta.compression}: ${meta.path}`));
      const key=`${meta.bufferView}:${meta.compression??'none'}`;
      let layout=this.layouts.get(key);
      if(!layout){
        layout=this.parser.getDependency('bufferView',meta.bufferView).then((data:ArrayBuffer)=>{
          const bytes:SourceVtfInput=meta.compression==='zlib'?unzlibSync(new Uint8Array(data)):data;
          return readSourceVtf(bytes);
        });
        this.layouts.set(key,layout);
      }
      parsed=layout.then(data=>selectSourceVtf(data,meta.frame,meta.face));this.parsed.set(index,parsed);
    }
    return parsed;
  }
  async get(index:number,colorSpace:string=THREE.NoColorSpace):Promise<THREE.Texture>{
    const texture=this.context.own(await this.parser.getDependency('texture',index) as THREE.Texture);
    return this.restore(texture,index,colorSpace);
  }
  restore(original:THREE.Texture,index:number,colorSpace=original.colorSpace):Promise<THREE.Texture>{
    const definition=this.parser.json.textures[index] as SourceTextureDefinition|undefined;
    const meta=definition?.extensions?.M0CLIP_texture_vtf??definition?.extras?.sourceVtf;
    if(!meta){if(original.colorSpace!==colorSpace){original.colorSpace=colorSpace;original.needsUpdate=true;}return Promise.resolve(original);}
    let variants=this.variants.get(original);if(!variants){variants=new Map();this.variants.set(original,variants);}
    let result=variants.get(colorSpace);
    if(!result){
      result=(async()=>{
        const vtf=await this.vtf(index,meta);
        if(original.image.width!==vtf.width||original.image.height!==vtf.height)throw new Error(`Source texture dimensions differ: ${meta.path}`);
        const floating=sourceVtfPixelKind(vtf.format)!=='byte';
        // Sampler meaning is noclip's VTF.ts (forceTrilinear, 16x anisotropy unless
        // point/no-mip), as before; a single stored level has no chain to filter.
        const point=!!(vtf.flags&1),noMip=!!(vtf.flags&256)||vtf.levels.length===1;
        const maximum=vtf.faces===6?this.renderer.capabilities.maxCubemapSize:this.renderer.capabilities.maxTextureSize;
        if(vtf.width>maximum||vtf.height>maximum)throw new Error(`Source VTF: ${vtf.width}x${vtf.height} exceeds GPU ${vtf.faces===6?'cubemap':'texture'} limit ${maximum}: ${meta.path}`);
        if(floating&&!this.renderer.capabilities.isWebGL2)throw new Error(`Source VTF: format ${vtf.format} requires WebGL2 float texture sampling: ${meta.path}`);
        if(floating&&(!point||!noMip)&&!this.renderer.extensions.has('OES_texture_float_linear'))throw new Error(`Source VTF: format ${vtf.format} requires OES_texture_float_linear for linear filtering: ${meta.path}`);
        const block=blockFormats[vtf.format],compressed=!!block&&this.renderer.extensions.has('WEBGL_compressed_texture_s3tc')
          &&(colorSpace!==THREE.SRGBColorSpace||this.renderer.extensions.has('WEBGL_compressed_texture_s3tc_srgb'))
          &&vtf.levels.every(level=>(level.width<=2||level.width%4===0)&&(level.height<=2||level.height%4===0));
        const format=compressed?vtf.format===13||vtf.format===20?THREE.RGBA_S3TC_DXT1_Format:vtf.format===14?THREE.RGBA_S3TC_DXT3_Format:THREE.RGBA_S3TC_DXT5_Format:THREE.RGBAFormat;
        const texture=this.context.own(new THREE.CompressedTexture([],vtf.width,vtf.height));texture.copy(original);
        (texture as THREE.Texture).format=format;texture.type=floating?THREE.FloatType:THREE.UnsignedByteType;
        texture.colorSpace=floating||vtf.format===5?THREE.NoColorSpace:colorSpace;
        const nativeImage=definition?.extensions?.M0CLIP_texture_vtf&&original instanceof THREE.DataTexture?original.image as {data:Uint8Array|Float32Array}:null;
        texture.mipmaps=compressed?vtf.levels:vtf.levels.map((level,mip)=>nativeImage&&mip===0
          ?{width:level.width,height:level.height,data:nativeImage.data}:decodeSourceMip(level,vtf.format));
        // Keep exact export pixels, decoded only on demand for native-only assets.
        // Compressed upload reads width/height here and pixel data from mipmaps.
        texture.image=original.image;texture.flipY=false;texture.generateMipmaps=false;
        texture.wrapS=vtf.flags&4?THREE.ClampToEdgeWrapping:THREE.RepeatWrapping;
        texture.wrapT=vtf.flags&8?THREE.ClampToEdgeWrapping:THREE.RepeatWrapping;
        texture.magFilter=point?THREE.NearestFilter:THREE.LinearFilter;
        texture.minFilter=noMip?texture.magFilter:point?THREE.NearestMipmapLinearFilter:THREE.LinearMipmapLinearFilter;
        texture.anisotropy=!point&&!noMip?Math.min(16,this.renderer.capabilities.getMaxAnisotropy()):1;
        texture.userData={...original.userData,sourceNativeTexture:{path:meta.path,frame:meta.frame,face:meta.face,format:vtf.format,levels:vtf.levels.length,compressed,pixelType:floating?'rgba32f':'rgba8',colorSpace:vtf.colorSpace}};
        texture.needsUpdate=true;return texture;
      })();
      variants.set(colorSpace,result);
    }
    return result;
  }
}

export function sourceNativeCube(textures:THREE.Texture[]):THREE.CubeTexture {
  if(textures.length!==6)throw new Error(`Source cubemap requires six faces (received ${textures.length})`);
  const native=textures.every(texture=>texture.userData.sourceNativeTexture);
  if(!native&&textures.some(texture=>texture.userData.sourceNativeTexture))throw new Error('Source cubemap mixes native and generic faces');
  if(native&&textures.some(texture=>texture.image.width!==textures[0].image.width||texture.image.height!==textures[0].image.height
    ||texture.image.width!==texture.image.height||texture.format!==textures[0].format||texture.type!==textures[0].type
    ||texture.colorSpace!==textures[0].colorSpace||texture.mipmaps.length!==textures[0].mipmaps.length
    ||texture.minFilter!==textures[0].minFilter||texture.magFilter!==textures[0].magFilter
    ||texture.mipmaps.some((mip,i)=>{
      const current=mip as THREE.CompressedTextureMipmap,first=textures[0].mipmaps[i] as THREE.CompressedTextureMipmap;
      return current.width!==first.width||current.height!==first.height;
    })))throw new Error('Source cubemap faces differ in layout, format, color space or sampling');
  const cube=new THREE.CubeTexture(native?textures.map(texture=>({width:texture.image.width,height:texture.image.height,mipmaps:texture.mipmaps,isCompressedTexture:true})):textures.map(texture=>texture.image));
  if(native){
    // Three supports an array of compressed faces for both native BC and decoded RGBA.
    (cube as THREE.CubeTexture&{isCompressedTexture:boolean}).isCompressedTexture=true;
    cube.format=textures[0].format;cube.type=textures[0].type;cube.generateMipmaps=false;cube.minFilter=textures[0].minFilter;cube.magFilter=textures[0].magFilter;cube.anisotropy=textures[0].anisotropy;
    cube.userData.sourceNativeTexture={levels:textures[0].mipmaps.length,cube:true};
  }
  cube.colorSpace=native?textures[0].colorSpace:THREE.SRGBColorSpace;cube.needsUpdate=true;return cube;
}
