/** Compile map switches with the application's actual MuJoCo wrapper in Node. */
import {build} from 'esbuild';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
const base=process.env.BASE_URL||'http://127.0.0.1:5176';
const originalFetch=globalThis.fetch;
globalThis.fetch=(input,options)=>originalFetch(new URL(input,base),options);
const describe=process.env.DESCRIBE_MODEL==='1';
const contents=describe?(await readFile('src/worker/sim.worker.ts','utf8')).split('const sim = new SimWorker();')[0]+'\nexport {SimWorker,Engine,terrainTransform};':"export {Engine} from './src/sim/engine';export {terrainTransform} from './src/sim/terrain';";
if(describe)globalThis.self={postMessage(){}};
const built=await build({stdin:{contents,loader:'ts',resolveDir:describe?resolve('src/worker'):process.cwd()},bundle:true,platform:'node',packages:'external',format:'esm',write:false});
const file=resolve('node_modules/.cache/map-engine-lifetime.mjs');await mkdir(resolve('node_modules/.cache'),{recursive:true});
const code=built.outputFiles[0].text.replaceAll('"/wasm/mujoco.js"',JSON.stringify(pathToFileURL(resolve('public/wasm/mujoco.js')).href)).replaceAll('"/wasm/mujoco.wasm"',JSON.stringify(resolve('public/wasm/mujoco.wasm')));
await writeFile(file,code);const {Engine,terrainTransform,SimWorker}=await import(pathToFileURL(file));
const sim=describe?new SimWorker():null;
if(sim){const renderModel=sim.renderModel.bind(sim);sim.renderModel=()=>{console.log('Describing '+sim.terrain);const result=renderModel();console.log('Description ready');return result;};}
const index=JSON.parse(await readFile('public/assets/maps/index.json','utf8'));
const maps=process.env.MAP_IDS?.split(',')||index.maps.map(m=>m.id);
let engine;const results=[];
try {for(const id of maps){
 console.log('Compiling '+id);const previous=engine,started=performance.now();
 if(sim){sim.terrain='map:'+id;await sim.buildEngine();engine=sim.eng;}
 else {engine=await Engine.create('/assets/models/r1',terrainTransform('map:'+id,{},'/work/map'),'scene.xml',{dir:'/assets/maps/'+id,mount:'/work/map'});previous?.dispose();}
 const row={id,geoms:engine.model.ngeom,ms:performance.now()-started,heap:engine.model.geom_pos.buffer.byteLength,rss:process.memoryUsage().rss,
 arena:engine.data.narena,usedArena:engine.data.maxuse_arena,modelBuffer:engine.model.nbuffer,dataBuffer:engine.data.nbuffer};
 results.push(row);console.log(JSON.stringify(row));
}console.log(JSON.stringify({maps:results.length,describe,results}));}finally{(sim?sim.eng:engine)?.dispose()}
