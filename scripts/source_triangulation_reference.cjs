/** Execute noclip's actual static-face index builder, including authored primitives. */
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {transformSync}=require('esbuild');
const root=process.env.NOCLIP_REFERENCE||path.resolve('../noclip.website');
const topology=fs.readFileSync(path.join(root,'src/gfx/helpers/TopologyHelpers.ts'),'utf8').replace(/^import .*;$/mg,'');
const nativeModule={exports:{}};
new Function('module','assert',transformSync(topology,{loader:'ts',format:'cjs'}).code)(nativeModule,assert.ok);
const exportsObject=nativeModule.exports;
const source=fs.readFileSync(path.join(root,'src/SourceEngine/BSPFile.ts'),'utf8');
const start=source.indexOf('                indexCount = getTriangleIndexCountForTopologyIndexCount(GfxTopology.TriFans, numedges);');
const end=source.indexOf('                vertexCount = numedges;',start);
assert.ok(start>=0&&end>start,'Native static index builder must match');
const code=source.slice(start,end).replace('continue;','return null;');
const build=new Function('numedges','m_NumPrims','firstPrimID','primitives','primindices','GfxTopology','convertToTrianglesRange','getTriangleIndexCountForTopologyIndexCount','assert',
    'let indexCount;const dstOffsIndex=0,dstIndexBase=0,indexBuffer={addUint32:n=>new Uint32Array(n)};'+code+';return Array.from(indexData);');
const input=JSON.parse(fs.readFileSync(0,'utf8'));
const output=input.map(group=>{
    const raw=Buffer.from(group.primitives,'base64'),primitives=new DataView(raw.buffer,raw.byteOffset,raw.byteLength);
    const indices=Buffer.from(group.indices,'base64'),primindices=new Uint16Array(indices.buffer,indices.byteOffset,indices.byteLength/2);
    return group.faces.map(([numedges,count,first])=>build.call({version:group.version},numedges,count&0x7fff,first,primitives,primindices,exportsObject.GfxTopology,exportsObject.convertToTrianglesRange,exportsObject.getTriangleIndexCountForTopologyIndexCount,assert.ok));
});
process.stdout.write(JSON.stringify(output));
