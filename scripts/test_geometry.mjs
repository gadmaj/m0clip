import assert from 'node:assert/strict';
import { mkdir, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { build } from 'esbuild';
import { zipSync, unzipSync } from 'fflate';
const file = resolve('node_modules/.cache/geometry-test.mjs');
await mkdir(resolve('node_modules/.cache'), { recursive: true });
try {
  await build({ stdin: { contents: "export * from './src/core/geometry';export * from './src/record/take';", resolveDir: process.cwd() }, bundle: true, packages: 'external', platform: 'node', format: 'esm', outfile: file });
  const { GeometryTrack, Take, TakeRecorder, denseGeometryPartition, validGeometryPartition, validGeometryData, saveTake, loadTake } = await import(file);
  const meta = { robot: 'unknown-legacy', model: 'Display label', terrain: 'flat', policy: 'test', created: '2026-01-01', ngeom: 4, nq: 0, baseQadr: -1, hinges: [] };
  const row = x => [x, x + 1, x + 2, 1, 0, 0, 0];
  const partition = { fixedIds: new Uint32Array([0, 2]), fixed: new Float32Array([...row(10), ...row(20)]) };
  const recorder = new TakeRecorder(meta, partition);
  partition.fixed[0] = 999;
  for (const clock of [0, 1]) recorder.push({ clock, xpos: new Float32Array([999,999,999,clock*4,1,2,999,999,999,30+clock*8,2,3]), xmat: new Float32Array(Array.from({length:4},()=>[1,0,0,0,1,0,0,0,1]).flat()), qpos: new Float64Array() }, [clock, 2, 3], { pos: [1,2,3], target: [0,0,0], fov: 60 });
  const first = recorder.snapshot(0), later = recorder.snapshot(1);
  assert.equal(first.geom.length, 28); assert.equal(later.geom.length, 14);
  assert.equal(first.geometry.fixed[0], 10); assert.equal('geometry' in later, false);
  first.geometry.fixed[0] = 888;
  const take = recorder.finish();
  assert.equal(take.geom.values.length, 42); assert.equal(take.meta.ngeom, 4); assert.equal(take.meta.model, 'Display label');
  const full = new Float32Array(28); take.geomPoseAt(.5, full);
  assert.equal(full[0], 10); assert.equal(full[7], 2); assert.equal(full[14], 20); assert.equal(full[21], 34);
  const pose = take.poseAt(.5); assert.deepEqual([...pose.xpos], [10,11,12,2,1,2,20,21,22,34,2,3]);
  assert.strictEqual(take.poseAt(1), pose); assert.equal(pose.xpos[3], 4); assert.equal(pose.xpos[0], 10);
  const sampled = take.sampleGeometry([-1, 0, .5, 1, 2], .25);
  assert.equal(sampled.values.length, 84);
  for (let frame = 0; frame < 5; frame++) {
    take.geomPoseAt([-1,0,.5,1,2][frame]+.25, full);
    for (let g = 0; g < 4; g++) assert.deepEqual(sampled.values.subarray(sampled.offset(frame,g),sampled.offset(frame,g)+7), full.subarray(g*7,g*7+7));
  }
  const reopened = await loadTake(await (await saveTake(take)).arrayBuffer());
  assert.deepEqual(reopened.geom.toData(), take.geom.toData());
  assert.notStrictEqual(reopened.poseAt(0).xpos, pose.xpos);
  for (const key of ['t','qpos','cmd','cam','hoist','camOrientation']) assert.deepEqual(reopened[key], take[key]);
  const files = unzipSync(new Uint8Array(await (await saveTake(take)).arrayBuffer()));
  const header = JSON.parse(new TextDecoder().decode(files['take.json'])); assert.equal(header.version, 2);
  for (const fixedIds of [new Uint32Array([2,0]),new Uint32Array([0,0]),new Uint32Array([4]),new Int32Array([0]),[0]]) {
    assert.equal(validGeometryPartition({fixedIds,fixed:new Float32Array(fixedIds.length*7)},4), false);
    assert.equal(validGeometryData({fixedIds,values:new Float32Array(42)},4,2), false);
  }
  assert.equal(validGeometryData({fixedIds:new Uint32Array([0,2]),values:new Float32Array(41)},4,2),false);
  for (const patch of [{ 'geom-fixed.u32': new Uint8Array(new Uint32Array([2,0]).buffer) }, { 'geom-fixed.u32': new Uint8Array(1) }, { 'geom.f32': new Uint8Array(4) }]) await assert.rejects(loadTake(zipSync({...files,...patch}).buffer), /geometry/);
  const missing = {...files}; delete missing['geom-fixed.u32']; await assert.rejects(loadTake(zipSync(missing).buffer), /geometry/);
  await assert.rejects(loadTake(zipSync({...files,'take.json':new TextEncoder().encode(JSON.stringify({...header,version:3}))}).buffer), /unsupported version/);
  // Legacy dense rows are retained even when unknown world geometry changes only later.
  const denseValues = new Float32Array([...row(1),...row(2),...row(3),...row(4),...row(101),...row(2),...row(303),...row(4)]);
  const legacyFiles = {...files,'take.json':new TextEncoder().encode(JSON.stringify({...header,version:1})),'geom.f32':new Uint8Array(denseValues.buffer)};
  delete legacyFiles['geom-fixed.u32']; delete legacyFiles['camOrientation.f32'];
  const legacy = await loadTake(zipSync(legacyFiles).buffer);
  assert.equal(legacy.geom.fixedIds.length,0); assert.deepEqual(legacy.geom.values,denseValues); assert.equal(legacy.camOrientation,undefined);
  legacy.geomPoseAt(.5,full); assert.equal(full[0],51); assert.equal(full[14],153);
  const legacyAgain = await loadTake(await(await saveTake(legacy)).arrayBuffer()); assert.deepEqual(legacyAgain.geom.values,denseValues);
  const one = new Take(meta,new Float64Array([0]),GeometryTrack.dense(4,1,denseValues.slice(0,28)),new Float32Array(),new Float32Array(3),new Float32Array(7),new Float32Array(3),[]);
  const oneFiles = unzipSync(new Uint8Array(await(await saveTake(one)).arrayBuffer()));
  const oneHeader = JSON.parse(new TextDecoder().decode(oneFiles['take.json'])); oneHeader.version=1; oneFiles['take.json']=new TextEncoder().encode(JSON.stringify(oneHeader)); delete oneFiles['geom-fixed.u32'];
  const oneLegacy=await loadTake(zipSync(oneFiles).buffer); assert.equal(oneLegacy.duration,0); assert.deepEqual(oneLegacy.sampleGeometry([0,1]).values,new Float32Array([...denseValues.slice(0,28),...denseValues.slice(0,28)]));
  const raw = new Float32Array([...row(0),...row(2)]); raw[10]=-1;
  const short = new Take({...meta,ngeom:1},new Float64Array([0,1]),GeometryTrack.dense(1,2,raw),new Float32Array(),new Float32Array(6),new Float32Array(14),new Float32Array(6),[]);
  const shortPose=new Float32Array(7); short.geomPoseAt(.5,shortPose); assert.equal(shortPose[3],1); assert.deepEqual(short.geom.values,raw);
  for (const ngeom of [0,2]) {
    const fixedIds=Uint32Array.from({length:ngeom},(_,i)=>i), values=new Float32Array(Array.from({length:ngeom},(_,i)=>row(i)).flat());
    const allFixed=new Take({...meta,ngeom},new Float64Array([0,1]),new GeometryTrack(ngeom,2,{fixedIds,values}),new Float32Array(),new Float32Array(6),new Float32Array(14),new Float32Array(6),[]);
    assert.equal(allFixed.sampleGeometry([0,.5,1]).values.length,ngeom*7); assert.equal(allFixed.poseAt(.5).xpos.length,ngeom*3);
  }
  const dense=GeometryTrack.dense(1,1,new Float32Array(row(1))); assert.strictEqual(dense.toData().values,dense.values); assert.equal(denseGeometryPartition().fixed.length,0);
  assert.throws(()=>new Take(meta,new Float64Array([0]),take.geom,new Float32Array(),new Float32Array(),new Float32Array(),new Float32Array(),[]),/dimensions/);
  console.log('PASS: compact original-ID geometry, interpolation, snapshot ownership, portable v2 and dense legacy conversion');
} finally { await rm(file,{force:true}); }
