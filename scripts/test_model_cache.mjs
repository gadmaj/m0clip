/** The compiled-model cache returns a stored MJB only for byte-identical compile inputs, simulates
 * identically, survives corrupted or undecodable entries and never exceeds its size cap.
 * Runs the application's actual Engine in Node; GHOST=1 also times R1 on Ghost. */
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {pathToFileURL} from 'node:url';

const pub=resolve('public'),mutations=new Map();
// The public directory as the dev server serves it; `mutations` edits one response's bytes.
globalThis.fetch=async input=>{
  const path=decodeURI(new URL(String(input),'http://local').pathname);
  try{
    let body=new Uint8Array(await readFile(join(pub,path)));
    if(mutations.has(path))body=mutations.get(path)(body.slice());
    return new Response(body,{headers:{'content-type':path.endsWith('.json')?'application/json':path.endsWith('.wasm')?'application/wasm':'application/octet-stream'}});
  }catch{return new Response('missing',{status:404});}
};
const built=await build({stdin:{contents:`export {Engine,mujocoModule,useModelCache} from './src/sim/engine';
export {ModelCache,IndexedDbModelStore,modelCacheKey,lruEvictions} from './src/sim/model-cache';
export {terrainTransform} from './src/sim/terrain';export {mapSource} from './src/maps/source';export {getSpec} from './src/robots';`,
  loader:'ts',resolveDir:process.cwd()},bundle:true,platform:'node',packages:'external',format:'esm',write:false});
const file=resolve('node_modules/.cache/model-cache-test.mjs');await mkdir(resolve('node_modules/.cache'),{recursive:true});
await writeFile(file,built.outputFiles[0].text.replaceAll('"/wasm/mujoco.js"',JSON.stringify(pathToFileURL(join(pub,'wasm/mujoco.js')).href)));
const {Engine,mujocoModule,useModelCache,ModelCache,IndexedDbModelStore,modelCacheKey,lruEvictions,terrainTransform,mapSource,getSpec}=await import(pathToFileURL(file));

/** A ModelStore in memory, cloning bodies as IndexedDB does. A write past `quota` aborts whole. */
class MemoryStore{
  entries=new Map();bodies=new Map();
  constructor(quota=Infinity){this.quota=quota;}
  async read(key){const entry=this.entries.get(key),body=this.bodies.get(key);return entry&&body?{entry:{...entry},body:body.slice()}:undefined;}
  async write(entry,body,evict){
    const evicted=new Set(evict([...this.entries.values()].map(e=>({...e}))));
    let total=body.byteLength;for(const [key,stored] of this.bodies)if(!evicted.has(key)&&key!==entry.key)total+=stored.byteLength;
    if(total>this.quota)throw new DOMException('The quota has been exceeded.','QuotaExceededError');
    for(const key of evicted){this.entries.delete(key);this.bodies.delete(key);}
    this.entries.set(entry.key,{...entry});this.bodies.set(entry.key,body.slice());
  }
  async touch(key,used){const entry=this.entries.get(key);if(entry)entry.used=used;}
  async remove(key){this.entries.delete(key);this.bodies.delete(key);}
  get total(){let sum=0;for(const body of this.bodies.values())sum+=body.byteLength;return sum;}
}

const mj=await mujocoModule(),calls={xml:0,binary:0},{mj_loadXML,mj_loadBinary}=mj.MjModel;
mj.MjModel.mj_loadXML=function(...args){calls.xml++;return mj_loadXML.apply(this,args);};
mj.MjModel.mj_loadBinary=function(...args){calls.binary++;return mj_loadBinary.apply(this,args);};
let clock=0,applies=true;const stages=[];
function use(store,maxBytes){
  const cache=new ModelCache(store,maxBytes,()=>++clock);
  return {cache,release:useModelCache(cache,()=>applies?stage=>stages.push(stage):null)};
}
/** The model's MJB bytes, saved the way the engine saves them. */
function mjbOf(model){mj.mj_saveModel(model,'/test-model.mjb',null);try{return Buffer.from(mj.FS.readFile('/test-model.mjb'));}finally{mj.FS.unlink('/test-model.mjb');}}
const sceneXml=(name,xml)=>xml;
async function compile(cache,transform=sceneXml){
  calls.xml=calls.binary=0;stages.length=0;
  const engine=await Engine.create('/assets/models/r1',transform,'scene.xml');
  await cache?.idle();
  return {engine,xml:calls.xml,binary:calls.binary,stages:[...stages]};
}
const qposAfter=(engine,steps=500)=>{for(let i=0;i<steps;i++)engine.step();return Buffer.from(new Float64Array(engine.qpos).buffer);};
const names=(m,type,count)=>Array.from({length:count},(_,i)=>mj.mj_id2name(m,type,i)??'');
const shape=m=>({nq:m.nq,nv:m.nv,nu:m.nu,nbody:m.nbody,ngeom:m.ngeom,njnt:m.njnt,nmesh:m.nmesh,
  bodies:names(m,mj.mjtObj.mjOBJ_BODY.value,m.nbody),geoms:names(m,mj.mjtObj.mjOBJ_GEOM.value,m.ngeom),joints:names(m,mj.mjtObj.mjOBJ_JOINT.value,m.njnt)});
const results={};

// Pure LRU policy and the key's sensitivity to every part.
assert.deepEqual(lruEvictions([{key:'a',bytes:4,used:3},{key:'b',bytes:4,used:1},{key:'c',bytes:4,used:2}],'d',4,12),['b']);
assert.deepEqual(lruEvictions([{key:'a',bytes:4,used:1}],'a',8,8),[],'a replaced entry does not count against itself');
const base=[['/w/scene.xml',new Uint8Array([1,2,3])],['/w/a.stl',new Uint8Array([4,5])]],k0=await modelCacheKey('rt','/w/scene.xml',base);
assert.equal(await modelCacheKey('rt','/w/scene.xml',[...base].reverse()),k0,'file order is not an input');
for(const changed of [
  modelCacheKey('rt2','/w/scene.xml',base),modelCacheKey('rt','/w/other.xml',base),
  modelCacheKey('rt','/w/scene.xml',[base[0],['/w/a.stl',new Uint8Array([4,6])]]),
  modelCacheKey('rt','/w/scene.xml',[base[0],['/w/b.stl',new Uint8Array([4,5])]]),
  modelCacheKey('rt','/w/scene.xml',[base[0]]),
])assert.notEqual(await changed,k0);

{ // MuJoCo's asset cache re-checks an unchanged file with stat alone. A compile that stat-ed a file
  // outside its inputs is never stored, so swapping that file can never load a stale model. Runs
  // first, while the asset cache holds only this file.
  const store=new MemoryStore(),{cache,release}=use(store),stray='/work/stray.STL';
  const withStray=(name,text)=>name==='scene.xml'
    ?text.replace('</mujoco>',`<asset><mesh name="stray" file="${stray}"/></asset><worldbody><body pos="3 3 1"><geom type="mesh" mesh="stray"/></body></worldbody></mujoco>`):text;
  const opens=new Map(),open=mj.FS.open;
  mj.FS.open=function(...args){const stream=open.apply(this,args);opens.set(stream.path,(opens.get(stream.path)??0)+1);return stream;};
  try{
    try{mj.FS.mkdir('/work');}catch{/* Already mounted. */}
    mj.FS.writeFile(stray,await readFile(join(pub,'assets/models/r1/meshes/head_yaw_link.STL')));
    applies=false;const warm=await compile(cache,withStray);applies=true;warm.engine.dispose();
    opens.clear();
    const traced=await compile(cache,withStray);
    assert.deepEqual([traced.xml,traced.binary],[1,0]);assert.equal(store.entries.size,0,'a compile that read an unkeyed file is not stored');
    assert.equal(opens.get(stray)??0,0,'the second compile only stat-ed the unchanged stray file');
    const ngeom=traced.engine.model.ngeom;traced.engine.dispose();
    mj.FS.writeFile(stray,await readFile(join(pub,'assets/models/r1/meshes/left_elbow_link.STL')));
    const swapped=await compile(cache,withStray);
    assert.deepEqual([swapped.xml,swapped.binary],[1,0],'the swapped file compiles; nothing stale is loaded');
    assert.equal(swapped.engine.model.ngeom,ngeom);swapped.engine.dispose();
  }finally{mj.FS.open=open;try{mj.FS.unlink(stray);}catch{}release();}
}

// Without a cache: the reference compile.
const reference=await compile(null);
assert.equal(reference.xml,1);
const referenceShape=shape(reference.engine.model),referenceQpos=qposAfter(reference.engine);reference.engine.dispose();

{ // Same inputs: miss then hit, with identical model and simulation.
  const store=new MemoryStore(),{cache,release}=use(store);
  try{
    const miss=await compile(cache);
    assert.deepEqual([miss.xml,miss.binary,miss.stages],[1,0,[]]);assert.equal(store.entries.size,1,'the compiled model was stored');
    const [entry]=store.entries.values();
    assert.ok(entry.bytes>0&&entry.bytes===store.bodies.get(entry.key).byteLength);
    miss.engine.dispose();
    const t=performance.now(),hit=await compile(cache),hitMs=performance.now()-t;
    assert.deepEqual([hit.xml,hit.binary,hit.stages],[0,1,['cached']]);
    assert.deepEqual(shape(hit.engine.model),referenceShape);
    assert.ok(qposAfter(hit.engine).equals(referenceQpos),'500 steps from a cached model are bit-identical');
    hit.engine.dispose();
    results.r1={mjbBytes:entry.bytes,hitMs:Math.round(hitMs)};
    // A compile the owner does not route through the cache (a Player spawn) neither reads nor fills it.
    applies=false;
    try{const silent=await compile(cache);assert.deepEqual([silent.xml,silent.binary,silent.stages],[1,0,[]]);silent.engine.dispose();}
    finally{applies=true;}
    assert.equal(store.entries.size,1);

    // Any input byte change misses: the scene XML, or a mesh header byte the STL reader ignores.
    const xml=await compile(cache,(name,text)=>name==='scene.xml'?text.replace('</mujoco>','<!-- changed --></mujoco>'):text);
    assert.deepEqual([xml.xml,xml.binary],[1,0]);xml.engine.dispose();
    mutations.set('/assets/models/r1/meshes/head_yaw_link.STL',bytes=>{bytes[10]^=1;return bytes;});
    try{
      const mesh=await compile(cache);
      assert.deepEqual([mesh.xml,mesh.binary],[1,0]);
      assert.deepEqual(shape(mesh.engine.model),referenceShape,'an ignored header byte still compiles the same model');
      mesh.engine.dispose();
    }finally{mutations.clear();}
    assert.equal(store.entries.size,3);
    const original=await compile(cache);assert.deepEqual([original.xml,original.binary],[0,1],'the original inputs still hit');original.engine.dispose();

    // A damaged body fails its digest: removed, compiled and stored again.
    store.bodies.get(entry.key)[entry.bytes>>1]^=0xff;
    const damaged=await compile(cache);
    assert.deepEqual([damaged.xml,damaged.binary,damaged.stages],[1,0,[]]);
    assert.ok(qposAfter(damaged.engine).equals(referenceQpos));damaged.engine.dispose();
    assert.equal(store.entries.get(entry.key).sha256,entry.sha256,'the recompiled model replaced the damaged entry');

    // A body with a valid digest that MuJoCo cannot load: removed, then compiled.
    const garbage=new Uint8Array(4096).fill(7),digest=Buffer.from(await crypto.subtle.digest('SHA-256',garbage)).toString('hex');
    store.bodies.set(entry.key,garbage);store.entries.set(entry.key,{...store.entries.get(entry.key),bytes:garbage.byteLength,sha256:digest});
    const undecodable=await compile(cache);
    assert.deepEqual([undecodable.xml,undecodable.binary,undecodable.stages],[1,1,['cached','compiling']]);
    assert.ok(qposAfter(undecodable.engine).equals(referenceQpos));undecodable.engine.dispose();
    assert.equal(store.entries.get(entry.key).sha256,entry.sha256,'the undecodable entry was replaced');
  }finally{release();}
}

{ // Composed worlds mount under a new /scenes/N root per call; identical compositions still hit.
  const store=new MemoryStore(),{cache,release}=use(store);
  const world=async slots=>{calls.xml=calls.binary=0;stages.length=0;
    const engine=await Engine.createScene({slots});await cache.idle();return {engine,xml:calls.xml,binary:calls.binary,stages:[...stages]};};
  try{
    const empty=[await world([]),await world([]),await world([])];
    assert.deepEqual(empty.map(run=>[run.xml,run.binary]),[[1,0],[0,1],[0,1]],'an empty Player world compiles once');
    assert.equal(store.entries.size,1);
    for(const run of empty)run.engine.dispose();
    const slots=[{id:'a',robot:getSpec('r1')}];
    const first=await world(slots),second=await world(slots);
    assert.deepEqual([first.xml,first.binary,second.xml,second.binary,second.stages],[1,0,0,1,['cached']]);
    assert.equal(store.entries.size,2);
    assert.deepEqual(second.engine.entities,first.engine.entities,'entities describe the cached model identically');
    // The model compiled under another root is byte-identical to the cached one: the root is not part of it.
    applies=false;const fresh=await world(slots);applies=true;
    assert.equal(fresh.xml,1);assert.ok(mjbOf(fresh.engine.model).equals(mjbOf(second.engine.model)));
    assert.ok(qposAfter(second.engine).equals(qposAfter(fresh.engine)));
    const other=await world([{id:'b',robot:getSpec('r1')}]);
    assert.deepEqual([other.xml,other.binary],[1,0],'another slot id is another scene');
    for(const run of [first,second,fresh,other])run.engine.dispose();
  }finally{release();}
}

{ // Quota: one retry evicts every other entry in the same write; a refused retry keeps them all.
  const store=new MemoryStore(10),cache=new ModelCache(store,100,()=>++clock),body=n=>new Uint8Array(n).fill(n);
  assert.equal(await cache.put('a',body(4)),true);assert.equal(await cache.put('b',body(4)),true);
  assert.equal(await cache.put('c',body(8)),true,'the retry made room');
  assert.deepEqual([...store.entries.keys()],['c']);
  assert.equal(await cache.put('d',body(2)),true);
  assert.equal(await cache.put('e',body(12)),false,'beyond the quota even alone');
  assert.deepEqual([...store.entries.keys()].sort(),['c','d'],'a refused retry left the entries in place');
}

{ // Size cap: least recently used entries go first; the total never exceeds the cap.
  const store=new MemoryStore(),cache=new ModelCache(store,10,()=>++clock),body=n=>new Uint8Array(n).fill(n);
  assert.equal(await cache.put('a',body(4)),true);assert.equal(await cache.put('b',body(4)),true);
  assert.ok(await cache.get('a'),'a is now more recent than b');
  assert.equal(await cache.put('c',body(4)),true);
  assert.deepEqual([...store.entries.keys()].sort(),['a','c']);assert.ok(store.total<=10);
  assert.equal(await cache.put('d',body(11)),false,'a body above the cap is never stored');
  assert.deepEqual([...store.entries.keys()].sort(),['a','c']);
  assert.equal(await cache.put('e',body(10)),true);assert.deepEqual([...store.entries.keys()],['e']);assert.equal(store.total,10);
  // Engine compiles still work when the MJB exceeds the cap.
  const small=new MemoryStore(),{cache:capped,release}=use(small,1024);
  try{const run=await compile(capped);assert.equal(run.xml,1);assert.equal(small.entries.size,0);run.engine.dispose();}finally{release();}
}

{ // Storage failures are misses: no IndexedDB (Node), or a store that refuses every call.
  const refusing={read:async()=>{throw new DOMException('quota','QuotaExceededError');},write:async()=>{throw new DOMException('quota','QuotaExceededError');},
    touch:async()=>{throw Error('x');},remove:async()=>{throw Error('x');}};
  for(const store of [new IndexedDbModelStore(),refusing]){
    const {cache,release}=use(store);
    try{
      const run=await compile(cache);assert.deepEqual([run.xml,run.binary],[1,0]);
      assert.ok(qposAfter(run.engine).equals(referenceQpos));run.engine.dispose();
      assert.equal(await cache.get('missing'),null);assert.equal(await cache.put('k',new Uint8Array(4)),false);
    }finally{release();}
  }
}

if(process.env.GHOST==='1'){ // R1 on Ghost, as the worker builds it: cold compile, then the cached load.
  const store=new MemoryStore(),{cache,release}=use(store),terrain='map:nt_ghost_ctg';
  const ghost=async()=>{calls.xml=calls.binary=0;const t=performance.now();
    const engine=await Engine.create('/assets/models/r1',terrainTransform(terrain,{},'/work/map'),'scene.xml',{source:mapSource(terrain),mount:'/work/map'});
    const ms=performance.now()-t;await cache.idle();return {engine,ms,xml:calls.xml,binary:calls.binary};};
  try{
    const cold=await ghost(),warm=await ghost();
    assert.deepEqual([cold.xml,warm.xml,warm.binary],[1,0,1]);
    assert.deepEqual(shape(warm.engine.model),shape(cold.engine.model));
    assert.ok(qposAfter(warm.engine).equals(qposAfter(cold.engine)));
    results.ghost={coldCreateMs:Math.round(cold.ms),cachedCreateMs:Math.round(warm.ms),mjbBytes:[...store.entries.values()][0].bytes};
    cold.engine.dispose();warm.engine.dispose();
  }finally{release();}
}
console.log(JSON.stringify({ok:true,...results}));
