/** Compile real source fixtures with the same Vite transforms as the application. */
'use strict';
const { isBuiltin } = require('node:module');
const { mkdtemp, rm } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

module.exports = async function buildFixture({ root, source, platform, format, externalPackages = false, globalName = 'Fixture' }) {
  const { build } = await import('vite');
  const entry = path.join(root, `.fixture-${randomUUID()}.ts`);
  const cache = await mkdtemp(path.join(tmpdir(), 'm0clip-fixture-'));
  try {
    const result = await build({ root, configFile: false, publicDir: false, cacheDir: cache, logLevel: 'warn',
      plugins: [{ name: 'source-fixture-entry',
        resolveId(id) { if (id === entry) return entry; },
        load(id) { if (id === entry) return source; },
      }],
      ssr: { noExternal: !externalPackages },
      build: { write: false, emptyOutDir: false, minify: false, target: 'es2022', cssCodeSplit: false,
        assetsInlineLimit: Infinity, ssr: platform === 'node' ? entry : false,
        rollupOptions: { input: entry, preserveEntrySignatures: 'strict',
          external(id) { return isBuiltin(id) || externalPackages && !id.startsWith('.') && !path.isAbsolute(id); },
          output: { format, name: globalName, inlineDynamicImports: true, exports: 'named' },
        },
      },
    });
    const output = (Array.isArray(result) ? result : [result]).flatMap(bundle => bundle.output);
    const chunks = output.filter(item => item.type === 'chunk');
    if (chunks.length !== 1) throw Error('Source fixture must emit one executable chunk.');
    const css = output.filter(item => item.type === 'asset' && item.fileName.endsWith('.css'))
      .map(item => typeof item.source === 'string' ? item.source : Buffer.from(item.source).toString('utf8')).join('\n');
    return { code: chunks[0].code, css };
  } finally { await rm(cache, { recursive: true, force: true }); }
};
