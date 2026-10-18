/** Native Ghost head fit: preserve original triangles/UVs under compiled mesh transforms. */
import { build } from 'esbuild';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import * as THREE from 'three';
const dir = await mkdtemp(join(tmpdir(), 'ghost-head-test-'));
try {
  const output = join(dir, 'head.mjs');
  await build({entryPoints:['src/render/source-robot/head.ts'], outfile:output, bundle:true, format:'esm', platform:'node'});
  const { fitGhostHead } = await import(output);
  const file = await readFile('public/assets/source-robots/neotokyo-girlbot/girlbot_head.glb');
  const length = file.readUInt32LE(12), json = JSON.parse(file.subarray(20,20+length));
  const bin = file.subarray(28+length);
  const primitive = json.meshes[0].primitives[0];
  const array = index => {
    const a=json.accessors[index], v=json.bufferViews[a.bufferView], components={SCALAR:1,VEC2:2,VEC3:3,VEC4:4}[a.type];
    const offset=(v.byteOffset||0)+(a.byteOffset||0), count=a.count*components;
    const copy=bin.subarray(offset,offset+count*4);
    return a.componentType===5125 ? new Uint32Array(copy.buffer.slice(copy.byteOffset,copy.byteOffset+copy.byteLength))
      : new Float32Array(copy.buffer.slice(copy.byteOffset,copy.byteOffset+copy.byteLength));
  };
  const source=new THREE.BufferGeometry();
  source.setAttribute('position',new THREE.BufferAttribute(array(primitive.attributes.POSITION),3));
  source.setAttribute('normal',new THREE.BufferAttribute(array(primitive.attributes.NORMAL),3));
  source.setAttribute('uv',new THREE.BufferAttribute(array(primitive.attributes.TEXCOORD_0),2));
  source.setIndex(new THREE.BufferAttribute(array(primitive.indices),1));
  assert.equal(source.index.count,366*3);
  const before=source.attributes.position.array.slice();
  // MuJoCo recentres/rotates STL mesh buffers. Fit in file coordinates, not those principal axes.
  const toFile=new THREE.Matrix4().compose(new THREE.Vector3(.03,-.02,.06),
    new THREE.Quaternion().setFromEuler(new THREE.Euler(.7,-.2,.4)),new THREE.Vector3(1,1,1));
  const targetFile=new THREE.BoxGeometry(.18,.14,.16).translate(.01,0,.04);
  const target=targetFile.clone().applyMatrix4(toFile.clone().invert());
  const fitted=fitGhostHead(source,target,toFile);
  const inFile=fitted.clone().applyMatrix4(toFile); inFile.computeBoundingBox();targetFile.computeBoundingBox();
  assert.ok(inFile.boundingBox.getCenter(new THREE.Vector3()).distanceTo(targetFile.boundingBox.getCenter(new THREE.Vector3()))<1e-6);
  assert.ok(Math.abs(inFile.boundingBox.getSize(new THREE.Vector3()).z-.16)<1e-6);
  assert.deepEqual(fitted.index.array,source.index.array);
  assert.deepEqual(fitted.attributes.uv.array,source.attributes.uv.array);
  assert.deepEqual(source.attributes.position.array,before,'Must not mutate the cached native source geometry');
  const nativeUpright=source.clone().rotateY(Math.PI/2); nativeUpright.computeBoundingBox();
  const expected=nativeUpright.boundingBox.getSize(new THREE.Vector3());
  const actual=inFile.boundingBox.getSize(new THREE.Vector3());
  for(const axis of ['x','y']) assert.ok(Math.abs(actual[axis]/actual.z-expected[axis]/expected.z)<1e-5,'Uniform fit must preserve native proportions');
  for(const image of json.images) assert.equal(image.mimeType,'image/png');
  assert.ok(json.materials[0].normalTexture,'Original normal map must be retained');
  assert.ok(json.materials[0].extras.sourceMaterial.phongexponenttextureIndex!==undefined,'Original Phong mask must be retained');
  console.log('Native 366-triangle Ghost head: UV/index preservation, uniform fit, compiled coordinate alignment, PNG/normal/Phong textures passed.');
} finally { await rm(dir,{recursive:true,force:true}); }
