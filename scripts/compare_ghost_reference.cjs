/** Real noclip Ghost captures against staged and stable production bundles.
 * source deploy/development/env.sh
 * BASE_URL=http://127.0.0.1:4174 xvfb-run -a node scripts/compare_ghost_reference.cjs
 * Results persist in GHOST_COMPARISON_OUTPUT (default ~/.local/state/unitree-renderer/comparison).
 * Requires noclip's rust/pkg generated with its pinned wasm-bindgen 0.2.100.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { spawn, execFileSync } = require('node:child_process');
const { createInterface } = require('node:readline');
const { build } = require('esbuild');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const shaderDiagnostics = require('./source_reflection_diagnostics.cjs');

const reference = path.resolve(process.env.NOCLIP_REFERENCE || '../noclip.website');
const output = path.resolve(process.env.GHOST_COMPARISON_OUTPUT || path.join(os.homedir(), '.local/state/unitree-renderer/comparison'));
const mapId=process.env.SOURCE_MAP_ID||'nt_ghost_ctg';
assert.ok(/^nt_[a-z0-9_]+$/.test(mapId),'Invalid Source comparison map');
const allViews = [
    { name: 'spawn', position: [2,-4,2], target: [0,0,1] },
    { name: 'grating', position: [74.089302,4.960490,3.499000], target: [74.089302,4.960490,4.699000] },
    { name: 'reflection', position: [-4.613978,.797870,3.224413], target: [-5.675760,.513366,3.183467] },
    { name: 'workbench', position: [17.462813,-11.670310,1.967519], target: [18.523958,-11.531636,1.713076] },
];
const requestedViews = process.env.GHOST_COMPARISON_VIEWS?.split(',');
if (requestedViews) assert.ok(requestedViews.every(name => allViews.some(view => view.name === name)), 'Unknown comparison view');
const views = requestedViews ? allViews.filter(view => requestedViews.includes(view.name)) : mapId==='nt_ghost_ctg'?allViews:allViews.slice(0,1);

async function main() {
    const antialiasing=process.env.GHOST_ANTIALIASING||'msaa4';
    assert.ok(['fxaa','msaa4','none'].includes(antialiasing),'Unknown antialiasing mode');
    await fs.mkdir(output, { recursive: true });
    const { PNG } = require(path.join(reference, 'node_modules/pngjs'));
    const bundle = path.join(output, 'reference.js');
    const diagnosticEnvmapScale = process.env.GHOST_DIAGNOSTIC_NO_ENVMAPS === '1' ? 0 : undefined;
    const diagnosticMaterial = process.env.GHOST_DIAGNOSTIC_MATERIAL;
    const diagnosticShader = process.env.GHOST_SHADER_DIAGNOSTIC;
    if (diagnosticShader) assert.ok(shaderDiagnostics[diagnosticShader], 'Unknown shader diagnostic');
    const patchCandidate = body => {
        if (!diagnosticShader) return body;
        if(shaderDiagnostics[diagnosticShader].flatBump)body=body.replace('bump = texture2D(sourceEffectNormal, vSourceEffectUv);','bump = vec4(.31,.63,.87,1.);');
        return body.replace('return result + specular * sourceExposure;', `return ${shaderDiagnostics[diagnosticShader].app};`);
    };
    await build({ entryPoints: ['scripts/ghost_reference_browser.ts'], bundle: true, format: 'esm', outfile: bundle,
        tsconfig: path.join(reference, 'tsconfig.json'), loader: { '.png': 'dataurl' },
        alias: { noclip: path.join(reference, 'src'), 'noclip-rust-support': path.join(reference, 'rust/pkg/index.js'),
            'gl-matrix': path.join(reference, 'node_modules/gl-matrix/esm/index.js') },
        define: { 'process.env.NODE_ENV': '"production"', 'import.meta.env.PUBLIC_STORAGE_URL': '""' },
        plugins: diagnosticShader ? [{ name:'source-shader-diagnostic', setup(build) {
            build.onLoad({filter:/SourceEngine\/Materials\/Material_Generic\.ts$/}, async args => {
                let original=await fs.readFile(args.path,'utf8');
                if(shaderDiagnostics[diagnosticShader].flatBump)original=original.replace('t_Sample = UnpackUnsignedNormalMap(t_Sample);','t_Sample = UnpackUnsignedNormalMap(vec4(.31,.63,.87,1.));');
                const expression=shaderDiagnostics[diagnosticShader].native;
                let replacement=`OutputLinearColor(vec4(${expression}, 1.0));`;
                if(diagnosticShader==='cube') replacement=`\n#if defined USE_ENVMAP\n${replacement}\n#else\nOutputLinearColor(vec4(0.,0.,0.,1.));\n#endif\n`;
                assert.ok(original.includes('OutputLinearColor(t_FinalColor);'));
                return {contents:original.replace('OutputLinearColor(t_FinalColor);',replacement),loader:'ts'};
            });
        }}] : [],
    });
    const server = spawn(process.env.PYTHON || 'python3', ['scripts/ghost_reference_server.py', '--bundle', bundle, '--reference', reference,'--map',mapId], { stdio: ['ignore','pipe','inherit'] });
    let browser;
    try {
        const serverUrl = await new Promise((resolve, reject) => {
            const lines = createInterface({ input: server.stdout });
            lines.once('line', line => { lines.close(); resolve(line); });
            server.once('exit', code => reject(new Error(`Reference transport exited: ${code}`)));
            server.once('error', reject);
        });
        browser = await chromium.launch({ headless: false, args: ['--no-sandbox','--ozone-platform=x11'] });
        const failures = [];
        const observe = (page, label) => {
            page.on('pageerror', error => failures.push(`${label}: ${error.stack || error}`));
            page.on('console', message => {
                if (message.type() === 'error') failures.push(`${label}: ${message.text()}`);
            });
        };
        const captureApp = async (url, label) => {
            const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: .25 });
            observe(page, label);
            for (const pattern of ['**/src/main.ts*', '**/assets/main-*.js']) await page.route(pattern, async route => {
                const response = await route.fetch(), original = await response.text();
                const body = patchCandidate(require('./expose-app.cjs')(original).replaceAll('this.renderLoop()', 'void 0'));
                
                await route.fulfill({ response, body });
            });
            if (diagnosticShader) await page.route('**/src/render/source-materials.ts*', async route => {
                const response=await route.fetch(),original=await response.text(),body=patchCandidate(original);
                assert.notEqual(body,original,'Source shader diagnostic must match the material module');
                await route.fulfill({response,body});
            });
            await page.goto(url + '/?plain&map='+mapId+'&body=stock');
            await require('./launch-scene.cjs').launchScene(page);
            await page.waitForFunction(() => window.__app?.lastFrame && window.__app.view.terrainObject && document.querySelector('#overlay').classList.contains('hidden'), null, { timeout: 180000 });
            const captures = [];
            for (const view of views) {
                const result = await page.evaluate(async ({ view, diagnosticEnvmapScale, diagnosticMaterial, antialiasing, label }) => {
                    const app = window.__app, v = app.view;
                    if(label==='staged')v.setSourceAntialiasing(antialiasing);
                    app.send({ t: 'pause', on: true });
                    await v.waitForTerrainVisuals();
                    if (diagnosticEnvmapScale === 0 && !window.__diagnosticEnvmapApplied) {
                        window.__diagnosticEnvmapApplied = true;
                        window.__diagnosticMaterials = 0;
                        for (const entry of v.terrainMaterials) {
                            const originals = [entry.original].flat(), sources = [entry.source].flat();
                            for (let i=0;i<originals.length;i++) {
                                if (typeof originals[i].userData.sourceLightmap !== 'number') continue;
                                if (diagnosticMaterial && originals[i].name !== diagnosticMaterial) continue;
                                const meta = originals[i].userData.sourceMaterial;
                                if (!meta?.envmaptint) continue;
                                window.__diagnosticMaterials++;
                                meta.envmaptint = [0,0,0];
                                const key = sources[i].customProgramCacheKey();
                                sources[i].customProgramCacheKey = () => key + '-diagnostic-no-envmaps';
                                sources[i].needsUpdate = true;
                            }
                        }
                    }
                    v.controls.enabled = false;
                    v.setDisplay({ ...v.display, robot: false });
                    v.setFlashlight(false);
                    v.setSourceTime(0);
                    v.beginOffscreen(320,240,{ floor: false });
                    const camera = v.camera;
                    camera.position.fromArray(view.position); camera.up.set(0,0,1);
                    camera.lookAt(...view.target); camera.aspect = 320/240; camera.fov = 60;
                    camera.near = 5*.0254; camera.far = Infinity;
                    camera.updateProjectionMatrix(); camera.updateMatrixWorld(true);
                    v.renderWith(camera);
                    const png = v.renderer.domElement.toDataURL('image/png');
                    const worldMatrix = camera.matrixWorld.toArray();
                    const colorCorrection=v.sourceColor?{layers:v.sourceColor.layers?.length??0,weights:[...(v.sourceColor.weights??[])]}:undefined;
                    v.endOffscreen();
                    const diagnosticGeometry=diagnosticMaterial?v.terrainMaterials.filter(entry=>[entry.original].flat().some(material=>material.name===diagnosticMaterial)).map(entry=>({
                        matrix:entry.mesh.matrixWorld.toArray(),attributes:Object.fromEntries(['position','normal','tangent','uv'].map(name=>[name,Array.from(entry.mesh.geometry.getAttribute(name).array)]))
                    })):undefined;
                    return { png, worldMatrix, fog: v.scene.fog, toneMapping: v.renderer.toneMapping,colorCorrection,cameraPlanes:{near:camera.near,far:Number.isFinite(camera.far)?camera.far:null},diagnosticMaterials:window.__diagnosticMaterials,diagnosticGeometry };
                }, { view, diagnosticEnvmapScale, diagnosticMaterial, antialiasing, label });
                await fs.writeFile(path.join(output, `${label}-${view.name}.png`), Buffer.from(result.png.split(',')[1], 'base64'));
                delete result.png;
                if (diagnosticEnvmapScale === 0) assert.ok(result.diagnosticMaterials>0,'Candidate diagnostic must change material parameters');
                captures.push(result);
            }
            await page.close();
            return captures;
        };
        const staged = await captureApp(process.env.BASE_URL || 'http://127.0.0.1:4174', 'staged');
        const stable = await captureApp(process.env.STABLE_URL || 'http://127.0.0.1:4173', 'stable');
        for (let i=0;i<views.length;i++) assert.deepEqual(stable[i].worldMatrix,staged[i].worldMatrix,'Production cameras must match');
        const manifest = JSON.parse(await fs.readFile(`public/assets/maps/${mapId}/manifest.json`, 'utf8'));
        const yaw = manifest.spawn_yaw * Math.PI/180, c = Math.cos(yaw), s = Math.sin(yaw);
        const sourceCamera = world => {
            const matrix = [...world];
            for (let column=0; column<4; column++) {
                const at=column*4, scale=column===3 ? 1/.0254 : 1;
                matrix[at]=(c*world[at]-s*world[at+1])*scale;
                matrix[at+1]=(s*world[at]+c*world[at+1])*scale;
                matrix[at+2]=world[at+2]*scale;
                if (column===3) for(let i=0;i<3;i++) matrix[at+i]+=manifest.spawn_source[i];
            }
            return matrix;
        };
        const page = await browser.newPage();
        observe(page, 'reference');
        // Avoid a browser favicon request becoming an unrelated error.
        await page.route('**/favicon.ico', route => route.fulfill({ status: 204 }));
        await page.goto(serverUrl);
        await page.waitForFunction(() => window.reference || window.referenceError, null, { timeout: 180000 });
        assert.equal(await page.evaluate(() => window.referenceError), undefined);
        const native = [];
        for (let i=0;i<views.length;i++) {
            const matrix = sourceCamera(staged[i].worldMatrix);
            const capture = await page.evaluate(({matrix,diagnosticEnvmapScale,diagnosticMaterial,antialiasing}) => window.reference.capture(matrix,{envmapScale:diagnosticEnvmapScale,material:diagnosticMaterial,antialiasing}), {matrix,diagnosticEnvmapScale,diagnosticMaterial,antialiasing});
            const repeated = await page.evaluate(({matrix,diagnosticEnvmapScale,diagnosticMaterial,antialiasing}) => window.reference.capture(matrix,{envmapScale:diagnosticEnvmapScale,material:diagnosticMaterial,antialiasing}), {matrix,diagnosticEnvmapScale,diagnosticMaterial,antialiasing});
            assert.equal(capture.png, repeated.png, `${views[i].name}: reference must be deterministic`);
            if (diagnosticEnvmapScale === 0) assert.ok(capture.diagnosticMaterials>0,'Native diagnostic must change material parameters');
            const png = Buffer.from(capture.png.split(',')[1], 'base64');
            const decoded = PNG.sync.read(png);
            assert.equal(decoded.width,320); assert.equal(decoded.height,240);
            const colors=new Set();
            for(let at=0;at<decoded.data.length;at+=4)colors.add(decoded.data.readUInt32LE(at));
            if (diagnosticShader && shaderDiagnostics[diagnosticShader].flatBump)
                assert.ok(capture.drawCalls>2,'Constant-normal diagnostics must still draw scene geometry');
            else assert.ok(colors.size>100,`${views[i].name}: a blank reference framebuffer is not a scene comparison`);
            await fs.writeFile(path.join(output, `reference-${views[i].name}.png`), png);
            delete capture.png;
            native.push(capture);
            console.log(`Captured native ${views[i].name}`);
        }
        const metrics = async (label, name) => {
            const actual = PNG.sync.read(await fs.readFile(path.join(output, `${label}-${name}.png`)));
            const expected = PNG.sync.read(await fs.readFile(path.join(output, `reference-${name}.png`)));
            assert.equal(actual.width,320); assert.equal(actual.height,240);
            const difference = new PNG({width:320,height:240}), samples=[];
            for(let i=0;i<actual.data.length;i+=4){
                for(let channel=0;channel<3;channel++){
                    const delta=Math.abs(actual.data[i+channel]-expected.data[i+channel]);
                    samples.push(delta); difference.data[i+channel]=Math.min(255,delta*8);
                }
                difference.data[i+3]=255;
            }
            samples.sort((a,b)=>a-b);
            await fs.writeFile(path.join(output, `${label}-${name}-difference-x8.png`), PNG.sync.write(difference));
            return { mean:samples.reduce((sum,v)=>sum+v,0)/samples.length, p95:samples[Math.floor(samples.length*.95)] };
        };
        const results=[];
        for(let i=0;i<views.length;i++)results.push({...views[i],stable:await metrics('stable',views[i].name),staged:await metrics('staged',views[i].name),camera:staged[i].worldMatrix,colorCorrection:staged[i].colorCorrection,cameraPlanes:staged[i].cameraPlanes,diagnosticGeometry:staged[i].diagnosticGeometry,reference:native[i]});
        const report={date:new Date().toISOString(),candidateUrl:process.env.BASE_URL||'http://127.0.0.1:4174',baselineUrl:process.env.STABLE_URL||'http://127.0.0.1:4173',referenceCommit:execFileSync('git',['-C',reference,'rev-parse','HEAD'],{encoding:'utf8'}).trim(),width:320,height:240,time:0,antialiasing,baselineAntialiasing:'msaa4',fog:false,diagnosticEnvmapScale,diagnosticMaterial,diagnosticShader,results,failures};
        report.map=mapId;
        await fs.writeFile(path.join(output,'report.json'),JSON.stringify(report,null,2)+'\n');
        console.log(JSON.stringify(report,null,2));
        assert.deepEqual(failures,[]);
    } finally {
        if(browser) await browser.close();
        server.kill();
    }
}
main().catch(error => { console.error(error); process.exitCode=1; });
