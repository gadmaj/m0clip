/** CPU fixtures exercise real native sidecar consumers, not renderer/GPU fidelity.
 * Run: node scripts/test_raw_source_lighting.mjs
 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

import { webcrypto } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { build } from 'esbuild';
if (!globalThis.crypto) globalThis.crypto = webcrypto;
const compiled = await build({ stdin: { contents: `export * from './src/maps/raw-source-lighting'; export * from './src/maps/raw-source-lighting-glb'; export * from './src/maps/raw-source-manifest'; export * from './src/maps/raw-source-physics'; export * from './src/maps/bundle'; export * from './src/maps/source'; export * from './src/maps/source-import-finalize'; export * from './src/maps/raw-source-gltf'; export * from './src/maps/raw-source-materials'; export * from './src/maps/raw-source-vtf'; export * from './src/maps/raw-source-bsp'; export * from './src/maps/raw-source-files'; export * from './src/render/source-lightstyle-values'; export * from './src/render/source-grading'; export * from './src/render/source-clock'; export { SourcePVS } from './src/render/source-sky3d'; export { SourceAmbient } from './src/render/source-ambient'; export { SourceLightStyles } from './src/render/source-lightstyles'; export { DataTexture as SourceLightstyleTestTexture } from 'three';`, resolveDir: process.cwd(), loader: 'ts' }, bundle: true, platform: 'node', format: 'cjs', write: false });
const module = { exports: {} };
new Function('module', 'require', compiled.outputFiles[0].text)(module, createRequire(import.meta.url));
const { buildSourceLighting, appendSourceLightingAssets, appendSourceCubemaps, composeSourceMapFiles, sourceMapLight, sourceWorldPhysicsXml, finalizeGeneratedMapBundle, registerLocalMap, SourceGlb, SourceMaterialExport, readSourceVtf, readSourceBsp, decodeSourceWorld, SourceFileSystem, SourcePVS, SourceAmbient, SourceLightStyles, sourceLightstylePatterns, sourceLightstyleValue, SourceLightstyleTestTexture, loadSourceColorLayers, sourceColorWeight, sourceColorCorrectionLut } = module.exports;
const { finalizeSourceAssembly, sourceDeterministicGzip, clampSourceTime } = module.exports;
const entity = values => ({ values, pairs: Object.entries(values) });
function fixture({ hdr = false, displaced = false } = {}) {
  const bytes = Array.from({ length: 64 }, () => new Uint8Array());
  const views = {};
  const table = (id, length) => { bytes[id] = new Uint8Array(length); return views[id] = new DataView(bytes[id].buffer); };
  const plane = table(1, 20); plane.setFloat32(0, 1, true);
  const node = table(5, 32); node.setInt32(4, -1, true); node.setInt32(8, -2, true);
  const face = table(hdr ? 58 : 7, 56); face.setInt16(12, displaced ? 0 : -1, true);
  const leaf = table(10, 64);
  for (let i = 0; i < 2; i++) {
    const at = i * 32; leaf.setUint16(at + 4, i, true);
    for (let k = 0; k < 3; k++) { leaf.setInt16(at + 8 + k * 2, -10, true); leaf.setInt16(at + 14 + k * 2, 10, true); }
    leaf.setUint16(at + 22, i === 0 ? 1 : 0, true);
  }
  table(14, 48); table(16, 2); table(20, 8);
  const index = table(hdr ? 51 : 52, 8); index.setUint16(0, 1, true); index.setUint16(4, 1, true); index.setUint16(6, 1, true);
  table(hdr ? 55 : 56, 56);
  for (let i = 0; i < 2; i++) for (let side = 0; side < 6; side++) bytes[hdr ? 55 : 56].set([side + 1, i + 2, 3, 255], i * 28 + side * 4);
  const pvs = table(4, 22); pvs.setUint32(0, 2, true);
  for (let i = 0; i < 4; i++) pvs.setUint32(4 + i * 4, 20 + (i >= 2 ? 1 : 0), true);
  bytes[4].set([1, 2], 20);
  const lights = table(hdr ? 54 : 15, 88); lights.setFloat32(12, 3, true); lights.setInt32(40, 1, true); lights.setFloat32(60, 100, true); lights.setFloat32(72, 1, true);
  // One luxel, two styles, each with the real four consecutive bump layers.
  // Directional mean equals flat: all static directional normalization remains observable.
  const samples = Uint8Array.from([
    255,0,0,0, 255,0,0,0, 0,0,0,0, 255,0,0,1,
    0,255,0,0, 0,0,0,0, 0,255,0,0, 0,255,0,1,
  ]);
  bytes[hdr ? 53 : 8] = samples;
  const surface = { face: 0, material: 'fixture/lit', visible: true, displacement: displaced ? 0 : -1, sourcePositions: Float64Array.of(-1,0,0, 1,0,0, 0,1,0), positions: new Float32Array(9), lightmapLuxels: Float32Array.of(.5,.5,.5,.5,.5,.5), lightmap: { width: 1, height: 1, mins: [0,0], styles: Uint8Array.of(0,32,255,255), layersPerStyle: 4, offset: 0, samples, hdr } };
  if(displaced){
    table(26,176).setInt32(20,2,true);table(33,25*20);
    surface.basePositions=Float64Array.from({length:75},(_,index)=>{
      const vertex=Math.floor(index/3),axis=index%3;
      return axis===0?-1+(vertex%5)*.5:axis===1?Math.floor(vertex/5)*.25:0;
    });
    surface.sourcePositions=surface.basePositions.slice();surface.positions=new Float32Array(75);
    surface.lightmapLuxels=new Float32Array(50).fill(.5);
  }
  const versions = { 10: 1, 7: 1, 58: 1, 8: 1, 53: 1, 55: 1, 56: 1 };
  const lumps = bytes.map((data, index) => ({ index, offset: 0, length: data.length, uncompressedSize: 0, version: versions[index] ?? 0, raw: new Blob([data]) }));
  const bsp = { lumps, entities: [entity({ classname: 'worldspawn', skyname: 'fixture' }), entity({ classname: 'light', style: '32', pattern: 'az' })], getLump: async id => bytes[id] };
  return { bytes, views, world: { bsp, frame: { origin: [0,0,0], yaw: 0, metresPerUnit: .0254, up: 'Z' }, surfaces: [surface] } };
}
const originalFetch = globalThis.fetch;
globalThis.fetch = () => { throw new Error('Raw lighting must never use HTTP'); };
try {
  const f = fixture(), untouched = f.world.surfaces[0].lightmap.samples.slice();
  const fs = { readFile: async () => { throw new Error('No unselected companion reads'); } };
  const output = await buildSourceLighting(f.world, fs, { atlasSize: 8 });
  assert.equal(output.pages.length, 1); assert.equal(output.placements.length, 1);
  const p = output.placements[0], page = output.pages[0];
  assert.deepEqual(Array.from(p.uv), Array(6).fill(1.5 / 8));
  assert.equal(p.samples, f.world.surfaces[0].lightmap.samples);
  assert.deepEqual(p.samples, untouched);
  const pixel = (layer, x, y) => [...page.layers[layer].subarray((y * 8 + x) * 4, (y * 8 + x) * 4 + 4)];
  assert.deepEqual(pixel(0, 1, 1), [252,252,0,43]);
  assert.deepEqual(pixel(1, 1, 1), [252,0,0,43]);
  assert.deepEqual(pixel(2, 1, 1), [0,252,0,43]);
  assert.deepEqual(pixel(3, 1, 1), [255,255,0,85]);
  for (let l = 0; l < 4; l++) for (let y = 0; y < 3; y++) for (let x = 0; x < 3; x++) assert.deepEqual(pixel(l,x,y), pixel(l,1,1));
  assert(output.requirements.some(r => r.code === 'directional-style-runtime' && r.blocking));
  const ambient = new SourceAmbient(); ambient.setData(output.native.lighting); ambient.sample(.0254,0,0);
  for(const [i,cube] of ambient.cube.value.entries()){
    const expected=[(i+1)/2,1,1.5];
    cube.toArray().forEach((value,axis)=>assert(Math.abs(value-expected[axis])<1e-12,'native ambient sample preserves decoded RGB'));
  }
  // Per-prop caches must keep their own probe/light result after the live sampler moves.
  const firstCache={cube:[],lights:[]},secondCache={cube:[],lights:[]};
  ambient.styleValue=style=>style===0?.5:1;
  ambient.sample(.0254,0,0,firstCache);
  assert.deepEqual(firstCache.lights.map(light=>light.color),[[1.5,0,0]]);
  const firstSnapshot=structuredClone(firstCache);
  ambient.sample(-.0254,0,0,secondCache);
  assert.deepEqual(firstCache,firstSnapshot);
  for(const [cache,expected] of [[firstCache,[.5,1,1.5]],[secondCache,[.5,1.5,1.5]]])
    cache.cube[0].forEach((value,axis)=>assert(Math.abs(value-expected[axis])<=8*Number.EPSILON*Math.max(1,Math.abs(expected[axis]))));
  ambient.setData(null);ambient.sample(0,0,0,secondCache);
  assert.deepEqual(secondCache,{cube:[],lights:[]});
  // Defaultstyle is a pattern index: -1 is normal gain, 2 starts dark. An
  // authored pattern overrides that index; the off flag overrides both.
  const styled=new SourceAmbient();
  styled.setData({...output.native.lighting,lights:[{...output.native.lighting.lights[0],style:32}]});
  for(const [definition,red]of [
    [{pattern:null,default:-1,off:false},3],
    [{pattern:null,default:2,off:false},0],
    [{pattern:'z',default:2,off:false},6.25],
    [{pattern:'z',default:-1,off:true},0],
  ]){
    const patterns=sourceLightstylePatterns({32:definition});
    const weights=Float32Array.from(patterns,pattern=>sourceLightstyleValue(pattern,0));
    styled.styleValue=style=>weights[style]??1;
    const cache={cube:[],lights:[]};styled.sample(.0254,0,0,cache);
    if(red===0)assert.deepEqual(cache.lights,[]);
    else{
      assert.equal(cache.lights.length,1);
      assert(Math.abs(cache.lights[0].color[0]-red)<1e-6,'Actual styled direct-light intensity reaches the prop cache');
      assert.deepEqual(cache.lights[0].color.slice(1),[0,0]);
    }
  }
  const pvs = new SourcePVS(output.native.visibility);
  assert.equal(pvs.cluster({ x: .0254, y: 0, z: 0 }), 0);
  assert(pvs.visible(pvs.row(0), output.native.visibility.faceClusters[0]));
  assert(!pvs.visible(pvs.row(1), output.native.visibility.faceClusters[0]));
  const displaced = await buildSourceLighting(fixture({ displaced: true }).world, fs, { atlasSize: 8 });
  assert.deepEqual(displaced.native.visibility.faceClusters[0], [0,1]);
  // Exercise the ACTUAL existing lightstyles loader and CPU texture mutation.
  const files = new Map([['lightstyles.json', new Response(JSON.stringify(output.native.lightstyles), { headers: { 'content-type': 'application/json' } })], ...output.native.stylePages.map(p => [p.file, new Response(p.rgba)])]);
  const styles = await SourceLightStyles.load({ has: path => files.has(path), read: async path => files.get(path).clone() });
  const at = (p.y * 8 + p.x) * 4, data = styles.textures.get(0).image.data;
  assert.deepEqual([...data.subarray(at, at + 4)], [252,0,0,43]);
  styles.update(.1); assert(data[at + 1] > data[at]);
  for (const texture of styles.textures.values()) texture.dispose();
  // Package the REAL RGBM/style result behind six actual native HDR cube textures.
  const cubeHeader=Buffer.alloc(80),cubePixels=Buffer.alloc(48);
  cubeHeader.write('VTF\0');cubeHeader.writeUInt32LE(7,4);cubeHeader.writeUInt32LE(2,8);cubeHeader.writeUInt32LE(80,12);
  cubeHeader.writeUInt16LE(1,16);cubeHeader.writeUInt16LE(1,18);cubeHeader.writeUInt32LE(0x4000,20);
  cubeHeader.writeUInt16LE(1,24);cubeHeader.writeUInt16LE(0xffff,26);cubeHeader.writeUInt32LE(24,52);cubeHeader[56]=1;cubeHeader.writeUInt32LE(0xffffffff,57);cubeHeader.writeUInt16LE(1,63);
  for(let face=0;face<6;face++){cubePixels.writeUInt16LE(0x4000+face*128,face*8);cubePixels.writeUInt16LE(0x3800,face*8+2);cubePixels.writeUInt16LE(0x3c00,face*8+6);}
  const cubeBlob=new Blob([cubeHeader,cubePixels]),cubePath='materials/maps/fixture/c0_0_0.hdr.vtf';
  const withCubes={...output,cubemaps:[{position:[0,0,0],size:1,hdr:true,path:cubePath,blob:cubeBlob},{position:[100,0,0],size:1,hdr:false,path:'materials/maps/fixture/missing.vtf'}]};
  const bindingGlb=new SourceGlb(),bindingFs={readFile:async path=>path===cubePath?cubeBlob:undefined},bindingMaterials=new SourceMaterialExport(bindingGlb,bindingFs);
  const bindingController=new AbortController(),bindingLimits={maxAtlasBytes:1024**2,maxOutputBytes:1024**2,maxCubeWork:4};
  const originalStyle=structuredClone(output.native.lightstyles);
  const packed=await appendSourceLightingAssets(bindingGlb,bindingMaterials,withCubes,{...bindingLimits,signal:bindingController.signal});
  const nativeFaces=packed.cubeAt([0,0,0]);
  assert.equal(packed.cubeAt([100,0,0]),undefined,'missing nearest cube must not select a farther available cube');
  assert.throws(()=>packed.cubeAt([0,0,0]));
  const bytes=Buffer.from(await bindingGlb.finish().arrayBuffer()),jsonLength=bytes.readUInt32LE(12),binary=bytes.subarray(28+jsonLength);
  const payload=index=>{const v=bindingGlb.json.bufferViews[index];return binary.subarray(v.byteOffset,v.byteOffset+v.byteLength);};
  for(let face=0;face<6;face++){
    const texture=bindingGlb.json.textures[nativeFaces[face]],meta=texture.extensions.M0CLIP_texture_vtf;
    assert.deepEqual([...(await(await readSourceVtf(payload(meta.bufferView))).decode({frame:meta.frame,face:meta.face})).data],[2+face*.25,.5,0,1],'native cube HDR face values must not be quantized');
  }
  // A separate props parser encounters face5 first. Reusing world texture IDs
  // would select different HDR colors even though both documents own the same VTF.
  const propGlb=new SourceGlb(),propMaterials=new SourceMaterialExport(propGlb,bindingFs);
  await propMaterials.texture(cubePath,0,5);
  const propCubes=await appendSourceCubemaps(propMaterials,withCubes.cubemaps,{maxWork:4});
  const propFaces=propCubes.cubeAt([0,0,0]),propBytes=Buffer.from(await propGlb.finish().arrayBuffer());
  const propJsonLength=propBytes.readUInt32LE(12),propJson=JSON.parse(propBytes.subarray(20,20+propJsonLength).toString());
  const propBinary=propBytes.subarray(28+propJsonLength);
  for(const face of [0,5]){
    const meta=propJson.textures[propFaces[face]].extensions.M0CLIP_texture_vtf,view=propJson.bufferViews[meta.bufferView];
    const native=await readSourceVtf(propBinary.subarray(view.byteOffset,view.byteOffset+view.byteLength));
    const decoded=await native.decode({frame:meta.frame,face:meta.face});
    assert.deepEqual([...decoded.data],[2+face*.25,.5,0,1],'Separate owning GLB preserves the selected native HDR cube face');
  }
  for(const [layer,index] of [packed.lightmaps[0].flat,...packed.lightmaps[0].bump].entries()){
    const image=bindingGlb.json.images[bindingGlb.json.textures[index].source];
    const decoded=spawnSync('python3',['-c','import io,sys\nfrom PIL import Image\nsys.stdout.buffer.write(Image.open(io.BytesIO(sys.stdin.buffer.read())).convert("RGBA").tobytes())'],{input:payload(image.bufferView)});
    assert.equal(decoded.status,0,decoded.stderr.toString());
    const expected=output.pages[0].layers[layer];
    assert.deepEqual(decoded.stdout,Buffer.from(expected.buffer,expected.byteOffset,expected.byteLength),'actual PNG bytes retain each native RGBM layer');
  }
  const boundStyles=await SourceLightStyles.load({has:path=>packed.files.has(path),read:async path=>{const blob=packed.files.get(path);assert(blob,`Missing actual sidecar ${path}`);return new Response(blob);}});
  const boundPixels=boundStyles.textures.get(packed.lightmaps[0].flat).image.data;
  assert.deepEqual([...boundPixels.subarray(at,at+4)],[252,0,0,43],'genuine gzip/style patch uses the real texture index, not CPU page zero');
  boundStyles.update(.1);assert(boundPixels[at+1]>boundPixels[at]);
  {
    // Lightstyle pages are gzip with a fixed header: no mtime, fixed XFL and OS byte 3,
    // never the platform zlib's OS code, so the same map converts to the same bytes anywhere.
    const gz=[...packed.files].filter(([path])=>path.endsWith('.rgba.gz'));
    assert.ok(gz.length>0,'fixture packs at least one lightstyle page');
    const againGlb=new SourceGlb(),again=await appendSourceLightingAssets(againGlb,new SourceMaterialExport(againGlb,bindingFs),withCubes,bindingLimits);
    for(const [path,blob] of gz){
      const bytes=Buffer.from(await blob.arrayBuffer());
      assert.deepEqual([...bytes.subarray(0,10)],[0x1f,0x8b,8,0,0,0,0,0,0,3],`${path}: deterministic gzip header`);
      assert.deepEqual(Buffer.from(await again.files.get(path).arrayBuffer()),bytes,`${path}: identical input gives identical bytes`);
    }
    // Multi-chunk pages and the existing DecompressionStream reader.
    const page=new Uint8Array(3*1024*1024+17);for(let i=0;i<page.length;i++)page[i]=(i*2654435761>>>24)&(i&4096?255:7);
    const first=Buffer.from(await(await sourceDeterministicGzip(page,page.length*2)).arrayBuffer());
    assert.deepEqual(Buffer.from(await(await sourceDeterministicGzip(page.slice(),page.length*2)).arrayBuffer()),first);
    assert.equal(first[9],3);
    assert.deepEqual(Buffer.from(await new Response(new Blob([first]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer()),Buffer.from(page));
    await assert.rejects(sourceDeterministicGzip(page,64),RangeError,'output stays bounded while compressing');
    const aborted=new AbortController();aborted.abort();
    await assert.rejects(sourceDeterministicGzip(page,page.length*2,aborted.signal),{name:'AbortError'});
  }
  // A recorded clock outside the lightstyle range is clamped before it reaches update().
  assert.throws(()=>boundStyles.update(-1),RangeError);
  for(const [time,expected] of [[NaN,0],[-1,0],[-Infinity,0],[Infinity,1e9],[1e300,1e9],[12.5,12.5]]){
    assert.equal(clampSourceTime(time),expected);boundStyles.update(clampSourceTime(time));
  }
  boundStyles.update(.1);
  assert.deepEqual(output.native.lightstyles,originalStyle,'packaging must not rewrite the CPU lighting owner');
  for(const texture of boundStyles.textures.values())texture.dispose();
  bindingController.abort(new Error('owned lighting cancellation'));
  assert.throws(()=>packed.cubeAt([0,0,0]));
  for(const [overrides] of [[{maxAtlasBytes:1}],[{maxOutputBytes:1}]]){
    const limited=new SourceGlb(),limitedMaterials=new SourceMaterialExport(limited,bindingFs);
    await assert.rejects(appendSourceLightingAssets(limited,limitedMaterials,withCubes,{...bindingLimits,...overrides}));
  }
  // Unequal per-channel directional means, signed exponents, two distinct luxels
  // and authored fractional weights. Consume the actual packaged gzip pages.
  const directionalFixture=fixture(), directionalSurface=directionalFixture.world.surfaces[0];
  const directionalSamples=Uint8Array.from([
    255,128,64,0, 64,32,255,1,
    255,0,64,0, 32,255,64,255,
    128,64,0,1, 255,64,128,0,
    0,255,255,255, 64,128,32,2,
    64,255,128,1, 128,255,64,255,
    32,128,255,1, 255,128,64,0,
    255,128,64,0, 64,255,32,1,
    128,0,64,2, 128,64,255,255,
  ]);
  directionalSurface.face=37;
  directionalFixture.bytes[7]=new Uint8Array(38*56);
  for(let face=0;face<38;face++)new DataView(directionalFixture.bytes[7].buffer).setInt16(face*56+12,-1,true);
  directionalFixture.world.bsp.lumps[7]={...directionalFixture.world.bsp.lumps[7],length:38*56,raw:new Blob([directionalFixture.bytes[7]])};
  directionalFixture.bytes[8]=directionalSamples;
  directionalFixture.world.bsp.lumps[8]={...directionalFixture.world.bsp.lumps[8],length:directionalSamples.length,raw:new Blob([directionalSamples])};
  directionalSurface.lightmap={...directionalSurface.lightmap,width:2,samples:directionalSamples};
  directionalFixture.world.bsp.entities[1]=entity({classname:'light',style:'32',pattern:'gmpa'});
  const directional=await buildSourceLighting(directionalFixture.world,fs,{atlasSize:8});
  const directionalOptions={...bindingLimits,maxStyleWork:112,maxStyleBytes:304};
  const packageLighting=async (lighting,overrides={})=>{
    const glb=new SourceGlb(),materials=new SourceMaterialExport(glb,bindingFs);
    // Genuine preceding native HDR cube textures make page zero differ from IDs.
    return appendSourceLightingAssets(glb,materials,{...lighting,cubemaps:withCubes.cubemaps.slice(0,1)},{...directionalOptions,...overrides});
  };
  const directionalPacked=await packageLighting(directional);
  const styleJson=await directionalPacked.files.get('lightstyles.json').text(),styleData=JSON.parse(styleJson);
  const directionalBinding=directionalPacked.lightmaps[0],directionalIds=[directionalBinding.flat,...directionalBinding.bump];
  assert.deepEqual(directionalPacked.directionalStyles,[{face:37,page:0,flat:directionalBinding.flat,bumpPages:directionalBinding.bump}]);
  assert.deepEqual(directionalPacked.requirements,directional.requirements,'positive CPU capability must not erase native blockers');
  assert.equal(directional.capabilities.directionalStylesNative,false,'supporting packaging does not claim GPU qualification');
  assert.deepEqual(styleData.patches[0].bumpPages,directionalBinding.bump);
  for(let layer=0;layer<4;layer++){
    const sample=Buffer.from(layer?styleData.patches[0].bumpSamples[layer-1]:styleData.patches[0].samples,'base64');
    const original=Buffer.concat([Buffer.from(directionalSamples.subarray(layer*8,layer*8+8)),Buffer.from(directionalSamples.subarray((4+layer)*8,(4+layer)*8+8))]);
    assert.deepEqual(sample,original,'each serialized layer must retain original style-major RGBExp32');
    const compressed=directionalPacked.files.get(styleData.pages[directionalIds[layer]]);
    const raw=new Uint8Array(await new Response(compressed.stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer());
    assert.deepEqual(raw,directional.pages[0].layers[layer],'initial real directional RGBM pages survive gzip packaging');
  }
  const nativeSource=(data=styleData,changedFiles=new Map())=>({
    has:path=>path==='lightstyles.json'||directionalPacked.files.has(path),
    read:async path=>path==='lightstyles.json'
      ?new Response(JSON.stringify(data),{headers:{'content-type':'application/json'}})
      :new Response(changedFiles.get(path)??directionalPacked.files.get(path)),
  });
  const liveDirectional=await SourceLightStyles.load(nativeSource(),{maxWork:112});
  // Independent radiance oracle: explicitly decode each authored texel, round
  // contributions as the static Float32 atlas does, normalize each channel by
  // the mean of ALL THREE directional irradiances, then RGBM6-quantize.
  const encodeRgbm=rgb=>{
    const scaled=rgb.map(v=>Math.max(0,Math.min(1,v/6))),m=Math.ceil(Math.max(...scaled,1e-6)*255)/255;
    return [...scaled.map(v=>Math.floor(v/m*255)),Math.floor(m*255)];
  };
  const oracleTexel=(texel,weight,legacyFlat=false)=>{
    const irradiance=Array.from({length:4},(_,layer)=>Array.from({length:3},(_,channel)=>{
      let sum=0;
      for(let style=0;style<2;style++){
        const at=((style*4+layer)*2+texel)*4,exponent=directionalSamples[at+3]<<24>>24;
        const contribution=directionalSamples[at+channel]*(2**exponent/255*(style?Math.fround(weight):1));
        sum=legacyFlat?sum+contribution:Math.fround(sum+contribution);
      }
      return sum;
    }));
    return irradiance.map((rgb,layer)=>encodeRgbm(layer===0?rgb:rgb.map((v,c)=>{
      const mean=(irradiance[1][c]+irradiance[2][c]+irradiance[3][c])/3;
      return mean?v*(irradiance[0][c]/mean):0;
    })));
  };
  const expectedPage=(layer,weight,legacyFlat=false)=>{
    const expected=directional.pages[0].layers[layer].slice();
    for(let y=0;y<3;y++)for(let x=0;x<4;x++)expected.set(oracleTexel(Math.min(1,Math.max(0,x-1)),weight,legacyFlat)[layer],(y*8+x)*4);
    return expected;
  };
  for(let layer=0;layer<4;layer++)assert.deepEqual(directional.pages[0].layers[layer],expectedPage(layer,1),'static normalized bytes are the same radiometric convention');
  for(const [time,weight]of [[0,.5],[.099999,.5],[.1,1],[.199999,1],[.2,1.25],[.3,0],[.4,.5],[1.1,0]]){
    liveDirectional.update(time);
    assert.equal(liveDirectional.value(32),Math.fround(weight));
    for(let layer=0;layer<4;layer++)assert.deepEqual(liveDirectional.textures.get(directionalIds[layer]).image.data,expectedPage(layer,weight),`all channels, both luxels and every gutter at ${time}s layer ${layer}`);
  }
  // The fixture would catch treating a directional layer as an unrelated flat.
  assert.notDeepEqual(oracleTexel(0,.5)[1],encodeRgbm([1+32*2/255*.5,128*2/255*.5,64/255+255*2/255*.5]));
  for(const texture of liveDirectional.textures.values())texture.dispose();
  const flatSamples=Uint8Array.from([...directionalSamples.subarray(0,8),...directionalSamples.subarray(32,40)]);
  const flatFixture=fixture(),flatSurface=flatFixture.world.surfaces[0];
  flatSurface.lightmap={...flatSurface.lightmap,width:2,layersPerStyle:1,samples:flatSamples};
  flatFixture.world.bsp.entities[1]=entity({classname:'light',style:'32',pattern:'gmpa'});
  const flatLighting=await buildSourceLighting(flatFixture.world,fs,{atlasSize:8}),flatJson=JSON.stringify(flatLighting.native.lightstyles);
  const flatPacked=await packageLighting(flatLighting,{maxStyleWork:96}),flatData=JSON.parse(await flatPacked.files.get('lightstyles.json').text());
  assert.equal(JSON.stringify(flatLighting.native.lightstyles),flatJson);
  assert.equal('bumpPages'in flatData.patches[0],false);assert.equal('bumpSamples'in flatData.patches[0],false);
  assert.deepEqual(Object.values(flatData.pages),Object.values(flatLighting.native.lightstyles.pages),'flat-only JSON retains its legacy fields and sidecar names');
  const flatLive=await SourceLightStyles.load({has:path=>flatPacked.files.has(path),read:async path=>new Response(flatPacked.files.get(path))});
  for(const[time,weight]of [[0,.5],[.1,1],[.2,1.25],[.3,0]]){
    flatLive.update(time);
    assert.deepEqual(flatLive.textures.get(flatPacked.lightmaps[0].flat).image.data,expectedPage(0,weight,true),'legacy flat-only mutation retains double-precision byte behavior');
  }
  for(const texture of flatLive.textures.values())texture.dispose();
  const mixedWorld={...directionalFixture.world,surfaces:[directionalSurface,{...flatSurface,face:0,lightmap:{...flatSurface.lightmap,width:1,samples:Uint8Array.from([...directionalSamples.subarray(0,4),...directionalSamples.subarray(32,36)])}}]};
  const mixed=await buildSourceLighting(mixedWorld,fs,{atlasSize:8});
  const mixedPacked=await packageLighting(mixed,{maxStyleWork:184,maxStyleBytes:352});
  const mixedLive=await SourceLightStyles.load({has:path=>mixedPacked.files.has(path),read:async path=>new Response(mixedPacked.files.get(path))});
  for(const[time,weight]of [[0,.5],[.1,1],[.2,1.25],[.3,0]]){
    mixedLive.update(time);
    const flatPlacement=mixed.placements.find(p=>p.face===0),data=mixedLive.textures.get(mixedPacked.lightmaps[0].flat).image.data;
    for(let y=-1;y<=1;y++)for(let x=-1;x<=1;x++){
      const at=((flatPlacement.y+y)*8+flatPlacement.x+x)*4;
      assert.deepEqual([...data.subarray(at,at+4)],oracleTexel(0,weight,true)[0],'legacy flat patches remain valid on an atlas shared with directional patches');
    }
  }
  for(const texture of mixedLive.textures.values())texture.dispose();
  const invalidStyles=[
    [d=>delete d.patches[0].bumpSamples],
    [d=>d.patches[0].bumpPages.pop()],
    [d=>d.patches[0].bumpPages[1]=d.patches[0].page],
    [d=>delete d.pages[d.patches[0].bumpPages[0]]],
    [d=>d.patches[0].bumpSamples[2]='AAAA'],
    [d=>d.patches[0].x=0],
    [d=>d.patches[0].styles.push(32)],
    [d=>d.patterns[32].pattern='m!'],
    [d=>{d.pages[99]='extra.rgba';d.patches.push({...d.patches[0],bumpPages:[99,...d.patches[0].bumpPages.slice(1)]});}],
  ];
  for(const[mutate]of invalidStyles){
    const invalid=structuredClone(styleData);mutate(invalid);
    await assert.rejects(SourceLightStyles.load(nativeSource(invalid)));
  }
  await assert.rejects(SourceLightStyles.load(nativeSource(),{maxWork:111}));
  await assert.rejects(SourceLightStyles.load(nativeSource(),{maxBytes:1}));
  await assert.rejects(SourceLightStyles.load(nativeSource(),{maxPatches:0}));
  await assert.rejects(packageLighting(directional,{maxStyleWork:111}));
  await assert.rejects(packageLighting(directional,{maxStyleBytes:303}));
  const badSamples={...directional,placements:directional.placements.map(p=>({...p,samples:p.samples.subarray(1)}))};
  await assert.rejects(packageLighting(badSamples));
  const badPatch={...directional,native:{...directional.native,lightstyles:{...directional.native.lightstyles,patches:directional.native.lightstyles.patches.map(p=>({...p,page:99}))}}};
  await assert.rejects(packageLighting(badPatch));
  const missingPatch={...directional,native:{...directional.native,lightstyles:{...directional.native.lightstyles,patches:[]}}};
  await assert.rejects(packageLighting(missingPatch));
  const hugePage=await new Response(new Blob([new Uint8Array(8*8*4+1)]).stream().pipeThrough(new CompressionStream('gzip'))).blob();
  await assert.rejects(SourceLightStyles.load(nativeSource(styleData,new Map([[styleData.pages[directionalIds[1]],hugePage]]))));
  const styleAbort=new AbortController();styleAbort.abort(new Error('owned style abort'));
  await assert.rejects(SourceLightStyles.load(nativeSource(),{signal:styleAbort.signal}));
  await assert.rejects(packageLighting(directional,{signal:styleAbort.signal}));
  const readAbort=new AbortController(),abortSource=nativeSource(),originalRead=abortSource.read;
  abortSource.read=async path=>{const response=await originalRead(path);if(path===styleData.pages[directionalIds[1]])readAbort.abort(new Error('owned page read abort'));return response;};
  await assert.rejects(SourceLightStyles.load(abortSource,{signal:readAbort.signal}));
  const updateAbort=new AbortController(),cancelledStyles=await SourceLightStyles.load(nativeSource(),{signal:updateAbort.signal});
  updateAbort.abort(new Error('owned tick abort'));assert.throws(()=>cancelledStyles.update(.2));
  for(const texture of cancelledStyles.textures.values())texture.dispose();
  // Cancellation must finish while response headers remain deliberately pending.
  // Observe real Three texture disposal, not a mock resource or elapsed timeout.
  const unhandledStyleReads=[],onUnhandledStyleRead=error=>unhandledStyleReads.push(error);
  process.on('unhandledRejection',onUnhandledStyleRead);
  try {
    for(const[stage,lateSettlement]of [['metadata','response'],['atlas','response'],['metadata','rejection'],['atlas','rejection']]){
      const controller=new AbortController(),reason=new Error(`owned deferred ${stage} abort`);
      const target=stage==='metadata'?'lightstyles.json':styleData.pages[directionalIds[1]];
      let resolveHeaders,rejectHeaders,announceRead;
      const headers=new Promise((resolve,reject)=>{resolveHeaders=resolve;rejectHeaders=reject;});
      const entered=new Promise(resolve=>{announceRead=resolve;});
      const deferredSource=nativeSource(),baseRead=deferredSource.read;
      deferredSource.read=path=>{
        if(path===target){announceRead();return headers;}
        return baseRead(path);
      };
      const disposed=[],prototype=SourceLightstyleTestTexture.prototype,originalDispose=prototype.dispose;
      const ownDispose=Object.hasOwn(prototype,'dispose');
      prototype.dispose=function(){
        const record={texture:this,events:0};
        this.addEventListener('dispose',()=>record.events++);
        disposed.push(record);
        return originalDispose.call(this);
      };
      try {
        const outcome=SourceLightStyles.load(deferredSource,{signal:controller.signal}).then(
          value=>({status:'resolved',value}),error=>({status:'rejected',error}));
        await entered;
        controller.abort(reason);
        const prompt=await Promise.race([outcome,new Promise(resolve=>setImmediate(()=>resolve({status:'pending'})))]);
        const disposedBeforeLate=disposed.slice(),lateCancellations=[];
        if(lateSettlement==='response'){
          const body=new ReadableStream({cancel(cancelReason){
            lateCancellations.push(cancelReason);
            return Promise.reject(new Error('late body cancellation rejection must be consumed'));
          }});
          resolveHeaders(new Response(body,{headers:{'content-type':'application/json'}}));
        }else rejectHeaders(new Error('late header rejection must be consumed'));
        await new Promise(resolve=>setImmediate(resolve));
        await new Promise(resolve=>setImmediate(resolve));
        assert.equal(prompt.status,'rejected',`${stage} cancellation must not await deferred headers`);
        assert.equal(prompt.error,reason,'the owning abort reason is preserved');
        assert.equal(disposedBeforeLate.length,stage==='atlas'?1:0,'existing textures must dispose before any late header settlement');
        for(const record of disposedBeforeLate){
          assert(record.texture instanceof SourceLightstyleTestTexture);
          assert.equal(record.events,1,'the actual Three dispose implementation dispatches its event');
          assert.deepEqual(record.texture.image.data,directional.pages[0].layers[0],'the disposed texture owns the genuine first packaged RGBM page');
        }
        assert.deepEqual(lateCancellations,lateSettlement==='response'?[reason]:[],'late response body ownership ends with the original abort');
        assert.equal(disposed.length,disposedBeforeLate.length,'a late response must never create another texture');
        assert.deepEqual(unhandledStyleReads,[],'late read and body-cancel rejections must be consumed');
      }finally{
        if(ownDispose)prototype.dispose=originalDispose;
        else delete prototype.dispose;
      }
    }
  }finally{process.off('unhandledRejection',onUnhandledStyleRead);}
  const hdr = await buildSourceLighting(fixture({ hdr: true }).world, fs, { atlasSize: 8 });
  assert.equal(hdr.identity.lightingLump, 53); assert.equal(hdr.identity.worldLightsLump, 54);
  assert(hdr.requirements.some(r => r.code === 'hdr-postprocessing-runtime'));
  const legacy=fixture(),legacyCubes=new Uint8Array(48);
  for(let i=0;i<2;i++)legacyCubes.set(legacy.bytes[56].subarray(i*28,i*28+24),i*24);
  legacy.bytes[52]=new Uint8Array();legacy.bytes[56]=legacyCubes;
  legacy.world.bsp.lumps[52]={...legacy.world.bsp.lumps[52],length:0};
  legacy.world.bsp.lumps[56]={...legacy.world.bsp.lumps[56],length:48,version:48};
  const legacyOutput=await buildSourceLighting(legacy.world,fs,{atlasSize:8});
  for(let i=0;i<2;i++)assert.deepEqual(legacyOutput.native.lighting.leaves[i],[
    [0,0,0,...Array.from({length:6},(_,side)=>[(side+1)/2,(i+2)/2,1.5]).flat()],
  ]);
  legacy.bytes[56]=legacyCubes.subarray(0,47);
  await assert.rejects(buildSourceLighting(legacy.world,fs,{atlasSize:8}));
  const borrowed=fixture(),borrowedLeaves=new Uint8Array(128),borrowedIndices=new Uint8Array(16);
  borrowedLeaves.set(borrowed.bytes[10]);
  const borrowedBounds=new DataView(borrowedLeaves.buffer),borrowedIndex=new DataView(borrowedIndices.buffer);
  [100,200,300].forEach((v,k)=>borrowedBounds.setInt16(96+8+k*2,v,true));
  [120,240,360].forEach((v,k)=>borrowedBounds.setInt16(96+14+k*2,v,true));
  borrowedIndex.setUint16(2,3,true);borrowedIndex.setUint16(12,1,true);
  const borrowedSample=borrowed.bytes[56].slice(0,28);borrowedSample.set([255,128,0],24);
  for(const [id,bytes] of [[10,borrowedLeaves],[52,borrowedIndices],[56,borrowedSample]]){
    borrowed.bytes[id]=bytes;borrowed.world.bsp.lumps[id]={...borrowed.world.bsp.lumps[id],length:bytes.length};
  }
  const borrowedOutput=await buildSourceLighting(borrowed.world,fs,{atlasSize:8});
  assert.deepEqual(borrowedOutput.native.lighting.leaves[0][0].slice(0,3),[120,200+40*128/255,300]);
  const borrowedAmbient=new SourceAmbient();borrowedAmbient.setData(borrowedOutput.native.lighting);borrowedAmbient.sample(.0254,0,0);
  borrowedAmbient.cube.value[0].toArray().forEach((v,k)=>assert(Math.abs(v-[.5,1,1.5][k])<1e-12));
  borrowedIndex.setUint16(2,4,true);
  await assert.rejects(buildSourceLighting(borrowed.world,fs,{atlasSize:8}));
  const absent = fixture(); absent.world.surfaces[0].lightmap.offset = -1;
  const unlit = await buildSourceLighting(absent.world, fs, { atlasSize: 8 });
  assert.equal(unlit.pages.length, 0); assert(unlit.requirements.some(r => r.code === 'face-without-baked-samples'));
  const corrupt = fixture(); corrupt.bytes[4][20] = 0; corrupt.bytes[4][21] = 0;
  await assert.rejects(buildSourceLighting(corrupt.world, fs, { atlasSize: 8 }));
  const cyclic = fixture(); cyclic.views[5].setInt32(4, 0, true);
  await assert.rejects(buildSourceLighting(cyclic.world, fs, { atlasSize: 8 }));
  const truncated = fixture(); truncated.world.surfaces[0].lightmap.samples = new Uint8Array(3);
  await assert.rejects(buildSourceLighting(truncated.world, fs, { atlasSize: 8 }));
  await assert.rejects(buildSourceLighting(f.world, fs, { atlasSize: 8, maxAtlasBytes: 16 }));
  const abort = new AbortController(); abort.abort(new Error('owned cancellation'));
  await assert.rejects(buildSourceLighting(f.world, fs, { signal: abort.signal }));
  // LUT selection, Source-to-map frame, startup output and Blob ownership boundary.
  const lutFixture = fixture(), lut = new Blob([new Uint8Array(32 ** 3 * 3)]);
  lutFixture.world.bsp.entities.push(entity({ classname: 'color_correction', filename: 'materials/grade.raw', targetname: 'grade', origin: '10 0 0', startdisabled: '1', minfalloff: '2', maxfalloff: '20' }), entity({ classname: 'logic_auto', OnMapSpawn: 'grade,Enable,,0,-1' }));
  let reads = 0;
  const local = { readFile: async path => { reads++; assert.equal(path, 'materials/grade.raw'); return lut; } };
  const missing = await buildSourceLighting(lutFixture.world, local, { atlasSize: 8 });
  assert.equal(reads, 0); assert(missing.requirements.some(r => r.code === 'unselected-local-companion'));
  const graded = await buildSourceLighting(lutFixture.world, local, { atlasSize: 8, selectedCompanionPaths: ['materials/grade.raw'] });
  assert.equal(reads, 1); assert.equal(graded.companions.get('materials/grade.raw'), lut);
  assert.equal(graded.native.colorCorrections[0].enabled, true);
  assert.deepEqual(graded.native.colorCorrections[0].origin, [.254,0,0]);
  const sharedFixture=fixture(),sharedBytes=new Uint8Array(32**3*3);
  for(let i=0;i<sharedBytes.length;i+=3)sharedBytes.set([120,60,30],i);
  const sharedBlob=new Blob([sharedBytes]),sharedFs={readFile:async path=>path==='materials/shared.raw'?sharedBlob:undefined};
  for(const [targetname,origin] of [['grade_a','0 0 0'],['grade_b','100 0 0']])
    sharedFixture.world.bsp.entities.push(entity({classname:'color_correction',filename:'materials/shared.raw',targetname,origin,minfalloff:'0',maxfalloff:'200'}));
  const sharedLighting=await buildSourceLighting(sharedFixture.world,sharedFs,{atlasSize:8,selectedCompanionPaths:['materials/shared.raw']});
  const sharedGlb=new SourceGlb(),sharedMaterials=new SourceMaterialExport(sharedGlb,sharedFs);
  const sharedAssets=await appendSourceLightingAssets(sharedGlb,sharedMaterials,sharedLighting,bindingLimits);
  const loadedLayers=await loadSourceColorLayers({color_corrections:sharedLighting.native.colorCorrections},{read:async path=>{const blob=sharedAssets.files.get(path);assert(blob,`Missing packaged LUT ${path}`);return new Response(blob);}});
  const weights=loadedLayers.map(layer=>sourceColorWeight(layer,{x:1.27,y:0,z:0}));
  assert.deepEqual([...sourceColorCorrectionLut(loadedLayers.map(layer=>layer.data),weights).subarray(0,4)],[60,30,15,255],'both independently placed controllers must contribute even when they share one packaged LUT');
  // Consume generated native metadata through the actual local-map and grading/
  // style loaders, rather than checking copied fields in isolation.
  const manifestWorld={...sharedFixture.world,frame:{...sharedFixture.world.frame,spawnClass:'info_player_start',floorFound:true},collision:[],limitations:['CPU lighting fixture; no map rendering qualification']};
  assert.equal(sourceMapLight(manifestWorld),null,'Absent authored light_environment never creates a synthetic sun');
  manifestWorld.bsp.entities.push(entity({classname:'light_environment',angles:'0 45 0',pitch:'-30',_light:'128 64 32 255',_ambient:'30 60 90 64'}));
  const composeLimits={id:'native-fixture',name:'Native fixture',game:'Fixture',physics:new Map([['map.xml',new Blob([sourceWorldPhysicsXml(manifestWorld)])]]),
    visual:sharedGlb.finish(),renderer:{version:1,color:'ldr-gamma-lut',antialiasing:'fxaa'},requirements:[{code:'parent-unresolved',blocking:true,detail:'Still unresolved'}],
    maxOutputBytes:8*1024**2,maxMetadataBytes:1024**2,maxMetadataAllocationBytes:16*1024**2};
  const composed=composeSourceMapFiles(manifestWorld,sharedLighting,sharedAssets,composeLimits);
  assert.deepEqual(composed.requirements.filter(item=>item.code==='directional-style-runtime').map(item=>item.face),[0],
    'One authored face must not repeat because both lighting writers retain its blocker');
  const distinctFace={...sharedLighting.requirements.find(item=>item.code==='directional-style-runtime'),face:1};
  const distinct=composeSourceMapFiles(manifestWorld,sharedLighting,sharedAssets,
    {...composeLimits,requirements:[...composeLimits.requirements,distinctFace]});
  assert.deepEqual(distinct.requirements.filter(item=>item.code==='directional-style-runtime').map(item=>item.face).sort(),[0,1],
    'Separate authored faces remain separate requirements even when their codes match');
  const variantCopies=[0,1].map(()=>({code:'material-shader-runtime',path:'materials/variant.vmt',detail:'Native shader x is not implemented by the existing renderer.',blocking:true}));
  const joined=composeSourceMapFiles(manifestWorld,sharedLighting,sharedAssets,{...composeLimits,requirements:[...composeLimits.requirements,...variantCopies]});
  assert.equal(joined.requirements.filter(item=>item.path==='materials/variant.vmt').length,1,
    'Per-variant material writers repeating one cause list it once');
  await assert.rejects(finalizeSourceAssembly(composed,'Fixture','Fixture'),error=>
    error.requirements.filter(item=>item.code==='directional-style-runtime').length===1);
  const finalized=await finalizeGeneratedMapBundle({...composeLimits,files:composed.files,maxHashBytes:16*1024**2});
  const composedSource=registerLocalMap(finalized),nativeManifest=await composedSource.json('manifest.json');
  assert.deepEqual(nativeManifest.light,{azimuth:-135,elevation:30,color:0x804020,intensity:1.8,ambientColor:0x1e3c5a,ambient:.6},'authored Source light converts into the renderer map frame');
  const manifestLayers=await loadSourceColorLayers(nativeManifest,composedSource);
  assert.deepEqual([...sourceColorCorrectionLut(manifestLayers.map(layer=>layer.data),manifestLayers.map(layer=>sourceColorWeight(layer,{x:1.27,y:0,z:0}))).subarray(0,4)],[60,30,15,255]);
  const manifestStyles=await SourceLightStyles.load(composedSource);
  manifestStyles.update(.1);
  assert(manifestStyles.textures.size>0,'actual native styles survive generated finalization and MapSource reads');
  for(const texture of manifestStyles.textures.values())texture.dispose();
  assert(composed.requirements.some(item=>item.code==='parent-unresolved'&&item.blocking));
  assert(!JSON.stringify(nativeManifest).includes('materials/shared.raw'),'source companion paths never enter runtime metadata');
  assert(!composedSource.has('materials/shared.raw'),'unselected/raw companions do not become map resources');
  // Authored boundary reaches the real admission consumer, not a copied-field oracle.
  const policyWorld = values => ({...manifestWorld,bsp:{...manifestWorld.bsp,entities:[
    entity({classname:'worldspawn',...values}),...manifestWorld.bsp.entities.filter(e=>e.values.classname!=='worldspawn'),
  ]}});
  const noPolicy=composeSourceMapFiles(policyWorld({}),sharedLighting,sharedAssets,composeLimits);
  assert.equal(noPolicy.manifest.source_prop_view,undefined);
  for(const [values,expected] of [
    [{minpropscreenwidth:'20',maxpropscreenwidth:'40','maxpropscreenwidth#1':'-1'},[20,-1]],
    [{'MinPropScreenWidth#1':'20','MAXPROPSCREENWIDTH#2':'40'},[20,40]],
    [{minpropscreenwidth:'20',maxpropscreenwidth:'NaN','maxpropscreenwidth#1':'40'},[20,40]],
    [{maxpropscreenwidth:'-1'},[0,-1]],
    [{minpropscreenwidth:'20'},[20,0]],
  ]){
    const authored=policyWorld(values),before=structuredClone(authored.bsp.entities);
    const resolved=composeSourceMapFiles(authored,sharedLighting,sharedAssets,composeLimits);
    assert.deepEqual(resolved.manifest.source_prop_view?.levelScreenFade,expected);
    assert.deepEqual(resolved.requirements,noPolicy.requirements);
    assert.deepEqual(authored.bsp.entities,before);
  }
  for(const values of [
    {minpropscreenwidth:'',maxpropscreenwidth:'40'},
    {minpropscreenwidth:'NaN',maxpropscreenwidth:'40'}, {minpropscreenwidth:'20',maxpropscreenwidth:'1e999'},
    {minpropscreenwidth:'0x10',maxpropscreenwidth:'40'}, {minpropscreenwidth:'20px',maxpropscreenwidth:'40'},
    {minpropscreenwidth:'20',maxpropscreenwidth:'40','maxpropscreenwidth#1':'NaN'},
  ]){
    const authored=policyWorld(values),before=structuredClone(authored.bsp.entities);
    const blocked=composeSourceMapFiles(authored,sharedLighting,sharedAssets,composeLimits);
    assert.deepEqual(authored.bsp.entities,before,'assembly leaves ordered original entity data intact');
    assert.equal(blocked.manifest.source_prop_view,undefined);
    let verifying=false;
    await assert.rejects(finalizeSourceAssembly(blocked,'Fixture','Fixture',()=>{verifying=true;}),error=>
      error.requirements.some(r=>r.code==='prop-level-screen-fade-policy'&&r.blocking));
    assert.equal(verifying,false,'invalid authored policy cannot enter verification or acquire identity');
  }
  assert.throws(()=>composeSourceMapFiles(manifestWorld,sharedLighting,{...sharedAssets,files:new Map([...sharedAssets.files,['materials-report.json',new Blob(['{}'])]])},composeLimits));
  assert.throws(()=>composeSourceMapFiles(manifestWorld,sharedLighting,sharedAssets,{...composeLimits,signal:AbortSignal.abort()}),{name:'AbortError'});
  assert.throws(()=>composeSourceMapFiles(manifestWorld,sharedLighting,sharedAssets,{...composeLimits,maxMetadataAllocationBytes:1}));
  assert.throws(()=>composeSourceMapFiles(manifestWorld,{...sharedLighting,identity:{...sharedLighting.identity,hdr:true}},sharedAssets,composeLimits));
  const missingLutFiles=new Map(composed.files);missingLutFiles.delete(nativeManifest.color_corrections[0].file);
  await assert.rejects(finalizeGeneratedMapBundle({...composeLimits,files:missingLutFiles,maxHashBytes:16*1024**2}));
  const wildcard=fixture();
  wildcard.world.bsp.entities.push(
    entity({classname:'color_correction',filename:'materials/grade.raw',targetname:'grade_main',startdisabled:'1'}),
    entity({classname:'logic_auto',OnMapSpawn:'grade*,Enable,,0,-1'}),
  );
  const wildcardOutput=await buildSourceLighting(wildcard.world,local,{atlasSize:8,selectedCompanionPaths:['materials/grade.raw']});
  assert(wildcardOutput.requirements.some(r=>r.code==='dynamic-lighting-target-runtime'&&r.blocking));
  assert.equal(wildcardOutput.native.colorCorrections[0].enabled,false);
  for(const [values,code] of [
    [{maxweight:'.25'},'color-correction-weight-runtime'],
    [{fadeInDuration:'2'},'color-correction-fade-runtime'],
    [{fadeOutDuration:'2'},'color-correction-fade-runtime'],
  ]){
    const weighted=fixture();
    weighted.world.bsp.entities.push(
      entity({classname:'color_correction',filename:'materials/grade.raw',targetname:'grade',startdisabled:'1',...values}),
      entity({classname:'logic_auto',OnMapSpawn:'grade,Enable,,0,-1'}),
    );
    const result=await buildSourceLighting(weighted.world,local,{atlasSize:8,selectedCompanionPaths:['materials/grade.raw']});
    assert(result.requirements.some(r=>r.code===code&&r.blocking));
  }
  const incomplete = fixture({ hdr: true });
  incomplete.bytes[51] = new Uint8Array();
  incomplete.world.bsp.lumps[51] = { ...incomplete.world.bsp.lumps[51], length: 0 };
  const incompleteOutput = await buildSourceLighting(incomplete.world, fs, { atlasSize: 8 });
  assert(incompleteOutput.requirements.some(r => r.code === 'missing-ambient-index'));
  assert(incompleteOutput.native.lighting.leaves.every(leaf => leaf.length === 0));
  console.log('Raw lighting CPU/native consumer fixtures passed (not renderer qualification)');

} finally { globalThis.fetch = originalFetch; }
