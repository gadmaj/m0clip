/** Actual WebGL regression for Source base-UV companions: static $basetexturetransform,
 * native TextureScroll and converter scroll, through the real patchSourceMaterial and
 * sourceVertexMaterial programs. Each case renders the transformed material and an
 * identity-UV twin whose textures are resampled on the CPU at independently computed
 * Source coordinates (SDK 2013: bump, envmap mask, self-illum mask and Phong exponent at
 * the base matrix; detail at $detailscale × base matrix; LightmappedGeneric envmap mask at
 * $envmapmasktransform·uv). Pixels must match. The production DCC encoder then
 * exports real native textures without changing live materials. Set BLENDER_PATH
 * to check Studio base/normal and Source base sampling in the actual DCC consumer.
 * Without it, the Blender check is explicitly skipped. Not full-map qualification.
 * CHROME_PATH=/path/to/chrome BLENDER_PATH=/path/to/blender HEADLESS=1 node scripts/test_source_base_uv_runtime.cjs */
'use strict';
const assert=require('node:assert/strict');
const path=require('node:path');
const fs=require('node:fs');
const {spawnSync}=require('node:child_process'),os=require('node:os'),crypto=require('node:crypto');
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const buildFixture=require('./build-fixture.cjs');
(async()=>{
  const {code}=await buildFixture({root:path.resolve(__dirname,'..'),platform:'browser',format:'iife',globalName:'SourceBaseUvFixture',source:`
    export * as THREE from 'three';
    export { SourceMaterials, patchSourceMaterial } from './src/render/source-materials';
    export { sourceVertexMaterial } from './src/render/source-lighting';
    export { SourceNativeTextures } from './src/render/source-vtf';
    export { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
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
    // Native UV88 stores signed XY. Live lighting and portable GLB normals must
    // match independent RGB references without changing shared native texels.
    const signedNormals=await page.evaluate(async()=>{
      const {THREE,SourceMaterials,patchSourceMaterial,sourceVertexMaterial,SourceNativeTextures,GLTFLoader,encodeSceneGlb}=window.SourceBaseUvFixture;
      const renderer=new THREE.WebGLRenderer({antialias:false});
      renderer.outputColorSpace=THREE.LinearSRGBColorSpace;
      const target=new THREE.WebGLRenderTarget(4,4),owner=new SourceMaterials();
      const geometry=new THREE.PlaneGeometry(2,2);geometry.computeTangents();
      const scene=new THREE.Scene(),camera=new THREE.OrthographicCamera(-1,1,1,-1,.1,10);
      camera.position.z=1;camera.updateMatrixWorld();
      const light=new THREE.DirectionalLight(0xffffff,2);light.position.set(1.5,.8,2);
      scene.add(light,new THREE.AmbientLight(0xffffff,.05));
      const mesh=new THREE.Mesh(geometry);scene.add(mesh);
      const cache={cube:[[.4,.1,.1],[.1,.4,.1],[.1,.1,.4],[.4,.4,.1],[.1,.4,.4],[.4,.1,.4]],lights:[]};
      const render=material=>{
        mesh.material=material;renderer.setRenderTarget(target);renderer.clear();renderer.render(scene,camera);
        const pixels=new Uint8Array(64);renderer.readRenderTargetPixels(target,0,0,4,4,pixels);
        return Array.from(pixels);
      };
      const native=async(x,y)=>{
        const data=new Uint8Array(82),header=new DataView(data.buffer);
        data.set([86,84,70,0]);header.setUint32(4,7,true);header.setUint32(8,2,true);header.setUint32(12,80,true);
        header.setUint16(16,1,true);header.setUint16(18,1,true);header.setUint32(20,1|256,true);
        header.setUint16(24,1,true);header.setUint32(52,22,true);data[56]=1;
        header.setUint32(57,0xffffffff,true);header.setUint16(63,1,true);data[80]=x&255;data[81]=y&255;
        const loader=new GLTFLoader();let textures;
        loader.register(parser=>textures=new SourceNativeTextures(parser,owner,renderer));
        await loader.parseAsync(JSON.stringify({
          asset:{version:'2.0'},extensionsUsed:['M0CLIP_texture_vtf'],extensionsRequired:['M0CLIP_texture_vtf'],
          buffers:[{byteLength:data.length,uri:'data:application/octet-stream;base64,'+btoa(String.fromCharCode(...data))}],
          bufferViews:[{buffer:0,byteOffset:0,byteLength:data.length}],
          textures:[{extensions:{M0CLIP_texture_vtf:{bufferView:0,frame:0,face:0,path:'fixture/signed-normal'}}}],
          scenes:[{nodes:[]}],scene:0,
        }),'');
        return textures.get(0,THREE.NoColorSpace);
      };
      const variants=normalMap=>{
        const original=owner.own(new THREE.MeshStandardMaterial({normalMap,roughness:1,metalness:0}));
        // Non-Phong props deliberately use vertex lighting; Phong props consume the bump normal.
        original.userData.sourceMaterial={shader:'vertexlitgeneric',nocull:false,phong:true};
        const source=owner.own(sourceVertexMaterial(original,1,{value:1},{value:1}));
        patchSourceMaterial(source,original,{normal:normalMap},cache,undefined,undefined,0,true,owner);
        return{studio:original,source};
      };
      const rows=[],exports=[];
      try{
        for(const [x,y] of [[0,0],[64,0],[-64,0],[0,64],[0,-64],[-128,127],[90,90]]){
          const actual=await native(x,y),before=Array.from(actual.image.data);
          const sx=Math.max(-1,x/127),sy=Math.max(-1,y/127),z=Math.sqrt(Math.max(0,1-sx*sx-sy*sy));
          const reference=owner.own(new THREE.DataTexture(new Float32Array([(sx+1)/2,(sy+1)/2,(z+1)/2,1]),1,1,THREE.RGBAFormat,THREE.FloatType));
          reference.colorSpace=THREE.NoColorSpace;reference.needsUpdate=true;
          const nativeVariants=variants(actual),referenceVariants=variants(reference);
          for(const variant of ['studio','source'])rows.push({
            variant,xy:[x,y],actual:render(nativeVariants[variant]),reference:render(referenceVariants[variant]),
          });
          mesh.material=nativeVariants.studio;mesh.material.map=actual;
          const blob=await encodeSceneGlb(mesh,renderer,[]);
          const portable=await new GLTFLoader().parseAsync(await blob.arrayBuffer(),'');
          let imported;portable.scene.traverse(object=>{if(object.isMesh)imported=object;});
          const pixels=texture=>{
            if(!texture?.image)throw Error('Portable GLB lost a texture binding');
            const canvas=new OffscreenCanvas(1,1),context=canvas.getContext('2d');
            context.drawImage(texture.image,0,0);
            return Array.from(context.getImageData(0,0,1,1).data);
          };
          try{
            exports.push({xy:[x,y],actual:pixels(imported?.material.normalMap),
              reference:[sx,sy,z].map(value=>Math.round((value+1)*127.5)).concat(255),
              base:pixels(imported?.material.map),baseReference:before.map(value=>Math.round(Math.max(0,Math.min(1,value))*255)),
              liveRestored:mesh.material===nativeVariants.studio&&mesh.material.map===actual&&mesh.material.normalMap===actual});
          }finally{
            portable.scene.traverse(object=>{
              if(!object.isMesh)return;object.geometry.dispose();
              for(const texture of new Set([object.material.map,object.material.normalMap])){
                texture?.image?.close?.();texture?.dispose();
              }
              object.material.dispose();
            });
          }
          if(JSON.stringify(Array.from(actual.image.data))!==JSON.stringify(before))
            throw Error('Rendering or export changed the shared native signed-normal texels');
        }
        return {rendered:rows,exports};
      }finally{
        owner.clear();geometry.dispose();target.dispose();renderer.dispose();renderer.forceContextLoss();
      }
    });
    for(const row of signedNormals.rendered)for(let i=0;i<row.actual.length;i++)
      assert(Math.abs(row.actual[i]-row.reference[i])<=1,
        `${row.variant} UV88 ${row.xy}: pixel byte ${i} ${row.actual[i]} != decoded normal ${row.reference[i]}`);
    for(const variant of ['studio','source'])
      assert(new Set(signedNormals.rendered.filter(row=>row.variant===variant).map(row=>row.reference.slice(0,3).join(','))).size>=4,
        `${variant}: signed-normal references do not distinguish authored directions`);
    for(const row of signedNormals.exports){
      assert(row.liveRestored,`UV88 ${row.xy}: export replaced the live material or texture`);
      for(let i=0;i<4;i++){
        assert(Math.abs(row.actual[i]-row.reference[i])<=1,`UV88 ${row.xy}: portable normal byte ${i} ${row.actual[i]} != ${row.reference[i]}`);
        assert(Math.abs(row.base[i]-row.baseReference[i])<=1,`UV88 ${row.xy}: normal conversion changed the shared base binding byte ${i}`);
      }
    }
    // Production DCC encoder with native (lossless-copied) textures and a static matrix.
    const exported=await page.evaluate(async()=>{
      const {THREE,SourceMaterials,patchSourceMaterial,sourceVertexMaterial,SourceNativeTextures,GLTFLoader,encodeSceneGlb}=window.SourceBaseUvFixture;
      const renderer=new THREE.WebGLRenderer({antialias:false}),owner=new SourceMaterials(),owned=new Set();
      const native=async seed=>{
        // Exercise the real native-only glTF/VTF loader, including its retained export image.
        const data=new Uint8Array(80+64),header=new DataView(data.buffer);
        data.set([86,84,70,0]);header.setUint32(4,7,true);header.setUint32(8,2,true);header.setUint32(12,80,true);
        header.setUint16(16,4,true);header.setUint16(18,4,true);header.setUint32(20,1|256,true);
        header.setUint16(24,1,true);header.setUint32(52,0,true);data[56]=1;header.setUint32(57,0xffffffff,true);header.setUint16(63,1,true);
        for(let i=0;i<64;i++)data[80+i]=(seed*37+i*11)&255;
        const loader=new GLTFLoader();let textures;
        loader.register(parser=>textures=new SourceNativeTextures(parser,{own:value=>{owned.add(value);return value;}},renderer));
        await loader.parseAsync(JSON.stringify({
          asset:{version:'2.0'},extensionsUsed:['M0CLIP_texture_vtf'],extensionsRequired:['M0CLIP_texture_vtf'],
          buffers:[{byteLength:data.length,uri:'data:application/octet-stream;base64,'+btoa(String.fromCharCode(...data))}],
          bufferViews:[{buffer:0,byteOffset:0,byteLength:data.length}],
          textures:[{extensions:{M0CLIP_texture_vtf:{bufferView:0,frame:0,face:0,path:`fixture/native-${seed}`}}}],
          scenes:[{nodes:[]}],scene:0,
        }),'');
        return textures.get(0,THREE.NoColorSpace);
      };
      const map=await native(1),normalMap=await native(2);
      const original=new THREE.MeshStandardMaterial({name:'studio',map,normalMap});
      // Row-major Source ParameterMatrix of "scale 2 .5 rotate 90 translate .35 .1".
      original.userData.sourceMaterial={shader:'vertexlitgeneric',unlit:true,nocull:false,basetexturetransform:[0,-.5,.35,2,0,.1,0,0,1]};
      original.userData.sourceUnlit=true;
      const source=sourceVertexMaterial(original,1,{value:1},{value:1});source.name='source';
      patchSourceMaterial(source,original,{normal:normalMap},undefined,undefined,undefined,0,false,owner);
      const scene=new THREE.Scene(),geometry=new THREE.PlaneGeometry(1,1);
      // Source retains authored tangents when its material UV matrix changes.
      geometry.computeTangents();
      const studioMesh=new THREE.Mesh(geometry,original),sourceMesh=new THREE.Mesh(geometry,source);scene.add(studioMesh,sourceMesh);
      try{
        const blob=await encodeSceneGlb(scene,renderer,[]),buffer=await blob.arrayBuffer();
        const live=studioMesh.material===original&&sourceMesh.material===source&&original.map===map&&original.normalMap===normalMap&&source.map===map;
        return {live,bytes:Array.from(new Uint8Array(buffer))};
      }finally{
        owner.clear();for(const texture of owned)texture.dispose();geometry.dispose();renderer.dispose();renderer.forceContextLoss();
      }
    });
    const artifactDir=process.env.QA_ARTIFACT_DIR||fs.mkdtempSync(path.join(os.tmpdir(),'m0clip-source-uv-'));
    const glbPath=path.join(artifactDir,'source-base-uv.glb'),bytes=Buffer.from(exported.bytes),sha=crypto.createHash('sha256').update(bytes).digest('hex');
    fs.writeFileSync(glbPath,bytes,{flag:'wx',mode:0o600});
    assert(exported.live,'export restores the live materials and native textures');
    let blender={skipped:true,reason:'Set BLENDER_PATH for actual DCC sampling'};
    if(process.env.BLENDER_PATH){
      const result=spawnSync(process.env.BLENDER_PATH,['--background','--factory-startup','--python-exit-code','2','--python',path.join(__dirname,'test_source_uv_blender.py'),'--',glbPath,artifactDir,sha],
        {encoding:'utf8',timeout:180000,maxBuffer:16*1024*1024,env:{...process.env,PYTHONDONTWRITEBYTECODE:'1',BLENDER_USER_CONFIG:path.join(artifactDir,'blender-config')}});
      assert.equal(result.status,0,`${result.error||''}\n${result.stdout}\n${result.stderr}`);
      const marker=result.stdout.split('\n').find(line=>line.startsWith('SOURCE_UV_BLENDER '));
      assert(marker,`Blender did not complete its sampler probes:\n${result.stdout}`);
      const proof=JSON.parse(marker.slice('SOURCE_UV_BLENDER '.length));
      assert.equal(proof.explicitCompletion,true);assert.equal(proof.sourceSha256,sha);
      const files=proof.cases.flatMap(row=>[row.actual,row.reference]);
      const decoded=spawnSync(process.env.PYTHON||'python3',['-B','-c',
        'import json,sys;from PIL import Image;print(json.dumps({p:list(Image.open(p).convert("RGBA").getpixel((0,0))) for p in sys.argv[1:]}))',...files],{encoding:'utf8',timeout:30000});
      assert.equal(decoded.status,0,decoded.stderr);const pixels=JSON.parse(decoded.stdout);
      for(const binding of ['studio map','studio normalMap','source map']){
        const referenceColors=new Set(proof.cases.filter(row=>row.binding===binding).map(row=>pixels[row.reference].slice(0,3).join(',')));
        assert.equal(referenceColors.size,4,`${binding}: reference pixels do not distinguish the four authored coordinates`);
        for(const [u,v] of [[.125,.125],[.375,.125],[.125,.625],[.875,.625]]){
          const row=proof.cases.find(row=>row.binding===binding&&row.uv[0]===u&&row.uv[1]===v);
          assert(row,`Blender missed ${binding} (${u},${v})`);
          const actual=pixels[row.actual],reference=pixels[row.reference];
          actual.forEach((value,i)=>assert(Math.abs(value-reference[i])<=1,`${binding} (${u},${v}): ${actual} != authored-coordinate sample ${reference}`));
        }
      }
      blender={version:proof.blender,samples:proof.cases.length,passed:true};
    }
    assert.deepEqual(errors,[]);
    console.log(JSON.stringify({webglCases:results.length,independentSamplerTwins:true,liveMaterialsRestored:exported.live,glbSha256:sha,blender}));
    if(!process.env.QA_ARTIFACT_DIR)fs.rmSync(artifactDir,{recursive:true});
  }finally{await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
