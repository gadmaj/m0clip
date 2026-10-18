/** Visibility affects rendering only: complete exports and picking remain available. */
import assert from 'node:assert/strict';
import {build} from 'esbuild';
const bundled=await build({stdin:{contents:"export * from './src/render/source-visibility';export * as THREE from 'three';",resolveDir:process.cwd()},bundle:true,platform:'node',format:'esm',write:false});
const {SourceVisibility,THREE}=await import('data:text/javascript;base64,'+Buffer.from(bundled.outputFiles[0].text).toString('base64'));
const raw=new Uint8Array(31),header=new DataView(raw.buffer);header.setUint32(0,3,true);for(let i=0;i<3;i++)header.setUint32(4+i*8,28+i,true);raw.set([1,2,4],28);
const data={version:1,spawn:[0,0,0],yaw:0,head:0,nodes:[[1,0,0,0,-1,-2]],leafClusters:[0,1],faceClusters:[[0],[1],[]],visibility:Buffer.from(raw).toString('base64'),sky:null};
const root=new THREE.Group(),geometry=new THREE.BufferGeometry();geometry.setAttribute('position',new THREE.Float32BufferAttribute([0,0,0,1,0,0,0,1,0,1,1,0],3));geometry.setIndex([0,1,2,1,3,2,0,2,3]);geometry.userData.sourceFaceRanges=[[0,0,3],[1,3,3],[2,6,3]];
const mesh=new THREE.Mesh(geometry,new THREE.MeshBasicMaterial());root.add(mesh);
const props=[0,1].map(i=>{const p=new THREE.Group();p.userData={sourceStaticIndex:i,sourceVisibilityClusters:[i]};root.add(p);return p});
const overlay=new THREE.Group();overlay.userData={sourceOverlay:true,sourceVisibilityFaces:[0]};overlay.visible=false;root.add(overlay);
const visibility=new SourceVisibility(data,root),camera=new THREE.PerspectiveCamera();camera.position.set(1,0,0);
visibility.draw(camera,()=>{assert.notEqual(mesh.geometry,geometry);assert.equal(mesh.geometry.drawRange.count,3);assert.deepEqual(Array.from(mesh.geometry.index.array.slice(0,3)),[0,1,2]);assert.deepEqual(props.map(p=>p.visible),[true,false]);assert.equal(overlay.visible,false)});
assert.deepEqual(visibility.stats,{cluster:0,fallback:false,faces:1,staticProps:1,overlays:1});
assert.equal(mesh.geometry,geometry);assert.equal(geometry.index.count,9);assert.deepEqual(props.map(p=>p.visible),[true,true]);
camera.position.x=-1;assert.throws(()=>visibility.draw(camera,()=>{assert.deepEqual(props.map(p=>p.visible),[false,true]);throw new Error('render failed')}),/render failed/);assert.equal(mesh.geometry,geometry);assert.deepEqual(props.map(p=>p.visible),[true,true]);
// A leaf with cluster 65535 enables the all-clusters main-view fallback.
data.leafClusters[1]=65535;
visibility.draw(camera,()=>{assert.equal(mesh.geometry.drawRange.count,6);assert.deepEqual(props.map(p=>p.visible),[true,true]);assert.equal(overlay.visible,false)});assert.equal(visibility.stats.fallback,true);assert.equal(visibility.stats.faces,2);
visibility.dispose();assert.equal(mesh.geometry,geometry);
console.log('PASS: PVS surface/prop selection, out-of-map fallback, hidden decals, complete geometry/picking, restoration after render errors, cleanup');
