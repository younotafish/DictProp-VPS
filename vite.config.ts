import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  server: {
    port: 3000,
    host: '0.0.0.0',
    watch: {
      ignored: ['**/test-results/**', '**/playwright-report/**', '**/.playwright/**']
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
  ],
  optimizeDeps: {
    // kokoro-js + transformers.js (onnxruntime-web wasm/workers) don't play well with Vite's
    // dev pre-bundling. They're loaded via dynamic import() so they stay code-split out of the
    // main bundle either way; excluding them here avoids dev-server pre-bundle errors.
    exclude: ['kokoro-js', '@huggingface/transformers'],
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
