/** Chromium pixels: Source projected lighting, albedo blending and independent native masks. */
const {buildSync}=require('esbuild');
const pngModule={exports:{}};new Function('module','exports','require',buildSync({entryPoints:['src/record/png.ts'],bundle:true,platform:'node',format:'cjs',write:false}).outputFiles[0].text)(pngModule,pngModule.exports,require);
const png=(rgba,width=1)=>Buffer.from(pngModule.exports.encodeRgbaPNG(width,1,new Uint8Array(rgba)));
const data=(rgba,width=1)=>'data:image/png;base64,'+png(rgba,width).toString('base64');
function fixture(mode){
 const frame=mode.startsWith('frame-');
 const positions=[-2,-2,-2,2,-2,-2,2,2,-2,-2,-2,-2,2,2,-2,-2,2,-2],normals=Array.from({length:6},()=>frame?[0,.6,.8]:[0,0,1]).flat(),uv=[0,0,1,0,1,1,0,0,1,1,0,1],tangents=Array.from({length:6},()=>[1,0,0,mode==='frame-negative'?-1:1]).flat();
 const arrays=[positions,normals,uv,tangents].map(values=>Buffer.from(new Float32Array(values).buffer));let offset=0;
 const bufferViews=arrays.map(array=>{const view={buffer:0,byteOffset:offset,byteLength:array.byteLength};offset+=array.byteLength;return view});
 const reflection=mode.startsWith('reflect-'),detail=mode.includes('detail'),transition=mode==='reflect-secondary',cutout=mode.includes('cutout');
 const bumped=mode.startsWith('bump-'),world=mode==='world'||transition||bumped,meta={shader:transition?'worldvertextransition':world?'lightmappedgeneric':'vertexlitgeneric',unlit:mode==='unlit',phong:mode.startsWith('phong'),phongexponent:5,phongboost:1,phongtint:[1,.5,.25],phongfresnelranges:[0,0,0],selfillum:mode.startsWith('emissive'),selfillumtint:[1,1,1],bumpmapIndex:0};
 const falloff=mode.endsWith('-falloff'),specularFalloff=mode==='phong-specular-falloff',spotFalloff=mode==='phong-spot-falloff';
 if(falloff)meta.halflambert=true;
 if(specularFalloff){meta.phongfresnelranges=[1,1,1];meta.phongtint=[1,1,1]}
 const light={kind:spotFalloff?2:1,pos:mode==='phong-interpolated-falloff'?[1.5/.0254,1.5/.0254,-1.5/.0254]:[0,0,0],color:specularFalloff?[.25,.125,.0625]:mode==='phong-interpolated-falloff'?[1,1,1]:[3,3,3],attenuation:spotFalloff?[1,0,0]:[0,0,.0254**2],normal:[0,0,-1],exponent:2,inner:.95,outer:.5};
 if(mode==='bump-disabled')meta.nodiffusebumplighting=true;
 if(mode==='emissive-partial')meta.selfillummaskIndex=1;
 if(mode==='phong-albedo'||mode==='phong-exponent')meta.phongexponenttextureIndex=3;
 if(mode==='phong-albedo'){meta.phongalbedotint=true;meta.phongalbedoboost=2}
 if(mode==='phong-base-mask'||mode==='phong-detail')meta.basealphaphongmask=true;
 if(mode==='phong-mask-invert')meta.phongmaskinvert=true;
 const animation=mode.startsWith('animated'),simple=mode.startsWith('cutout-'),bare=mode==='cutout-bare';
 if(animation||simple){meta.unlit=true;meta.shader='unlitgeneric'}
 if(animation){meta.animationfps=2;meta.animationFrames=[8,9]}
 if(detail)Object.assign(meta,{detailIndex:6,detailscale:4,detailblendfactor:.8});
 if(reflection)Object.assign(meta,{envmap:'env_cubemap',envmapFaces:[5,5,5,5,5,5],envmaptint:[.25,.125,.0625],basealphaenvmapmask:true});
 if(transition){meta.basetexture2Index=7;const array=Buffer.from(new Float32Array(Array.from({length:6},()=>[1,1,1,.5]).flat()).buffer);bufferViews.push({buffer:0,byteOffset:offset,byteLength:array.byteLength});offset+=array.byteLength;arrays.push(array)}
 const extras={sourceMaterial:meta,...world?{sourceLightmap:2,...bumped?{sourcePropBrush:true,sourceBumpLightmaps:[11,12,13]}:{}}:{sourceVertexLighting:6,sourceUnlit:mode==='unlit'}};
 if(animation||simple)extras.sourceUnlit=true;if(bare)delete extras.sourceMaterial;
 const result={asset:{version:'2.0'},scene:0,scenes:[{nodes:[0]}],nodes:[{mesh:0,extras:{sourceOrigin:[0,0,0],sourceYaw:0,...world?{}:{sourceLighting:{cube:Array.from({length:6},()=>[0,0,0]),lights:falloff?[light]:[]}}}}],
  buffers:[{byteLength:offset,uri:'data:application/octet-stream;base64,'+Buffer.concat(arrays).toString('base64')}],bufferViews,
  accessors:arrays.map((_,i)=>({bufferView:i,componentType:5126,count:6,type:i===3||i===4?'VEC4':i===2?'VEC2':'VEC3',...i===0?{min:[-2,-2,-2],max:[2,2,-2]}:{}})),
  meshes:[{primitives:[{attributes:{POSITION:0,NORMAL:1,TEXCOORD_0:2,TEXCOORD_1:2,TANGENT:3,...transition?{COLOR_0:4}:{}},material:0}]}],
  materials:[{name:'Source texture probe',pbrMetallicRoughness:{baseColorFactor:animation||simple?[1,1,1,1]:reflection||specularFalloff?[0,0,0,1]:[.25,.125,.0625,1],...animation?{baseColorTexture:{index:8}}:simple?{baseColorTexture:{index:10}}:mode==='phong-base-mask'||reflection||detail?{baseColorTexture:{index:4}}:{}},normalTexture:{index:0},...cutout||simple?{alphaMode:'MASK',alphaCutoff:(simple||animation)? .5:.7}:{},extras}],
  samplers:[{magFilter:9728,minFilter:9728,wrapS:33071,wrapT:33071}],textures:Array.from({length:14},(_,source)=>({source,sampler:0})),images:[{uri:data(frame?[128,230,204,255]:mode==='bump-tilted'?[238,128,201,255]:mode==='sideways'?[255,128,128,255]:mode==='phong-exponent'?[204,128,230,255]:[128,128,255,mode==='phong-masked'?0:255])},{uri:data([128,128,128,255])},{uri:data([0,0,0,255])},{uri:data([0,128,0,255])},{uri:data([255,255,255,128])},{uri:data([255,255,255,255])},{uri:data([128,128,128,mode.includes('clear')?0:255])},{uri:data([255,255,255,255])},{uri:data([255,0,0,64])},{uri:data([0,255,0,192])},{uri:data([255,0,0,0,0,255,0,128,0,0,255,255],3)},{uri:data([48,0,0,255])},{uri:data([0,48,0,255])},{uri:data([0,0,48,255])}]};
 if(mode==='phong-skinned-falloff'){
  const append=(array,type,componentType,count)=>{const buffer=Buffer.from(array.buffer,array.byteOffset,array.byteLength),view=result.bufferViews.length;result.bufferViews.push({buffer:0,byteOffset:offset,byteLength:buffer.length});arrays.push(buffer);offset+=buffer.length;const accessor=result.accessors.length;result.accessors.push({bufferView:view,componentType,count,type});return accessor};
  const attrs=result.meshes[0].primitives[0].attributes,weights=new Float32Array(24);for(let i=0;i<6;i++)weights[i*4]=1;
  attrs.JOINTS_0=append(new Uint16Array(24),'VEC4',5123,6);attrs.WEIGHTS_0=append(weights,'VEC4',5126,6);
  const inverse=append(new Float32Array([1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1]),'MAT4',5126,1);
  result.nodes[0].skin=0;result.nodes.push({name:'falloff_joint',translation:[0,0,0]});result.scenes[0].nodes.push(1);result.skins=[{joints:[1],skeleton:1,inverseBindMatrices:inverse}];
  result.buffers[0]={byteLength:offset,uri:'data:application/octet-stream;base64,'+Buffer.concat(arrays).toString('base64')};
 }
 return result;
}

module.exports={fixture,png};
