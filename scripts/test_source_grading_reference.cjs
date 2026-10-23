/** Complete LUT bytes and falloff against noclip's actual color-correction classes. */
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),{buildSync,transformSync}=require('esbuild');
const root=process.env.NOCLIP_REFERENCE||path.resolve('../noclip.website');
const {vec3}=require(path.join(root,'node_modules/gl-matrix'));
function moduleFrom(code,globals={}) {
 const module={exports:{}};new Function('module',...Object.keys(globals),transformSync(code,{loader:'ts',format:'cjs'}).code)(module,...Object.values(globals));return module.exports;
}
const ownModule={exports:{}};
new Function('module',buildSync({entryPoints:['src/render/source-grading.ts'],bundle:true,platform:'node',format:'cjs',write:false}).outputFiles[0].text)(ownModule);
const {sourceColorCorrectionLut,sourceColorWeight}=ownModule.exports;
const source=fs.readFileSync(path.join(root,'src/SourceEngine/Main.ts'),'utf8');
const start=source.indexOf('export class SourceColorCorrection {'),end=source.indexOf('\nclass DebugStatistics',start);assert.ok(start>0&&end>start);
const enums=new Proxy({},{get:(_,name)=>name});
const {SourceColorCorrection}=moduleFrom(source.slice(start,end),{assert:assert.ok,arrayRemove:(a,v)=>a.splice(a.indexOf(v),1),GfxTextureDimension:enums,GfxFormat:enums,GfxTextureUsage:enums,GfxWrapMode:enums,GfxTexFilterMode:enums,GfxMipFilterMode:enums});
const tables=['nt_dawn_ctg','nt_dusk_ctg','nt_saitama_ctg'].map(id=>new Uint8Array(fs.readFileSync(`public/assets/maps/${id}/source-color-0.rgb`)));
let checks=0;
for(const weights of [[],[0],[1],[.003],[.047],[.5],[.2,.3],[.8,.8],[.2,.3,.4],[1,0,0]]) {
 let expected;
 const device={createTexture:()=>({}),setResourceName(){},uploadTextureData:(_t,_l,data)=>expected=data[0].slice()};
 const native=new SourceColorCorrection(device,{createSampler:()=>({})});
 const layers=tables.slice(0,weights.length);
 layers.forEach((layer,i)=>{native.addLayer(layer);native.setLayerWeight(layer,weights[i]);});native.prepareToRender(device);
 const storage=new Uint8Array(32*32*32*4);storage.fill(77);
 const actual=sourceColorCorrectionLut(layers,weights,storage);assert.equal(actual,storage);let different=0;
 for(let i=0;i<actual.length;i++)different+=actual[i]!==expected[i];
 assert.equal(different,0,`Full native LUT differs for weights ${weights}`);checks++;
}
const entities=fs.readFileSync(path.join(root,'src/SourceEngine/EntitySystem.ts'),'utf8');
const a=entities.indexOf('    private calcWeight(',entities.indexOf('class color_correction extends'));
const b=entities.indexOf('    private updateWeight(',a);assert.ok(a>0&&b>a);
const functionSource=entities.slice(a,b).replace('private calcWeight(renderContext: SourceRenderContext): number','function calcWeight(renderContext: any)');
const calcWeight=new Function('vec3','scratchVec3a','saturate','invlerp',transformSync(functionSource,{loader:'ts'}).code+';return calcWeight;')(vec3,vec3.create(),x=>Math.max(0,Math.min(1,x)),(a,b,v)=>(v-a)/(b-a));
let weightChecks=0;
for(const enabled of [false,true])for(const [min,max] of [[-1,-1],[0,50000],[20,100],[100,20],[0,0]])for(const eye of [[120,64,32],[200,128,128],[90000,50000,100]]) {
 const origin=[120,64,32],scale=.0254;
 const native=calcWeight.call({enabled,weightOverride:-1,minfalloff:min,maxfalloff:max,getAbsOrigin:out=>vec3.copy(out,origin)},{currentView:{cameraPos:eye}});
 const ours=sourceColorWeight({enabled,minfalloff:min*scale,maxfalloff:max*scale,origin:origin.map(v=>v*scale)},{x:eye[0]*scale,y:eye[1]*scale,z:eye[2]*scale});
 assert.ok(Math.abs(native-ours)<1e-14,`Native distance weight differs: ${native} / ${ours}`);weightChecks++;
}
console.log(JSON.stringify({completeLutComparisons:checks,bytesPerLut:32*32*32*4,weightChecks,actualMapTables:tables.length,exact:true}));
