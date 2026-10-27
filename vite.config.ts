import { defineConfig, type Plugin, type ViteDevServer } from "vite";
import type { OutputBundle } from "rollup";
import { spawn } from "node:child_process";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { resolve, sep } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import { buildDevelopmentCatalogue, buildRuntimeGraph, captureRuntimeChunks, writeStartupCatalogue } from './scripts/build_startup_catalogue.mjs';
import { privateAssetReceiptMiddleware, removePrivateAssetReceipts } from './scripts/public_asset_policy.mjs';

// COOP/COEP so the mujoco wasm's SharedArrayBuffer/threads are usable.
// A production host must send these too (see README).
const crossOriginIsolation = {
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Embedder-Policy": "require-corp",
};

type RuntimeChunk = {
  url: string;
  role?: 'page' | 'worker' | 'shell' | 'localMap' | 'localMapVerification';
  imports: string[];
  dynamicImports: string[];
  css: string[];
  assets: string[];
};

/** Sirv otherwise marks explicit .gz files as HTTP Content-Encoding:gzip. Native
 * indexed gzip entities must retain their file bytes, just as on production hosts. */
function explicitGzip(root: string) {
  return (request: IncomingMessage, response: ServerResponse, next: () => void) => {
    const url = new URL(request.url ?? '/', 'http://localhost');
    if (!url.pathname.endsWith('.gz') || !['GET', 'HEAD'].includes(request.method ?? '')) return next();
    let path: string;
    try { path = resolve(root, '.' + decodeURIComponent(url.pathname)); } catch { return next(); }
    if (!path.startsWith(root + sep)) return next();
    void stat(path).then(info => {
      if (!info.isFile()) return next();
      response.statusCode = 200;
      response.setHeader('Content-Type', 'application/gzip');
      response.setHeader('Content-Length', info.size);
      response.setHeader('Cache-Control', 'no-cache');
      response.removeHeader('Content-Encoding');
      if (request.method === 'HEAD') response.end();
      else createReadStream(path).on('error', error => response.destroy(error)).pipe(response);
    }).catch(next);
  };
}

async function developmentCatalogue(server: ViteDevServer) {
  const address = server.httpServer?.address();
  if (!address || typeof address === 'string') throw Error('Startup catalogue needs a listening Vite HTTP server');
  const host = address.address.includes(':') ? `[${address.address === '::' ? '::1' : address.address}]` : address.address === '0.0.0.0' ? '127.0.0.1' : address.address;
  const base = `http://${host}:${address.port}`;
  return buildDevelopmentCatalogue(server.config.publicDir, async (key: string, binary = false) => {
    const response = await fetch(new URL(key, base));
    if (!response.ok || response.headers.get('content-type')?.includes('text/html')) return null;
    return binary ? Buffer.from(await response.arrayBuffer()) : response.text();
  });
}

export default defineConfig(({ command }) => {
  let outputDirectory = '';
  const catalogueFile = command === 'serve' ? '__startup-catalogue.json' : `startup-catalogue-${randomUUID()}.json`;
  const chunks: RuntimeChunk[] = [];
  function captureGraph(workerBuild = false): Plugin {
    return {
      name: 'startup-runtime-graph',
      generateBundle(_options, bundle: OutputBundle) {
        chunks.push(...captureRuntimeChunks(bundle, workerBuild));
      },
    };
  }
  return {
    define: { __STARTUP_CATALOGUE_URL__: JSON.stringify('/' + catalogueFile) },
    plugins: [captureGraph(), {
      name: 'lossless-native-assets',
      apply: 'build',
      configResolved(config) { outputDirectory = resolve(config.root, config.build.outDir); },
      async closeBundle() {
        await new Promise<void>((done,fail) => {
          const child = spawn(process.execPath,
            ['scripts/compress_model_assets.mjs',outputDirectory],{stdio:'inherit'});
          child.on('error',fail);
          child.on('exit',code => code === 0 ? done() : fail(new Error('Native mesh compression failed')));
        });
        await new Promise<void>((done,fail) => {
          const child = spawn(process.env.PYTHON || 'python3',
            ['scripts/build_native_map_visuals.py',outputDirectory],{stdio:'inherit'});
          child.on('error',fail);
          child.on('exit',code => code === 0 ? done() : fail(new Error('Native Ghost visual build failed')));
        });
        await removePrivateAssetReceipts(outputDirectory);
        // The catalogue sees rewritten manifests, generated native GLBs and final
        // gzip mesh entities, never their larger pre-postprocessing source files.
        const graph = await buildRuntimeGraph(outputDirectory, chunks);
        await writeStartupCatalogue(outputDirectory, graph.runtime, { dependencies: graph.dependencies, fileName: catalogueFile });
      },
    }, {
      name: 'startup-catalogue-serving',
      configureServer(server) {
        server.middlewares.use(privateAssetReceiptMiddleware);
        server.middlewares.use(explicitGzip(server.config.publicDir));
        server.middlewares.use((request, response, next) => {
          if (request.url?.split('?')[0] !== '/' + catalogueFile) return next();
          void developmentCatalogue(server).then(catalogue => {
            response.setHeader('Content-Type', 'application/json');
            response.setHeader('Cache-Control', 'no-store');
            response.end(JSON.stringify(catalogue));
          }).catch(error => {
            server.config.logger.error(String(error));
            response.statusCode = 500;
            response.end('Startup catalogue generation failed');
          });
        });
      },
      configurePreviewServer(server) {
        server.middlewares.use(privateAssetReceiptMiddleware);
        server.middlewares.use(explicitGzip(resolve(server.config.root, server.config.build.outDir)));
      },
    }],
    // mujoco's emscripten glue does dynamic wasm fetches; don't prebundle it
    // Worker-only YAML must be optimized before Load, not trigger a mid-load dev reload.
    optimizeDeps: { include: ["js-yaml"], exclude: ["mujoco", "onnxruntime-web"] },
    server: {
      headers: crossOriginIsolation,
      watch: {
        ignored: [
          "**/workbench_configs/**",
          "**/decrypted/**",
          "**/policy-packs/**",
          "**/docs/**",
          "**/.git/**",
        ],
      },
    },
    // ".trycloudflare.com": a public Cloudflare quick tunnel to `vite preview` (vite rejects unknown hosts)
    preview: { headers: crossOriginIsolation, allowedHosts: [".trycloudflare.com"] },
    build: {
      target: "es2022",
      rollupOptions: {
        input: { main: "index.html" },
      },
    },
    worker: { format: "es", plugins: () => [captureGraph(true)] },
  };
});
