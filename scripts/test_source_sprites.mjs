import {build}from'esbuild';import assert from'node:assert/strict';
const result=await build({entryPoints:['src/render/source-sprites.ts'],bundle:true,platform:'node',format:'esm',write:false});
const{sourceSpriteState}=await import('data:text/javascript;base64,'+Buffer.from(result.outputFiles[0].text).toString('base64'));
for(const units of [0,100,200,1200,2400,4800]){
  const world=sourceSpriteState(9,units*.0254),glow=sourceSpriteState(3,units*.0254);
  const fade=units>1200?(1200/units)**2:1;
  assert.ok(Math.abs(world.alpha-fade)<1e-12);assert.equal(world.scale,1);
  assert.equal(glow.alpha,world.alpha);assert.ok(Math.abs(glow.scale-units/200)<1e-12);
  assert.deepEqual(sourceSpriteState(2,units*.0254),{alpha:1,scale:1});
}
console.log('PASS: Source WorldGlow/Glow distance alpha, fixed/growing scale, and non-glow render modes');
