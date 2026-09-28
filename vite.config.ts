import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';

// The neural voice runtime: large and only needed once neural voices are used, so it's cached on first use.
const OPTIONAL_MEDIA = /^assets\/(?:neuralTts|transformers\.web|kokoro|ort-wasm)[^/]*\.(?:js|wasm)$/;

/**
 * Stamps the build into the copied service worker: the hashed files to precache and a version derived from
 * them, so every deploy that changes the app changes the worker, and devices install it in the background.
 */
function stampServiceWorker(): Plugin {
  let outDir = '';
  return {
    name: 'stamp-service-worker',
    apply: 'build',
    configResolved(config) {
      outDir = resolve(config.root, config.build.outDir);
    },
    writeBundle(_options, bundle) {
      const files = Object.keys(bundle).filter(name => name.startsWith('assets/')).sort();
      const precache = files.filter(name => !OPTIONAL_MEDIA.test(name)).map(name => `/${name}`);
      const optional = files.filter(name => OPTIONAL_MEDIA.test(name)).map(name => `/${name}`);
      const html = readFileSync(resolve(outDir, 'index.html'), 'utf8');
      const version = createHash('sha256').update(html).update(files.join('\n')).digest('hex').slice(0, 16);

      const workerPath = resolve(outDir, 'sw.js');
      let worker = readFileSync(workerPath, 'utf8');
      for (const [placeholder, value] of [
        ["const VERSION = 'dev';", `const VERSION = '${version}';`],
        ['const PRECACHE = [];', `const PRECACHE = ${JSON.stringify(precache)};`],
        ['const OPTIONAL = [];', `const OPTIONAL = ${JSON.stringify(optional)};`],
      ]) {
        if (!worker.includes(placeholder)) throw new Error(`sw.js no longer contains \`${placeholder}\``);
        worker = worker.replace(placeholder, () => value);
      }
      writeFileSync(workerPath, worker);
    },
  };
}

export default defineConfig({
  server: {
    port: 3000,
    host: '0.0.0.0',
    watch: {
      // Ignore Watchman's ephemeral cookie files — it creates and instantly deletes them, and the
      // dev watcher otherwise races to realpath() a now-gone file and crashes the server with ENOENT.
      ignored: ['**/test-results/**', '**/playwright-report/**', '**/.playwright/**', '**/.watchman-cookie-*']
    },
    hmr: {
      overlay: process.env.CI ? false : true
    },
    // Proxy API requests to the Hono server during development
    proxy: {
      '/api': {
        target: 'http://localhost:3001',
        changeOrigin: true,
      }
    }
  },
  plugins: [
    react(),
    stampServiceWorker(),
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
          'react-vendor': ['react', 'react-dom'],
        }
      }
    }
  }
});
