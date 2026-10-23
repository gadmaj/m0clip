/** Native preview preserves the authored shader-space skin, seams and material selection. */
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {mkdir,writeFile} from 'node:fs/promises';
import * as THREE from 'three';

const bundle=await build({stdin:{contents:"export {DogBody} from './src/render/source-robot/body';",resolveDir:process.cwd()},bundle:true,platform:'node',format:'esm',write:false,external:['three','three/*']});
const output=new URL('../node_modules/.cache/dog-preview-test.mjs',import.meta.url);
await mkdir(new URL('.',output),{recursive:true});await writeFile(output,bundle.outputFiles[0].text);
const {DogBody}=await import(output.href+'?'+Date.now());
const geometry=new THREE.BufferGeometry();
geometry.setAttribute('position',new THREE.Float32BufferAttribute([0,0,0,1,0,0,0,1,0,1,1,0,0,0,0,0,1,0,-1,0,0],3));
const normal=[],tangent=[],uv=[],weights=[];
for(let i=0;i<7;i++) {
  const n=new THREE.Vector3(i<4?.2:-.3,.4+i*.04,1).normalize();
  const t=new THREE.Vector3(1,0,0).addScaledVector(n,-n.x).normalize();
  normal.push(...n);tangent.push(...t,i<4?1:-1);uv.push(i/7,i<4?0:1);weights.push(.2+i*.08,.8-i*.08,0,0);
}
geometry.setAttribute('normal',new THREE.Float32BufferAttribute(normal,3));
geometry.setAttribute('tangent',new THREE.Float32BufferAttribute(tangent,4));
geometry.setAttribute('uv',new THREE.Float32BufferAttribute(uv,2));
geometry.setAttribute('skinIndex',new THREE.Uint16BufferAttribute(Array.from({length:7},()=>[0,1,0,0]).flat(),4));
geometry.setAttribute('skinWeight',new THREE.Float32BufferAttribute(weights,4));
geometry.setIndex([0,1,2,1,3,2,4,5,6]);geometry.addGroup(0,6,0);geometry.addGroup(6,3,1);
const a=new THREE.Bone(),b=new THREE.Bone(),rig=new THREE.Group();rig.add(a);a.add(b);b.position.set(.4,.3,-.2);rig.updateMatrixWorld(true);
const skeleton=new THREE.Skeleton([a,b]);
const source=[new THREE.MeshStandardMaterial({color:0x778899}),new THREE.MeshStandardMaterial({color:0x99aabb})];
const live=source.map(material=>new THREE.MeshPhysicalMaterial({color:0xff0000}));
const mesh=new THREE.SkinnedMesh(geometry,live);mesh.bindMode=THREE.DetachedBindMode;
const bind=new THREE.Matrix4().compose(new THREE.Vector3(.3,-.7,.2),new THREE.Quaternion().setFromEuler(new THREE.Euler(.2,-.4,.1)),new THREE.Vector3(1.2,.8,1.1));
mesh.bind(skeleton,bind);mesh.position.set(-.2,.6,.1);mesh.rotation.set(.3,.1,-.2);mesh.scale.set(.8,1.3,.9);mesh.updateMatrixWorld(true);
a.rotation.set(.4,-.3,.2);b.rotation.set(-.25,.6,.3);b.scale.set(1.1,.7,1.2);rig.updateMatrixWorld(true);skeleton.update();
mesh.userData.sourcePartNames=['arm','torso'];
// Isolate the public preview consumer from unrelated model retargeting: all skin inputs are real Three objects.
const body=Object.create(DogBody.prototype);body.meshes=[mesh];
body.materials=source.map((material,i)=>({part:mesh.userData.sourcePartNames[i],source:material,material:live[i],nativeCompile:live[i].onBeforeCompile,nativeKey:live[i].customProgramCacheKey}));
const snapshot=()=>JSON.stringify({attributes:Object.fromEntries(Object.entries(geometry.attributes).map(([name,attribute])=>[name,Array.from(attribute.array)])),index:Array.from(geometry.index.array),groups:geometry.groups,bones:skeleton.bones.map(bone=>bone.matrixWorld.toArray()),boneMatrices:Array.from(skeleton.boneMatrices),bind:mesh.bindMatrix.toArray(),inverse:mesh.bindMatrixInverse.toArray(),world:mesh.matrixWorld.toArray(),materials:live.map(material=>material.toJSON())});
const before=snapshot();
// Independent GLSL-style vector blend: bindInverse * sum(weight * bone * bind * vec4(value,w)).
function shader(vertex,attribute,w) {
  const value=new THREE.Vector4(attribute.getX(vertex),attribute.getY(vertex),attribute.getZ(vertex),w).applyMatrix4(bind);
  const result=new THREE.Vector4(0,0,0,0),indices=geometry.getAttribute('skinIndex'),weights=geometry.getAttribute('skinWeight');
  for(let j=0;j<4;j++)result.addScaledVector(value.clone().applyMatrix4(new THREE.Matrix4().fromArray(skeleton.boneMatrices,16*indices.getComponent(vertex,j))),weights.getComponent(vertex,j));
  return result.applyMatrix4(mesh.bindMatrixInverse);
}
function near(actual,expected,message) {assert.ok(Math.abs(actual-expected)<2e-6,`${message}: ${actual} != ${expected}`)}
function paint(part,material) {material.color.set(part==='arm'?0x00cc44:0x3344cc)}
const preview=body.preview(null,paint),baked=preview.children[0];
// Check authored shading first so the old flat-normal bake fails for the actual visible defect.
let maxNormalError=0;
for(let i=0;i<7;i++) {
  const expected=shader(i,geometry.getAttribute('normal'),0),actual=baked.geometry.getAttribute('normal');
  maxNormalError=Math.max(maxNormalError,Math.hypot(actual.getX(i)-expected.x,actual.getY(i)-expected.y,actual.getZ(i)-expected.z));
}
console.log(`Authored skin normal maximum vector error: ${maxNormalError}`);
assert.ok(maxNormalError<2e-6,'Preview must retain authored skin normals, not per-triangle face normals');
assert.ok(baked.geometry.index,'Authored indexed topology must remain indexed');
assert.deepEqual(Array.from(baked.geometry.index.array),Array.from(geometry.index.array));
assert.deepEqual(baked.geometry.groups,geometry.groups);
assert.deepEqual(Array.from(baked.geometry.getAttribute('uv').array),uv.map(Math.fround));
for(const attribute of ['position','normal','tangent'])for(let i=0;i<7;i++) {
  const expected=shader(i,geometry.getAttribute(attribute),attribute==='position'?1:0),actual=baked.geometry.getAttribute(attribute);
  for(const [j,axis]of ['x','y','z'].entries())near(actual.getComponent(i,j),expected[axis],`${attribute}[${i}].${axis}`);
  if(attribute==='tangent')assert.equal(actual.getW(i),geometry.getAttribute('tangent').getW(i));
}
assert.equal(baked.geometry.getAttribute('skinIndex'),undefined);assert.equal(baked.geometry.getAttribute('skinWeight'),undefined);
for(let i=0;i<16;i++)near(baked.matrix.elements[i],mesh.matrixWorld.elements[i],`world matrix[${i}]`);
assert.equal(baked.material[0].color.getHex(),0x00cc44);assert.equal(baked.material[1].color.getHex(),0x3344cc);
assert.notEqual(baked.material[0],live[0]);assert.notEqual(baked.material[0],source[0]);
const selected=body.preview('torso',paint),selection=selected.children[0];
assert.deepEqual(Array.from(selection.geometry.index.array),[4,5,6]);assert.deepEqual(selection.geometry.groups,[{start:0,count:3,materialIndex:0}]);
assert.equal(selection.material.length,1);assert.equal(selection.material[0].color.getHex(),0x3344cc);
const expectedPartBounds=new THREE.Box3();
for(const index of [4,5,6]) {
  const point=shader(index,geometry.getAttribute('position'),1);
  expectedPartBounds.expandByPoint(new THREE.Vector3(point.x,point.y,point.z));
}
expectedPartBounds.applyMatrix4(mesh.matrixWorld);
const actualPartBounds=new THREE.Box3().setFromObject(selected);
for(const edge of ['min','max'])for(const axis of ['x','y','z'])
  near(actualPartBounds[edge][axis],expectedPartBounds[edge][axis],
    `Part preview ${edge}.${axis} must frame drawn triangles, not unused full-body vertices`);
assert.equal(body.preview('absent',paint).children.length,0);assert.equal(snapshot(),before,'Preview must not mutate live geometry, skeleton, transform or materials');
for(const root of [preview,selected])for(const child of root.children){child.geometry.dispose();for(const material of child.material)material.dispose()}
geometry.dispose();skeleton.dispose();for(const material of [...source,...live])material.dispose();
console.log('PASS: authored weighted skin positions/normals/tangents, nonidentity bind, indexed seams/groups, part filtering, paint isolation and unchanged live rig.');
