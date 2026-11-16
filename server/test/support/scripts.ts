import { spawnSync } from 'node:child_process';
import { SERVER_DIR } from './paths.js';

/**
 * Runs server/src/scripts/<name>.ts in a process of its own, as production runs the scripts, with `env` added to this
 * process's environment, whose DATA_DIR is the test's database. Returns the exit status and the raw output.
 * NODE_TEST_CONTEXT stays out, or the child would report to the test runner instead of running.
 */
export function spawnScript(name: string, args: readonly string[] = [], env: NodeJS.ProcessEnv = {}) {
  const { NODE_TEST_CONTEXT: _testContext, ...parentEnv } = process.env;
  const child = spawnSync(process.execPath, ['--import', 'tsx', `src/scripts/${name}.ts`, ...args], {
    cwd: SERVER_DIR,
    env: { ...parentEnv, ...env },
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  return { status: child.status, stdout: child.stdout, stderr: child.stderr };
}

/** A script's report: the last line of its output, parsed. */
export const lastJsonLine = (stdout: string) => JSON.parse(stdout.trim().split('\n').at(-1) || 'null');

/** spawnScript for an importer, whose report is its last line of output: the exit status, stderr and that report. */
export function runServerScript(name: string, args: readonly string[], env: NodeJS.ProcessEnv = {}) {
  const { status, stdout, stderr } = spawnScript(name, args, env);
  return { status, stderr, output: lastJsonLine(stdout) };
}
