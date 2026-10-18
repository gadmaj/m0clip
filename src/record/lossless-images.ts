/** GLTFExporter's canvas path discards RGB under zero alpha and quantizes partial alpha.
 * Read the source pixels without blending or gamma conversion, then encode lossless PNG. */
import * as THREE from 'three';
import type { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js';
import { encodeRgbaPNG } from './png';

interface NativeImage {width:number;height:number;data?:Uint8Array|Uint8ClampedArray|Float32Array}
const diffuseSources=new WeakMap<NativeImage,NativeImage>();
/** An export-only image identity keeps gray diffuse and original normal/mask
 * uses of the same image separate in GLTFExporter's image cache. */
export function diffuseOnlyImage(image:NativeImage):NativeImage{
  const copy={width:image.width,height:image.height};diffuseSources.set(copy,image);return copy;
}
interface ImageWriter {
  processImage(image:NativeImage,format:number,flipY:boolean,mimeType?:string):number;
  processBufferViewImage(blob:Blob):Promise<number>;
  json:{images?:{mimeType:string;bufferView?:number}[]};pending:Promise<unknown>[];
}

export function losslessImageWriter(renderer:THREE.WebGLRenderer) {
  const material=new THREE.RawShaderMaterial({glslVersion:THREE.GLSL3,depthTest:false,depthWrite:false,blending:THREE.NoBlending,
    uniforms:{inputImage:{value:null as THREE.Texture|null}},
    vertexShader:'precision highp float; in vec3 position; in vec2 uv; out vec2 pixelUV; void main(){pixelUV=uv;gl_Position=vec4(position.xy,0.0,1.0);}',
    fragmentShader:'precision highp float; uniform sampler2D inputImage; in vec2 pixelUV; out vec4 pixelColor; void main(){pixelColor=texture(inputImage,pixelUV);}' });
  const geometry=new THREE.PlaneGeometry(2,2),scene=new THREE.Scene(),camera=new THREE.Camera();scene.add(new THREE.Mesh(geometry,material));
  const target=new THREE.WebGLRenderTarget(1,1,{depthBuffer:false,stencilBuffer:false,minFilter:THREE.NearestFilter,magFilter:THREE.NearestFilter});
  let queue=Promise.resolve();
  const plugin:Parameters<GLTFExporter['register']>[0]=context=>{
    // Three 0.185's writer exposes these methods at runtime; the installed type
    // declarations omit them. The RGBA roundtrip test covers this integration.
    const writer=context as unknown as ImageWriter;
    if(typeof writer.processImage!=='function'||typeof writer.processBufferViewImage!=='function')throw new Error('The exporter image API changed.');
    const original=writer.processImage.bind(writer),cache=new Map<unknown,Map<string,number>>();
    writer.processImage=(image,format,flipY,mimeType)=>{
      if(!image?.width||!image?.height||format!==THREE.RGBAFormat)return original(image,format,flipY,mimeType);
      let variants=cache.get(image);if(!variants){variants=new Map();cache.set(image,variants)}
      const key=String(flipY),existing=variants.get(key);if(existing!==undefined)return existing;
      const images=writer.json.images??(writer.json.images=[]),index=images.length;
      const definition:{mimeType:string;bufferView?:number}={mimeType:'image/png'};images.push(definition);variants.set(key,index);
      // Serialize image work: large map exports must not allocate every decoded image again at once.
      const task=queue.then(async()=>{
        await new Promise<void>(done=>setTimeout(done,0));
        if(renderer.getContext().isContextLost())throw new Error('The GPU context was lost while exporting textures.');
        const native=diffuseSources.get(image)??image;
        const source=native.data?new THREE.DataTexture(native.data,native.width,native.height,THREE.RGBAFormat,native.data instanceof Float32Array?THREE.FloatType:THREE.UnsignedByteType)
          :new THREE.Texture(native as unknown as TexImageSource);
        source.colorSpace=THREE.NoColorSpace;source.flipY=false;source.premultiplyAlpha=false;
        source.generateMipmaps=false;source.minFilter=source.magFilter=THREE.NearestFilter;source.needsUpdate=true;
        const previous=renderer.getRenderTarget(),autoClear=renderer.autoClear;
        const pixels=new Uint8Array(image.width*image.height*4);
        try {
          target.setSize(image.width,image.height);material.uniforms.inputImage.value=source;
          // Render targets supply their own pixel viewport/scissor; setViewport
          // would multiply this by the display's pixel ratio on Retina screens.
          renderer.setRenderTarget(target);renderer.autoClear=true;
          renderer.render(scene,camera);renderer.readRenderTargetPixels(target,0,0,image.width,image.height,pixels);
          if(renderer.getContext().isContextLost())throw new Error('The GPU context was lost while exporting textures.');
        }finally{
          renderer.setRenderTarget(previous);renderer.autoClear=autoClear;
          material.uniforms.inputImage.value=null;source.dispose();
        }
        // Linear 0.5 is sRGB 188 in the exported base-color texture. Keep every
        // alpha byte, including RGB-under-zero-alpha mask texels, losslessly.
        if(native!==image)for(let i=0;i<pixels.length;i+=4)pixels[i]=pixels[i+1]=pixels[i+2]=188;
        const png=encodeRgbaPNG(image.width,image.height,pixels,flipY);
        definition.bufferView=await writer.processBufferViewImage(new Blob([png as Uint8Array<ArrayBuffer>],{type:'image/png'}));
      });
      queue=task;writer.pending.push(task);return index;
    };
    return {beforeParse(){}};
  };
  return {plugin,dispose(){target.dispose();material.dispose();geometry.dispose()}};
}
