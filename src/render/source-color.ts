/** noclip.website SourceEngine/Main.ts: sRGB scene target, gamma 2.2, then 32³ LUT.
 * Ghost is LDR and has no color_correction entities: no bloom or automatic exposure,
 * and the reference's quantized identity LUT is the only color-correction layer.
 * Copyright (c) 2018 Jasper St. Pierre, MIT; see LICENSE.noclip. */
import * as THREE from 'three';

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
  private lut=new THREE.Data3DTexture(sourceIdentityLut(),32,32,32);
  private scene=new THREE.Scene();
  private camera=new THREE.Camera();
  private material: THREE.RawShaderMaterial;
  private geometry=new THREE.BufferGeometry();

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
    const mesh=new THREE.Mesh(this.geometry,this.material);mesh.frustumCulled=false;this.scene.add(mesh);
  }

  /** Draw into the reference's sRGB attachment, blend there in linear light, then resolve
   * into the caller's current viewport. Does not disturb letterbox bars or export targets. */
  render(renderer:THREE.WebGLRenderer,draw:()=>void,linearOutput:{value:number},transparent=false) {
    const viewport=renderer.getCurrentViewport(new THREE.Vector4());
    const width=Math.max(1,Math.round(viewport.z)),height=Math.max(1,Math.round(viewport.w));
    if(!this.target) {
      this.target=new THREE.WebGLRenderTarget(width,height,{colorSpace:THREE.SRGBColorSpace,
        minFilter:THREE.LinearFilter,magFilter:THREE.LinearFilter,depthBuffer:true,
        samples:Math.min(4,renderer.capabilities.maxSamples)});
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
      restoreOutput();renderer.autoClear=false;
      this.material.uniforms.image.value=this.target.texture;
      this.material.uniforms.transparentOutput.value=transparent;
      renderer.render(this.scene,this.camera);
    }finally{linearOutput.value=previousLinear;renderer.autoClear=autoClear;restoreOutput();}
  }

  reset(){this.target?.dispose();this.target=null;}
  dispose(){this.reset();this.lut.dispose();this.material.dispose();this.geometry.dispose();}
}
