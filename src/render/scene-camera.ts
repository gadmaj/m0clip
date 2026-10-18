/** noclip's Source view uses a five-unit near plane and no far clipping plane.
 * Reference: noclip.website viewer.ts / Camera.ts (MIT, LICENSE.noclip).
 * Three's perspective matrix does not accept Infinity; take its analytic limit
 * while preserving the lens, zoom, film offset and view offset calculations. */
import * as THREE from 'three';
import type { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js';

export class SceneCamera extends THREE.PerspectiveCamera {
  private defaultNear:number;
  private defaultFar:number;

  constructor(fov=50,aspect=1,near=.1,far=2000){
    super(fov,aspect,near,far);this.defaultNear=near;this.defaultFar=far;
  }

  setSourceProjection(source:boolean){
    const near=source?5*.0254:this.defaultNear,far=source?Infinity:this.defaultFar;
    if(this.near===near&&this.far===far)return;
    this.near=near;this.far=far;this.updateProjectionMatrix();
  }

  override updateProjectionMatrix(){
    if(this.far!==Infinity){super.updateProjectionMatrix();return}
    this.far=this.near+1;
    try{super.updateProjectionMatrix()}finally{this.far=Infinity}
    const matrix=this.projectionMatrix.elements;
    matrix[10]=-1;matrix[14]=-2*this.near;
    this.projectionMatrixInverse.copy(this.projectionMatrix).invert();
  }

  override copy(source:THREE.PerspectiveCamera,recursive=true):this{
    super.copy(source,recursive);
    if(source instanceof SceneCamera){this.defaultNear=source.defaultNear;this.defaultFar=source.defaultFar}
    return this;
  }
}

/** glTF represents an infinite perspective far plane by omitting zfar. Three's
 * exporter otherwise serializes Infinity as invalid null camera metadata. */
export const infiniteCameraWriter:Parameters<GLTFExporter['register']>[0]=writer=>{
  const json=(writer as unknown as {json:{cameras?:{perspective?:{zfar?:number}}[]}}).json;
  return {name:'SourceCameraClipping',afterParse(){
    for(const camera of json.cameras??[])if(camera.perspective?.zfar===Infinity)delete camera.perspective.zfar;
  }};
};
