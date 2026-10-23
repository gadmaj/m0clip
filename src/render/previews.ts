import * as THREE from 'three';
import type { Colorway, Lighting } from './scene';
import type { Finish } from './paint';
import type { KitStyle, KitRegion } from './robot-kit-data';
import { SourceColor } from './source-color';

export type PreviewRequest =
  | {kind:'part';value:string;originalFinish?:boolean}
  | {kind:'module';value:KitStyle;region:KitRegion}
  | {kind:'colorway';value:Colorway}
  | {kind:'finish';value:Finish}
  | {kind:'lighting';value:string;lighting?:Lighting}
  | {kind:'antialiasing';value:'fxaa'|'msaa4'|'none'};

/** Offscreen work must restore both canvas settings and the currently bound target's GL state. */
function renderToCanvas(renderer:THREE.WebGLRenderer,target:THREE.WebGLRenderTarget,draw:()=>void):HTMLCanvasElement {
  const oldTarget=renderer.getRenderTarget(),oldFace=renderer.getActiveCubeFace(),oldMip=renderer.getActiveMipmapLevel();
  const viewport=renderer.getViewport(new THREE.Vector4()),currentViewport=renderer.getCurrentViewport(new THREE.Vector4());
  const scissor=renderer.getScissor(new THREE.Vector4()),scissorTest=renderer.getScissorTest();
  const targetViewport=oldTarget?.viewport.clone(),targetScissor=oldTarget?.scissor.clone(),targetScissorTest=oldTarget?.scissorTest;
  const gl=renderer.getContext(),currentScissor=new THREE.Vector4().fromArray(gl.getParameter(gl.SCISSOR_BOX) as Int32Array);
  const currentScissorTest=gl.isEnabled(gl.SCISSOR_TEST);
  const autoClear=renderer.autoClear,tone=renderer.toneMapping,exposure=renderer.toneMappingExposure;
  const clear=renderer.getClearColor(new THREE.Color()),alpha=renderer.getClearAlpha();
  const shadows=renderer.shadowMap.enabled,shadowUpdate=renderer.shadowMap.autoUpdate,shadowNeedsUpdate=renderer.shadowMap.needsUpdate;
  try {
    // Binding the target applies its native-pixel viewport, independent of canvas DPR.
    renderer.setRenderTarget(target);renderer.setScissorTest(false);
    renderer.autoClear=true;
    draw();
    const {width,height}=target,pixels=new Uint8Array(width*height*4);
    renderer.readRenderTargetPixels(target,0,0,width,height,pixels);
    const canvas=document.createElement('canvas');canvas.width=width;canvas.height=height;
    const context=canvas.getContext('2d');if(!context)throw new Error('Canvas previews are unavailable.');
    const image=context.createImageData(width,height);
    for(let y=0;y<height;y++)image.data.set(pixels.subarray((height-1-y)*width*4,(height-y)*width*4),y*width*4);
    context.putImageData(image,0,0);return canvas;
  } finally {
    renderer.autoClear=autoClear;renderer.toneMapping=tone;renderer.toneMappingExposure=exposure;
    renderer.shadowMap.enabled=shadows;renderer.shadowMap.autoUpdate=shadowUpdate;renderer.shadowMap.needsUpdate=shadowNeedsUpdate;
    renderer.setClearColor(clear,alpha);
    renderer.setViewport(viewport);renderer.setScissor(scissor);renderer.setScissorTest(scissorTest);
    // Target metadata can differ from the active viewport after setViewport/setScissor.
    // Bind using the active state, then put the target's own settings back untouched.
    if(oldTarget){oldTarget.viewport.copy(currentViewport);oldTarget.scissor.copy(currentScissor);oldTarget.scissorTest=currentScissorTest;}
    try {renderer.setRenderTarget(oldTarget,oldFace,oldMip);}
    finally {if(oldTarget){oldTarget.viewport.copy(targetViewport!);oldTarget.scissor.copy(targetScissor!);oldTarget.scissorTest=targetScissorTest!;}}
  }
}

/** Uses the already loaded renderer only. All geometry/materials passed here are owned clones. */
export function renderPreview(renderer:THREE.WebGLRenderer, root:THREE.Object3D, lighting:Lighting,
    environment:THREE.Scene['environment']):HTMLCanvasElement {
  const size=224, scene=new THREE.Scene();scene.add(root);
  scene.background=new THREE.Color(lighting.background);scene.environment=environment;
  scene.environmentIntensity=lighting.reflections;
  const hemi=new THREE.HemisphereLight(lighting.skyColor,lighting.groundColor,lighting.ambient);
  hemi.up.set(0,0,1);hemi.position.set(0,0,10);scene.add(hemi);
  const sun=new THREE.DirectionalLight(lighting.sunColor,lighting.sunIntensity);
  const az=THREE.MathUtils.degToRad(lighting.sunAzimuth),el=THREE.MathUtils.degToRad(lighting.sunElevation);
  root.updateMatrixWorld(true);
  const box=new THREE.Box3().setFromObject(root),center=box.getCenter(new THREE.Vector3());
  const radius=box.getSize(new THREE.Vector3()).length()/2;
  const target=new THREE.WebGLRenderTarget(size,size,{depthBuffer:true,samples:Math.min(4,renderer.capabilities.maxSamples)});
  target.texture.colorSpace=THREE.SRGBColorSpace;
  try {
    if(!Number.isFinite(radius)||radius<=0)throw new Error('No renderable geometry for this preview.');
    sun.position.set(Math.cos(az)*Math.cos(el),Math.sin(az)*Math.cos(el),Math.sin(el)).multiplyScalar(radius*5).add(center);
    sun.target.position.copy(center);sun.castShadow=lighting.shadows;scene.add(sun,sun.target);
    const camera=new THREE.PerspectiveCamera(34,1,radius*.01,radius*30);
    camera.up.set(0,0,1);camera.position.copy(center).add(new THREE.Vector3(1.8,-2.8,1.5).normalize().multiplyScalar(radius/Math.sin(THREE.MathUtils.degToRad(17))*1.15));camera.lookAt(center);
    const fill=new THREE.DirectionalLight(0xcfd8e6,lighting.fill);fill.position.copy(camera.position);fill.target.position.copy(center);scene.add(fill,fill.target);
    return renderToCanvas(renderer,target,()=>{
      renderer.toneMapping=THREE.NeutralToneMapping;renderer.toneMappingExposure=lighting.exposure;renderer.shadowMap.enabled=lighting.shadows;
      root.traverse(object=>{if(object instanceof THREE.Mesh){object.castShadow=true;object.receiveShadow=true;}});
      renderer.render(scene,camera);
    });
  } finally {
    target.dispose();
    root.traverse(object=>{if(object instanceof THREE.Mesh){object.geometry.dispose();for(const material of [object.material].flat())material.dispose();}});
    scene.remove(root);sun.shadow.dispose();
  }
}

/** Fixed native-resolution Source edge scene, not a prediction of a particular map's pixels. */
export function antialiasingPreview(value:'fxaa'|'msaa4'|'none',renderer:THREE.WebGLRenderer):HTMLCanvasElement {
  const size=224,scene=new THREE.Scene(),camera=new THREE.OrthographicCamera(-1,1,1,-1,.1,10);
  scene.background=new THREE.Color(0x101820);camera.position.z=2;
  const geometry=new THREE.BufferGeometry();
  // One silhouette and a narrow slanted rail expose diagonal and subpixel coverage.
  geometry.setAttribute('position',new THREE.Float32BufferAttribute([
    -.8,-.45,0, .74,-.45,0, .28,.8,0,
    -.8,-.62,0, .74,-.54,0, .74,-.515,0,
    -.8,-.62,0, .74,-.515,0, -.8,-.595,0,
  ],3));
  const material=new THREE.MeshBasicMaterial({color:0xe0e7ef,toneMapped:false});
  scene.add(new THREE.Mesh(geometry,material));
  // The output attachment is deliberately unencoded: SourceColor already emits gamma RGB.
  const target=new THREE.WebGLRenderTarget(size,size,{depthBuffer:false,samples:0});
  const source=new SourceColor();
  try {
    source.setAntialiasing(value);
    const canvas=renderToCanvas(renderer,target,()=>{
      renderer.toneMapping=THREE.NoToneMapping;renderer.toneMappingExposure=1;renderer.shadowMap.enabled=false;
      source.render(renderer,()=>renderer.render(scene,camera),{value:0});
    });
    const context=canvas.getContext('2d')!;
    const mode=value==='msaa4'?`MSAA ${Math.min(4,renderer.capabilities.maxSamples)}×`:value.toUpperCase();
    context.fillStyle='#101820';context.fillRect(0,192,size,32);context.fillStyle='white';context.font='12px sans-serif';
    context.fillText('Source edge sample · '+mode,10,212);
    return canvas;
  } finally {
    source.dispose();target.dispose();geometry.dispose();material.dispose();scene.clear();
  }
}
