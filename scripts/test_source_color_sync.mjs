/** Live canvas frames through Source's final color pass must not issue synchronous GL queries
 * (issue #117: a per-frame getParameter(SCISSOR_BOX) waited for the whole previous frame under
 * SwiftShader). A bound output target still restores the live GL scissor it found. */
import assert from 'node:assert/strict';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import buildFixture from './build-fixture.cjs';

const file = resolve('node_modules/.cache/source-color-sync-test.mjs');
await mkdir(resolve('node_modules/.cache'), { recursive: true });
try {
  await writeFile(file, (await buildFixture({ root: process.cwd(), source: "export * as THREE from 'three';export { SourceColor } from './src/render/source-color';",
    platform: 'node', format: 'es', externalPackages: true })).code);
  const { THREE, SourceColor } = await import(file);
  const SCISSOR_BOX = 0x0C10, SCISSOR_TEST = 0x0C11;
  const parameters = [], live = { box: [5, 6, 30, 20], test: true };
  const gl = {
    SCISSOR_BOX, SCISSOR_TEST,
    isContextLost: () => false,
    getParameter(name) { parameters.push(name); assert.equal(name, SCISSOR_BOX); return new Int32Array(live.box); },
    isEnabled(cap) { assert.equal(cap, SCISSOR_TEST); return live.test; },
  };
  let bound = null, draws = 0;
  const binds = [];
  const renderer = {
    autoClear: true, capabilities: { maxSamples: 4 },
    getContext: () => gl,
    getCurrentViewport: target => target.set(2, 3, 64, 48),
    getRenderTarget: () => bound, getActiveCubeFace: () => 0, getActiveMipmapLevel: () => 0,
    setRenderTarget(target) {
      bound = target;
      binds.push(target ? { viewport: target.viewport.toArray(), scissor: target.scissor.toArray(), scissorTest: target.scissorTest } : null);
    },
    render() {},
  };
  const post = new SourceColor(), linear = { value: 0 }, draw = () => { draws++; };

  // Live canvas frames: no GL query at all, and the canvas is rebound afterwards.
  for (let frame = 0; frame < 3; frame++) post.render(renderer, draw, linear);
  assert.equal(draws, 3);
  assert.deepEqual(parameters, [], 'canvas frames must not call getParameter');
  assert.equal(bound, null);
  assert.equal(binds.at(-1), null);
  assert.equal(linear.value, 0);

  // A bound output target is rebound with the live GL viewport/scissor, then keeps its own settings.
  const output = new THREE.WebGLRenderTarget(64, 48);
  output.viewport.set(1, 1, 10, 10); output.scissor.set(0, 0, 8, 8); output.scissorTest = false;
  bound = output; binds.length = 0;
  post.render(renderer, draw, linear);
  assert.deepEqual(parameters, [SCISSOR_BOX], 'an output target reads the live scissor once');
  assert.equal(bound, output);
  assert.deepEqual(binds.at(-1), { viewport: [2, 3, 64, 48], scissor: live.box, scissorTest: true });
  assert.deepEqual([output.viewport.toArray(), output.scissor.toArray(), output.scissorTest], [[1, 1, 10, 10], [0, 0, 8, 8], false]);
  post.dispose(); output.dispose();
  console.log(JSON.stringify({ canvasFrames: 3, canvasQueries: 0, targetQueries: parameters.length }));
} finally { await rm(file, { force: true }); }
