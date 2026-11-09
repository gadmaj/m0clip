/** A take's recorded map clock (sourceTime) must be a usable lightstyle/animation time. */
import assert from 'node:assert/strict';import buildFixture from './build-fixture.cjs';import{mkdir,rm,writeFile}from'node:fs/promises';import{resolve}from'node:path';import{unzipSync,zipSync}from'fflate';
const dir=resolve('node_modules/.cache'),file=resolve(dir,'take-source-time-test.mjs');await mkdir(dir,{recursive:true});
try{
 await writeFile(file,(await buildFixture({root:process.cwd(),source:"export * from './src/core/geometry';export * from './src/record/take';export {validMeta} from './src/record/storage';export {validPlayerMeta} from './src/record/player-take';export * from './src/render/source-clock';",platform:'node',format:'es',externalPackages:true})).code);
 const{denseGeometryPartition,TakeRecorder,saveTake,loadTake,validMeta,validPlayerMeta,clampSourceTime,SOURCE_TIME_LIMIT_SECONDS}=await import(file);
 const meta={robot:'r1',terrain:'flat',policy:'test',created:new Date(0).toISOString(),ngeom:1,nq:7,baseQadr:0,hinges:[],sourceTime:12.5};
 const rec=new TakeRecorder(meta,denseGeometryPartition()),frame={xpos:new Float32Array([0,0,1]),xmat:new Float32Array([1,0,0,0,1,0,0,0,1]),qpos:new Float64Array([0,0,1,1,0,0,0])};
 const player={mode:'player',terrain:'flat',created:meta.created,content:[]};
 for(const clock of[0,1])rec.push({...frame,clock},[0,0,0],{pos:[2,-2,1],target:[0,0,1],fov:60});
 const take=rec.finish(),files=unzipSync(new Uint8Array(await(await saveTake(take)).arrayBuffer()));
 const head=JSON.parse(new TextDecoder().decode(files['take.json']));
 const withClock=value=>{const changed={...head,meta:{...head.meta}};if(value===undefined)delete changed.meta.sourceTime;else changed.meta.sourceTime=value;return zipSync({...files,'take.json':new TextEncoder().encode(JSON.stringify(changed))}).buffer;};
 assert.equal((await loadTake(withClock(12.5))).meta.sourceTime,12.5);
 assert.equal((await loadTake(withClock(undefined))).meta.sourceTime,undefined,'Takes without a map clock still load');
 assert.equal((await loadTake(withClock(0))).meta.sourceTime,0);
 assert.equal((await loadTake(withClock(SOURCE_TIME_LIMIT_SECONDS))).meta.sourceTime,SOURCE_TIME_LIMIT_SECONDS);
 // JSON cannot carry NaN or Infinity; these are the bad clocks a file can actually hold.
 for(const bad of[-0.5,-1e9,1e300,SOURCE_TIME_LIMIT_SECONDS*2,'12',null,true,[1],{}])
  await assert.rejects(loadTake(withClock(bad)),/take file: invalid map clock \(sourceTime must be a number of seconds from 0 to 1,000,000,000\)/,JSON.stringify(bad));
 for(const bad of[-1,NaN,Infinity,1e300]){
  assert.equal(validMeta({...meta,sourceTime:bad}),false,`stored Robot take clock ${bad}`);
  assert.equal(validPlayerMeta({...player,sourceTime:bad}),false,`Player take clock ${bad}`);
 }
 assert.equal(validMeta(meta),true);assert.equal(validPlayerMeta({...player,sourceTime:12.5}),true);
 // Review frames add playback time to the recorded clock; the scene clamps whatever it is given.
 for(const[time,expected]of[[NaN,0],[-3,0],[-Infinity,0],[Infinity,SOURCE_TIME_LIMIT_SECONDS],[SOURCE_TIME_LIMIT_SECONDS+60,SOURCE_TIME_LIMIT_SECONDS],[3.25,3.25]])
  assert.equal(clampSourceTime(time),expected,String(time));
 console.log('PASS: take map clock loads when valid, refuses negative/huge/non-number values with a specific message, and review clocks clamp');
}finally{await rm(file,{force:true})}
