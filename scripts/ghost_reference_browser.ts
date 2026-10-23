// Bundled against NOCLIP_REFERENCE by compare_ghost_reference.cjs.
// Only asset transport is adapted; loaders, materials and rendering are upstream.
import { Viewer } from 'noclip/viewer';
import { createSwapChainForWebGL2, GfxPlatformWebGL2Config } from 'noclip/gfx/platform/GfxPlatformWebGL2';
import { SourceFileSystem, SourceLoadContext } from 'noclip/SourceEngine/Main';
import { createScene } from 'noclip/SourceEngine/Scenes';
import { DataShare } from 'noclip/DataShare';
import ArrayBufferSlice from 'noclip/ArrayBufferSlice';
import { loadRustLib } from 'noclip/rustlib';
import { mat4 } from 'gl-matrix';
import { AntialiasingMode } from 'noclip/gfx/helpers/RenderGraphHelpers';

async function main() {
    await loadRustLib();
    const canvas = document.querySelector('canvas')!;
    const gl = canvas.getContext('webgl2', { antialias: false, preserveDrawingBuffer: true, depth: false, stencil: false })!;
    const viewer = new Viewer(createSwapChainForWebGL2(gl, new GfxPlatformWebGL2Config()), canvas);
    viewer.camera.clipSpaceNearZ = viewer.gfxDevice.queryVendorInfo().clipSpaceNearZ;
    viewer.viewerRenderInput.antialiasingMode = AntialiasingMode.MSAAx4;
    const entries = new Set<string>(await (await fetch('/entries')).json());
    const pending = new Set<Promise<unknown>>();
    let requests = 0;
    const fetchData = async (url: string) => {
        const response = await fetch(url);
        if (!response.ok) throw new Error(`${response.status}: ${url}`);
        return new ArrayBufferSlice(await response.arrayBuffer());
    };
    const filesystem = new SourceFileSystem(null!);
    filesystem.hasEntry = path => entries.has(path);
    filesystem.fetchFileData = path => {
        if (!entries.has(path)) return Promise.resolve(null);
        requests++;
        const promise = fetchData('/file/' + path);
        pending.add(promise);
        promise.finally(() => pending.delete(promise));
        return promise;
    };
    const context = {
        device: viewer.gfxDevice, dataFetcher: { fetchData: () => fetchData('/map.bsp') },
        dataShare: new DataShare(), uiContainer: document.createElement('div'), destroyablePool: [],
        inputManager: viewer.inputManager, viewerInput: viewer.viewerRenderInput, initialSceneTime: 0,
        sceneLoader: { loadSceneById() { throw new Error('Unexpected scene transition'); } },
    };
    const mapInfo=await(await fetch('/map-info')).json();
    const scene = await createScene(context as any, new SourceLoadContext(filesystem), mapInfo.id, 'map.bsp');
    scene.renderContext.enableFog = false;
    viewer.setScene(scene);
    const sourceToNoclip = mat4.fromValues(0,0,-1,0, -1,0,0,0, 0,1,0,0, 0,0,0,1);
    const capture = async (sourceCamera: number[], options: { envmapScale?: number; material?: string; antialiasing?: 'fxaa'|'msaa4'|'none' } = {}) => {
        viewer.viewerRenderInput.antialiasingMode=options.antialiasing==='fxaa'?AntialiasingMode.FXAA:options.antialiasing==='none'?AntialiasingMode.None:AntialiasingMode.MSAAx4;
        mat4.multiply(viewer.camera.worldMatrix, sourceToNoclip, sourceCamera);
        viewer.camera.worldMatrixUpdated();
        viewer.camera.setPerspective(Math.PI / 3, 320 / 240, 5, Infinity);
        // Loader work is asynchronous. Render to request any view-dependent assets,
        // then require two quiescent passes before accepting a capture.
        let quiet = 0;
        const deadline = performance.now() + 180000;
        while (quiet < 2) {
            if (performance.now() > deadline) throw new Error('Reference assets did not settle');
            const previous = requests;
            await Promise.all([...pending]);
            (viewer as any).render();
            await new Promise(resolve => setTimeout(resolve, 250));
            quiet = pending.size === 0 && requests === previous ? quiet + 1 : 0;
        }
        // Diagnostic captures vary native material parameters, without replacing
        // shader code. Restore immediately so regular comparisons stay authored.
        const changed = new Map<any, number[]>();
        try {
            if (options.envmapScale !== undefined) for (const bsp of scene.bspRenderers)
                for (const model of bsp.models) for (const surface of model.surfaces) {
                    if (options.material && surface.surface.texName !== options.material) continue;
                    const tint = (surface.materialInstance?.param['$envmaptint'] as any)?.internal;
                    if (!tint || changed.has(tint)) continue;
                    changed.set(tint, tint.map((entry: any) => entry.value));
                    for (const entry of tint) entry.value *= options.envmapScale;
                }
            (viewer as any).render();
            gl.finish();
            return { png: canvas.toDataURL('image/png'), worldMatrix: Array.from(viewer.camera.worldMatrix),
                requests, pending: pending.size, hdr: scene.renderContext.isUsingHDR(),
                fog: scene.renderContext.enableFog, diagnosticEnvmapScale: options.envmapScale,
                colorCorrection:{layers:(scene.renderContext.colorCorrection as any).layers.length,weights:[...(scene.renderContext.colorCorrection as any).weights]},
                drawCalls: (viewer as any).statisticsGroup.drawCallCount,
                diagnosticMaterials: changed.size,
                diagnosticGeometry: options.material ? scene.bspRenderers.flatMap(renderer => {
                    const data=new Float32Array(renderer.bsp.vertexData),indices=new Uint32Array(renderer.bsp.indexData),vertices=new Set<number>();
                    for(const model of renderer.models)for(const surface of model.surfaces)
                        if(surface.surface.texName===options.material)for(let i=0;i<surface.surface.indexCount;i++)vertices.add(indices[surface.surface.startIndex+i]);
                    return [...vertices].map(index=>Array.from(data.slice(index*15,index*15+15)));
                }) : undefined };
        } finally {
            for (const [tint, values] of changed) for (let i=0;i<values.length;i++) tint[i].value=values[i];
        }
    };
    (window as any).reference = { capture };
}
main().catch(error => { console.error(error); (window as any).referenceError = String(error); });
