/** Run the local noclip BSP vertex builder directly as an independent numerical reference. */
const fs=require('node:fs'),path=require('node:path'),{transformSync}=require('esbuild');
const root=process.env.NOCLIP_REFERENCE||path.resolve('../noclip.website');
const {vec3,vec2}=require(path.join(root,'node_modules/gl-matrix'));
const source=fs.readFileSync(path.join(root,'src/SourceEngine/BSPFile.ts'),'utf8');
const section=(start,end)=>source.slice(source.indexOf(start),source.indexOf(end,source.indexOf(start)));
const code=section('const VERTEX_SIZE =','function calcTexCoord(')
 +section('function calcTexCoord(','function packVertexInBuffer(')
 +section('function packVertexInBuffer(','function fetchVertexFromBuffer(')
 +section('function buildDisplacement(','\n//#endregion\n\n//#region Overlays');
const js=transformSync(code,{loader:'ts',format:'cjs'}).code;
class AABB{unionPoint(){}}
const reference=new Function('vec3','vec2','AABB','saturate','scratchVec3a','nArray',js+';return {MeshVertex,buildDisplacement,packVertexInBuffer};')(vec3,vec2,AABB,v=>Math.max(0,Math.min(v,1)),vec3.create(),(length,fn)=>Array.from({length},(_,i)=>fn(i)));
const cases=JSON.parse(fs.readFileSync(0,'utf8'));
const output=cases.map(c=>{
 let vertices;
 if(c.disp){
  const info={sideLength:c.side,vertexCount:c.side*c.side,dispVertStart:0};
  vertices=reference.buildDisplacement(info,c.corners,new Float32Array(c.disp),{s:[1,0,0,0],t:[0,1,0,0]}).vertex;
 }else vertices=c.normals.map(n=>{const v=new reference.MeshVertex();vec3.copy(v.normal,n);return v});
 return vertices.map(v=>{const packed=new Float32Array(15);reference.packVertexInBuffer(packed,0,v,c.t,c.sign);return Array.from(packed.slice(3,11))});
});
process.stdout.write(JSON.stringify(output));
