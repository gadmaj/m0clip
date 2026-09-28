import { defineConfig } from "vite";

// COOP/COEP so the mujoco wasm's SharedArrayBuffer/threads are usable.
// A production host must send these too (see README).
const crossOriginIsolation = {
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Embedder-Policy": "require-corp",
};

export default defineConfig({
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
  preview: { headers: crossOriginIsolation },
  build: {
    target: "es2022",
    rollupOptions: {
      input: { main: "index.html" },
    },
  },
  worker: { format: "es" },
});
