/** Projection and real glTF camera export, independent of browser rendering. */
import assert from'node:assert/strict';import{build}from'esbuild';import{mkdir,rm}from'node:fs/promises';import{resolve}from'node:path';
import * as THREE from'three';import{GLTFExporter}from'three/addons/exporters/GLTFExporter.js';
const file=resolve('node_modules/.cache/source-camera-test.mjs');await mkdir(resolve('node_modules/.cache'),{recursive:true});
try{
 await build({entryPoints:['src/render/scene-camera.ts'],bundle:true,packages:'external',platform:'node',format:'esm',outfile:file});
 const{SceneCamera,infiniteCameraWriter}=await import(file),camera=new SceneCamera(60,1.5,.05,100);
 const point=z=>new THREE.Vector3(0,0,-z).project(camera);
 assert.ok(point(150).z>1);camera.setSourceProjection(true);
 assert.equal(camera.near,.127);assert.equal(camera.far,Infinity);assert.ok(camera.projectionMatrix.elements.every(Number.isFinite));
 assert.ok(Math.abs(point(.127).z+1)<1e-12);
 for(const distance of [100,150,1000,1e8])assert.ok(point(distance).z<1,`${distance}m must not be far-clipped`);
 assert.ok(point(.126).z< -1);
 camera.zoom=1.7;camera.filmOffset=2;camera.setViewOffset(1200,800,100,50,600,400);camera.updateProjectionMatrix();
 const finite=new THREE.PerspectiveCamera(60,1.5,.127,1e10);finite.zoom=1.7;finite.filmOffset=2;finite.setViewOffset(1200,800,100,50,600,400);
 for(let i=0;i<16;i++)assert.ok(Math.abs(camera.projectionMatrix.elements[i]-finite.projectionMatrix.elements[i])<1e-9,`lens matrix ${i}`);
 const product=camera.projectionMatrix.clone().multiply(camera.projectionMatrixInverse);
 product.elements.forEach((value,i)=>assert.ok(Math.abs(value-(i%5===0?1:0))<1e-12));
 const copy=camera.clone();copy.setSourceProjection(false);assert.equal(copy.near,.05);assert.equal(copy.far,100);
 camera.clearViewOffset();camera.zoom=1;camera.filmOffset=0;camera.updateProjectionMatrix();
 const frustum=new THREE.Frustum().setFromProjectionMatrix(camera.projectionMatrix);
 assert.ok(frustum.intersectsSphere(new THREE.Sphere(new THREE.Vector3(0,0,-1000),1)));
 assert.ok(!frustum.intersectsSphere(new THREE.Sphere(new THREE.Vector3(0,0,1000),1)));
 assert.ok(!frustum.intersectsSphere(new THREE.Sphere(new THREE.Vector3(10000,0,-1000),1)));
 const scene=new THREE.Scene();camera.name='source';scene.add(camera);const stock=new SceneCamera(45,1,.05,200);stock.name='stock';scene.add(stock);
 const gltf=await new GLTFExporter().register(infiniteCameraWriter).parseAsync(scene);
 assert.equal(gltf.cameras[0].perspective.znear,.127);assert.ok(!Object.hasOwn(gltf.cameras[0].perspective,'zfar'));
 assert.equal(gltf.cameras[1].perspective.zfar,200);assert.ok(!JSON.stringify(gltf).includes(':null'));
 camera.setSourceProjection(false);assert.equal(camera.near,.05);assert.equal(camera.far,100);
 console.log('PASS: Source near plane, infinite perspective, lens/view offsets, inverse, frustum, clone/reset, valid glTF infinite and finite cameras');
}finally{await rm(file,{force:true})}
