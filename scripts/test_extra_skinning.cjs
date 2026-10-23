/** Actual Chrome/WebGL + real GLTFLoader/GLTFExporter eight-influence regression.
 * Run once after integration: node scripts/test_extra_skinning.cjs
 * Uses one isolated Chrome, no app/server state and no suppressed warnings.
 */
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { build } = require('esbuild');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');

(async () => {
  const bundle = await build({
    stdin: { resolveDir: path.resolve(__dirname, '..'), sourcefile: 'extra-skin-fixture.ts', contents: `
      import * as THREE from 'three';
      import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
      import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js';
      import { clone } from 'three/examples/jsm/utils/SkeletonUtils.js';
      import { prepareExtraSkinning, extraSkinningWriter } from './src/render/extra-skin.ts';
      import { SourceFlashlight } from './src/render/source-flashlight.ts';
      import { SourceAmbient } from './src/render/source-ambient.ts';
      import { RobotIllumination } from './src/render/robot-light.ts';
      import { ShotLights } from './src/render/shot-lights.ts';
      const check = (ok, message) => { if (!ok) throw new Error(message); };
      const loader = new GLTFLoader(), exporter = new GLTFExporter();
      const result = { synthetic: {}, gingerbread: {} };
      const scene = new THREE.Scene(), bones = Array.from({length:8}, (_, i) => { const bone = new THREE.Bone(); bone.name = 'joint' + i; return bone; });
      bones.slice(1).forEach(bone => bones[0].add(bone));
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.Float32BufferAttribute([-.35,-.3,0, .35,-.3,0, 0,.4,0], 3));
      geometry.setAttribute('normal', new THREE.Float32BufferAttribute([0,0,1, 0,0,1, 0,0,1], 3));
      geometry.setAttribute('tangent', new THREE.Float32BufferAttribute([1,0,0,1, 1,0,0,1, 1,0,0,1], 4));
      geometry.setAttribute('uv', new THREE.Float32BufferAttribute([0,0, 1,0, .5,1], 2));
      geometry.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(new Uint16Array(12), 4));
      geometry.setAttribute('skinWeight', new THREE.Float32BufferAttribute(new Float32Array(12), 4));
      geometry.setAttribute('joints_1', new THREE.Uint16BufferAttribute([4,5,6,7, 4,5,6,7, 4,5,6,7], 4));
      geometry.setAttribute('weights_1', new THREE.Float32BufferAttribute([0,0,0,1, 0,0,0,1, 0,0,0,1], 4));
      const mesh = new THREE.SkinnedMesh(geometry, new THREE.MeshStandardMaterial());
      mesh.name = 'eighth-only'; mesh.add(bones[0]); scene.add(mesh); scene.updateMatrixWorld(true);
      mesh.bind(new THREE.Skeleton(bones));
      // Feed valid unit-total eight-weight GLB through the actual loader, which
      // replaces the zero first set with its first-four fallback before our hook.
      const input = await exporter.parseAsync(scene, {binary:true});
      const loaded = await loader.parseAsync(input, ''); prepareExtraSkinning(loaded.scene);
      let actual; loaded.scene.traverse(o => { if (o.isSkinnedMesh) actual = o; });
      check(actual.geometry.getAttribute('skinWeight').getX(0) === 0, 'Loader first-four fallback was not removed');
      const stable = Array.from(actual.geometry.getAttribute('skinWeight').array);
      prepareExtraSkinning(loaded.scene); prepareExtraSkinning(loaded.scene);
      check(JSON.stringify(stable) === JSON.stringify(Array.from(actual.geometry.getAttribute('skinWeight').array)), 'Preparation changed weights twice');
      actual.skeleton.bones[7].position.x = 1.1;
      actual.skeleton.bones[7].rotation.y = .65;
      loaded.scene.updateMatrixWorld(true); actual.skeleton.update();
      const point = actual.getVertexPosition(0, new THREE.Vector3());
      check(Math.abs(point.x - (-.35 * Math.cos(.65) + 1.1)) < 1e-5, 'CPU ignored eighth moving joint');
      actual.computeBoundingBox(); actual.computeBoundingSphere();
      check(actual.boundingBox.min.x > .8, 'Bounds ignored eighth joint');
      const hit = new THREE.Raycaster(new THREE.Vector3(1.1,0,3), new THREE.Vector3(0,0,-1)).intersectObject(actual);
      check(hit.length > 0, 'Raycast missed eighth-joint triangle');
      const cloned = clone(loaded.scene); let cloneMesh; cloned.traverse(o => { if (o.isSkinnedMesh) cloneMesh = o; });
      cloneMesh.material = new THREE.MeshNormalMaterial(); prepareExtraSkinning(cloned);
      cloned.updateMatrixWorld(true);
      check(cloneMesh.getVertexPosition(0, new THREE.Vector3()).distanceTo(point) < 1e-6, 'SkeletonUtils lost CPU hook');
      check(!!cloneMesh.customDepthMaterial && !!cloneMesh.customDistanceMaterial, 'SkeletonUtils lost shadow hooks');
      // A static CPU-baked triangle is the independent image reference. Position,
      // normal and tangent each use the known eighth bone's affine transform.
      const bakedGeometry = geometry.clone();
      for (const name of ['skinWeight', 'skinIndex', 'weights_1', 'joints_1']) bakedGeometry.deleteAttribute(name);
      const transform = new THREE.Matrix4().makeRotationY(.65); transform.setPosition(1.1,0,0);
      bakedGeometry.applyMatrix4(transform);
      const reference = new THREE.Mesh(bakedGeometry, new THREE.MeshNormalMaterial());
      const renderer = new THREE.WebGLRenderer({antialias:false, preserveDrawingBuffer:true});
      renderer.setSize(96,96); renderer.outputColorSpace = THREE.LinearSRGBColorSpace; renderer.toneMapping = THREE.NoToneMapping;
      const camera = new THREE.OrthographicCamera(-.65,.65,.65,-.65,.1,10); camera.position.set(1.1,0,3); camera.lookAt(1.1,0,0);
      const target = new THREE.WebGLRenderTarget(96,96), left = new Uint8Array(96*96*4), right = new Uint8Array(left.length);
      function image(object, pixels) { const view = new THREE.Scene(); view.add(object); renderer.setRenderTarget(target); renderer.render(view,camera); renderer.readRenderTargetPixels(target,0,0,96,96,pixels); renderer.setRenderTarget(null); }
      function compare(name) { let differing=0, maximum=0; for(let i=0;i<left.length;i++) { const delta=Math.abs(left[i]-right[i]); maximum=Math.max(maximum,delta); if(delta>2) differing++; } check(differing < 48, name + ' GPU mismatch: ' + differing + ' channels; max=' + maximum); result.synthetic[name]={differing,maximum}; }
      image(cloned,left); image(reference,right); compare('normal');
      const normalMap = new THREE.DataTexture(new Uint8Array([210,170,240,255]),1,1); normalMap.needsUpdate=true;
      cloneMesh.material = new THREE.MeshStandardMaterial({normalMap, roughness:1}); prepareExtraSkinning(cloned);
      reference.material = new THREE.MeshStandardMaterial({normalMap, roughness:1});
      const lightA = new THREE.DirectionalLight(0xffffff,3), lightB = lightA.clone(); lightA.position.set(0,0,3);lightB.position.copy(lightA.position);
      cloned.add(lightA, new THREE.AmbientLight(0xffffff,.3)); reference.add(lightB, new THREE.AmbientLight(0xffffff,.3));
      image(cloned,left); image(reference,right); compare('tangentNormalMap');
      cloneMesh.material = cloneMesh.customDepthMaterial; reference.material = new THREE.MeshDepthMaterial({depthPacking:THREE.RGBADepthPacking});
      image(cloned,left); image(reference,right); compare('depth');
      cloneMesh.material = cloneMesh.customDistanceMaterial; reference.material = new THREE.MeshDistanceMaterial();
      const distanceLight = new THREE.PointLight(); distanceLight.position.set(1.1,0,3); distanceLight.updateMatrixWorld(true);
      renderer.properties.get(cloneMesh.material).light = distanceLight;
      renderer.properties.get(reference.material).light = distanceLight;
      image(cloned,left); image(reference,right); compare('distance');
      cloneMesh.material = new THREE.MeshBasicMaterial(); reference.material = new THREE.MeshBasicMaterial(); prepareExtraSkinning(cloned);
      const flashlight = new SourceFlashlight(); await new Promise(resolve => THREE.DefaultLoadingManager.onLoad = resolve);
      const perspective = new THREE.PerspectiveCamera(90,1,.1,20); perspective.position.set(1.1,0,3); perspective.lookAt(1.1,0,0);
      const flashA = new THREE.Scene(), flashB = new THREE.Scene(); flashA.add(cloned); flashB.add(reference);
      const flashLeft = new Uint8Array(512*512*4), flashRight = new Uint8Array(flashLeft.length);
      flashlight.set(true); flashlight.renderDepth(renderer,flashA,perspective); renderer.readRenderTargetPixels(flashlight.target,0,0,512,512,flashLeft);
      flashlight.set(true); flashlight.renderDepth(renderer,flashB,perspective); renderer.readRenderTargetPixels(flashlight.target,0,0,512,512,flashRight);
      let flashMismatch=0; for(let i=0;i<flashLeft.length;i++) if(Math.abs(flashLeft[i]-flashRight[i])>2) flashMismatch++;
      check(flashMismatch<128, 'Source flashlight depth ignored extra influences: '+flashMismatch); result.synthetic.flashlightMismatch=flashMismatch;
      const writer = new GLTFExporter(); writer.register(extraSkinningWriter);
      const output = await writer.parseAsync(loaded.scene,{binary:true});
      const roundtrip = await loader.parseAsync(output,''); prepareExtraSkinning(roundtrip.scene);
      let roundMesh; roundtrip.scene.traverse(o => { if(o.isSkinnedMesh) roundMesh=o; });
      check(roundMesh.geometry.getAttribute('weights_1').getW(0) === 1, 'GLB lost eighth influence');
      check(roundMesh.geometry.getAttribute('skinWeight').getX(0) === 0, 'GLB reload skipped recovery after first-four normalization');
      const json = JSON.parse(new TextDecoder().decode(new Uint8Array(output,20,new DataView(output).getUint32(12,true))).trim());
      const attrs=json.meshes[0].primitives[0].attributes;
      check(attrs.JOINTS_1 !== undefined && attrs.WEIGHTS_1 !== undefined && !Object.keys(attrs).some(k=>k.startsWith('_')), 'GLB wrote custom instead of standard skin semantics');
      check(!JSON.stringify(json.meshes).includes('m0clipExtraSkinWeightsRecovered'), 'GLB leaked transient recovery state');
      result.synthetic.attributes=Object.keys(attrs); result.synthetic.cpu=point.toArray();
      // Different skin layouts must remain independent after every live actor shader hook.
      flashlight.set(false);
      for(const [name,side,eightFirst]of [
        ['mixedSourceEightFirst',THREE.FrontSide,true],
        ['mixedSourceFourFirst',THREE.DoubleSide,false],
      ]){
        const eight=clone(loaded.scene),four=clone(loaded.scene),ambient=new SourceAmbient();
        const illumination=new RobotIllumination(),shotLights=new ShotLights();
        for(const [root,extra]of [[eight,true],[four,false]]){
          root.traverse(object=>{
            if(!object.isSkinnedMesh)return;
            object.material=new THREE.MeshPhysicalMaterial({side});
            if(!extra){
              object.geometry=object.geometry.clone();
              object.geometry.deleteAttribute('joints_1');object.geometry.deleteAttribute('weights_1');
              const indices=object.geometry.getAttribute('skinIndex'),weights=object.geometry.getAttribute('skinWeight');
              for(let i=0;i<indices.count;i++){indices.setXYZW(i,7,0,0,0);weights.setXYZW(i,1,0,0,0);}
            }
          });
          prepareExtraSkinning(root);
          root.traverse(object=>{
            if(!object.isSkinnedMesh)return;
            ambient.patch(object.material);flashlight.patch(object.material);
            illumination.patch(object.material,true);shotLights.patch(object.material);
          });
          const light=new THREE.DirectionalLight(0xffffff,3);light.position.set(0,0,3);
          root.add(light,new THREE.AmbientLight(0xffffff,.3));
        }
        image(eightFirst?eight:four,left);image(eightFirst?four:eight,right);compare(name);
      }
      const gingerInput = await fetch('/gingerbread.glb').then(response=>response.arrayBuffer());
      const rawView=new DataView(gingerInput),rawJsonLength=rawView.getUint32(12,true);
      const rawJson=JSON.parse(new TextDecoder().decode(new Uint8Array(gingerInput,20,rawJsonLength)).trim());
      const rawBin=20+rawJsonLength+8;
      const gingerbread = await loader.parseAsync(gingerInput,''); prepareExtraSkinning(gingerbread.scene);
      let overFour=0, maximum=0, vertices=0,maxInputWeightError=0; const weightSnapshot=[];
      gingerbread.scene.traverse(o => { if(!o.isSkinnedMesh) return; const g=o.geometry,w0=g.getAttribute('skinWeight'),w1=g.getAttribute('weights_1');
        const association=gingerbread.parser.associations.get(o);
        const primitive=rawJson.meshes[association.meshes].primitives[association.primitives??0];
        for(let set=0;set<2;set++){
          const index=primitive.attributes['WEIGHTS_'+set];if(index===undefined)continue;
          const accessor=rawJson.accessors[index],view=rawJson.bufferViews[accessor.bufferView],actual=set?w1:w0;
          check(accessor.componentType===5126&&!!actual,'Missing authored float skin set');
          const offset=rawBin+(view.byteOffset??0)+(accessor.byteOffset??0),stride=view.byteStride??16;
          for(let i=0;i<accessor.count;i++)for(let c=0;c<4;c++)
            maxInputWeightError=Math.max(maxInputWeightError,Math.abs(actual.getComponent(i,c)-rawView.getFloat32(offset+i*stride+c*4,true)));
        }
        for(let i=0;i<w0.count;i++){ let total=0,active=0; const row=[]; for(const a of [w0,w1]) if(a) for(let c=0;c<4;c++){const w=a.getComponent(i,c);row.push(w);total+=w;if(w>0)active++;} check(Math.abs(total-1)<2e-6,'Gingerbread unit mass');if(active>4)overFour++;maximum=Math.max(maximum,active);vertices++;weightSnapshot.push(row); }
      });
      check(maxInputWeightError<2e-6,'Loader changed authored mixed-set weight ratios: '+maxInputWeightError);
      const gingerOutput = await writer.parseAsync(gingerbread.scene,{binary:true});
      const gingerAgain=await loader.parseAsync(gingerOutput,'');prepareExtraSkinning(gingerAgain.scene);
      let rowIndex=0, maxWeightError=0;
      gingerAgain.scene.traverse(o=>{if(!o.isSkinnedMesh)return;const w0=o.geometry.getAttribute('skinWeight'),w1=o.geometry.getAttribute('weights_1');for(let i=0;i<w0.count;i++){let c0=0;for(const a of [w0,w1])if(a)for(let c=0;c<4;c++)maxWeightError=Math.max(maxWeightError,Math.abs(a.getComponent(i,c)-weightSnapshot[rowIndex][c0++]));rowIndex++;}});
      check(rowIndex===weightSnapshot.length && maxWeightError<2e-6,'Gingerbread GLB roundtrip changed weights');
      result.gingerbread={overFour,maximum,vertices,maxInputWeightError,maxWeightError};
      renderer.dispose(); window.results=result; window.done=true;
    ` },
    bundle: true, format: 'esm', platform: 'browser', write: false,
  });
  const browser = await chromium.launch({ executablePath: process.env.CHROME_BIN || '/usr/bin/google-chrome', headless: true,
    args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  try {
    const page = await browser.newPage(), errors = [], diagnostics = [];
    page.on('pageerror', error => errors.push(error.stack??error.message));
    page.on('console', message => { if (['error', 'warning'].includes(message.type())) diagnostics.push(message.text()); });
    await page.route('http://m0clip.test/', route => route.fulfill({contentType:'text/html',body:'<!doctype html><script type="module" src="/fixture.js"></script>'}));
    await page.route('http://m0clip.test/fixture.js', route => route.fulfill({contentType:'text/javascript',body:bundle.outputFiles[0].text}));
    await page.route('http://m0clip.test/gingerbread.glb', route => route.fulfill({contentType:'model/gltf-binary',body:fs.readFileSync(path.resolve(__dirname,'../public/assets/characters/gingerbread-man/gingerbread-man-512.glb'))}));
    await page.route('http://m0clip.test/assets/source/flashlight.png', route => route.fulfill({contentType:'image/png',body:fs.readFileSync(path.resolve(__dirname,'../public/assets/source/flashlight.png'))}));
    await page.goto('http://m0clip.test/');
    if(errors.length)throw new Error(errors.join('\n'));
    await Promise.race([
      page.waitForFunction(() => window.done, undefined, {timeout:90000}),
      page.waitForEvent('pageerror').then(error=>{throw error;}),
    ]).catch(error=>{console.error(JSON.stringify({errors,diagnostics},null,2));throw error;});
    const results = await page.evaluate(() => window.results);
    assert.deepEqual(errors, []);
    assert.deepEqual(diagnostics.filter(message=>!/GL Driver Message.*GPU stall due to ReadPixels/.test(message)), []);
    const report={...results,diagnostics};
    if(process.env.QA_ARTIFACT_DIR) { fs.mkdirSync(process.env.QA_ARTIFACT_DIR,{recursive:true}); fs.writeFileSync(path.join(process.env.QA_ARTIFACT_DIR,'extra-skinning.json'), JSON.stringify(report,null,2)); }
    console.log(JSON.stringify(report,null,2));
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode=1; });
