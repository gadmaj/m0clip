/** Verify Source's sky camera projection, PVS selection, and shared asset preservation. */
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import fs from 'node:fs/promises';
const bundled = await build({stdin:{contents:"export * from './src/render/source-sky3d'; export * as THREE from 'three';",resolveDir:process.cwd()},bundle:true,platform:'node',format:'esm',write:false});
const {SourceSky3D,THREE} = await import('data:text/javascript;base64,'+Buffer.from(bundled.outputFiles[0].text).toString('base64'));
const data=JSON.parse(await fs.readFile('public/assets/maps/nt_ghost_ctg/visibility.json','utf8'));
const root=new THREE.Group(),geometry=new THREE.BufferGeometry();
geometry.setAttribute('position',new THREE.Float32BufferAttribute([0,0,0,1,0,0,0,1,0,2,0,0],3));
geometry.setIndex([0,1,2,1,3,2]);
const visible=data.faceClusters.findIndex(c=>c.includes(545)),hidden=data.faceClusters.findIndex(c=>c.length===0);
geometry.userData.sourceFaceRanges=[[visible,0,3],[hidden,3,3]];
const mesh=new THREE.Mesh(geometry,new THREE.MeshBasicMaterial());root.add(mesh);
const prop=new THREE.Group();prop.userData={sourceStaticIndex:0,sourceVisibilityClusters:[545]};root.add(prop);
const excluded=new THREE.Group();excluded.userData={sourceStaticIndex:1,sourceVisibilityClusters:[65535]};root.add(excluded);
const sky=new SourceSky3D(data,root,()=>{});
const camera=new THREE.PerspectiveCamera(60,1.7,.03,10000);camera.up.set(0,0,1);camera.position.set(...data.spawn).applyMatrix3(sky.pvs.rotation).multiplyScalar(-.0254);camera.lookAt(camera.position.clone().add(new THREE.Vector3(0,1,0)));
sky.prepare(camera,true);
assert.equal(sky.stats.cluster,545);assert.equal(sky.stats.faces,1);assert.equal(sky.stats.staticProps,1);
assert.equal(sky.scene.children[0].geometry.drawRange.count,3);assert.equal(sky.scene.children[1].visible,true);assert.equal(sky.scene.children[2].visible,false);
assert.deepEqual(Array.from(geometry.index.array),[0,1,2,1,3,2]);
const row=sky.pvs.row(545);assert.equal(Array.from(row).reduce((n,b)=>n+b.toString(2).replaceAll('0','').length,0),90);
assert.equal(sky.pvs.row(65535),null);
const spawn=new THREE.Vector3(...data.spawn),K=new THREE.Vector3(...data.sky.origin);
const offset=K.clone().addScaledVector(spawn,1/16-1).applyMatrix3(sky.pvs.rotation).multiplyScalar(.0254);
const model=new THREE.Matrix4().makeScale(16,16,16);model.setPosition(offset.clone().multiplyScalar(-16));
for(const camera of [new THREE.PerspectiveCamera(63,1.4,.05,5000),new THREE.OrthographicCamera(-8,8,6,-6,.05,5000)]){
 camera.up.set(0,0,1);camera.position.set(3,-4,2);camera.lookAt(0,0,1);camera.updateMatrixWorld();
 sky.prepare(camera,true);
 const native=camera.projectionMatrix.clone().multiply(camera.matrixWorldInverse).multiply(model);
 const actual=sky.camera.projectionMatrix.clone().multiply(sky.camera.matrixWorldInverse);
 for(let i=0;i<16;i++)assert.ok(Math.abs(native.elements[i]/16-actual.elements[i])<1e-8,`matrix ${i}`);
}
camera.position.set(2000,2000,2000);sky.prepare(camera,true);
assert.equal(sky.stats.faces,0);assert.equal(sky.stats.staticProps,0);
sky.dispose();assert.equal(sky.scene.children.length,0);
console.log('PASS: native sky PVS, surface selection, static props, unchanged source geometry, perspective/orthographic projection, invalid-cluster fallback, cleanup');
