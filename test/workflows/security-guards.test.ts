import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { readRepoFile, SERVER_DIR } from '../support/paths.ts';

/** Loads env.ts in a child process with the given variables and reports how it went. */
const loadEnv = (vars: Record<string, string>) => spawnSync(process.execPath, ['--import', 'tsx', 'src/env.ts'], {
  cwd: SERVER_DIR,
  env: { ...process.env, ...vars },
  encoding: 'utf8',
});

/** What env.ts's listenOptions returns for each environment, with env.ts loaded in a child process as loadEnv loads it. */
function listenOptionsFor(...environments: { PORT: number; DEV_AUTH_BYPASS: boolean }[]): unknown {
  const script = `import { listenOptions } from './src/env.ts';
    process.stdout.write(JSON.stringify(${JSON.stringify(environments)}.map(environment => listenOptions(environment))));`;
  const child = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], {
    cwd: SERVER_DIR,
    encoding: 'utf8',
  });
  assert.equal(child.status, 0, child.stderr);
  return JSON.parse(child.stdout);
}

test('the auth bypass is refused in production and stays on loopback in development', () => {
  const production = loadEnv({ NODE_ENV: 'production', DEV_AUTH_BYPASS: '1' });
  assert.notEqual(production.status, 0);
  assert.match(production.stderr, /DEV_AUTH_BYPASS=1 would make every visitor an admin/);

  const development = loadEnv({ NODE_ENV: 'development', DEV_AUTH_BYPASS: '1' });
  assert.equal(development.status, 0, development.stderr);

  // The image runs as production, and a bypassed server or dev proxy listens on loopback only.
  assert.match(readRepoFile('Dockerfile'), /^ENV NODE_ENV=production$/m);
  assert.deepEqual(listenOptionsFor({ PORT: 1, DEV_AUTH_BYPASS: true }, { PORT: 1, DEV_AUTH_BYPASS: false }), [
    { port: 1, hostname: '127.0.0.1' },
    { port: 1 },
  ]);
  assert.match(readRepoFile('server/src/index.ts'), /\blistenOptions\(\)/, 'the server listens where listenOptions says');
  assert.match(readRepoFile('vite.config.ts'), /host: process\.env\.DEV_LAN === '1' \? '0\.0\.0\.0' : '127\.0\.0\.1'/);
});
