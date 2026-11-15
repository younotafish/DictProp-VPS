import { spawnSync } from 'node:child_process';
import { SERVER_DIR } from './paths.js';

/**
 * Runs server/src/scripts/<name>.ts in a process of its own, as production runs the importers, with `env` added to
 * this process's environment. NODE_TEST_CONTEXT stays out, or the child would report to the test runner instead of
 * running. Returns the exit status, stderr, and the last line of stdout parsed as JSON.
 */
export function runServerScript(name: string, args: readonly string[], env: NodeJS.ProcessEnv = {}) {
  const { NODE_TEST_CONTEXT: _testContext, ...parentEnv } = process.env;
  const child = spawnSync(process.execPath, ['--import', 'tsx', `src/scripts/${name}.ts`, ...args], {
    cwd: SERVER_DIR,
    env: { ...parentEnv, ...env },
    encoding: 'utf8',
  });
  const lines = child.stdout.trim().split('\n');
  return { status: child.status, stderr: child.stderr, output: JSON.parse(lines[lines.length - 1] || 'null') };
}
