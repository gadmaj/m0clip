/** Native Source texture levels. VTF layout and sampling follow noclip.website
 * SourceEngine/VTF.ts (Copyright Jasper St. Pierre; MIT, LICENSE.noclip). */
import * as THREE from 'three';
import type { GLTFParser } from 'three/addons/loaders/GLTFLoader.js';
import type { SourceMaterials } from './source-materials';
import { unzlibSync } from 'fflate';

export interface SourceMip { width:number; height:number; data:Uint8Array }
export interface SourceVtf { width:number; height:number; flags:number; format:number; levels:SourceMip[] }
const rawFormats:Record<number,string>={0:'RGBA',1:'ABGR',2:'RGB',3:'BGR',5:'I',6:'IA',8:'A',11:'ARGB',12:'BGRA',16:'BGRX'};
const blockFormats:Record<number,number>={13:8,14:16,15:16,20:8};
function levelSize(format:number,width:number,height:number){
  const block=blockFormats[format];if(block)return Math.ceil(width/4)*Math.ceil(height/4)*block;
  const order=rawFormats[format];if(!order)throw new Error(`Unsupported Source texture format ${format}`);
  return width*height*order.length;
}

export function parseSourceVtf(buffer:ArrayBuffer,frame=0,face=0):SourceVtf {
  const view=new DataView(buffer);
  const requireBytes=(offset:number,size:number)=>{if(offset<0||size<0||offset+size>buffer.byteLength)throw new Error('Truncated Source texture');};
  requireBytes(0,64);
  if(view.getUint32(0,true)!==0x00465456||view.getUint32(4,true)!==7)throw new Error('Invalid Source texture');
  const minor=view.getUint32(8,true);if(minor>5)throw new Error('Unsupported Source texture version');
  if(minor>=2)requireBytes(0,80);
  const width=view.getUint16(16,true),height=view.getUint16(18,true),flags=view.getUint32(20,true);
  const frames=view.getUint16(24,true),format=view.getUint32(52,true),count=view.getUint8(56);
  const depth=minor>=2?Math.max(1,view.getUint16(65,true)):1;
  const faces=flags&0x4000?6:1,storedFaces=faces===6&&minor<5?7:faces;
  if(!width||!height||!count||count>1+Math.floor(Math.log2(Math.max(width,height))))throw new Error('Invalid Source mip chain');
  if(!Number.isInteger(frame)||frame<0||frame>=frames||!Number.isInteger(face)||face<0||face>=faces)throw new Error('Source texture frame or face out of range');
  if(depth!==1)throw new Error('Source volume textures are not supported');
  const resources=minor>=3?view.getUint32(68,true):0;
  let offset=minor>=2?80:64;
  if(resources){
    requireBytes(80,resources*8);let found=false;
    for(let i=0;i<resources;i++){
      const at=80+i*8;
      if(view.getUint8(at)===0x30&&view.getUint8(at+1)===0&&view.getUint8(at+2)===0&&view.getUint8(at+3)!==2){offset=view.getUint32(at+4,true);found=true;}
    }
    if(!found)throw new Error('Source texture image resource is missing');
  }else{
    const lowFormat=view.getUint32(57,true);
    if(lowFormat!==0xffffffff)offset+=levelSize(lowFormat,view.getUint8(61),view.getUint8(62));
  }
  const levels:SourceMip[]=Array(count);
  for(let level=count-1;level>=0;level--){
    const w=Math.max(1,width>>level),h=Math.max(1,height>>level),size=levelSize(format,w,h);
    requireBytes(offset,size*frames*storedFaces);
    levels[level]={width:w,height:h,data:new Uint8Array(buffer,offset+(frame*storedFaces+face)*size,size)};
    offset+=size*frames*storedFaces;
  }
  return{width,height,flags,format,levels};
}

/** RGBA fallback for devices without S3TC; retains authored levels and alpha. */
export function decodeSourceMip(mip:SourceMip,format:number):SourceMip {
  const {width,height,data}=mip,out=new Uint8Array(width*height*4),order=rawFormats[format];
  if(order){
    out.fill(255);
    for(let i=0;i<width*height;i++)for(let channel=0;channel<order.length;channel++){
      const c=order[channel],value=data[i*order.length+channel];
      if(c==='I'){out[i*4]=out[i*4+1]=out[i*4+2]=value;}
      else{const target='RGBA'.indexOf(c);if(target>=0)out[i*4+target]=value;}
    }
  }else{
    const size=blockFormats[format];if(!size)throw new Error(`Unsupported Source texture format ${format}`);
    const color=(value:number)=>{const r=value>>11&31,g=value>>5&63,b=value&31;return[r<<3|r>>2,g<<2|g>>4,b<<3|b>>2,255];};
    for(let by=0,at=0;by<Math.ceil(height/4);by++)for(let bx=0;bx<Math.ceil(width/4);bx++,at+=size){
      const colorAt=at+(size===8?0:8),c0=data[colorAt]|data[colorAt+1]<<8,c1=data[colorAt+2]|data[colorAt+3]<<8;
      const a=color(c0),b=color(c1),four=size!==8||c0>c1;
      const palette=[a,b,four?a.map((v,i)=>i===3?255:Math.floor((2*v+b[i])/3)):a.map((v,i)=>i===3?255:Math.floor((v+b[i])/2)),four?a.map((v,i)=>i===3?255:Math.floor((v+2*b[i])/3)):[0,0,0,0]];
      const indices=(data[colorAt+4]|data[colorAt+5]<<8|data[colorAt+6]<<16|data[colorAt+7]<<24)>>>0;
      const alpha=[data[at],data[at+1]];
      if(format===15){
        if(alpha[0]>alpha[1])for(let i=1;i<=6;i++)alpha[i+1]=Math.floor(((7-i)*alpha[0]+i*alpha[1])/7);
        else{for(let i=1;i<=4;i++)alpha[i+1]=Math.floor(((5-i)*alpha[0]+i*alpha[1])/5);alpha[6]=0;alpha[7]=255;}
      }
      // Six alpha-index bytes fit exactly in a JS Number; avoid 32-bit truncation.
      let alphaBits=0;if(format===15)for(let i=0;i<6;i++)alphaBits+=data[at+2+i]*2**(i*8);
      for(let y=0;y<4;y++)for(let x=0;x<4;x++){
        const px=bx*4+x,py=by*4+y;if(px>=width||py>=height)continue;
        const i=y*4+x,to=(py*width+px)*4,pixel=palette[indices>>>(i*2)&3];out.set(pixel,to);
        if(format===14)out[to+3]=(data[at+(i>>1)]>>((i&1)*4)&15)*17;
        else if(format===15)out[to+3]=alpha[Math.floor(alphaBits/2**(i*3))%8];
      }
    }
  }
  return{width,height,data:out};
}

export class SourceNativeTextures {
  private variants=new WeakMap<THREE.Texture,Map<string,Promise<THREE.Texture>>>();
  private parsed=new Map<number,Promise<SourceVtf>>();
  private buffers=new Map<number,Promise<ArrayBuffer>>();
  constructor(private parser:GLTFParser,private context:SourceMaterials,private renderer:THREE.WebGLRenderer){}
  async get(index:number,colorSpace:string=THREE.NoColorSpace):Promise<THREE.Texture>{
    const texture=this.context.own(await this.parser.getDependency('texture',index) as THREE.Texture);
    return this.restore(texture,index,colorSpace);
  }
  restore(original:THREE.Texture,index:number,colorSpace=original.colorSpace):Promise<THREE.Texture>{
    const meta=this.parser.json.textures[index]?.extras?.sourceVtf as {bufferView:number;frame:number;face:number;path:string;compression?:'zlib'}|undefined;
    if(!meta){if(original.colorSpace!==colorSpace){original.colorSpace=colorSpace;original.needsUpdate=true;}return Promise.resolve(original);}
    let variants=this.variants.get(original);if(!variants){variants=new Map();this.variants.set(original,variants);}
    let result=variants.get(colorSpace);
    if(!result){
      result=(async()=>{
        // Parsing is per frame/face, while GLTFParser shares the underlying VTF buffer.
        let parsed=this.parsed.get(index);
        if(!parsed){
          let buffer=this.buffers.get(meta.bufferView);
          if(!buffer){buffer=this.parser.getDependency('bufferView',meta.bufferView).then((data:ArrayBuffer)=>{
            if(meta.compression!=='zlib')return data;
            const decoded=unzlibSync(new Uint8Array(data));return decoded.buffer.slice(decoded.byteOffset,decoded.byteOffset+decoded.byteLength) as ArrayBuffer;
          });this.buffers.set(meta.bufferView,buffer);}
          parsed=buffer.then(data=>parseSourceVtf(data,meta.frame,meta.face));this.parsed.set(index,parsed);
        }
        const vtf=await parsed;
        if(original.image.width!==vtf.width||original.image.height!==vtf.height)throw new Error(`Source texture dimensions differ: ${meta.path}`);
        const block=blockFormats[vtf.format],compressed=!!block&&this.renderer.extensions.has('WEBGL_compressed_texture_s3tc')
          &&(colorSpace!==THREE.SRGBColorSpace||this.renderer.extensions.has('WEBGL_compressed_texture_s3tc_srgb'));
        const format=compressed?vtf.format===13||vtf.format===20?THREE.RGBA_S3TC_DXT1_Format:vtf.format===14?THREE.RGBA_S3TC_DXT3_Format:THREE.RGBA_S3TC_DXT5_Format:THREE.RGBAFormat;
        const texture=this.context.own(new THREE.CompressedTexture([],vtf.width,vtf.height));texture.copy(original);
        (texture as THREE.Texture).format=format;texture.colorSpace=vtf.format===5?THREE.NoColorSpace:colorSpace;
        texture.mipmaps=compressed?vtf.levels:vtf.levels.map(level=>decodeSourceMip(level,vtf.format));
        // Retain the original decoded image for lossless PNG/GLB export. Three's
        // compressed upload path reads width/height here and pixel data from mipmaps.
        texture.image=original.image;texture.flipY=false;texture.generateMipmaps=false;
        texture.wrapS=vtf.flags&4?THREE.ClampToEdgeWrapping:THREE.RepeatWrapping;
        texture.wrapT=vtf.flags&8?THREE.ClampToEdgeWrapping:THREE.RepeatWrapping;
        const point=!!(vtf.flags&1),noMip=!!(vtf.flags&256);
        texture.magFilter=point?THREE.NearestFilter:THREE.LinearFilter;
        texture.minFilter=noMip?texture.magFilter:point?THREE.NearestMipmapLinearFilter:THREE.LinearMipmapLinearFilter;
        texture.anisotropy=!point&&!noMip?Math.min(16,this.renderer.capabilities.getMaxAnisotropy()):1;
        texture.userData={...original.userData,sourceNativeTexture:{path:meta.path,frame:meta.frame,face:meta.face,format:vtf.format,levels:vtf.levels.length,compressed}};
        texture.needsUpdate=true;return texture;
      })();
      variants.set(colorSpace,result);
    }
    return result;
  }
}

export function sourceNativeCube(textures:THREE.Texture[]):THREE.CubeTexture {
  const native=textures.every(texture=>texture.userData.sourceNativeTexture);
  const cube=new THREE.CubeTexture(native?textures.map(texture=>({width:texture.image.width,height:texture.image.height,mipmaps:texture.mipmaps,isCompressedTexture:true})):textures.map(texture=>texture.image));
  if(native){
    if(textures.some(texture=>texture.format!==textures[0].format||texture.mipmaps.length!==textures[0].mipmaps.length))throw new Error('Source cubemap faces differ');
    // Three supports an array of compressed faces for both native BC and RGBA fallback.
    (cube as THREE.CubeTexture&{isCompressedTexture:boolean}).isCompressedTexture=true;
    cube.format=textures[0].format;cube.generateMipmaps=false;cube.minFilter=textures[0].minFilter;cube.magFilter=textures[0].magFilter;cube.anisotropy=textures[0].anisotropy;
    cube.userData.sourceNativeTexture={levels:textures[0].mipmaps.length,cube:true};
  }
  cube.colorSpace=THREE.SRGBColorSpace;cube.needsUpdate=true;return cube;
}
