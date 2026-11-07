import assert from'node:assert/strict';import buildFixture from'./build-fixture.cjs';import{mkdir,rm,writeFile}from'node:fs/promises';import{resolve}from'node:path';import * as THREE from'three';
const file=resolve('node_modules/.cache/source-resource-test.mjs');await mkdir(resolve('node_modules/.cache'),{recursive:true});
try{
 await writeFile(file,(await buildFixture({root:process.cwd(),source:"export {SourceMaterials,patchSourceMaterial} from './src/render/source-materials';export {SourceLightStyles} from './src/render/source-lightstyles';export {MapSource} from './src/maps/source';",platform:'node',format:'es',externalPackages:true})).code);const{SourceMaterials,patchSourceMaterial,SourceLightStyles,MapSource}=await import(file);
 const a=new SourceMaterials(),b=new SourceMaterials(),ta=new THREE.Texture(),tb=new THREE.Texture(),late=new THREE.Texture();let da=0,db=0,dl=0;ta.addEventListener('dispose',()=>da++);tb.addEventListener('dispose',()=>db++);late.addEventListener('dispose',()=>dl++);
 a.own(ta);a.own(ta);b.own(tb);assert.throws(()=>b.own(null),/failed to load/);a.dispose();a.dispose();a.own(ta);a.own(late);a.own(late);assert.equal(da,1);assert.equal(dl,1);assert.equal(db,0);
 let discarded=0;const replaced={dispose(){discarded++}};b.own(replaced);b.discard(replaced);b.discard(replaced);assert.equal(discarded,1);assert.ok(!b.resources.has(replaced));b.discard({dispose(){throw new Error('Unowned resource disposed')}});
 const original=new THREE.MeshStandardMaterial(),material=new THREE.MeshBasicMaterial({map:tb}),frame=new THREE.Texture();original.userData.sourceMaterial={shader:'unlitgeneric',unlit:true,animationfps:2};patchSourceMaterial(material,original,{frames:[tb,frame]},undefined,undefined,undefined,0,false,b);b.update(.5);assert.equal(material.map,frame);const shader={uniforms:{},vertexShader:'',fragmentShader:''};material.onBeforeCompile(shader,null);assert.equal(shader.uniforms.sourceEffectTime,b.time);assert.equal(b.time.value,.5);a.update(99);assert.equal(b.time.value,.5);assert.equal(db,0);b.dispose();assert.equal(db,1);
 const fetch=globalThis.fetch,dispose=THREE.Texture.prototype.dispose;let partial=0;THREE.Texture.prototype.dispose=function(){partial++;return dispose.call(this)};
 try{
  // Smallest valid atlas (4x4 RGBA). Page 0 is fully loaded before page 1 fails.
  const source=new MapSource('local-'+'a'.repeat(64),{id:'local-'+'a'.repeat(64),fingerprint:'a'.repeat(64),name:'Styles',game:'Fixture',files:new Map([['lightstyles.json',new Blob([JSON.stringify({size:4,pages:{0:'good.bin',1:'bad.bin'},patches:[],patterns:{}})],{type:'application/json'})],['good.bin',new Blob([new Uint8Array(4*4*4).fill(128)])]])});
  await assert.rejects(SourceLightStyles.load(source));assert.equal(partial,1,'A loaded page must be disposed when a later page fails');
 }finally{globalThis.fetch=fetch;THREE.Texture.prototype.dispose=dispose}
 assert.equal(discarded,1);console.log('PASS: per-map material clocks and animation, replaced resources, deduplicated disposal, late allocation cleanup, partial lightstyle failure cleanup');
}finally{await rm(file,{force:true})}
