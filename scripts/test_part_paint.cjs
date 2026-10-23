/** Sparse material axes and real native consumers. Parent runs after integration:
 * node scripts/test_part_paint.cjs — one isolated Chrome; no app/service changes. */
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {build} = require('esbuild');
const {chromium} = require(process.env.PLAYWRIGHT_MODULE || 'playwright');

(async () => {
  const root = path.resolve(__dirname, '..');
  const bundle = await build({stdin:{resolveDir:root,sourcefile:'part-paint-fixture.ts',contents:`
    import * as THREE from 'three';
    import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
    import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js';
    import { applyPartPaint, readPartPaint } from './src/render/paint-material';
    import { FINISH } from './src/render/paint';
    import { characterAsset } from './src/render/characters/body';
    import { decodeGoldSrcScene } from './src/render/characters/goldsrc';
    import { loadDog } from './src/render/source-robot/body';
    import { loadGhostHead, R1_HEAD_PART } from './src/render/source-robot/head';
    import { GeometryTrack } from './src/core/geometry';
    const check=(ok,message)=>{if(!ok)throw new Error(message);};
    const same=(a,b,message)=>check(JSON.stringify(a)===JSON.stringify(b),message);
    const list=m=>Array.isArray(m.material)?m.material:[m.material];
    const near=(a,b,message)=>check(Math.abs(a-b)<1e-6,message);
    const surface=m=>({color:m.color.toArray(),emissive:m.emissive.toArray(),roughness:m.roughness,metalness:m.metalness,clearcoat:m.clearcoat??0});
    const texture=new THREE.DataTexture(new Uint8Array([255,180,100,255]),1,1);texture.needsUpdate=true;
    const materials=[0xffffff,0xb6422a,0x286aac].map((color,i)=>{
      const m=new THREE.MeshPhysicalMaterial({color,emissive:[0x472b14,0x18392c,0x2b1847][i],roughness:.71,metalness:.17,clearcoat:0,
        map:texture,emissiveMap:texture,normalMap:texture,roughnessMap:texture,metalnessMap:texture,side:THREE.DoubleSide,alphaTest:.2});
      return m;
    });
    const defaults=materials.map(m=>({surface:surface(m)}));
    const renderer=new THREE.WebGLRenderer({antialias:false});renderer.setSize(96,32);renderer.setClearColor(0);
    const scene=new THREE.Scene(),camera=new THREE.OrthographicCamera(-1.5,1.5,.5,-.5,.1,10);camera.position.z=3;
    materials.forEach((m,i)=>{const mesh=new THREE.Mesh(new THREE.PlaneGeometry(.9,.9),m);mesh.position.x=i-1;scene.add(mesh);});
    const target=new THREE.WebGLRenderTarget(96,32);
    const pixels=()=>{const out=new Uint8Array(96*32*4);renderer.setRenderTarget(target);renderer.render(scene,camera);renderer.readRenderTargetPixels(target,0,0,96,32,out);return out;};
    const beforePixels=pixels();
    materials.forEach((m,i)=>{
      const offset=(16*96+16+i*32)*4,expected=[m.emissive.r*255,m.emissive.g*180,m.emissive.b*100];
      expected.forEach((value,k)=>check(Math.abs(beforePixels[offset+k]-value)<=1,'native GPU emission/texture control differs'));
    });
    materials.forEach((m,i)=>{
      applyPartPaint(m,{finish:'metal'});applyPartPaint(m,{roughness:.33});
      same(m.color.toArray(),defaults[i].surface.color,'finish/numeric replaced native RGB slot '+i);
      same(m.emissive.toArray(),defaults[i].surface.emissive,'finish/numeric multiplied native emission slot '+i);
      near(m.metalness,FINISH.metal.metalness,'numeric-only reset finish metalness');near(m.roughness,.33,'numeric delta missing');
      check(['map','emissiveMap','normalMap','roughnessMap','metalnessMap'].every(k=>m[k]===texture),'native maps replaced');
    });
    same(Array.from(pixels()),Array.from(beforePixels),'finish-only changed authored emission GPU pixels without illumination');
    const recolor=0x38ba71,oldEmission=materials[0].emissive.clone();applyPartPaint(materials[0],{color:recolor});
    check(materials[0].color.getHex()===recolor,'explicit color did not recolor');
    same(materials[0].emissive.toArray(),oldEmission.multiply(new THREE.Color(recolor)).toArray(),'explicit color emissive composition');
    const composed=new THREE.MeshPhysicalMaterial({emissive:0x765432,roughness:.91,metalness:.12,clearcoat:.19});
    const nativeEmission=composed.emissive.clone();
    applyPartPaint(composed,{color:0x6080a0,finish:'metal',roughness:.22},{color:0x987654,finish:'gloss',roughness:.83,metalness:.23,clearcoat:.77});
    same(composed.emissive.toArray(),nativeEmission.multiply(new THREE.Color(0x6080a0)).toArray(),'base and delta double-tinted authored emission');
    near(composed.roughness,.22,'explicit delta numeric lost');near(composed.metalness,FINISH.metal.metalness,'base numeric overrode new finish');near(composed.clearcoat,FINISH.metal.clearcoat,'base clearcoat overrode new finish');
    applyPartPaint(composed,{roughness:.29},{finish:'gloss',metalness:.34});
    near(composed.roughness,.29,'numeric delta precedence');near(composed.metalness,.34,'numeric-only delta lost base numeric');near(composed.clearcoat,FINISH.gloss.clearcoat,'numeric delta lost base finish');
    const unchanged=surface(composed);applyPartPaint(composed,undefined);same(surface(composed),unchanged,'absent axes changed source');
    const optical=new THREE.MeshPhysicalMaterial({color:0x998877,iridescence:.64,iridescenceIOR:1.62,iridescenceThicknessRange:[140,360],clearcoatRoughness:.73});
    const opticalRange=optical.iridescenceThicknessRange;
    applyPartPaint(optical,{color:0x778899,roughness:.26});
    near(optical.iridescence,.64,'numeric/color delta reset native film');near(optical.iridescenceIOR,1.62,'numeric/color delta reset native film IOR');same(optical.iridescenceThicknessRange,[140,360],'numeric/color delta reset native film thickness');near(optical.clearcoatRoughness,.73,'numeric/color delta reset native coat roughness');
    applyPartPaint(optical,undefined,{finish:'mirror'});
    near(optical.iridescence,1,'base Mirror film missing');near(optical.iridescenceIOR,1.8,'base Mirror film IOR missing');same(optical.iridescenceThicknessRange,[300,520],'base Mirror film thickness missing');near(optical.clearcoatRoughness,.03,'Mirror coat roughness missing');
    applyPartPaint(optical,{finish:'metal'});
    near(optical.iridescence,0,'Metal retained Mirror film');near(optical.iridescenceIOR,1.3,'Metal retained Mirror film IOR');same(optical.iridescenceThicknessRange,[100,400],'Metal retained Mirror film thickness');near(optical.clearcoatRoughness,FINISH.metal.clearcoatRoughness,'Metal retained Mirror coat roughness');check(optical.iridescenceThicknessRange===opticalRange,'preset allocated a film thickness array');
    const standard=new THREE.MeshStandardMaterial({color:0x579abc,roughness:.63,metalness:.16});applyPartPaint(standard,{clearcoat:.8});
    check(!('clearcoat' in standard),'clearcoat added to Standard material');
    same(readPartPaint(standard),{color:0x579abc,finish:'satin',roughness:.63,metalness:.16,clearcoat:0},'Standard source readback');
    const basic=new THREE.MeshBasicMaterial({color:0x984321,map:texture});
    same(readPartPaint(basic),{color:0x984321,finish:'satin',roughness:1,metalness:0,clearcoat:0},'Basic source readback');
    const names=['world','pelvis','torso_link','left_shoulder_yaw_link','right_shoulder_yaw_link','left_elbow_link','right_elbow_link','left_wrist_roll_link','right_wrist_roll_link','left_hip_yaw_link','right_hip_yaw_link','left_knee_link','right_knee_link','left_ankle_roll_link','right_ankle_roll_link','head_pitch_link','head_yaw_link'];
    const centers=[[0,0,0],[0,0,.74],[0,0,.98],[0,.24,1.1],[0,-.24,1.1],[0,.24,.82],[0,-.24,.82],[0,.24,.59],[0,-.24,.59],[0,.12,.68],[0,-.12,.68],[0,.12,.4],[0,-.12,.4],[0,.12,.08],[0,-.12,.08],[0,0,1.23],[0,0,1.32]];
    const n=names.length,ngeom=n-1,quat=new Float64Array(n*4),gquat=new Float64Array(ngeom*4);
    for(let i=0;i<n;i++)quat[i*4]=1;for(let i=0;i<ngeom;i++)gquat[i*4]=1;
    const model={robot:'r1',ngeom,bodyNames:names,bodyid:Int32Array.from(names.slice(1),(_,i)=>i+1),bodyFrames:{parent:new Int32Array(n),pos:Float64Array.from(centers.flat()),quat},geomFrames:{pos:new Float64Array(ngeom*3),quat:gquat},contype:new Int32Array(ngeom),dataid:new Int32Array(ngeom),meshes:[{vert:new Float32Array([-.1,-.06,-.08,.15,-.06,-.08,.15,.06,-.08,-.1,.06,-.08])}]};
    const mdl=await (await fetch('/assets/characters/picardia-v1sc/picardia_v1sc.mdl')).arrayBuffer();
    const decoded=await decodeGoldSrcScene({name:'picardia_v1sc',model:mdl,source:'https://github.com/wootguy/pmodels',thumbnail:'',loadDependency:async name=>{throw new Error('Unexpected dependency '+name);}});
    const source=decoded.scene,sourceMeshes=[];source.traverseVisible(o=>{if(o.isMesh)sourceMeshes.push(o);});
    // Deliberately mixed source tints exercise all native slot branches on the real rig.
    [...new Set(sourceMeshes.flatMap(list))].forEach((m,i)=>m.color.setHex([0xffffff,0xc34e28,0x317cba][i%3]));
    sourceMeshes[0].material=new THREE.MeshBasicMaterial({color:0x8843aa,map:sourceMeshes[0].material.map});
    const fullbright=sourceMeshes[1].material;fullbright.userData.goldsrcFullbright=true;fullbright.emissive.setHex(0x37ac81);fullbright.emissiveMap=fullbright.map;fullbright.color.setHex(0);
    check(readPartPaint(fullbright).color===0x37ac81,'Fullbright readback used black diffuse RGB');
    // A non-root native collection must still survive independent ownership.
    const nested=sourceMeshes[0];nested.animations=[new THREE.AnimationClip('nested-native',1,[new THREE.VectorKeyframeTrack(nested.name+'.position',[0,1],[0,0,0,1,2,3])])];
    const sourceByName=new Map(sourceMeshes.map(m=>[m.name,m]));
    let delta={},light='native';
    const paint=(part,m)=>{applyPartPaint(m,delta);if(light==='glow'){m.emissive.setHex(0x22ee44);m.emissiveIntensity=.8;return true;}if(light==='dull'){m.emissive.setHex(0);m.emissiveIntensity=0;return true;}return false;};
    const asset=characterAsset(source,decoded.definition);
    const body=asset.create(model,paint);
    const second=asset.create(model,()=>{});
    const totalClips=root=>{let count=0;root.traverse(o=>count+=o.animations.length);return count;};
    check(body.root.animations.length===367&&body.root.children[0].animations.length===0&&totalClips(body.root)===368,'native root clips duplicated or nested clips lost');
    const firstByPart=new Map(),nativeSlots=[];
    for(const mesh of body.meshes){const original=sourceByName.get(mesh.name).material;list(mesh).forEach((m,i)=>{
      const part=mesh.userData.sourcePartNames[i];if(!firstByPart.has(part))firstByPart.set(part,readPartPaint(original));
      nativeSlots.push({m,original,color:m.color.toArray(),emissive:m.emissive.toArray(),map:m.map,emissiveMap:m.emissiveMap});
    });}
    for(const [part,value] of firstByPart)same(body.nativePaintFor(part),value,'native representative source readback '+part);
    check(body.nativePaintFor('missing-native-part')===undefined,'unknown native part synthesized defaults');
    const unlitSlots=nativeSlots.filter(({original})=>original instanceof THREE.MeshBasicMaterial||original.userData.goldsrcFullbright);
    check(unlitSlots.some(({original})=>original instanceof THREE.MeshBasicMaterial)&&unlitSlots.some(({original})=>original.userData.goldsrcFullbright),'fixture omitted an authored unlit source branch');
    unlitSlots.forEach(({m})=>{near(m.roughness,1,'native unlit roughness baseline');near(m.metalness,0,'native unlit metalness baseline');near(m.clearcoat,0,'native unlit coat baseline');});
    delta={finish:'metal'};body.updateMaterials();
    nativeSlots.forEach(({m,color,emissive,map,emissiveMap})=>{
      same(m.color.toArray(),color,'body finish flattened native slot RGB');same(m.emissive.toArray(),emissive,'body finish changed native slot emission');
      check(m.map===map&&m.emissiveMap===emissiveMap,'body finish changed native texture maps');
    });
    unlitSlots.forEach(({m})=>{near(m.roughness,FINISH.metal.roughness,'unlit finalization erased explicit finish roughness');near(m.metalness,FINISH.metal.metalness,'unlit finalization erased explicit finish metalness');near(m.clearcoat,FINISH.metal.clearcoat,'unlit finalization erased explicit finish coat');});
    delta={finish:'gloss',roughness:.27,metalness:.61,clearcoat:.24};body.updateMaterials();
    unlitSlots.forEach(({m})=>{near(m.roughness,.27,'unlit finalization erased numeric roughness');near(m.metalness,.61,'unlit finalization erased numeric metalness');near(m.clearcoat,.24,'unlit finalization erased numeric coat');check(m.color.getHex()===0,'numeric paint enabled unlit diffuse');});
    delta={color:0x44bb66};body.updateMaterials();nativeSlots.forEach(({m,original})=>{
      const unlit=original instanceof THREE.MeshBasicMaterial||original.userData.goldsrcFullbright;
      check((unlit?m.emissive:m.color).getHex()===0x44bb66,'explicit body color did not recolor native slot');
    });
    light='glow';body.updateMaterials();nativeSlots.forEach(({m})=>check(m.emissive.getHex()===0x22ee44,'unlit restoration overwrote explicit glow'));
    const glowPreview=body.preview(null,paint);glowPreview.traverse(o=>{if(o.isMesh){for(const m of list(o)){check(m.emissive.getHex()===0x22ee44,'preview unlit restoration overwrote explicit glow');m.dispose();}o.geometry.dispose();}});
    light='dull';body.updateMaterials();nativeSlots.forEach(({m})=>check(m.emissive.getHex()===0&&m.emissiveIntensity===0,'unlit restoration overwrote explicit Dull'));
    for(const [part,value] of firstByPart)same(body.nativePaintFor(part),value,'live glow/Dull contaminated native source readback');
    light='native';delta={finish:'metal',roughness:.32};body.updateMaterials();
    const liveTrack=body.root.animations[0].tracks[0],sourceTrack=source.animations[0].tracks[0],secondTrack=second.root.animations[0].tracks[0];
    const sourceValue=sourceTrack.values[0],secondValue=secondTrack.values[0],liveValue=liveTrack.values[0];
    liveTrack.values[0]+=3;check(sourceTrack.values[0]===sourceValue&&secondTrack.values[0]===secondValue,'instance native tracks alias source or another body');liveTrack.values[0]=liveValue;
    const poses=new Float32Array(ngeom*14);for(let frame=0;frame<2;frame++)for(let i=0;i<ngeom;i++)poses.set([...centers[i+1],1,0,0,0],frame*ngeom*7+i*7);
    const exported=body.export(GeometryTrack.dense(ngeom,2,poses),new Float32Array([0,.1]));
    check(totalClips(exported.root)===368&&exported.root.animations.length===367,'export duplicated native clips or lost nested collection');
    const exportedTrack=exported.root.animations[0].tracks[0];exportedTrack.values[0]+=5;exportedTrack.times[0]+=.025;
    check(liveTrack.values[0]===liveValue&&sourceTrack.values[0]===sourceValue&&secondTrack.values[0]===secondValue&&liveTrack.times[0]===sourceTrack.times[0],'export native tracks alias live/source/other instance');
    const nestedLive=body.root.getObjectByName(nested.name).animations[0].tracks[0];
    exported.root.getObjectByName(nested.name).animations[0].tracks[0].values[0]+=7;
    check(nestedLive.values[0]===0&&nested.animations[0].tracks[0].values[0]===0,'export nested native tracks alias live/source');
    const expected=new Map();let slot=0;exported.root.traverseVisible(o=>{if(o.isMesh)for(const m of list(o)){m.name='native_paint_slot_'+slot++;expected.set(m.name,{...surface(m),map:!!m.map,emissiveMap:!!m.emissiveMap});}});
    const glb=await new GLTFExporter().parseAsync(exported.root,{binary:true,trs:true,onlyVisible:true,animations:[new THREE.AnimationClip('recorded',.1,exported.tracks)]});
    const parsed=await new GLTFLoader().parseAsync(glb,'');const seen=new Set();
    parsed.scene.traverse(o=>{if(o.isMesh)for(const m of list(o)){const wanted=expected.get(m.name);check(!!wanted,'GLB material slot lost its identity');const got=surface(m);for(const k of ['color','emissive'])got[k].forEach((v,i)=>near(v,wanted[k][i],'GLB sparse paint changed '+k));for(const k of ['roughness','metalness','clearcoat'])near(got[k],wanted[k],'GLB sparse paint changed '+k);check(!!m.map===wanted.map&&!!m.emissiveMap===wanted.emissiveMap,'GLB lost native maps');seen.add(m.name);}});
    check(seen.size===expected.size,'GLB dropped native material slots');
    let dogDelta={};const dogAsset=await loadDog(),dog=dogAsset.create(model,(part,m)=>applyPartPaint(m,dogDelta));
    const dogNative=new Map(dog.partNames().map(part=>[part,dog.nativePaintFor(part)])),dogSlots=[];
    dog.eachMaterial(m=>dogSlots.push({m,color:m.color.toArray(),emissive:m.emissive.toArray(),map:m.map}));
    dogDelta={finish:'metal'};dog.updateMaterials();dogSlots.forEach(({m,color,emissive,map})=>{same(m.color.toArray(),color,'Dog finish replaced source RGB');same(m.emissive.toArray(),emissive,'Dog finish retinted emission');check(m.map===map,'Dog finish replaced source map');m.color.setHex(0xff00ff);});
    for(const [part,value] of dogNative)same(dog.nativePaintFor(part),value,'Dog readback used live paint');
    check(dog.nativePaintFor('missing-native-part')===undefined,'unknown Dog part synthesized paint');
    const headAsset=await loadGhostHead(),headTarget=new THREE.Mesh(new THREE.BoxGeometry(.2,.2,.2),new THREE.MeshPhysicalMaterial());headTarget.userData.meshName=R1_HEAD_PART;
    const head=headAsset.apply(headTarget,new THREE.Matrix4(),m=>applyPartPaint(m,{finish:'metal'}));
    const headNative=head.nativePaintFor();check(!!headNative,'Ghost head source readback missing');check(headTarget.material.color.getHex()===headNative.color,'head finish changed source RGB');
    headTarget.material.color.setHex(0xff00ff);headTarget.material.emissive.setHex(0x22ee44);same(head.nativePaintFor(),headNative,'head readback used live paint/glow');
    const headPreview=head.preview(m=>applyPartPaint(m,{roughness:.28}));check(headPreview.material.color.getHex()===headNative.color,'head preview flattened native RGB');near(headPreview.material.roughness,.28,'head preview numeric delta missing');
    headPreview.geometry.dispose();headPreview.material.dispose();head.restore();headAsset.dispose();dog.dispose();dogAsset.dispose();body.dispose();second.dispose();asset.dispose();
    target.dispose();renderer.dispose();window.results={gpu:'native emission pixels unchanged',nativeSlots:nativeSlots.length,glbSlots:seen.size,nativeClips:367,nestedClips:1,dogSlots:dogSlots.length,head:headNative};window.done=true;
  `},bundle:true,format:'esm',platform:'browser',write:false});
  const browser=await chromium.launch({executablePath:process.env.CHROME_BIN||'/usr/bin/google-chrome',headless:true,args:['--no-sandbox','--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader']});
  try {
    const page=await browser.newPage(),errors=[];
    page.on('pageerror',error=>errors.push(error.stack||error.message));
    await page.route('http://m0clip.test/',route=>route.fulfill({contentType:'text/html',body:'<!doctype html><script type="module" src="/fixture.js"></script>'}));
    await page.route('http://m0clip.test/fixture.js',route=>route.fulfill({contentType:'text/javascript',body:bundle.outputFiles[0].text}));
    await page.route('http://m0clip.test/assets/**',route=>{const file=path.join(root,'public',new URL(route.request().url()).pathname);return route.fulfill({contentType:file.endsWith('.glb')?'model/gltf-binary':'application/octet-stream',body:fs.readFileSync(file)});});
    await page.goto('http://m0clip.test/');
    if(errors.length)throw new Error(errors.join('\n'));
    await Promise.race([page.waitForFunction(()=>window.done,undefined,{timeout:180000}),page.waitForEvent('pageerror').then(error=>{throw error;})]);
    assert.deepEqual(errors,[]);const results=await page.evaluate(()=>window.results);
    if(process.env.QA_ARTIFACT_DIR){fs.mkdirSync(process.env.QA_ARTIFACT_DIR,{recursive:true});fs.writeFileSync(path.join(process.env.QA_ARTIFACT_DIR,'part-paint.json'),JSON.stringify(results,null,2));}
    console.log(JSON.stringify(results,null,2));
  } finally {await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
