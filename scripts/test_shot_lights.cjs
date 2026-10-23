/** Chrome/WebGL float pixels: physical shot lights and real native Source factories.
 * Run after integration, separately from the immutable native-light regression. */
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { build } = require('esbuild');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const { png } = require('./source_material_fixture.cjs');

(async () => {
  const bundle = await build({
    stdin: { resolveDir: path.resolve(__dirname, '..'), sourcefile: 'shot-light-fixture.ts', contents: `
      import * as THREE from 'three';
      import { ShotLights } from './src/render/shot-lights.ts';
      import { SourceAmbient } from './src/render/source-ambient.ts';
      import { SourceFlashlight } from './src/render/source-flashlight.ts';
      import { RobotIllumination } from './src/render/robot-light.ts';
      import { sourceMaterial } from './src/render/source-lighting.ts';
      import { SourceMaterials, patchSourceMaterial } from './src/render/source-materials.ts';

      const size = 33, renderer = new THREE.WebGLRenderer({ antialias: false });
      renderer.setSize(size, size); renderer.outputColorSpace = THREE.LinearSRGBColorSpace;
      renderer.toneMapping = THREE.NoToneMapping; document.body.append(renderer.domElement);
      const gl = renderer.getContext();
      if (!gl.getExtension('EXT_color_buffer_float')) throw new Error('Float framebuffer support is required');
      const target = new THREE.WebGLRenderTarget(size, size, { type: THREE.FloatType,
        minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter });
      const pixel = new Float32Array(4), geometry = new THREE.PlaneGeometry(2, 2);
      geometry.setAttribute('uv1', geometry.getAttribute('uv').clone());
      const skinGeometry = geometry.clone();
      const skinIndices = new Uint16Array(skinGeometry.getAttribute('position').count * 4);
      const skinWeights = new Float32Array(skinIndices.length);
      for (let i = 0; i < skinWeights.length; i += 4) skinWeights[i] = 1;
      skinGeometry.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(skinIndices, 4));
      skinGeometry.setAttribute('skinWeight', new THREE.Float32BufferAttribute(skinWeights, 4));
      const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, .01, 30);
      const flashlight = new SourceFlashlight(), robot = new RobotIllumination();
      const origin = new THREE.Vector3(1.3, -.7, .8);
      const output = { physical: [], zero: [], native: [], finite: [], deformation: [], gpu: {} };

      function readAt(x, y) {
        renderer.readRenderTargetPixels(target, x, y, 1, 1, pixel);
        return Array.from(pixel);
      }
      function draw(material, lights = [], options = {}) {
        const scene = new THREE.Scene();
        const mesh = options.skinned ? new THREE.SkinnedMesh(skinGeometry, material) : new THREE.Mesh(geometry, material);
        mesh.position.copy(options.origin || origin);
        if (options.skinned) {
          const bone = new THREE.Bone(); mesh.add(bone); mesh.bind(new THREE.Skeleton([bone]));
          bone.position.z = options.boneZ || 0;
        }
        scene.add(mesh);
        for (const light of lights) { scene.add(light); if (light.target) scene.add(light.target); }
        camera.position.copy(mesh.position).add(options.rotated ? new THREE.Vector3(1.2, .6, 3) : new THREE.Vector3(0, 0, 3));
        camera.up.set(0, 1, 0); camera.lookAt(mesh.position); camera.updateMatrixWorld();
        renderer.setRenderTarget(target); renderer.clear(); renderer.render(scene, camera);
        if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) throw new Error('Incomplete float framebuffer');
        const samples = { center: readAt(16, 16), left: readAt(3, 16), right: readAt(29, 16) };
        const error = gl.getError();
        if (error !== gl.NO_ERROR) throw new Error('WebGL error ' + error);
        return samples;
      }
      function shot(overrides = {}) {
        return { id: 'key', name: 'Key', kind: 'point', enabled: true, color: 0xc4a080,
          intensity: .8, position: [origin.x + .2, origin.y + .1, origin.z + 1.5],
          target: origin.toArray(), range: 4, angle: 35, penumbra: .3, ...overrides };
      }
      // Independent reference: no shotLightObjects and no copied attenuation shader.
      function referenceLights(lights) {
        const result = [];
        for (const data of lights) {
          if (!data.enabled) continue;
          let light;
          if (data.kind === 'point') light = new THREE.PointLight(data.color, data.intensity, data.range, 2);
          else if (data.kind === 'spot') light = new THREE.SpotLight(data.color, data.intensity, data.range,
            data.angle * Math.PI / 180, data.penumbra, 2);
          else light = new THREE.DirectionalLight(data.color, data.intensity);
          light.position.fromArray(data.position);
          if (light.target) light.target.position.fromArray(data.target);
          result.push(light);
        }
        return result;
      }
      function patch(material, rig, ambient) {
        if (ambient) ambient.patch(material);
        flashlight.patch(material); robot.patch(material); rig.patch(material);
      }
      function physicalMaterial(finish) {
        return new THREE.MeshPhysicalMaterial({ color: 0x9a846e, metalness: finish === 'metal' ? 1 : 0,
          roughness: .42, clearcoat: finish === 'clearcoat' ? 1 : 0, clearcoatRoughness: .18 });
      }
      const cases = [];
      for (const kind of ['point', 'spot', 'directional']) for (const finish of ['paint', 'metal', 'clearcoat']) {
        cases.push({ name: kind + '-' + finish, finish, lights: [shot({ kind })] });
      }
      cases.push({ name: 'rotated-camera-world-position-metal', finish: 'metal', rotated: true, lights: [shot()] });
      cases.push({ name: 'unlimited-point-clearcoat', finish: 'clearcoat', lights: [shot({ range: 0 })] });
      cases.push({ name: 'outside-point-range', finish: 'paint', dark: true, lights: [shot({ range: .5 })] });
      for (const setting of [
        { name: 'inside-cone', aim: 10, penumbra: .5 },
        { name: 'penumbra', aim: 26, penumbra: .5 },
        { name: 'outside-cone', aim: 45, penumbra: .5, dark: true },
        { name: 'hard-inside', aim: 20, penumbra: 0 },
        { name: 'hard-outside', aim: 45, penumbra: 0, dark: true },
        { name: 'full-penumbra-axis', aim: 0, penumbra: 1 },
        { name: 'full-penumbra-edge', aim: 24, penumbra: 1 },
      ]) {
        cases.push({ name: 'spot-' + setting.name, finish: 'paint', dark: setting.dark,
          lights: [shot({ kind: 'spot', position: [origin.x, origin.y, origin.z + 1.5],
            target: [origin.x + 1.5 * Math.tan(setting.aim * Math.PI / 180), origin.y, origin.z],
            penumbra: setting.penumbra })] });
      }
      cases.push({ name: 'disabled', finish: 'clearcoat', dark: true, lights: [shot({ enabled: false })] });
      cases.push({ name: 'zero', finish: 'metal', dark: true, lights: [] });
      const eight = Array.from({ length: 8 }, (_, i) => shot({ id: 'light-' + i, name: 'Light ' + i,
        intensity: .1, position: [origin.x + (i - 3.5) * .08, origin.y, origin.z + 1.4] }));
      cases.push({ name: 'all-eight-slots', finish: 'clearcoat', lights: eight });
      cases.push({ name: 'skinned-head-position', finish: 'metal', skinned: true, boneZ: .4, lights: [shot()] });
      for (const test of cases) {
        const exposure = { value: 1 }, rig = new ShotLights(exposure), ambient = new SourceAmbient();
        ambient.enabled.value = 1; ambient.linearOutput.value = 1;
        const material = physicalMaterial(test.finish); patch(material, rig, ambient); rig.set(test.lights);
        const actual = draw(material, [], test), reference = draw(physicalMaterial(test.finish), referenceLights(test.lights), test);
        output.physical.push({ name: test.name, actual, reference, dark: !!test.dark });
        if (test.name === 'all-eight-slots') {
          const program = renderer.properties.get(material).currentProgram.program;
          output.gpu.eighthRadianceActive = gl.getUniformLocation(program, 'shotLights[7].radiance') !== null;
          output.gpu.eighthPositionActive = gl.getUniformLocation(program, 'shotLights[7].position') !== null;
          output.gpu.activeCount = gl.getUniform(program, gl.getUniformLocation(program, 'shotLightCount'));
          rig.set(test.lights.slice(0, 7));
          const seven = draw(material);
          output.gpu.seven = seven.center; output.gpu.eight = actual.center;
          rig.count.value = 0; const temporarilyOff = draw(material);
          rig.count.value = 7; const restored = draw(material);
          output.zero.push({ name: 'sky-count-zero', actual: temporarilyOff, reference: draw(physicalMaterial(test.finish)) });
          output.zero.push({ name: 'sky-count-restored', actual: restored, reference: seven });
        }
        material.dispose();
      }
      // Exercise the exact emitter/hard-edge cases using float pixels: byte
      // readback would silently turn a NaN into zero and miss the failure.
      const finiteOrigin = new THREE.Vector3();
      for (const data of [shot({ position: [0, 0, 0], range: 0 }),
        shot({ kind: 'spot', position: [0, 0, 0], target: [0, 0, -1], penumbra: 0 }),
        shot({ kind: 'spot', position: [0, 0, 1.5],
          target: [1.5 * Math.tan(35 * Math.PI / 180), 0, 0], penumbra: 0 })]) {
        const material = physicalMaterial('clearcoat'), rig = new ShotLights({ value: 1 });
        patch(material, rig); rig.set([data]);
        output.finite.push({ name: data.kind + '-' + output.finite.length, pixels: draw(material, [], { origin: finiteOrigin }) });
      }
      // Keep a nonzero authored Source cache active while adding shot lights.
      {
        const ambient = new SourceAmbient(); ambient.enabled.value = 1; ambient.linearOutput.value = 1;
        const unit = .0254;
        ambient.setData({ origin: [0, 0, 0], yaw: 0, head: -1, nodes: [], leaves: [], lights: [{
          pos: [origin.x / unit, origin.y / unit, (origin.z + 1.5) / unit], color: [300, 200, 100],
          normal: [0, 0, -1], kind: 1, style: 0, inner: 0, outer: 0, exponent: 0,
          radius: 0, attenuation: [0, 0, 1], flags: 0 }] });
        ambient.sample(origin.x, origin.y, origin.z);
        const material = physicalMaterial('metal'), rig = new ShotLights(ambient.exposure);
        patch(material, rig, ambient); rig.set([shot()]);
        const authored = new THREE.PointLight(new THREE.Color(300, 200, 100), Math.PI * unit * unit, 0, 2);
        authored.position.set(origin.x, origin.y, origin.z + 1.5);
        output.physical.push({ name: 'authored-cache-plus-shot', actual: draw(material),
          reference: draw(physicalMaterial('metal'), [...referenceLights([shot()]), authored]) });
      }
      function texture(r, g, b, a = 1) {
        const value = new THREE.DataTexture(new Float32Array([r, g, b, a]), 1, 1, THREE.RGBAFormat, THREE.FloatType);
        value.colorSpace = THREE.LinearSRGBColorSpace; value.needsUpdate = true; return value;
      }
      function nativeMaterial(mode, exposure) {
        const original = new THREE.MeshStandardMaterial({ color: 0xffffff,
          map: texture(.35, .2, .1, mode === 'selfillum-partial' ? .5 : 1) });
        const material = sourceMaterial(original, texture(.015, .015, .015), exposure, { value: 1 });
        if (mode !== 'basic-fallback') {
          original.userData.sourceMaterial = { unlit: mode === 'unlit', phong: mode.startsWith('phong'),
            selfillum: mode.startsWith('selfillum'), envmap: '', phongfresnelranges: [1, 1, 1],
            phongexponent: 8, phongboost: .4, phongtint: [1, 1, 1], selfillumtint: [1, 1, 1] };
          const normal = mode === 'bump-sideways' ? texture(1, .5, .5) : texture(.5, .5, 1, mode === 'phong-masked' ? 0 : 1);
          patchSourceMaterial(material, original, { normal }, undefined, undefined, undefined, 0, false, new SourceMaterials());
        }
        return material;
      }
      const localLight = shot({ color: 0xffffff, intensity: .08,
        position: [origin.x, origin.y, origin.z + .25], range: .55 });
      for (const mode of ['basic-fallback', 'native-flat', 'bump-sideways', 'phong', 'phong-masked',
        'selfillum-full', 'selfillum-partial', 'unlit']) {
        const exposure = { value: 1 }, material = nativeMaterial(mode, exposure), rig = new ShotLights(exposure);
        const baseline = draw(nativeMaterial(mode, exposure));
        patch(material, rig); const off = draw(material);
        rig.set([localLight]); const on = draw(material);
        rig.set([shot({ ...localLight, enabled: false })]); const disabled = draw(material);
        output.zero.push({ name: mode + '-zero', actual: off, reference: baseline });
        output.zero.push({ name: mode + '-disabled', actual: disabled, reference: baseline });
        output.native.push({ name: mode, off, on });
        output.finite.push({ name: 'native-' + mode, pixels: on });
      }
      // Exposure and the deformation varyings are observed on real native material
      // instances, not shader strings or undeformed stand-in geometry.
      for (const mode of ['basic-fallback', 'native-flat', 'phong']) {
        const exposure = { value: 1 }, material = nativeMaterial(mode, exposure), rig = new ShotLights(exposure);
        patch(material, rig); rig.set([shot({ color: 0xffffff, intensity: .1,
          position: [origin.x, origin.y, origin.z + 1], range: 0 })]);
        const base = draw(material, [], { skinned: true, boneZ: 0 });
        const moved = draw(material, [], { skinned: true, boneZ: .5 });
        rig.count.value = 0;
        const baseOff = draw(material, [], { skinned: true, boneZ: 0 });
        const movedOff = draw(material, [], { skinned: true, boneZ: .5 });
        rig.count.value = 1; exposure.value = 1.7;
        const exposed = draw(material, [], { skinned: true, boneZ: 0 });
        output.deformation.push({ name: mode, base, moved, baseOff, movedOff, exposed });
      }
      renderer.setRenderTarget(null); target.dispose(); geometry.dispose(); skinGeometry.dispose();
      renderer.dispose(); window.results = output; window.done = true;
    ` },
    bundle: true, format: 'iife', platform: 'browser', write: false,
  });
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome', headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  try {
    const page = await browser.newPage(), errors = [], consoleErrors = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => { if (message.type() === 'error') consoleErrors.push(message.text()); });
    await page.route('http://m0clip.test/', route => route.fulfill({ contentType: 'text/html',
      body: '<!doctype html><body><script src="/shot.js"></script>' }));
    await page.route('http://m0clip.test/shot.js', route => route.fulfill({ contentType: 'text/javascript', body: bundle.outputFiles[0].text }));
    await page.route('http://m0clip.test/assets/source/flashlight.png', route => route.fulfill({ contentType: 'image/png', body: png([255, 255, 255, 255]) }));
    await page.goto('http://m0clip.test/');
    await page.waitForFunction(() => window.done, null, { timeout: 60000 });
    const results = await page.evaluate(() => window.results);
    if (process.env.QA_ARTIFACT_DIR) {
      fs.mkdirSync(process.env.QA_ARTIFACT_DIR, { recursive: true });
      fs.writeFileSync(path.join(process.env.QA_ARTIFACT_DIR, 'shot-light-gpu.json'), JSON.stringify({ results, errors, consoleErrors }, null, 2));
    }
    assert.deepEqual(errors, []); assert.deepEqual(consoleErrors, []);
    const near = (actual, expected, name) => assert.ok(Number.isFinite(actual) && Number.isFinite(expected)
      && Math.abs(actual - expected) <= .0001 + Math.abs(expected) * .001, name + ': ' + actual + ' vs ' + expected);
    for (const row of results.physical) {
      for (const sample of ['center', 'left', 'right']) for (let channel = 0; channel < 4; channel++) {
        near(row.actual[sample][channel], row.reference[sample][channel], row.name + '/' + sample + '/' + channel);
      }
      if (row.dark) assert.ok(row.actual.center.slice(0, 3).every(value => Math.abs(value) < 1e-7), row.name + ' must be dark');
      else assert.ok(row.actual.center.slice(0, 3).some(value => value > .0001), row.name + ' must contribute visible radiance');
    }
    for (const row of results.zero) assert.deepEqual(row.actual, row.reference, row.name + ' must be an exact no-op');
    for (const row of results.finite) for (const values of Object.values(row.pixels)) {
      assert.ok(values.every(Number.isFinite), row.name + ' must retain finite float pixels');
    }
    assert.equal(results.gpu.eighthRadianceActive, true); assert.equal(results.gpu.eighthPositionActive, true);
    assert.equal(results.gpu.activeCount, 8);
    assert.ok(results.gpu.eight[0] > results.gpu.seven[0], 'eighth light must affect actual GPU output');
    const native = Object.fromEntries(results.native.map(row => [row.name, row]));
    for (const mode of ['basic-fallback', 'native-flat', 'phong', 'phong-masked', 'selfillum-partial']) {
      assert.ok(native[mode].on.center[0] > native[mode].off.center[0] + .001, mode + ' must actually relight');
      assert.deepEqual(native[mode].on.left, native[mode].off.left, mode + ' left outside range must remain unchanged');
      assert.deepEqual(native[mode].on.right, native[mode].off.right, mode + ' right outside range must remain unchanged');
    }
    assert.deepEqual(native.unlit.on, native.unlit.off, 'unlit must reject added diffuse');
    // GLSL mix(x, y, 1) can round by one float32 ULP when the diffuse operand changes.
    for (const sample of ['center', 'left', 'right']) for (let channel = 0; channel < 4; channel++)
      assert.ok(Math.abs(native['selfillum-full'].on[sample][channel] - native['selfillum-full'].off[sample][channel]) < 1e-7,
        'full selfillum must reject added diffuse within float32 rounding');
    for (let channel = 0; channel < 3; channel++) near(native['bump-sideways'].on.center[channel],
      native['bump-sideways'].off.center[channel], 'sideways bump must reject frontal light');
    assert.ok(native.phong.on.center[0] > native['native-flat'].on.center[0] + .001, 'native Phong must add real specular');
    near(native['phong-masked'].on.center[0], native['native-flat'].on.center[0], 'authored bump-alpha Phong mask');
    for (let channel = 0; channel < 3; channel++) {
      const diffuse = native['native-flat'].on.center[channel] - native['native-flat'].off.center[channel];
      const partial = native['selfillum-partial'].on.center[channel] - native['selfillum-partial'].off.center[channel];
      near(partial, diffuse * .5, 'selfillum mask must attenuate the added diffuse');
    }
    for (const row of results.deformation) for (let channel = 0; channel < 3; channel++) {
      const base = row.base.center[channel] - row.baseOff.center[channel];
      const moved = row.moved.center[channel] - row.movedOff.center[channel];
      assert.ok(base > .0001, row.name + ' bind-pose light must contribute');
      near(moved, base * 4, row.name + ' skinned position inverse-square response');
      near(row.exposed.center[channel], row.base.center[channel] * 1.7, row.name + ' single exposure application');
    }
    console.log(JSON.stringify({ physicalCases: results.physical.length, exactZeroCases: results.zero.length,
      nativeCases: results.native.length, finiteCases: results.finite.length, deformationCases: results.deformation.length, gpu: results.gpu }));
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
