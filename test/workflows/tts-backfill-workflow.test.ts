import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { GNU_STAT, REMOTE_SHELL, scriptEnv, stub } from './support/deploy.ts';
import { block, readWorkflow } from './support/workflow.ts';

// TTS Backfill starts the detached worker and prints its status. A status the worker hasn't rewritten since the step
// began is an earlier run's, possibly twelve hours old, so it must not be printed as this run's.

const STALE = '{"running": false, "startedAt": 1}';
const FRESH = '{"running": true, "startedAt": 2}';

function startWorker(variables: Record<string, string>, staleStatus: boolean) {
  const dir = mkdtempSync(join(tmpdir(), 'tts-backfill-'));
  try {
    const bin = join(dir, 'bin');
    const data = join(dir, 'app', 'data');
    mkdirSync(bin);
    mkdirSync(data, { recursive: true });
    if (staleStatus) {
      const status = join(data, 'tts-backfill-status.json');
      writeFileSync(status, `${STALE}\n`);
      const twelveHoursAgo = Date.now() / 1000 - 12 * 60 * 60;
      utimesSync(status, twelveHoursAgo, twelveHoursAgo);
    }
    // A worker that starts writes its status at once; one that finds another running exits without writing.
    stub(bin, 'docker', String.raw`
[ "$1 $2 $3 $4" = 'compose exec -d app' ] || { echo "unexpected docker $*" >&2; exit 97; }
[ -n "$WORKER_RUNNING_ELSEWHERE" ] || echo "$FRESH" > data/tts-backfill-status.json`);
    stub(bin, 'stat', GNU_STAT);
    stub(bin, 'sleep', 'exit 0');
    const script = block(readWorkflow('tts-backfill.yml'), 'script').replace('cd /opt/dictprop-vps', 'cd "$DEPLOY_DIR"');
    const result = spawnSync(REMOTE_SHELL[0], [...REMOTE_SHELL.slice(1), '-c', script], {
      encoding: 'utf8',
      env: scriptEnv(bin, { DEPLOY_DIR: join(dir, 'app'), FRESH, ...variables }),
    });
    return { status: result.status, output: `${result.stdout}${result.stderr}`.trim() };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("the step prints the status the worker it started wrote, not the last run's", () => {
  for (const stale of [false, true]) {
    const run = startWorker({}, stale);
    assert.equal(run.status, 0, run.output);
    assert.equal(run.output, FRESH);
  }
});

test('without a fresh status the step says so instead of printing a stale one', () => {
  const run = startWorker({ WORKER_RUNNING_ELSEWHERE: '1' }, true);
  assert.equal(run.status, 0, run.output);
  assert.equal(run.output, 'The TTS worker was started, or was already running, but has not written a status yet');
});
