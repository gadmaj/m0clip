/** Actual WebGL regression for Source base-UV companions: static $basetexturetransform,
 * native TextureScroll and converter scroll, through the real patchSourceMaterial and
 * sourceVertexMaterial programs. Each case renders the transformed material and an
 * identity-UV twin whose textures are resampled on the CPU at independently computed
 * Source coordinates (SDK 2013: bump, envmap mask, self-illum mask and Phong exponent at
 * the base matrix; detail at $detailscale × base matrix; LightmappedGeneric envmap mask at
 * $envmapmasktransform·uv). Pixels must match. Then the production DCC encoder
 * (encodeSceneGlb: lossless native-texture copies + exporter plugins) must write the
 * same static matrix on the Studio base/normal and Source base textures, leaving live
 * materials untouched. Not a full-map or native-asset qualification.
 * Run once after integration: CHROME_PATH=/path/to/chrome HEADLESS=1 node scripts/test_source_base_uv_runtime.cjs */
'use strict';
const assert=require('node:assert/strict');
const path=require('node:path');
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const buildFixture=require('./build-fixture.cjs');
(async()=>{
  const {code}=await buildFixture({root:path.resolve(__dirname,'..'),platform:'browser',format:'iife',globalName:'SourceBaseUvFixture',source:`
    export * as THREE from 'three';
    export { SourceMaterials, patchSourceMaterial } from './src/render/source-materials';
    export { sourceVertexMaterial } from './src/render/source-lighting';
    export { encodeSceneGlb } from './src/record/export-blender';`});
  const browser=await chromium.launch({headless:process.env.HEADLESS==='1',
    ...(process.env.CHROME_PATH?{executablePath:process.env.CHROME_PATH}:{}),args:['--no-sandbox','--ozone-platform=x11']});
  try{
    const page=await browser.newPage(),errors=[];
    page.on('pageerror',e=>errors.push(e.message));
    page.on('console',m=>{if(m.type()==='error')errors.push(m.text());});
    await page.addScriptTag({content:code});
    const results=await page.evaluate(()=>{
      const {THREE,SourceMaterials,patchSourceMaterial,sourceVertexMaterial}=window.SourceBaseUvFixture;
      const N=4,frac=x=>x-Math.floor(x);
      const renderer=new THREE.WebGLRenderer({antialias:false});
      const target=new THREE.WebGLRenderTarget(N,N,{depthBuffer:true});
      const camera=new THREE.OrthographicCamera(-1,1,1,-1,.1,10);camera.position.set(0,0,1);camera.updateMatrixWorld();
      const geometry=new THREE.PlaneGeometry(2,2); // uv (0,0) bottom-left = framebuffer row 0
      const texture=pixel=>{
        const data=new Uint8Array(N*N*4);
        for(let j=0;j<N;j++)for(let i=0;i<N;i++)data.set(pixel(i,j),(j*N+i)*4);
        const result=new THREE.DataTexture(data,N,N);
        result.magFilter=result.minFilter=THREE.NearestFilter;result.wrapS=result.wrapT=THREE.RepeatWrapping;
        result.generateMipmaps=false;result.needsUpdate=true;return result;
      };
      // Resample a nearest/repeat texel function at an independently computed coordinate
      // per output pixel centre; the twin samples texel (i,j) at its own pixel centre.
      const resample=(pixel,coordinate)=>texture((i,j)=>{
        const [x,y]=coordinate((i+.5)/N,(j+.5)/N);
        for(const t of [x*N,y*N]){const d=frac(t);if(Math.min(d,1-d)<.05)throw new Error(`ambiguous nearest fixture coordinate ${t}`);}
        return pixel(Math.floor(frac(x)*N),Math.floor(frac(y)*N));
      });
      const patterns={
        base:(i,j)=>[40+50*i,30+60*j,200-40*i-10*j,255],
        detail:(i,j)=>[20+25*i,15+30*j,100-20*j+5*i,255],
        mask:(i,j)=>[10+60*i,20+60*j,5+30*(i+j),255],
        exponent:(i,j)=>[[0,3,8,20][(i+2*j)%4],0,0,255], // exponents 1..13.7: distinct .8^e specular
        normal:(i,j)=>[128+28*(i-1.5),128+28*(j-1.5),230,255].map(Math.round),
      };
      const white=texture(()=>[255,255,255,255]),black=texture(()=>[0,0,0,255]);
      const cube=new THREE.CubeTexture(Array.from({length:6},()=>texture(()=>[255,255,255,255])));
      cube.magFilter=cube.minFilter=THREE.NearestFilter;cube.generateMipmaps=false;cube.needsUpdate=true;
      // Source ParameterMatrix (noclip MaterialParameters.ts setMatrix): T(c+t)·R·T(-c)·S, row-major 2x3.
      const parameterMatrix=({center=[0,0],scale=[1,1],rotate=0,translate=[0,0]})=>{
        const r=rotate*Math.PI/180,c=Math.cos(r),s=Math.sin(r),[cx,cy]=center,[sx,sy]=scale,[tx,ty]=translate;
        return [c*sx,-s*sy,cx+tx-c*cx+s*cy, s*sx,c*sy,cy+ty-s*cx-c*cy];
      };
      // SDK 2013 texturescrollmaterialproxy.cpp OnBind: replaces the whole matrix.
      const scrollMatrix=(rate,angle,scale,time)=>{
        const r=angle*Math.PI/180,positive=v=>v<0?v+1+-Math.trunc(v):v,wrap=v=>v-Math.trunc(v);
        return [scale,0,wrap(positive(time*Math.cos(r)*rate)),0,scale,wrap(positive(time*Math.sin(r)*rate))];
      };
      const apply=(m,u,v)=>[m[0]*u+m[1]*v+m[2],m[3]*u+m[4]*v+m[5]];
      const authored=parameterMatrix({scale:[2,.5],rotate:90,translate:[.35,.1]});
      const authoredMetadata=[...authored,0,0,1];
      const variants=[
        {name:'static',matrix:authored,detailScale:2,meta:{basetexturetransform:authoredMetadata}},
        {name:'texturescroll',matrix:scrollMatrix(.5,0,1,.3),detailScale:1.5,time:.3,
          meta:{basetexturetransform:authoredMetadata,temporalProxies:{operations:[{kind:'texturescroll',scroll:[.5,0],scale:1}]}}},
        {name:'converter-scroll',matrix:scrollMatrix(.5,0,1,.3),detailScale:1.5,time:.3,
          meta:{basetexturetransform:authoredMetadata,scroll:[.5,0]}},
      ];
      const ambient=[[.8,0,0],[0,.8,0],[0,0,.8],[.4,.4,0],[0,.4,.4],[.4,0,.4]];
      const light={kind:3,pos:[0,0,0],color:[.5,.5,.5],attenuation:[1,0,0],normal:[-.6,0,-.8],exponent:0,inner:0,outer:0};
      // Each case: authored metadata, textures, and which companion samples which coordinate.
      const cases=[
        {name:'base',meta:{unlit:true},maps:{base:'base'},coordinates:{base:'base'}},
        {name:'detail',meta:{unlit:true,detailblendfactor:1},maps:{base:white,detail:'detail'},coordinates:{detail:'detail'}},
        {name:'selfillum-mask',meta:{unlit:true,selfillum:true,selfillumtint:[0,0,0]},maps:{base:white,selfIllum:'mask'},coordinates:{selfIllum:'base'}},
        {name:'vertexlit-envmap-mask',meta:{unlit:true,envmap:'env_cubemap'},maps:{base:black,mask:'mask',cube:true},coordinates:{mask:'base'}},
        {name:'lightmapped-envmap-mask',meta:{shader:'lightmappedgeneric',unlit:true,envmap:'env_cubemap'},maps:{base:black,mask:'mask',cube:true},coordinates:{mask:'raw'}},
        {name:'bump',meta:{unlit:false,phong:true,phongfresnelranges:[1,1,1]},cache:{cube:ambient,lights:[]},maps:{base:white,normal:'normal'},coordinates:{normal:'base'}},
        {name:'phong-exponent',meta:{unlit:false,phong:true,phongfresnelranges:[1,1,1]},cache:{cube:ambient.map(()=>[0,0,0]),lights:[light]},maps:{base:white,exponent:'exponent'},coordinates:{exponent:'base'}},
      ];
      const read=()=>{const out=new Uint8Array(N*N*4);renderer.readRenderTargetPixels(target,0,0,N,N,out);return Array.from(out);};
      function draw(meta,maps,cache,time){
        const owner=new SourceMaterials();
        const original=new THREE.MeshStandardMaterial({map:maps.base});
        original.userData.sourceMaterial={shader:'vertexlitgeneric',nocull:false,...meta};
        original.userData.sourceUnlit=!!meta.unlit;
        const source=sourceVertexMaterial(original,1,{value:1},{value:1});
        patchSourceMaterial(source,original,{detail:maps.detail,normal:maps.normal,mask:maps.mask,exponent:maps.exponent,selfIllum:maps.selfIllum},
          cache,maps.cube?cube:undefined,undefined,0,false,owner);
        if(time!==undefined)owner.update(time);
        const scene=new THREE.Scene();scene.add(new THREE.Mesh(geometry,source));
        renderer.setRenderTarget(target);renderer.setClearColor(0x000000,0);renderer.clear();renderer.render(scene,camera);
        const pixels=read();renderer.setRenderTarget(null);source.dispose();original.dispose();
        return pixels;
      }
      const results=[];
      for(const variant of variants)for(const entry of cases){
        const detailMatrix=variant.matrix.map(v=>v*variant.detailScale);
        const coordinate={base:(u,v)=>apply(variant.matrix,u,v),detail:(u,v)=>apply(detailMatrix,u,v),raw:(u,v)=>[u,v]};
        const authoredMaps={},twinMaps={},plainMaps={};
        for(const [slot,value] of Object.entries(entry.maps)){
          if(typeof value!=='string'){authoredMaps[slot]=twinMaps[slot]=plainMaps[slot]=value;continue;}
          authoredMaps[slot]=plainMaps[slot]=texture(patterns[value]);
          const mode=entry.coordinates[slot]??'base';
          twinMaps[slot]=mode==='raw'?authoredMaps[slot]:resample(patterns[value],coordinate[mode]);
        }
        // White/black constant maps are coordinate independent; varied base maps follow the base matrix.
        const detailscale=variant.detailScale;
        const actual=draw({...entry.meta,...variant.meta,detailscale},authoredMaps,entry.cache,variant.time);
        const twin=draw({...entry.meta,detailscale:1},twinMaps,entry.cache);
        const untransformed=draw({...entry.meta,detailscale},plainMaps,entry.cache);
        results.push({variant:variant.name,name:entry.name,raw:entry.coordinates[Object.keys(entry.coordinates)[0]]==='raw',actual,twin,untransformed});
      }
      renderer.dispose();renderer.forceContextLoss();
      return results;
    });
    for(const result of results){
      const label=`${result.variant} ${result.name}`;
      for(let i=0;i<result.actual.length;i++)assert(Math.abs(result.actual[i]-result.twin[i])<=1,`${label}: pixel byte ${i} ${result.actual[i]} != independent ${result.twin[i]}`);
      // The fixture is sensitive: transformed coordinates actually change the image,
      // except where Source samples the authored UVs (LightmappedGeneric envmap mask).
      if(result.raw)assert.deepEqual(result.actual,result.untransformed,`${label}: authored-UV sampler moved`);
      else assert.notDeepEqual(result.actual,result.untransformed,`${label}: fixture cannot distinguish coordinates`);
    }
    // Production DCC encoder with native (lossless-copied) textures and a static matrix.
    const exported=await page.evaluate(async()=>{
      const {THREE,SourceMaterials,patchSourceMaterial,sourceVertexMaterial,encodeSceneGlb}=window.SourceBaseUvFixture;
      const renderer=new THREE.WebGLRenderer({antialias:false}),owner=new SourceMaterials();
      const native=seed=>{
        const data=new Uint8Array(64);for(let i=0;i<64;i++)data[i]=(seed*37+i*11)&255;
        const texture=new THREE.DataTexture(data,4,4);texture.userData.sourceNativeTexture={format:0};texture.needsUpdate=true;return texture;
      };
      const map=native(1),normalMap=native(2);
      const original=new THREE.MeshStandardMaterial({name:'studio',map,normalMap});
      // Row-major Source ParameterMatrix of "scale 2 .5 rotate 90 translate .35 .1".
      original.userData.sourceMaterial={shader:'vertexlitgeneric',unlit:true,nocull:false,basetexturetransform:[0,-.5,.35,2,0,.1,0,0,1]};
      original.userData.sourceUnlit=true;
      const source=sourceVertexMaterial(original,1,{value:1},{value:1});source.name='source';
      patchSourceMaterial(source,original,{normal:normalMap},undefined,undefined,undefined,0,false,owner);
      const scene=new THREE.Scene(),geometry=new THREE.PlaneGeometry(1,1);
      const studioMesh=new THREE.Mesh(geometry,original),sourceMesh=new THREE.Mesh(geometry,source);scene.add(studioMesh,sourceMesh);
      const blob=await encodeSceneGlb(scene,renderer,[]);
      const bytes=new DataView(await blob.arrayBuffer()),length=bytes.getUint32(12,true);
      const json=JSON.parse(new TextDecoder().decode(new Uint8Array(bytes.buffer,20,length)));
      const live=studioMesh.material===original&&sourceMesh.material===source&&original.map===map&&original.normalMap===normalMap&&source.map===map;
      owner.clear();renderer.dispose();renderer.forceContextLoss();
      return {json,live};
    });
    const {json}=exported,byName=Object.fromEntries(json.materials.map(material=>[material.name,material]));
    assert(exported.live,'export restores the live materials and native textures');
    assert(json.images?.length&&json.textures.every(texture=>!texture.extensions?.M0CLIP_texture_vtf),'native textures went through lossless export copies');
    assert(json.extensionsUsed.includes('KHR_texture_transform'));
    // Spec semantics (verified against the KHR_texture_transform README example):
    // uv' = offset + R·S·uv with R rows [cos sin; -sin cos].
    const authored=(u,v)=>[.35-.5*v,2*u+.1];
    const infos=[['studio base',byName.studio?.pbrMetallicRoughness?.baseColorTexture],['studio normal',byName.studio?.normalTexture],
      ['source base',byName.source?.pbrMetallicRoughness?.baseColorTexture]];
    for(const [label,info] of infos){
      const t=info?.extensions?.KHR_texture_transform;assert(t,`${label}: no exported static transform`);
      for(const [u,v] of [[0,0],[1,0],[0,1],[.3,.8]]){
        const c=Math.cos(t.rotation),s=Math.sin(t.rotation),x=t.scale[0]*u,y=t.scale[1]*v,expected=authored(u,v);
        const actual=[c*x+s*y+t.offset[0],-s*x+c*y+t.offset[1]];
        actual.forEach((value,i)=>assert(Math.abs(value-expected[i])<1e-6,`${label} (${u},${v}): ${actual} != ${expected}`));
      }
    }
    assert.deepEqual(errors,[]);
    console.log(`Source base-UV companions: ${results.length} WebGL cases (static, TextureScroll, converter scroll) match independent CPU-resampled twins; encodeSceneGlb exports the static matrix on Studio base/normal and Source base textures.`);
  }finally{await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
