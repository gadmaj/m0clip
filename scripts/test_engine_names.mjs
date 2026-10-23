/** Native C API lookups agree with the original accessor values on every robot variant. */
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {writeFile,mkdir} from 'node:fs/promises';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
const fetchOriginal=globalThis.fetch;
globalThis.fetch=(url,options)=>fetchOriginal(new URL(url,process.env.BASE_URL||'http://127.0.0.1:5176'),options);
const bundle=await build({stdin:{contents:"export {Engine} from './src/sim/engine';export {getSpec} from './src/robots';",resolveDir:process.cwd()},bundle:true,platform:'node',packages:'external',format:'esm',write:false});
const file=resolve('node_modules/.cache/engine-names.mjs');await mkdir(resolve('node_modules/.cache'),{recursive:true});
await writeFile(file,bundle.outputFiles[0].text.replaceAll('"/wasm/mujoco.js"',JSON.stringify(pathToFileURL(resolve('public/wasm/mujoco.js')).href)).replaceAll('"/wasm/mujoco.wasm"',JSON.stringify(resolve('public/wasm/mujoco.wasm'))));
const {Engine,getSpec}=await import(pathToFileURL(file)),results=[];
for(const robot of ['r1','r1_air','r1_air_edu','g1','g1_air','go2']){
 const spec=getSpec(robot),engine=await Engine.create(spec.model_dir,undefined,spec.scene);try{
  const m=engine.model,mj=engine.mj,actuators=new Map();
  for(let i=0;i<m.nu;i++){const a=m.actuator(i);try{actuators.set(a.name,Math.abs(a.ctrlrange[1]))}finally{a.delete()}}
  let bodies=0,joints=0,fallbacks=0;
  for(let i=0;i<m.nbody;i++){const a=m.body(i);try{assert.equal(mj.mj_id2name(m,mj.mjtObj.mjOBJ_BODY.value,i)??'',a.name);if(a.name){assert.equal(engine.bodyId(a.name),a.id);bodies++}}finally{a.delete()}}
  for(let i=0;i<m.njnt;i++){const a=m.jnt(i);try{
   assert.equal(mj.mj_id2name(m,mj.mjtObj.mjOBJ_JOINT.value,i)??'',a.name);
   assert.equal(engine.jointQposAdr(a.name),Number(a.qposadr[0]??a.qposadr));assert.equal(engine.jointDofAdr(a.name),Number(a.dofadr[0]??a.dofadr));
   const expected=[a.name,a.name.replace('_joint','')].map(n=>actuators.get(n)).find(v=>v>0)??200;
   assert.equal(engine.actuatorLim(a.name),expected);fallbacks+=expected===200;joints++;
  }finally{a.delete()}}
  assert.throws(()=>engine.bodyId('__missing_body__'),/not found/);assert.throws(()=>engine.jointQposAdr('__missing_joint__'),/not found/);
  results.push({robot,bodies,joints,fallbacks});
 }finally{engine.dispose()}
}
console.log(JSON.stringify({results,exact:true}));
