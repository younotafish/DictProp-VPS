import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';

// This checkout's root, so the watcher's ignores below apply here and not to a worktree nested under tmp/.
const here = fileURLToPath(new URL('.', import.meta.url));

// The Kokoro voice runtime (its worker, transformers.js and the ONNX runtime): megabytes that only neural voices need,
// so the service worker caches it on first use. The voice engine (neuralTts) stays out of this list: it's small, and
// its file name changes with nearly every deploy, so an offline launch after one would find it in no cache.
const OPTIONAL_MEDIA = /^assets\/(?:transformers\.web|kokoro|ort-wasm)[^/]*\.(?:js|wasm)$/;

/**
 * The service worker a build ships: public/sw.js stamped with the build's hashed files to precache, the voice
 * runtime it caches on first use instead, and a version derived from them and the shell, so every deploy that
 * changes the app changes the worker, and devices install it in the background. `files` are the bundle's file
 * names (`assets/index-1a2b.js`). The tests stamp their workers with it too.
 */
export function stampServiceWorker(worker: string, build: { html: string; files: readonly string[] }): string {
  const files = build.files.filter(name => name.startsWith('assets/')).sort();
  const precache = files.filter(name => !OPTIONAL_MEDIA.test(name)).map(name => `/${name}`);
  const optional = files.filter(name => OPTIONAL_MEDIA.test(name)).map(name => `/${name}`);
  const version = createHash('sha256').update(build.html).update(files.join('\n')).digest('hex').slice(0, 16);

  let stamped = worker;
  for (const [placeholder, value] of [
    ["const VERSION = 'dev';", `const VERSION = '${version}';`],
    ['const PRECACHE = [];', `const PRECACHE = ${JSON.stringify(precache)};`],
    ['const OPTIONAL = [];', `const OPTIONAL = ${JSON.stringify(optional)};`],
  ]) {
    if (!stamped.includes(placeholder)) throw new Error(`sw.js no longer contains \`${placeholder}\``);
    stamped = stamped.replace(placeholder, () => value);
  }
  return stamped;
}

/** Stamps the build into the service worker Vite copied from public/ (see stampServiceWorker). */
function serviceWorkerStamp(): Plugin {
  let outDir = '';
  return {
    name: 'stamp-service-worker',
    apply: 'build',
    configResolved(config) {
      outDir = resolve(config.root, config.build.outDir);
    },
    writeBundle(_options, bundle) {
      const html = readFileSync(resolve(outDir, 'index.html'), 'utf8');
      const workerPath = resolve(outDir, 'sw.js');
      writeFileSync(workerPath, stampServiceWorker(readFileSync(workerPath, 'utf8'), { html, files: Object.keys(bundle) }));
    },
  };
}

export default defineConfig({
  server: {
    port: 3000,
    // Loopback unless DEV_LAN=1: with DEV_AUTH_BYPASS the proxied /api has no auth, so the local network
    // shouldn't reach it by default.
    host: process.env.DEV_LAN === '1' ? '0.0.0.0' : '127.0.0.1',
    watch: {
      ignored: [
        // Ignore Watchman's ephemeral cookie files — it creates and instantly deletes them, and the
        // dev watcher otherwise races to realpath() a now-gone file and crashes the server with ENOENT.
        '**/.watchman-cookie-*',
        // Databases, generated data, audit worktrees and personal files: tens of thousands of files the app never
        // imports, which the watcher would otherwise walk at startup. Anchored to this checkout, because the
        // worktrees under tmp/ are checkouts too, and their own dev servers must still watch their sources.
        `${here}data/**`,
        `${here}server/data/**`,
        `${here}tmp/**`,
        `${here}personal_1/**`,
      ],
    },
    // Proxy API requests to the Hono server during development
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:3001',
        changeOrigin: true,
      }
    }
  },
  plugins: [
    react(),
    serviceWorkerStamp(),
  ],
  optimizeDeps: {
    // kokoro-js + transformers.js (onnxruntime-web wasm/workers) don't play well with Vite's
    // dev pre-bundling. They're loaded via dynamic import() so they stay code-split out of the
    // main bundle either way; excluding them here avoids dev-server pre-bundle errors.
    exclude: ['kokoro-js', '@huggingface/transformers'],
  },
  // The Kokoro worker is a module worker, so its code can be split like the page's.
  worker: {
    format: 'es',
  },
  build: {
    rollupOptions: {
      output: {
        manualChunks: {
          // react-dom/client and scheduler change only with React, so they ride in the long-cached chunk too.
          'react-vendor': ['react', 'react-dom', 'react-dom/client', 'scheduler'],
        }
      }
    }
  }
});
