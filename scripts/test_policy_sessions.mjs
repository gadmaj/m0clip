/** Session ownership across policy replacement, rollback and repeated terrain loads. */
import assert from 'node:assert/strict';
import {build} from 'esbuild';
const backend=`
export const state={created:[],released:[]},env={wasm:{}};
export class Tensor{constructor(type,data,dims){Object.assign(this,{type,data,dims})}}
export const InferenceSession={async create(bytes,options){
 const value=new Uint8Array(bytes)[0];if(value===255)throw new Error('Invalid network');
 const session={value,closed:false,inputNames:['obs'],outputNames:['actions'],inputMetadata:[{name:'obs',shape:[1,2]}],
 async run(feeds){if(this.closed)throw new Error('Released session');return{actions:{data:Float32Array.of(feeds.obs.data[0]+feeds.obs.data[1]+value)}}},
 async release(){if(this.closed)throw new Error('Double release');this.closed=true;state.released.push(this.value)}};
 state.created.push(session);return session;
}};`;
const result=await build({stdin:{contents:"export * from './src/core/policy';export {state} from 'onnxruntime-web/wasm';",resolveDir:process.cwd()},bundle:true,platform:'node',format:'cjs',write:false,
 plugins:[{name:'controlled-runtime',setup(b){b.onResolve({filter:/^onnxruntime-web\/wasm$/},()=>({path:'runtime',namespace:'controlled'}));b.onLoad({filter:/.*/,namespace:'controlled'},()=>({contents:backend,loader:'js'}))}}]});
const module={exports:{}};new Function('module',result.outputFiles[0].text)(module);
const {OnnxPolicy,OnnxSession,withPolicySessions,releasePolicySessions,state}=module.exports;
const fetchOriginal=globalThis.fetch;
globalThis.fetch=async url=>new Response(Uint8Array.of(({a:10,b:20,c:30,bad:255})[url.slice(1)]));
try{
 const first=await withPolicySessions(async()=>({a:await OnnxPolicy.load('/a'),b:await OnnxSession.load('/b')}));
 assert.deepEqual(Array.from(await first.a.run(Float32Array.of(1,2))),[13]);
 await withPolicySessions(async()=>{await OnnxPolicy.load('/a');await OnnxSession.load('/b')});
 assert.equal(state.created.length,2);assert.equal(state.released.length,0);
 await assert.rejects(withPolicySessions(async()=>{await OnnxPolicy.load('/c');await OnnxPolicy.load('/bad')}),/Invalid network/);
 assert.deepEqual(state.released,[30]);assert.deepEqual(Array.from(await first.a.run(Float32Array.of(1,2))),[13]);
 assert.deepEqual(Array.from(await first.b.run({obs:{data:Float32Array.of(1,2),dims:[1,2]}})),[23]);
 await withPolicySessions(async()=>{await OnnxPolicy.load('/a');await OnnxPolicy.load('/c')});
 assert.deepEqual(state.released,[30,20]);await assert.rejects(first.b.run({obs:{data:Float32Array.of(1,2),dims:[1,2]}}),/Released/);
 await releasePolicySessions();await releasePolicySessions();
 assert.equal(state.created.length,4);assert.equal(state.released.length,4);assert.ok(state.created.every(s=>s.closed));
 console.log(JSON.stringify({reuse:true,outputs:true,replacement:true,failedLoadRollback:true,partialLoadCleanup:true,clear:true,created:4,released:4}));
}finally{globalThis.fetch=fetchOriginal}
