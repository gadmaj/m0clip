#!/usr/bin/env node
/** Index one MJCF entry using the real compiler's file reads, not a second XML resolver. */
import {readFileSync,statSync,writeFileSync,renameSync,unlinkSync} from 'node:fs';
import {dirname,resolve,posix} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';

const [bundleArg,scene='scene.xml',...extra]=process.argv.slice(2);
if(!bundleArg||extra.length)throw Error('Usage: node scripts/index_model_assets.mjs <bundle-directory> [scene.xml]');
const bundle=resolve(bundleArg),project=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const catalog=JSON.parse(readFileSync(resolve(bundle,'manifest.json'),'utf8'));
if(!catalog.files.includes(scene))throw Error(`Scene is not in the bundle catalog: ${scene}`);
const wasm=resolve(project,'public/wasm');
const factory=(await import(pathToFileURL(resolve(wasm,'mujoco.js')).href)).default;
// One entry per process gives the compiler a fresh native asset cache. An index
// must not omit files merely because another model already populated that cache.
const mj=await factory({locateFile:p=>p.endsWith('.wasm')?resolve(wasm,p):p});
const mount='/work';
function directories(path){
  let current='';
  for(const part of path.split('/').filter(Boolean)){
    current+='/'+part;try{mj.FS.mkdir(current)}catch{/* already mounted */}
  }
}
directories(mount);
for(const relative of catalog.files){
  const target=posix.join(mount,relative);directories(posix.dirname(target));
  let body=readFileSync(resolve(bundle,relative));
  if(relative.endsWith('.xml')){
    // Match Engine.create's single-threaded model compilation. Source files on
    // disk remain unchanged; native includes, compiler dirs and assets resolve normally.
    let xml=body.toString('utf8');
    xml=xml.includes('<compiler ')
      ?xml.replace(/<compiler /g,'<compiler usethread="false" ')
      :xml.replace(/(<mujoco[^>]*>)/,'$1\n  <compiler usethread="false"/>');
    body=xml;
  }
  mj.FS.writeFile(target,body);
}
const required=new Set(),open=mj.FS.open;
mj.FS.open=function(...args){
  const stream=open.apply(this,args),path=posix.normalize(stream.path);
  if(path.startsWith(mount+'/'))required.add(path.slice(mount.length+1));
  return stream;
};
let model,shape;
try{
  model=mj.MjModel.mj_loadXML(posix.join(mount,scene));
  shape={nq:model.nq,ngeom:model.ngeom,nmesh:model.nmesh};
}finally{
  mj.FS.open=open;model?.delete();
}
for(const relative of required)if(!catalog.files.includes(relative))throw Error(`Compiler read an uncatalogued asset: ${relative}`);
if(!required.has(scene))throw Error('Compiler dependency tracing did not observe the scene');
const files=catalog.files.filter(relative=>required.has(relative));
const output=resolve(bundle,scene+'.manifest.json'),temporary=output+'.tmp';
try{
  writeFileSync(temporary,JSON.stringify({files},null,2)+'\n');renameSync(temporary,output);
}finally{
  try{unlinkSync(temporary)}catch(error){if(error.code!=='ENOENT')throw error}
}
console.log(JSON.stringify({scene,files:files.length,bytes:files.reduce((sum,file)=>sum+statSync(resolve(bundle,file)).size,0),shape,output}));
