import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import vm from 'node:vm';

const serverDir = fileURLToPath(new URL('..', import.meta.url));
const readRepoFile = (relativePath: string): string => readFileSync(
  fileURLToPath(new URL(`../../${relativePath}`, import.meta.url)),
  'utf8',
);

/** Loads env.ts in a child process with the given variables and reports how it went. */
const loadEnv = (vars: Record<string, string>) => spawnSync(process.execPath, ['--import', 'tsx', 'src/env.ts'], {
  cwd: serverDir,
  env: { ...process.env, ...vars },
  encoding: 'utf8',
});

test('the auth bypass is refused in production and stays on loopback in development', () => {
  const production = loadEnv({ NODE_ENV: 'production', DEV_AUTH_BYPASS: '1' });
  assert.notEqual(production.status, 0);
  assert.match(production.stderr, /DEV_AUTH_BYPASS=1 would make every visitor an admin/);

  const development = loadEnv({ NODE_ENV: 'development', DEV_AUTH_BYPASS: '1' });
  assert.equal(development.status, 0, development.stderr);

  // The image runs as production, and a bypassed server or dev proxy listens on loopback only.
  assert.match(readRepoFile('Dockerfile'), /^ENV NODE_ENV=production$/m);
  assert.match(readRepoFile('server/src/index.ts'), /env\.DEV_AUTH_BYPASS \? \{ hostname: '127\.0\.0\.1' \}/);
  assert.match(readRepoFile('vite.config.ts'), /host: process\.env\.DEV_LAN === '1' \? '0\.0\.0\.0' : '127\.0\.0\.1'/);
});

type FetchListener = (event: { request: { method: string; mode: string; url: string }; respondWith: (response: unknown) => void }) => void;

/** Runs public/sw.js against a stub worker scope and returns its fetch listener. */
const loadServiceWorker = (): FetchListener => {
  const listeners = new Map<string, FetchListener>();
  const scope = {
    location: { origin: 'https://dictprop.online' },
    addEventListener: (type: string, listener: FetchListener) => { listeners.set(type, listener); },
  };
  vm.runInNewContext(readRepoFile('public/sw.js'), { self: scope, URL, caches: {}, fetch: () => Promise.reject(new Error('offline')) });
  const onFetch = listeners.get('fetch');
  assert.ok(onFetch, 'sw.js listens for fetch');
  return onFetch;
};

test('the service worker answers only for the app, never for the other sites on its origin', () => {
  const onFetch = loadServiceWorker();
  const answers = (url: string, mode = 'no-cors', method = 'GET'): boolean => {
    let answered = false;
    onFetch({
      request: { method, mode, url: `https://dictprop.online${url}` },
      // Only whether the worker answers matters here; its answer needs Cache Storage, which the stub lacks.
      respondWith: (response) => { answered = true; Promise.resolve(response).catch(() => {}); },
    });
    return answered;
  };

  assert.equal(answers('/', 'navigate'), true);
  assert.equal(answers('/index.html', 'navigate'), true);
  // The trip pages sit behind their own auth on this origin; the app shell must not stand in for them.
  assert.equal(answers('/nz-japan/', 'navigate'), false);
  assert.equal(answers('/nz-japan/itinerary.html', 'navigate'), false);
  // Their files and anything dynamic go to the network untouched, so nothing private lands in Cache Storage.
  assert.equal(answers('/nz-japan/photo.jpg'), false);
  assert.equal(answers('/api/items'), false);
  assert.equal(answers('/api/items', 'cors', 'PUT'), false);
  assert.equal(answers('/assets/index-abc123.js'), true);
  assert.equal(answers('/manifest.json'), true);
});
