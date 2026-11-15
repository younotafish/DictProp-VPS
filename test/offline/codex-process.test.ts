import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { repoPath } from '../support/paths.ts';

const helpers = pathToFileURL(repoPath('scripts', 'offline', 'codex-process.mjs')).href;

// A stand-in for a model stage: it starts one model CLI in a process group of its own, prints its pid, and then
// either waits for a signal or crashes.
const stage = `
import { spawn } from 'node:child_process';
const { DETACHED_PROCESS_GROUPS, installSignalCleanup } = await import(${JSON.stringify(helpers)});
const activeChildren = new Set();
installSignalCleanup(activeChildren);
const cli = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: DETACHED_PROCESS_GROUPS, stdio: 'ignore' });
activeChildren.add(cli);
process.stdout.write(cli.pid + '\\n');
if (process.argv[1] === 'crash') setTimeout(() => { throw new Error('the stage crashed'); }, 50);
setInterval(() => {}, 1000);
`;

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function startStage(mode: 'wait' | 'crash') {
  const child = spawn(process.execPath, ['--input-type=module', '-e', stage, mode], { stdio: ['ignore', 'pipe', 'pipe'] });
  const exited = once(child, 'exit') as Promise<[number | null, string | null]>;
  const [line] = await once(child.stdout, 'data') as [Buffer];
  return { child, exited, cliPid: Number(String(line).trim()) };
}

async function assertStopped(pid: number) {
  const deadline = Date.now() + 5_000;
  while (alive(pid)) {
    assert.ok(Date.now() < deadline, `model CLI ${pid} is still running`);
    await new Promise(resolve => setTimeout(resolve, 50));
  }
}

test('a hangup stops the model CLIs and exits with 129', async () => {
  const { child, exited, cliPid } = await startStage('wait');
  assert.ok(alive(cliPid));
  child.kill('SIGHUP');
  assert.deepEqual(await exited, [129, null]);
  await assertStopped(cliPid);
});

test('a stage that crashes takes its model CLIs with it', async () => {
  const { exited, cliPid } = await startStage('crash');
  assert.deepEqual(await exited, [1, null]);
  await assertStopped(cliPid);
});
