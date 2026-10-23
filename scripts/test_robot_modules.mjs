/** Procedural modules preserve joint-local placement and restore owned resources. */
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import * as THREE from 'three';
const bundle=await build({stdin:{contents:"export {RobotKit} from './src/render/robot-kit';export {kitRegion} from './src/render/robot-kit-data';",resolveDir:process.cwd()},bundle:true,platform:'node',format:'esm',write:false,external:['three','three/addons/utils/BufferGeometryUtils.js']});
// Resolve external imports from this project rather than a data URL.
const {writeFile,mkdir}=await import('node:fs/promises');
const output=new URL('../node_modules/.cache/robot-kit-test.mjs',import.meta.url);await mkdir(new URL('.',output),{recursive:true});await writeFile(output,bundle.outputFiles[0].text);
const {RobotKit,kitRegion}=await import(output.href+'?'+Date.now());
const kit=new RobotKit(),frame=new THREE.Matrix4().compose(new THREE.Vector3(.1,-.2,.05),new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0,1,0),.7),new THREE.Vector3(1,1,1));
for(const style of ['boxy','round','prism'])for(const region of ['head','torso','arms','hands','legs','feet']) {
 const original=new THREE.BoxGeometry(.16,.2,.3),material=new THREE.MeshPhysicalMaterial({color:0x88aacc}),mesh=new THREE.Mesh(original,material);
 let geometryDisposed=0,materialDisposed=0;
 kit.apply(mesh,style,region,frame);
 assert.notEqual(mesh.geometry,original);assert.notEqual(mesh.material,material);assert.ok(mesh.material.vertexColors);
 assert.deepEqual(mesh.userData.robotModule,{style,region});
 const p=mesh.geometry.getAttribute('position'),n=mesh.geometry.getAttribute('normal');
 for(const value of p.array)assert.ok(Number.isFinite(value));
 for(let i=0;i<n.count;i++)assert.ok(Math.abs(Math.hypot(n.getX(i),n.getY(i),n.getZ(i))-1)<1e-5);
 const inFile=mesh.geometry.clone().applyMatrix4(frame),expected=original.clone().applyMatrix4(frame);inFile.computeBoundingBox();expected.computeBoundingBox();
 for(const axis of ['x','y','z']) {
  assert.ok(inFile.boundingBox.min[axis]>=expected.boundingBox.min[axis]-1e-6);
  assert.ok(inFile.boundingBox.max[axis]<=expected.boundingBox.max[axis]+(region==='head'&&axis==='x'?.1:1e-6));
 }
 mesh.geometry.addEventListener('dispose',()=>geometryDisposed++);mesh.material.addEventListener('dispose',()=>materialDisposed++);
 kit.restore(mesh);kit.restore(mesh);
 assert.equal(mesh.geometry,original);assert.equal(mesh.material,material);assert.equal(geometryDisposed,1);assert.equal(materialDisposed,1);assert.equal(mesh.userData.robotModule,undefined);
 original.dispose();material.dispose();inFile.dispose();expected.dispose();
}
assert.equal(kitRegion('left_elbow_link'),'arms');assert.equal(kitRegion('right_ankle_roll_link'),'feet');assert.equal(kitRegion('head_yaw_link'),'head');assert.equal(kitRegion('trunk'),'torso');
kit.reset();console.log('PASS: 18 module shapes, transformed bounds, normals, paint materials, exact restoration and single disposal.');
