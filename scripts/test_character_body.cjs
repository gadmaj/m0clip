/** Registered glTF rigs through the production body factory; run after integration.
 * node scripts/test_character_body.cjs — one isolated Chrome; no app/service changes.
 */
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { build } = require('esbuild');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');

(async () => {
  const root = path.resolve(__dirname, '..');
  const bundle = await build({
    stdin: { resolveDir: root, sourcefile: 'character-body-fixture.ts', contents: `
      import * as THREE from 'three';
      import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
      import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js';
      import { AUTHORED_CHARACTERS } from './src/characters/catalog';
      import { characterAsset } from './src/render/characters/body';
      import { GeometryTrack } from './src/core/geometry';
      import { extraSkinningWriter } from './src/render/extra-skin';
      const check = (ok, message) => {if (!ok) throw new Error(message);};
      const names = ['world','pelvis','torso_link','left_shoulder_yaw_link','right_shoulder_yaw_link',
        'left_elbow_link','right_elbow_link','left_wrist_roll_link','right_wrist_roll_link',
        'left_hip_yaw_link','right_hip_yaw_link','left_knee_link','right_knee_link',
        'left_ankle_roll_link','right_ankle_roll_link','head_pitch_link','head_yaw_link'];
      const centers = [[0,0,0],[0,0,.74],[0,0,.98],[0,.24,1.1],[0,-.24,1.1],
        [0,.24,.82],[0,-.24,.82],[0,.24,.59],[0,-.24,.59],
        [0,.12,.68],[0,-.12,.68],[0,.12,.4],[0,-.12,.4],
        [0,.12,.08],[0,-.12,.08],[0,0,1.23],[0,0,1.32]];
      const n = names.length, ngeom = n-1;
      const pos = Float64Array.from(centers.flat()), quat = new Float64Array(n*4);
      const gpos = new Float64Array(ngeom*3), gquat = new Float64Array(ngeom*4);
      for (let i=0;i<n;i++) quat[i*4]=1;
      for (let i=0;i<ngeom;i++) {gquat[i*4]=1;gpos[i*3]=.025;}
      const sole = new Float32Array([-.1,-.06,-.08, .15,-.06,-.08, .15,.06,-.08, -.1,.06,-.08]);
      const model = {robot:'r1',ngeom,bodyNames:names,bodyid:Int32Array.from(names.slice(1),(_,i)=>i+1),
        bodyFrames:{parent:new Int32Array(n),pos,quat},geomFrames:{pos:gpos,quat:gquat},
        contype:new Int32Array(ngeom),dataid:new Int32Array(ngeom),meshes:[{vert:sole}]};
      const world = centers.slice(1).map((p,g)=>new THREE.Matrix4().makeTranslation(p[0]+gpos[g*3],p[1],p[2]));
      const x = new Float32Array(ngeom*3), r = new Float32Array(ngeom*9);
      function frame(move = new THREE.Matrix4()) {
        const recorded = new Float32Array(ngeom*7);
        world.forEach((m,g)=>{
          const mat = move.clone().multiply(m), e=mat.elements;
          const p=new THREE.Vector3().setFromMatrixPosition(mat),q=new THREE.Quaternion().setFromRotationMatrix(mat);
          p.toArray(x,g*3);r.set([e[0],e[4],e[8],e[1],e[5],e[9],e[2],e[6],e[10]],g*9);
          recorded.set([p.x,p.y,p.z,q.w,q.x,q.y,q.z],g*7);
        });
        return recorded;
      }
      const r1Fixture = {model,ngeom,x,r,frame};
      function quadrupedFixture() {
        const names=['world','base_link'],centers=[[0,0,0],[0,0,.7]],bodyid=[1],type=[6];
        for(const [leg,px,py] of [['FL',.25,.16],['FR',.25,-.16],['RL',-.25,.16],['RR',-.25,-.16]]) {
          const first=names.length;
          names.push(leg+'_hip',leg+'_thigh',leg+'_calf',leg+'_foot');
          centers.push([px,py,.66],[px,py,.62],[px,py,.32],[px,py,.04]);
          bodyid.push(first,first+1,first+2,first+2);type.push(6,6,6,2);
        }
        const n=names.length,ngeom=bodyid.length,pos=Float64Array.from(centers.flat()),quat=new Float64Array(n*4);
        const gpos=new Float64Array(ngeom*3),gquat=new Float64Array(ngeom*4),size=new Float64Array(ngeom*3),contype=new Int32Array(ngeom);
        for(let i=0;i<n;i++)quat[i*4]=1;
        for(let g=0;g<ngeom;g++) {
          gquat[g*4]=1;
          if(type[g]===2){gpos[g*3+2]=-.28;size[g*3]=.04;contype[g]=1;}
        }
        const model={robot:'go2',ngeom,bodyNames:names,bodyid:Int32Array.from(bodyid),type:Int32Array.from(type),size,contype,
          bodyFrames:{parent:new Int32Array(n),pos,quat},geomFrames:{pos:gpos,quat:gquat},dataid:new Int32Array(ngeom).fill(-1),meshes:{}};
        const world=bodyid.map((b,g)=>new THREE.Matrix4().makeTranslation(centers[b][0]+gpos[g*3],centers[b][1],centers[b][2]+gpos[g*3+2]));
        const x=new Float32Array(ngeom*3),r=new Float32Array(ngeom*9);
        function frame(move=new THREE.Matrix4()) {
          const recorded=new Float32Array(ngeom*7);
          world.forEach((m,g)=>{
            const mat=move.clone().multiply(m),e=mat.elements,p=new THREE.Vector3().setFromMatrixPosition(mat),q=new THREE.Quaternion().setFromRotationMatrix(mat);
            p.toArray(x,g*3);r.set([e[0],e[4],e[8],e[1],e[5],e[9],e[2],e[6],e[10]],g*9);
            recorded.set([p.x,p.y,p.z,q.w,q.x,q.y,q.z],g*7);
          });
          return recorded;
        }
        return {model,ngeom,x,r,frame,spheres:type.flatMap((t,i)=>t===2?[i]:[])};
      }
      const go2Fixture=quadrupedFixture();
      const materialList = mesh => Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      function snapshot(body) {
        return JSON.stringify({position:body.root.position.toArray(),quaternion:body.root.quaternion.toArray(),
          bones:body.retarget.bones.map(b=>b.quaternion.toArray()),
          surfaces:body.meshes.map(m=>({geometry:m.geometry.uuid,materials:materialList(m).map(a=>({uuid:a.uuid,color:a.color?.toArray(),opacity:a.opacity,transparent:a.transparent,depthWrite:a.depthWrite}))})),
          clips:body.root.animations.map(c=>c.toJSON())});
      }
      const results = {};
      for (const [id,definition] of Object.entries(AUTHORED_CHARACTERS)) {
        const {model,ngeom,x,r,frame}=definition.physics==='go2'?go2Fixture:r1Fixture;
        const loaded = await new GLTFLoader().loadAsync(definition.url);
        loaded.scene.animations = loaded.animations;
        const source = [];
        loaded.scene.traverse(o=>{if(o.isMesh)source.push(o);});
        const nativeVertices = source.map(m=>Array.from(m.geometry.getAttribute('position').array));
        const asset = characterAsset(loaded.scene,definition), body=asset.create(model,()=>{});
        const other=definition.physics==='go2'?r1Fixture.model:go2Fixture.model;
        let incompatible=false,unexpected;
        try{unexpected=asset.create(other,()=>{});}catch{incompatible=true;}unexpected?.dispose();
        check(incompatible,id+': incompatible physics accepted');
        if(definition.physics==='go2')for(const radius of [0,NaN]) {
          const invalid={...model,size:model.size.slice()};invalid.size[go2Fixture.spheres[0]*3]=radius;
          let rejected=false;try{asset.create(invalid,()=>{});}catch{rejected=true;}
          check(rejected,id+': missing or invalid contact sphere accepted');
        }
        check(body.meshes.length===source.length,id+': dropped authored surfaces');
        const rigid=body.meshes.filter(m=>!m.isSkinnedMesh),skins=body.meshes.filter(m=>m.isSkinnedMesh);
        if(id==='ralph') {
          check(rigid.length===74 && skins.length===12,'Ralph real 74 rigid / 12 weighted surfaces changed');
          check(body.retarget.bones.length===87,'Ralph helper/independent roots lost');
          check(body.retarget.bones.some(b=>!(b.parent instanceof THREE.Bone)&&b.name!=='Main'),'Ralph independent roots lost');
        }
        body.meshes.forEach((m,i)=>check(JSON.stringify(Array.from(m.geometry.getAttribute('position').array))===JSON.stringify(nativeVertices[i]),id+': changed authored vertex data'));
        body.meshes.forEach(m=>check(m.geometry.groups.every(g=>!!m.userData.sourcePartNames[g.materialIndex]),id+': missing triangle part labels'));
        const initial=frame();body.sync(x,r);
        const initialRoot=body.root.position.clone(),initialQ=body.root.quaternion.clone();
        const bonePose=body.retarget.bones.map(b=>b.quaternion.clone());
        const move=new THREE.Matrix4().makeRotationFromQuaternion(new THREE.Quaternion().setFromEuler(new THREE.Euler(.35,-.2,.7)));
        move.setPosition(3,-4,8);const airborne=frame(move);body.sync(x,r);
        check(body.root.position.distanceTo(initialRoot.applyMatrix4(move))<2e-4,id+': airborne/tilted sole fit changed rigid translation');
        check(body.root.quaternion.angleTo(new THREE.Quaternion().setFromRotationMatrix(move).multiply(initialQ))<2e-4,id+': global orientation lost');
        body.retarget.bones.forEach((b,i)=>check(b.quaternion.clone().normalize().angleTo(bonePose[i].clone().normalize())<2e-4,id+': rigid motion changed local bone '+b.name));
        const count=body.meshes.reduce((sum,m)=>sum+m.geometry.index.count,0);
        const before=snapshot(body),preview=body.preview(null,()=>{});let previewCount=0;
        preview.traverse(o=>{if(o.isMesh){previewCount+=o.geometry.index.count;check(!o.isSkinnedMesh,id+': preview not independently baked');}});
        check(previewCount===count,id+': preview dropped rigid or weighted triangles');
        check(snapshot(body)===before,id+': preview mutated live state');
        body.visibility(.4,true);check(body.meshes.every(m=>!m.castShadow&&materialList(m).every(a=>a.transparent)),id+': partial fade/shadows omitted a surface');
        const faded=snapshot(body),poses=new Float32Array(ngeom*14);poses.set(initial);poses.set(airborne,ngeom*7);
        const exported=body.export(GeometryTrack.dense(ngeom,2,poses),new Float32Array([0,.2]));
        check(snapshot(body)===faded,id+': independent export changed live pose/materials/native tracks');
        let exportCount=0;exported.root.traverse(o=>{if(o.isMesh){exportCount+=o.geometry.index.count;check(!body.meshes.some(m=>m.geometry===o.geometry),id+': export shares live geometry');check(materialList(o).every(a=>!body.meshes.some(m=>materialList(m).includes(a))),id+': export shares live material');}});
        check(exportCount===count,id+': export dropped authored triangles');
        if(exported.root.animations.length) {
          exported.root.animations[0].tracks[0].values[0]+=1;
          check(snapshot(body)===faded,id+': export native track aliases live track');
        }
        const output=await new GLTFExporter().register(extraSkinningWriter).parseAsync(exported.root,{binary:true,trs:true,onlyVisible:true,animations:[new THREE.AnimationClip('motion',-1,exported.tracks)]});
        const again=await new GLTFLoader().parseAsync(output,'');let roundTriangles=0;
        again.scene.traverse(o=>{if(o.isMesh)roundTriangles+=(o.geometry.index?.count??o.geometry.getAttribute('position').count)/3;});
        check(roundTriangles===count/3,id+': real GLB export triangle loss');
        body.visibility(1,true);check(body.meshes.every(m=>m.castShadow),id+': shadow restore omitted a surface');
        const sourceGeometry=source[0].geometry;let templateDisposed=0;sourceGeometry.addEventListener('dispose',()=>templateDisposed++);
        body.dispose();check(templateDisposed===0,id+': instance disposed cached geometry');
        asset.dispose();asset.dispose();check(templateDisposed===1,id+': template geometry not disposed exactly once');
        let rejected=false;try{asset.create(model,()=>{});}catch{rejected=true;}check(rejected,id+': disposed template reused');
        results[id]={surfaces:source.length,rigid:rigid.length,skins:skins.length,bones:bonePose.length,triangles:count/3,parts:body.partNames(),nativeClips:loaded.animations.length};
      }
      window.results=results;window.done=true;
    ` },bundle:true,format:'esm',platform:'browser',write:false,
  });
  const browser = await chromium.launch({executablePath:process.env.CHROME_BIN || '/usr/bin/google-chrome',headless:true,
    args:['--no-sandbox','--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader']});
  try {
    const page=await browser.newPage(),errors=[];
    page.on('pageerror',e=>errors.push(e.stack??e.message));
    await page.route('http://m0clip.test/',route=>route.fulfill({contentType:'text/html',body:'<!doctype html><script type="module" src="/fixture.js"></script>'}));
    await page.route('http://m0clip.test/fixture.js',route=>route.fulfill({contentType:'text/javascript',body:bundle.outputFiles[0].text}));
    await page.route('http://m0clip.test/assets/characters/**',route=>{
      const file=path.join(root,'public',new URL(route.request().url()).pathname);
      return route.fulfill({contentType:file.endsWith('.glb')?'model/gltf-binary':'application/octet-stream',body:fs.readFileSync(file)});
    });
    await page.goto('http://m0clip.test/');
    if(errors.length)throw new Error(errors.join('\n'));
    await Promise.race([
      page.waitForFunction(()=>window.done,undefined,{timeout:120000}),
      page.waitForEvent('pageerror').then(error=>{throw error;}),
    ]);
    assert.deepEqual(errors,[]);const results=await page.evaluate(()=>window.results);
    if(process.env.QA_ARTIFACT_DIR){fs.mkdirSync(process.env.QA_ARTIFACT_DIR,{recursive:true});fs.writeFileSync(path.join(process.env.QA_ARTIFACT_DIR,'character-body.json'),JSON.stringify(results,null,2));}
    console.log(JSON.stringify(results,null,2));
  } finally {await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
