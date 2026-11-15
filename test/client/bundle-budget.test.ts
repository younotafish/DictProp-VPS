import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { stampServiceWorker } from '../../vite.config.ts';
import { readRepoFile, repoPath } from '../support/paths.ts';

// scripts/check-bundle-budget.mjs, the release gate's last look at the client build: the initial JavaScript stays
// under 100 kB gzip, and the service worker precaches every file the app can reach without the voice runtime.

const SHELL = [
  '<script type="module" crossorigin src="/assets/index-a1.js"></script>',
  '<link rel="modulepreload" crossorigin href="/assets/vendor-b2.js">',
  '<link rel="stylesheet" crossorigin href="/assets/index-c3.css">',
].join('\n');

/** A small build shaped like the real one: an entry, a vendor chunk, a stylesheet, a lazy screen and the voice runtime. */
const BUILD: Record<string, string> = {
  'index.html': SHELL,
  'assets/index-a1.js': 'import{r}from"./vendor-b2.js";const s=()=>import("./Lazy-d4.js");',
  'assets/vendor-b2.js': 'export const r=1;',
  'assets/index-c3.css': 'body{margin:0}',
  'assets/Lazy-d4.js': 'import{r}from"./vendor-b2.js";const w=()=>new Worker(new URL("/assets/kokoroWorker-e5.js",import.meta.url),{type:"module"});',
  'assets/kokoroWorker-e5.js': 'const m=()=>import("./ort-wasm-simd-threaded.jsep-f6.mjs");',
  'assets/ort-wasm-simd-threaded.jsep-f6.wasm': '\0asm',
};

/**
 * Writes a build into a fresh folder's dist/, with the worker stamped the way vite.config.ts stamps it. `late` files
 * land in dist/ without being part of the stamped build.
 */
function writeBuild(files: Record<string, string>, late: Record<string, string> = {}): string {
  const root = mkdtempSync(join(tmpdir(), 'bundle-budget-'));
  mkdirSync(join(root, 'dist', 'assets'), { recursive: true });
  for (const [name, contents] of Object.entries({ ...files, ...late })) writeFileSync(join(root, 'dist', name), contents);
  const worker = stampServiceWorker(readRepoFile('public/sw.js'), { html: files['index.html'], files: Object.keys(files) });
  writeFileSync(join(root, 'dist', 'sw.js'), worker);
  return root;
}

/** Runs the bundle check on the build in `root`, as `npm run check:bundle` does from the repository root. */
const checkBundle = (root: string) =>
  spawnSync(process.execPath, [repoPath('scripts/check-bundle-budget.mjs')], { cwd: root, encoding: 'utf8' });

test('a build whose core files are all precached passes, with the voice runtime left out of the core graph', () => {
  const result = checkBundle(writeBuild(BUILD));
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^Initial JavaScript: 0\.\d\d kB gzip across 2 assets \(limit 100\.00 kB\)$/m);
  assert.match(result.stdout, /^Offline core graph: 4 hashed assets, all precached by the service worker \(optional media excluded\)$/m);
});

test('initial JavaScript over 100 kB gzip fails the check, which still reports the core graph', () => {
  // Random bytes in base64 barely compress, so this entry alone is over the limit.
  const entry = `${BUILD['assets/index-a1.js']}const pad="${randomBytes(110 * 1024).toString('base64')}";`;
  const result = checkBundle(writeBuild({ ...BUILD, 'assets/index-a1.js': entry }));
  assert.equal(result.status, 1);
  assert.match(result.stdout, /^Initial JavaScript: 1\d\d\.\d\d kB gzip across 2 assets \(limit 100\.00 kB\)$/m);
  assert.match(result.stdout, /^Offline core graph: 4 hashed assets/m);
});

test('a core file the worker does not precache fails the check', () => {
  const result = checkBundle(writeBuild(
    { ...BUILD, 'assets/Lazy-d4.js': `${BUILD['assets/Lazy-d4.js']}const h=()=>import("./Help-g7.js");` },
    { 'assets/Help-g7.js': 'export default 1;' },
  ));
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /dist\/sw\.js does not precache \/assets\/Help-g7\.js/);
});

test('a worker left unstamped precaches nothing, so the check fails', () => {
  const root = writeBuild(BUILD);
  writeFileSync(join(root, 'dist', 'sw.js'), readRepoFile('public/sw.js'));
  const result = checkBundle(root);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /dist\/sw\.js does not precache \/assets\/index-a1\.js/);
});

test('a worker without its stamped lists fails the check', () => {
  const root = writeBuild(BUILD);
  writeFileSync(join(root, 'dist', 'sw.js'), "self.addEventListener('fetch', () => {});\n");
  const result = checkBundle(root);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /dist\/sw\.js has no stamped (?:OPTIONAL|PRECACHE) list/);
});

test('a precached file missing from dist fails the check', () => {
  const root = writeBuild(BUILD);
  const stamped = stampServiceWorker(readRepoFile('public/sw.js'), {
    html: SHELL,
    files: [...Object.keys(BUILD), 'assets/Gone-h8.js'],
  });
  writeFileSync(join(root, 'dist', 'sw.js'), stamped);
  const result = checkBundle(root);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /ENOENT[^\n]*Gone-h8\.js/);
});
