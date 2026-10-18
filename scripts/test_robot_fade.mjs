import { build } from 'esbuild';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
const directory=await mkdtemp(join(tmpdir(),'robot-fade-'));
try {
 const path=join(directory,'fade.mjs');
 await build({entryPoints:['src/render/robot-fade.ts'],outfile:path,bundle:true,format:'esm',platform:'node'});
 const {fadeOpacity,recordedRobotOpacity}=await import(path);
 assert.equal(fadeOpacity(1,0,0),1);assert.equal(fadeOpacity(1,0,.125),.5);assert.equal(fadeOpacity(1,0,.25),0);
 assert.equal(fadeOpacity(0,1,.125),.5);assert.equal(fadeOpacity(0,1,1),1);
 const events=[{t:1,kind:'noclip',label:'Noclip on'},{t:2,kind:'noclip',label:'Noclip off'}];
 const initial={from:1,target:1,elapsed:0};
 assert.equal(recordedRobotOpacity(initial,events,0),1);assert.equal(recordedRobotOpacity(initial,events,1.125),.5);
 assert.equal(recordedRobotOpacity(initial,events,1.5),0);assert.equal(recordedRobotOpacity(initial,events,2.125),.5);
 assert.equal(recordedRobotOpacity(initial,events,3),1);
 assert.equal(recordedRobotOpacity(undefined,events,1.5),1,'Old takes retain original visibility');
 assert.equal(recordedRobotOpacity({from:1,target:0,elapsed:.125},[],0),.5,'Capture retains an in-progress fade');
 const reversed=[{t:0,kind:'noclip',label:'Noclip on'},{t:.125,kind:'noclip',label:'Noclip off'}];
 assert.equal(recordedRobotOpacity(initial,reversed,.125),.5);assert.equal(recordedRobotOpacity(initial,reversed,.25),.75);
 console.log('Fade endpoints, midpoint, reversal, recorded transitions and older takes passed.');
}finally{await rm(directory,{recursive:true,force:true});}
