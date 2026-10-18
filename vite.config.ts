import { defineConfig } from "vite";
import { spawn } from "node:child_process";
import { resolve } from "node:path";

// COOP/COEP so the mujoco wasm's SharedArrayBuffer/threads are usable.
// A production host must send these too (see README).
const crossOriginIsolation = {
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Embedder-Policy": "require-corp",
};

let outputDirectory = "";

export default defineConfig({
  plugins: process.env.SOURCE_TEXTURE_OPTIMIZE === '1' ? [{
    name: 'ghost-lossless-textures',
    apply: 'build',
    configResolved(config) { outputDirectory = resolve(config.root,config.build.outDir); },
    async closeBundle() {
      const directory = resolve(outputDirectory,'assets/maps/nt_ghost_ctg');
      await new Promise<void>((done,fail) => {
        const child = spawn(process.env.PYTHON || 'python3',
          ['scripts/optimize_map_textures.py','--directory',directory],{stdio:'inherit'});
        child.on('error',fail);
        child.on('exit',code => code === 0 ? done() : fail(new Error('Lossless Ghost texture optimization failed')));
      });
    },
  }] : [],
  // mujoco's emscripten glue does dynamic wasm fetches; don't prebundle it
  optimizeDeps: { exclude: ["mujoco", "onnxruntime-web"] },
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
  worker: { format: "es" },
});
