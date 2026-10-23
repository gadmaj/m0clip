/** Native compilation retains shared/include assets and excludes unrelated variants. */
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,unlink,rm,stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';

const project=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const directory=await mkdtemp(resolve(tmpdir(),'m0clip-model-index-'));
const tool=resolve(project,'scripts/index_model_assets.mjs');
function tetrahedron(){
  const vertices=[[0,0,0],[1,0,0],[0,1,0],[0,0,1]],faces=[[0,2,1],[0,1,3],[0,3,2],[1,2,3]];
  const bytes=Buffer.alloc(84+faces.length*50);bytes.writeUInt32LE(faces.length,80);
  for(let i=0;i<faces.length;i++)for(let v=0;v<3;v++)for(let c=0;c<3;c++)bytes.writeFloatLE(vertices[faces[i][v]][c],84+i*50+12+v*12+c*4);
  return bytes;
}
function generate(scene){return spawnSync(process.execPath,[tool,directory,scene],{cwd:project,encoding:'utf8',timeout:60000})}
try{
  await mkdir(resolve(directory,'parts'));await mkdir(resolve(directory,'meshes'));
  const xml={
    'scene.xml':'<mujoco><include file="parts/first.xml"/></mujoco>',
    'other_scene.xml':'<mujoco><include file="parts/other.xml"/></mujoco>',
    'parts/first.xml':'<mujoco><compiler meshdir="meshes"/><include file="parts/shared.xml"/><asset><mesh name="first" file="first.stl"/></asset><worldbody><geom type="mesh" mesh="first" pos="2 0 0"/></worldbody></mujoco>',
    'parts/other.xml':'<mujoco><compiler meshdir="meshes"/><include file="parts/shared.xml"/><asset><mesh name="other" file="other.stl"/></asset><worldbody><geom type="mesh" mesh="other" pos="-2 0 0"/></worldbody></mujoco>',
    'parts/shared.xml':'<mujoco><asset><mesh name="shared" file="shared.stl"/></asset><worldbody><geom type="mesh" mesh="shared"/></worldbody></mujoco>',
  };
  for(const [name,body] of Object.entries(xml))await writeFile(resolve(directory,name),body);
  for(const name of ['first','other','shared'])await writeFile(resolve(directory,'meshes',name+'.stl'),tetrahedron());
  await writeFile(resolve(directory,'unused.payload'),'Not part of either compiled scene.');
  const files=[...Object.keys(xml),'meshes/first.stl','meshes/other.stl','meshes/shared.stl','unused.payload'];
  await writeFile(resolve(directory,'manifest.json'),JSON.stringify({files}));
  const expected={
    'scene.xml':['scene.xml','parts/first.xml','parts/shared.xml','meshes/first.stl','meshes/shared.stl'],
    'other_scene.xml':['other_scene.xml','parts/other.xml','parts/shared.xml','meshes/other.stl','meshes/shared.stl'],
  };
  for(const [scene,required] of Object.entries(expected)){
    const result=generate(scene);assert.equal(result.status,0,result.stderr);
    const indexed=JSON.parse(await readFile(resolve(directory,scene+'.manifest.json'),'utf8'));
    assert.deepEqual(new Set(indexed.files),new Set(required),'A scene lost a native dependency or included an unrelated variant');
  }
  const index=resolve(directory,'scene.xml.manifest.json'),previous=await readFile(index);
  await unlink(resolve(directory,'meshes/first.stl'));
  const failed=generate('scene.xml');assert.notEqual(failed.status,0,'Missing source asset must stop regeneration');
  assert.deepEqual(await readFile(index),previous,'Failed regeneration replaced the usable asset index');
  await assert.rejects(stat(index+'.tmp'),{code:'ENOENT'});
  console.log('Native scene dependency closure, shared/nested includes and failed-index preservation PASS');
}finally{await rm(directory,{recursive:true,force:true})}
