import assert from'node:assert/strict';import{build}from'esbuild';import{mkdir,rm}from'node:fs/promises';import{resolve}from'node:path';import * as THREE from'three';
const file=resolve('node_modules/.cache/source-texture-export-test.mjs');await mkdir(resolve('node_modules/.cache'),{recursive:true});
try{
 await build({stdin:{contents:"export * from './src/render/source-textures';export {prepareLosslessTextures} from './src/record/lossless-textures';",resolveDir:process.cwd()},bundle:true,packages:'external',platform:'node',format:'esm',outfile:file});
 const{sourceTextureControl,setSourceTexturesEnabled,prepareLosslessTextures}=await import(file);
 const pixels=new Uint8Array([255,30,90,0,40,220,80,128]),texture=new THREE.DataTexture(pixels,2,1);texture.userData.mimeType='image/webp';
 const material=new THREE.MeshStandardMaterial({map:texture,normalMap:texture}),geometry=new THREE.PlaneGeometry(),mesh=new THREE.Mesh(geometry,material),scene=new THREE.Scene();scene.add(mesh);
 sourceTextureControl(material);setSourceTexturesEnabled(material,false);
 const cleanup=prepareLosslessTextures(scene),copy=mesh.material;
 assert.notEqual(copy,material);assert.notEqual(copy.map,copy.normalMap);assert.notEqual(copy.map.image,texture.image);assert.equal(copy.normalMap.image,texture.image);
 assert.equal(copy.map.image.width,2);assert.equal(copy.map.userData.mimeType,'image/png');assert.equal(copy.normalMap.userData.mimeType,'image/png');
 assert.equal(material.map,texture);assert.equal(material.normalMap,texture);assert.deepEqual([...texture.image.data],[255,30,90,0,40,220,80,128]);
 cleanup();assert.equal(mesh.material,material);assert.equal(texture.userData.mimeType,'image/webp');assert.equal(sourceTextureControl(material).value,0);
 geometry.dispose();material.dispose();texture.dispose();
 console.log('PASS: independent gray diffuse/original normal image identities, original RGBA and live material preserved, cleanup restores scene');
}finally{await rm(file,{force:true})}
