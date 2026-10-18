/** Execute the local noclip lightmap accumulator/packer directly for asset verification. */
const fs=require('node:fs'),path=require('node:path'),{transformSync}=require('esbuild');
const root=process.env.NOCLIP_REFERENCE||path.resolve('../noclip.website');
const source=fs.readFileSync(path.join(root,'src/SourceEngine/Materials/Lightmap.ts'),'utf8');
const code=source.slice(source.indexOf('export function unpackColorRGBExp32('),source.indexOf('\nenum FaceLightmapUpdaterState'));
const js=transformSync(code,{loader:'ts',format:'cjs'}).code;
const moduleState={exports:{}};
const reference=new Function('module','exports','saturate','RGBM_SCALE',js+';return {lightmapAccumLight,lightmapPackRuntimeBumpmap};')(moduleState,moduleState.exports,v=>Math.max(0,Math.min(v,1)),6);
const cases=JSON.parse(fs.readFileSync(0,'utf8'));
const output=cases.map(c=>{
 const count=c.width*c.height,src=new Uint8Array(c.samples),accumulated=new Float32Array(count*4*3);
 for(let style=0;style<c.intensities.length;style++)reference.lightmapAccumLight(accumulated,0,src,style*count*4*4,count*4*4,c.intensities[style]);
 const page={page:{width:c.width,height:c.height},data:new Uint8Array(count*4*4)};
 reference.lightmapPackRuntimeBumpmap(page,{width:c.width,height:c.height,pagePosX:0,pagePosY:0},accumulated,0);
 return Array.from(page.data);
});
process.stdout.write(JSON.stringify(output));
