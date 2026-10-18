/** noclip's DebugColorTexture replaces diffuse RGB with linear 0.5 and keeps alpha.
 * MaterialBase.ts / Material_Generic.ts (MIT, LICENSE.noclip). */
import type * as THREE from 'three';
const controls=new WeakMap<THREE.Material,{uniform:{value:number};keepColor:boolean}>();

export function sourceTextureControl(material:THREE.Material,keepColor=false){
  let control=controls.get(material);
  if(!control){control={uniform:{value:1},keepColor};controls.set(material,control)}
  else if(keepColor)control.keepColor=true;
  return control.uniform;
}

export function setSourceTexturesEnabled(material:THREE.Material,on:boolean):boolean{
  const control=controls.get(material);if(!control)return false;
  control.uniform.value=on||control.keepColor?1:0;return true;
}

export const sourceDiffuseOnly=(material:THREE.Material)=>controls.get(material)?.uniform.value===0;

export function sourceTextureShader(material:THREE.Material,shader:{uniforms:Record<string,unknown>;fragmentShader:string}){
  shader.uniforms.sourceTexturesEnabled=sourceTextureControl(material);
  if(!shader.fragmentShader.includes('#define SOURCE_TEXTURE_CONTROL'))shader.fragmentShader=`
    #define SOURCE_TEXTURE_CONTROL
    uniform float sourceTexturesEnabled;
    vec4 sourceDiffuseSample(vec4 sampleColor){
      if(sourceTexturesEnabled<.5)sampleColor.rgb=vec3(.5);
      return sampleColor;
    }
  `+shader.fragmentShader;
}

/** Basic lightmap/vertex materials also cover sprites and detail cutouts. The
 * generic effect shader replaces this fallback with its full texture blending. */
export const SOURCE_TEXTURE_FALLBACK=`
  #ifdef USE_MAP
    sampledDiffuseColor=sourceDiffuseSample(sampledDiffuseColor);
    if(sourceTexturesEnabled<.5)diffuseColor.rgb=diffuse*sampledDiffuseColor.rgb;
  #endif
`;
