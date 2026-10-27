import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
const bundled=await build({stdin:{contents:"export * from './src/maps/source';export {Engine} from './src/sim/engine';",resolveDir:process.cwd()},bundle:true,platform:'node',format:'cjs',write:false});
const module={exports:{}};
new Function('module','exports','require',bundled.outputFiles[0].text)(module,module.exports,createRequire(import.meta.url));
const {MapSource,registerLocalMap,mapSource,validLocalMap,Engine}=module.exports;
const payload=(fingerprint,text)=>({id:`local-${fingerprint}`,fingerprint,name:'Same map name',game:'Converted',files:new Map([
  ['manifest.json',new Blob([JSON.stringify({files:['map.xml','physics/hull.bin']})],{type:'application/json'})],
  ['map.xml',new Blob(['<mujoco><worldbody/></mujoco>'],{type:'application/xml'})],
  ['physics/hull.bin',new Blob([text])],
  ['resources/body.bin',new Blob([text])],
])});
const a=registerLocalMap(payload('a'.repeat(64),'first')),b=registerLocalMap(payload('b'.repeat(64),'second'));
assert.ok(validLocalMap(a.identity,`map:${a.id}`));
assert.ok(!validLocalMap(a.identity,`map:${b.id}`));
assert.throws(()=>mapSource(`map:local-${'c'.repeat(64)}`),/same map bundle/);
const originalFetch=globalThis.fetch;
let network=0;
globalThis.fetch=async()=>{network++;throw new Error('Unexpected HTTP fallback');};
try{
  assert.equal(await(await a.read('physics/hull.bin')).text(),'first');
  assert.equal(await(await b.read('physics/hull.bin')).text(),'second');
  await assert.rejects(a.read('textures/missing.png'),/missing/);
  for(const path of ['../escape','/absolute','https://outside.test/asset','a/../b','textures\\world.png'])await assert.rejects(a.read(path),/Invalid map resource/);
  assert.throws(()=>a.httpUrl('map.xml'),/not HTTP/);
  assert.equal(network,0,'Local reads, invalid paths and missing leaves never request HTTP');
  const releaseA=a.retain(),releaseAgain=a.retain(),releaseB=b.retain();
  const urlA=a.resolveUrl(a.base+'resources/body.bin'),urlB=b.resolveUrl(b.base+'resources/body.bin');
  assert.equal(a.resolveUrl(a.base+'render/../resources/body.bin'),urlA,'Relative GLTF leaves remain inside the same virtual root');
  assert.throws(()=>a.resolveUrl(a.base+'../outside.bin'),/escapes/);
  assert.notEqual(urlA,urlB);
  assert.equal(await(await originalFetch(urlA)).text(),'first');
  releaseA();assert.equal(await(await originalFetch(urlA)).text(),'first','Another scene/export lease retains the exact body');
  releaseAgain();await assert.rejects(originalFetch(urlA));
  assert.throws(()=>a.resolveUrl(a.base+'resources/body.bin'),/lease/,'Cancelled parsers cannot allocate immortal late URLs');
  assert.equal(await(await originalFetch(urlB)).text(),'second','Releasing one bundle cannot revoke another bundle');
  releaseB();await assert.rejects(originalFetch(urlB));
  const plan=await Engine.prepare('/robot','scene.xml',{source:a,mount:'/work/maps/'+a.identity.fingerprint},async()=>Response.json({files:['scene.xml','meshes/leg.stl']}));
  assert.deepEqual(plan.urls,['/robot/scene.xml.manifest.json','/robot/scene.xml','/robot/meshes/leg.stl'],'Fixed HTTP closure excludes every local file byte');
}finally{globalThis.fetch=originalFetch;}
console.log('PASS: map containment, independent URL leases, no HTTP fallback and local-free download closure');
