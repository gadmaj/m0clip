/** noclip.website SourceEngine/Main.ts: sRGB scene target, gamma 2.2, then 32³ LUT.
 * The NeoTokyo catalog is LDR: no bloom or automatic exposure. Ghost uses the
 * quantized identity LUT; maps with color_correction entities blend authored LUTs.
 * Copyright (c) 2018 Jasper St. Pierre, MIT; see LICENSE.noclip. */
import * as THREE from 'three';
import { SOURCE_FXAA_FRAGMENT } from './source-fxaa';
import { sourceColorCorrectionLut, sourceColorWeight, type SourceColorLayer } from './source-grading';

export type SourceAntialiasing = 'fxaa' | 'msaa4' | 'none';

export function sourceIdentityLut(): Uint8Array {
  const data=new Uint8Array(32*32*32*4);
  for(let z=0;z<32;z++)for(let y=0;y<32;y++)for(let x=0;x<32;x++) {
    const i=((z*32+y)*32+x)*4;
    data[i]=x*255/31;data[i+1]=y*255/31;data[i+2]=z*255/31;data[i+3]=255;
  }
  return data;
}

export class SourceColor {
  private target: THREE.WebGLRenderTarget|null=null;
  private gammaTarget: THREE.WebGLRenderTarget|null=null;
  antialiasing: SourceAntialiasing = 'fxaa';
  private lutBytes=sourceIdentityLut();
  private lut=new THREE.Data3DTexture(this.lutBytes,32,32,32);
  private scene=new THREE.Scene();
  private camera=new THREE.Camera();
  private material: THREE.RawShaderMaterial;
  private fxaa: THREE.RawShaderMaterial;
  private quad: THREE.Mesh;
  private geometry=new THREE.BufferGeometry();
  private layers: SourceColorLayer[]=[];
  private weights: number[]=[];
  private eye=new THREE.Vector3();

  constructor() {
    this.lut.name='Source identity color correction';
    this.lut.minFilter=this.lut.magFilter=THREE.LinearFilter;
    this.lut.unpackAlignment=1;this.lut.needsUpdate=true;
    this.material=new THREE.RawShaderMaterial({
      name:'Source final gamma and color correction',glslVersion:THREE.GLSL3,
      depthTest:false,depthWrite:false,blending:THREE.NoBlending,toneMapped:false,
      uniforms:{image:{value:null},lut:{value:this.lut},transparentOutput:{value:false}},
      vertexShader:`precision highp float;
        in vec3 position;out vec2 texcoord;
        void main(){texcoord=position.xy*.5+.5;gl_Position=vec4(position,1.);}`,
      fragmentShader:`precision highp float;precision highp sampler3D;
        uniform sampler2D image;uniform sampler3D lut;uniform bool transparentOutput;
        in vec2 texcoord;out vec4 color;
        void main(){
          color=texture(image,texcoord);
          // Canvas exports retain premultiplied alpha while gamma operates on straight RGB.
          vec3 rgb=transparentOutput&&color.a>0.?color.rgb/color.a:color.rgb;
          rgb=pow(max(rgb,vec3(0.)),vec3(1./2.2));
          rgb=texture(lut,rgb*(31./32.)+vec3(.5/32.)).rgb;
          color.rgb=rgb*(transparentOutput?color.a:1.);
        }`,
    });
    this.geometry.setAttribute('position',new THREE.Float32BufferAttribute([-1,-1,0,3,-1,0,-1,3,0],3));
    this.fxaa=new THREE.RawShaderMaterial({
      name:'Source FXAA',glslVersion:THREE.GLSL3,depthTest:false,depthWrite:false,
      blending:THREE.NoBlending,toneMapped:false,uniforms:{u_Texture:{value:null}},
      vertexShader:this.material.vertexShader,fragmentShader:SOURCE_FXAA_FRAGMENT,
    });
    this.quad=new THREE.Mesh(this.geometry,this.material);this.quad.frustumCulled=false;this.scene.add(this.quad);
  }

  setAntialiasing(mode: SourceAntialiasing) {
    if(this.antialiasing===mode)return;
    this.antialiasing=mode;this.reset();
  }

  setColorCorrections(layers: SourceColorLayer[]) {
    this.layers=layers;this.weights=[];
    if(!layers.length){this.lutBytes.set(sourceIdentityLut());this.lut.needsUpdate=true;}
  }

  private updateColorCorrections(camera?: THREE.Camera) {
    if(!this.layers.length)return;
    if(camera)camera.getWorldPosition(this.eye);else this.eye.set(0,0,0);
    const weights=this.layers.map(layer=>sourceColorWeight(layer,this.eye));
    if(weights.length===this.weights.length&&weights.every((w,i)=>w===this.weights[i]))return;
    this.weights=weights;
    // Camera-dependent grades reuse the 128 KiB upload buffer during flight.
    sourceColorCorrectionLut(this.layers.map(l=>l.data),weights,this.lutBytes);this.lut.needsUpdate=true;
  }

  /** Draw into the reference's sRGB attachment, blend there in linear light, then resolve
   * into the caller's current viewport. Does not disturb letterbox bars or export targets. */
  render(renderer:THREE.WebGLRenderer,draw:()=>void,linearOutput:{value:number},transparent=false,camera?: THREE.Camera) {
    this.updateColorCorrections(camera);
    const viewport=renderer.getCurrentViewport(new THREE.Vector4());
    const width=Math.max(1,Math.round(viewport.z)),height=Math.max(1,Math.round(viewport.w));
    if(!this.target) {
      this.target=new THREE.WebGLRenderTarget(width,height,{colorSpace:THREE.SRGBColorSpace,
        minFilter:THREE.LinearFilter,magFilter:THREE.LinearFilter,depthBuffer:true,
        samples:this.antialiasing==='msaa4'?Math.min(4,renderer.capabilities.maxSamples):0});
      this.target.texture.name='Source scene before gamma';
    }else this.target.setSize(width,height);
    const output=renderer.getRenderTarget(),face=renderer.getActiveCubeFace(),mip=renderer.getActiveMipmapLevel();
    const autoClear=renderer.autoClear,previousLinear=linearOutput.value;
    // setRenderTarget uses target-owned viewport/scissor, whereas setViewport updates
    // the renderer's canvas settings. Retain both for callers rendering into a target.
    const outputViewport=output?.viewport.clone(),outputScissor=output?.scissor.clone(),outputScissorTest=output?.scissorTest;
    const gl=renderer.getContext(),scissor=Array.from(gl.getParameter(gl.SCISSOR_BOX) as Int32Array),scissorTest=gl.isEnabled(gl.SCISSOR_TEST);
    const restoreOutput=()=>{
      if(output){output.viewport.copy(viewport);output.scissor.fromArray(scissor);output.scissorTest=scissorTest;}
      renderer.setRenderTarget(output,face,mip);
      if(output){output.viewport.copy(outputViewport!);output.scissor.copy(outputScissor!);output.scissorTest=outputScissorTest!;}
    };
    try {
      linearOutput.value=1;renderer.autoClear=true;renderer.setRenderTarget(this.target);draw();
      renderer.autoClear=false;
      this.material.uniforms.image.value=this.target.texture;
      this.material.uniforms.transparentOutput.value=transparent;
      this.quad.material=this.material;
      if(this.antialiasing==='fxaa') {
        if(!this.gammaTarget) {
          this.gammaTarget=new THREE.WebGLRenderTarget(width,height,{depthBuffer:false,
            minFilter:THREE.NearestFilter,magFilter:THREE.NearestFilter,
            wrapS:THREE.RepeatWrapping,wrapT:THREE.RepeatWrapping});
          this.gammaTarget.texture.name='Source gamma before FXAA';
        }else this.gammaTarget.setSize(width,height);
        renderer.setRenderTarget(this.gammaTarget);renderer.render(this.scene,this.camera);
        this.fxaa.uniforms.u_Texture.value=this.gammaTarget.texture;
        this.quad.material=this.fxaa;
      }
      restoreOutput();
      renderer.render(this.scene,this.camera);
    }finally{this.quad.material=this.material;linearOutput.value=previousLinear;renderer.autoClear=autoClear;restoreOutput();}
  }

  reset(){this.target?.dispose();this.target=null;this.gammaTarget?.dispose();this.gammaTarget=null;}
  dispose(){this.reset();this.lut.dispose();this.material.dispose();this.fxaa.dispose();this.geometry.dispose();}
}
