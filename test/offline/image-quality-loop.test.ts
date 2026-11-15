import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { writeExecutable, writeJson } from '../support/fs.ts';
import { REPO_ROOT, repoPath } from '../support/paths.ts';

// How run-streaming-image-quality-loop.sh drives the renderer: the arguments of each render and what a
// signal does to a render in progress. The judging side is covered in offline-image-resume.test.ts.

// Stands in for the mflux Python: records its arguments and pid, then fails, or renders until stopped.
const RENDERER = `#!/bin/sh
printf '%s\\n' "$*" >> "$FAKE_RENDER_LOG"
printf '%s\\n' "$$" > "$FAKE_RENDER_PID"
if [ "$FAKE_RENDER" = hang ]; then exec sleep 30; fi
exit 1
`;

function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'dictprop-image-loop-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const renderer = join(root, 'python');
  writeExecutable(renderer, RENDERER);
  const targets = join(root, 'targets.json');
  writeJson(targets, { version: 1, targets: [{ imageId: 'one', filename: 'one.webp', prompt: 'A dugout full of players.' }] });
  return {
    root,
    targets,
    args: [
      repoPath('scripts', 'offline', 'run-streaming-image-quality-loop.sh'),
      targets, join(root, 'candidates'), join(root, 'images'), join(root, 'work'), '1024', '576', '8', '1', '64',
    ],
    env: {
      ...process.env,
      KREA_PYTHON: renderer,
      FAKE_RENDER_LOG: join(root, 'render.log'),
      FAKE_RENDER_PID: join(root, 'render.pid'),
      IMAGE_QUALITY_RETRY_DELAY_SECONDS: '0',
    },
  };
}

test('each round renders in one call with the configured model and quantization, retried as a whole', t => {
  const { root, targets, args, env } = fixture(t);
  const result = spawnSync('bash', args, {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    timeout: 60_000,
    env: { ...env, IMAGE_MODEL: 'ernie-image-turbo', IMAGE_MODEL_QUANTIZE: '8', IMAGE_QUALITY_RETRY_LIMIT: '2' },
  });

  assert.equal(result.status, 1, result.stderr);
  const render = `scripts/offline/generate-krea-candidates.py ${targets} ${join(root, 'candidates')} --candidate-start 1 --candidates 1`
    + ` --width 1024 --height 576 --steps 8 --accepted-directory ${join(root, 'images')} --model ernie-image-turbo --quantize 8`;
  assert.deepEqual(readFileSync(join(root, 'render.log'), 'utf8').trim().split('\n'), [render, render]);
  assert.match(result.stderr, /command failed 2 time\(s\); giving up: generate_candidates /);
});

test('a TERM ends the loop with 143 and stops the render in progress', async t => {
  const { root, args, env } = fixture(t);
  const child = spawn('bash', args, { cwd: REPO_ROOT, env: { ...env, FAKE_RENDER: 'hang' }, stdio: 'ignore' });
  const closed = new Promise<number | null>(resolvePromise => child.on('close', code => resolvePromise(code)));
  const pidFile = join(root, 'render.pid');
  const deadline = Date.now() + 30_000;
  while (!existsSync(pidFile) || readFileSync(pidFile, 'utf8').trim() === '') {
    assert.ok(Date.now() < deadline, 'the renderer never started');
    await new Promise(resolvePromise => setTimeout(resolvePromise, 50));
  }
  const rendererPid = Number(readFileSync(pidFile, 'utf8').trim());

  const stopped = Date.now();
  child.kill('SIGTERM');
  assert.equal(await closed, 143);
  // The render would have run for 30 s; the loop's trap stopped it.
  assert.ok(Date.now() - stopped < 15_000);
  assert.throws(() => process.kill(rendererPid, 0), { code: 'ESRCH' });
});
