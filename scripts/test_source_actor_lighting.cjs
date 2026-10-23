/** Chrome/WebGL: native Source lights retain the physical response of actor finishes. */
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { build } = require('esbuild');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');

(async () => {
  const bundle = await build({
    stdin: { resolveDir: path.resolve(__dirname, '..'), sourcefile: 'actor-light-fixture.ts', contents: `
      import * as THREE from 'three';
      import { SourceAmbient } from './src/render/source-ambient.ts';
      const renderer = new THREE.WebGLRenderer({ antialias: false, preserveDrawingBuffer: true });
      renderer.setSize(96, 96); renderer.outputColorSpace = THREE.LinearSRGBColorSpace;
      renderer.toneMapping = THREE.NoToneMapping; document.body.append(renderer.domElement);
      const geometry = new THREE.PlaneGeometry(1, 1), camera = new THREE.OrthographicCamera(-.5, .5, .5, -.5, .1, 10);
      camera.position.set(0, 0, 4); camera.lookAt(0, 0, 0);
      const unit = .0254, pixel = new Uint8Array(4);
      function render(material, light) {
        const scene = new THREE.Scene(), mesh = new THREE.Mesh(geometry, material);
        scene.add(mesh); if (light) { scene.add(light); if (light.target) scene.add(light.target); }
        renderer.render(scene, camera);
        renderer.getContext().readPixels(48, 48, 1, 1, renderer.getContext().RGBA, renderer.getContext().UNSIGNED_BYTE, pixel);
        material.dispose(); return Array.from(pixel);
      }
      window.results = [];
      for (const test of [
        { name: 'metal-point', metalness: 1 },
        { name: 'paint-point', metalness: 0 },
        { name: 'clearcoat-point', metalness: 0, clearcoat: 1 },
        { name: 'rotated-metal-point', metalness: 1, yaw: 90, origin: [80, -20, 9], point: [1.2, .8, 2.54] },
        { name: 'metal-directional', metalness: 1, directional: true },
        { name: 'ambient-paint', metalness: 0, ambient: true },
        { name: 'non-source-control', metalness: 1, disabled: true },
      ]) {
        const point = test.point || [0, 0, 2.54], origin = test.origin || [0, 0, 0];
        const yaw = (test.yaw || 0) * Math.PI / 180;
        const position = [Math.cos(yaw) * point[0] / unit - Math.sin(yaw) * point[1] / unit + origin[0],
          Math.sin(yaw) * point[0] / unit + Math.cos(yaw) * point[1] / unit + origin[1], point[2] / unit + origin[2]];
        const ambient = new SourceAmbient(); ambient.enabled.value = test.disabled ? 0 : 1; ambient.linearOutput.value = 1;
        ambient.setData({ origin, yaw: test.yaw || 0, head: -1, nodes: [], leaves: [[[0, 0, 0, ...Array.from({ length: 6 }, () => test.ambient ? [.05, .1, .2] : [0, 0, 0]).flat()]]],
          lights: test.ambient ? [] : [{ pos: position, color: test.directional ? [1, 1, 1] : [10000, 10000, 10000],
            normal: [0, 0, -1], kind: test.directional ? 3 : 1, style: 0, inner: 0, outer: 0, exponent: 0,
            radius: 0, attenuation: [0, 0, 1], flags: 0 }] });
        ambient.sample(0, 0, 0);
        const makeMaterial = () => new THREE.MeshPhysicalMaterial({ color: 0xaaaaaa, metalness: test.metalness,
          roughness: .6, clearcoat: test.clearcoat || 0, clearcoatRoughness: .3 });
        function physicalLight() {
          if (test.ambient) return new THREE.AmbientLight(new THREE.Color(.05, .1, .2), Math.PI);
          if (test.directional) { const light = new THREE.DirectionalLight(0xffffff, Math.PI); light.position.set(0, 0, 2.54); return light; }
          const light = new THREE.PointLight(0xffffff, 10000 * Math.PI * unit * unit, 0, 2); light.position.fromArray(point); return light;
        }
        const material = makeMaterial(); ambient.patch(material);
        const actual = render(material, test.disabled ? physicalLight() : null);
        const reference = render(makeMaterial(), physicalLight());
        window.results.push({ name: test.name, actual, reference });
      }
      geometry.dispose(); renderer.dispose(); window.done = true;
    ` },
    bundle: true, format: 'iife', platform: 'browser', write: false,
  });
  const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  try {
    const page = await browser.newPage(), errors = [], consoleErrors = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => { if (message.type() === 'error') consoleErrors.push(message.text()); });
    await page.route('http://m0clip.test/', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><body><script src="/actor.js"></script>' }));
    await page.route('http://m0clip.test/actor.js', route => route.fulfill({ contentType: 'text/javascript', body: bundle.outputFiles[0].text }));
    await page.goto('http://m0clip.test/'); await page.waitForFunction(() => window.done);
    const results = await page.evaluate(() => window.results);
    if (process.env.QA_ARTIFACT_DIR) { fs.mkdirSync(process.env.QA_ARTIFACT_DIR, { recursive: true }); fs.writeFileSync(path.join(process.env.QA_ARTIFACT_DIR, 'physical-light-parity.json'), JSON.stringify({ results, errors, consoleErrors }, null, 2)); }
    assert.deepEqual(errors, []); assert.deepEqual(consoleErrors, []);
    console.log(JSON.stringify(results));
    for (const test of results) {
      for (let channel = 0; channel < 4; channel++) assert.ok(Math.abs(test.actual[channel] - test.reference[channel]) <= 2,
        `${test.name}: Source-lit actor ${test.actual} must match physical light ${test.reference}`);
    }
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
