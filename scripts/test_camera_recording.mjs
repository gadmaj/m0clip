/** Camera banking survives interpolation and .take files; legacy tracks keep their layout. */
import assert from 'node:assert/strict';import{build}from'esbuild';import{mkdir,rm}from'node:fs/promises';import{resolve}from'node:path';import * as THREE from'three';import{unzipSync,zipSync}from'fflate';
const dir=resolve('node_modules/.cache'),file=resolve(dir,'camera-recording-test.mjs');await mkdir(dir,{recursive:true});
try{
 await build({stdin:{contents:"export * from './src/record/take';export * from './src/record/shot';",resolveDir:process.cwd()},bundle:true,packages:'external',format:'esm',platform:'node',outfile:file});
 const{Take,TakeRecorder,ShotPath,defaultShot,saveTake,loadTake,CAM_STRIDE}=await import(file);
 const meta={robot:'r1',terrain:'flat',policy:'test',created:new Date(0).toISOString(),ngeom:1,nq:7,baseQadr:0,hinges:[]};
 const camera=new THREE.PerspectiveCamera();camera.up.set(0,0,1);camera.position.set(2,-2,1);camera.lookAt(0,0,1);const level=camera.quaternion.clone();
 const rotation=angle=>level.clone().multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0,0,1),angle));
 const rec=new TakeRecorder(meta),frame={xpos:new Float32Array([0,0,1]),xmat:new Float32Array([1,0,0,0,1,0,0,0,1]),qpos:new Float64Array([0,0,1,1,0,0,0])};
 for(const[clock,angle]of[[0,179],[1,-179]])rec.push({...frame,clock},[0,0,0],{pos:[2,-2,1],target:[0,0,1],fov:60,orientation:rotation(angle*Math.PI/180).toArray()});
 const take=rec.finish();assert.equal(CAM_STRIDE,7);assert.equal(take.cam.length,14);assert.equal(take.camOrientation.length,8);
 const expected=rotation(Math.PI),mid=take.camAt(.5);assert.ok(new THREE.Quaternion().fromArray(mid.orientation).angleTo(expected)<1e-6,'Bank crosses ±180 using the shortest arc');
 assert.deepEqual(mid.pos,[2,-2,1]);assert.equal(mid.fov,60);
 const loaded=await loadTake(await(await saveTake(take)).arrayBuffer());assert.deepEqual(loaded.cam,take.cam);assert.deepEqual(loaded.camOrientation,take.camOrientation);assert.ok(new THREE.Quaternion().fromArray(loaded.camAt(.5).orientation).angleTo(expected)<1e-6);
 const shot={...defaultShot(.7),mode:'viewport',smooth:0},path=new ShotPath(loaded,shot);path.apply(camera,.5,1.5);assert.ok(camera.quaternion.angleTo(expected)<1e-6);
 const smoothed=new ShotPath(loaded,{...shot,smooth:.5});for(const t of[0,.25,.5,.75,1]){smoothed.apply(camera,t,1.5);assert.ok(Math.abs(camera.quaternion.length()-1)<1e-12);assert.ok(camera.quaternion.angleTo(expected)<.04)}
 const legacy=new Take(meta,take.t,take.geom,take.qpos,take.cmd,take.cam,take.hoist,[]);assert.equal(legacy.camAt(.5).orientation,undefined);const old=await loadTake(await(await saveTake(legacy)).arrayBuffer());assert.equal(old.camOrientation,undefined);new ShotPath(old,shot).apply(camera,.5,1.5);assert.ok(camera.quaternion.angleTo(level)<1e-6);
 const bytes=unzipSync(new Uint8Array(await(await saveTake(take)).arrayBuffer()));for(const bad of[new Float32Array(8),Float32Array.from([NaN,0,0,1,0,0,0,1]),new Float32Array(4)]){const zipped=zipSync({...bytes,'camOrientation.f32':new Uint8Array(bad.buffer)});await assert.rejects(loadTake(zipped.buffer),/camera orientation|expected/)}
 const fallback=new TakeRecorder(meta);for(const clock of[0,1])fallback.push({...frame,clock},[0,0,0],{pos:[2,-2,1],target:[0,0,1],fov:60});assert.ok(new THREE.Quaternion().fromArray(fallback.finish().camAt(.5).orientation).angleTo(level)<1e-6);
 console.log('PASS: recorded roll, shortest-arc interpolation, viewport smoothing, lossless take round-trip, old takes, malformed orientation rejection, lookAt fallback');
}finally{await rm(file,{force:true})}
