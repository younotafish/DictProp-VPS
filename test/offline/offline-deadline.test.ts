import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const deadlineScript = fileURLToPath(new URL('../../scripts/offline/deadline.sh', import.meta.url));

function bash(body: string, env: Record<string, string> = {}, input?: string) {
  return spawnSync('/bin/bash', ['-c', `set -euo pipefail\n. "$DEADLINE_SH"\n${body}`], {
    encoding: 'utf8',
    env: { ...process.env, DEADLINE_SH: deadlineScript, ...env },
    input,
    timeout: 60_000,
  });
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

async function waitFor(condition: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`condition not met within ${timeoutMs}ms`);
    await new Promise(resolvePromise => setTimeout(resolvePromise, 50));
  }
}

test('run_bounded exits with the command status', () => {
  const result = bash('status=0; run_bounded 5 bash -c "exit 7" || status=$?; echo "status=$status"');
  assert.equal(result.stdout.trim(), 'status=7', result.stderr);
});

test('run_bounded stops a command at its limit and exits 124 like timeout(1)', () => {
  const started = Date.now();
  const result = bash('status=0; run_bounded 1 sleep 30 || status=$?; echo "status=$status"');
  assert.equal(result.stdout.trim(), 'status=124', result.stderr);
  assert.match(result.stderr, /run_bounded: gave up after 1s: sleep 30/);
  assert.ok(Date.now() - started < 10_000);
});

test('run_bounded reports a command killed by a signal as 128 plus the signal', () => {
  const result = bash(`status=0; run_bounded 5 bash -c 'kill -TERM $$' || status=$?; echo "status=$status"`);
  assert.equal(result.stdout.trim(), 'status=143', result.stderr);
});

test('run_bounded reports a missing command and bad usage', () => {
  const missing = bash('status=0; run_bounded 5 /nonexistent/command || status=$?; echo "status=$status"');
  assert.equal(missing.stdout.trim(), 'status=127');
  assert.match(missing.stderr, /run_bounded: cannot run \/nonexistent\/command/);
  const usage = bash('status=0; run_bounded 0 true || status=$?; echo "status=$status"');
  assert.equal(usage.stdout.trim(), 'status=2');
  assert.match(usage.stderr, /run_bounded: usage/);
});

test('run_bounded kills a command that ignores TERM together with the processes it started', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dictprop-run-bounded-'));
  try {
    const pidFile = join(root, 'grandchild.pid');
    const started = Date.now();
    const result = bash(`status=0
run_bounded 1 bash -c 'trap "" TERM; sleep 60 & echo $! > "$0"; wait' "$PID_FILE" || status=$?
echo "status=$status"`, { PID_FILE: pidFile });
    const elapsed = Date.now() - started;
    assert.equal(result.stdout.trim(), 'status=124', result.stderr);
    assert.ok(elapsed >= 5_000 && elapsed < 15_000, `took ${elapsed}ms`);
    const grandchild = Number(readFileSync(pidFile, 'utf8').trim());
    await waitFor(() => !processAlive(grandchild), 5_000);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a stop signal ends a caller waiting in run_stage, and its exit trap stops the stage', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dictprop-run-stage-'));
  try {
    const harness = join(root, 'harness.sh');
    const lock = join(root, 'cycle.lock');
    const stagePidFile = join(root, 'stage.pid');
    // The same lock and trap arrangement as the incremental runner.
    writeFileSync(harness, `set -euo pipefail
. "$1"
lock="$2"
touch "$lock"
cleanup() {
  stop_stage
  rm -f "$lock"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
run_stage 60 bash -c 'echo $$ > "$0"; trap "" TERM; exec sleep 30' "$3"
echo unreachable
`);
    const child = spawn('/bin/bash', [harness, deadlineScript, lock, stagePidFile], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    const closed = new Promise<number | null>(resolvePromise => child.on('close', code => resolvePromise(code)));
    await waitFor(() => existsSync(stagePidFile) && readFileSync(stagePidFile, 'utf8').trim() !== '');
    const stagePid = Number(readFileSync(stagePidFile, 'utf8').trim());

    const signalledAt = Date.now();
    child.kill('SIGTERM');
    const code = await closed;
    assert.equal(code, 143);
    assert.ok(Date.now() - signalledAt < 15_000);
    assert.equal(existsSync(lock), false);
    assert.doesNotMatch(stdout, /unreachable/);
    await waitFor(() => !processAlive(stagePid), 5_000);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('deadline helpers compare wall-clock seconds and print GitHub timestamps', () => {
  const result = bash(`start=$(date +%s)
deadline=$(deadline_after 100)
echo "offset=$((deadline - start))"
if deadline_passed "$deadline"; then echo "future deadline passed"; fi
if deadline_passed "$((start - 1))"; then echo "past deadline passed"; fi
utc_timestamp_ago 120`);
  assert.equal(result.status, 0, result.stderr);
  const [offset, passed, timestamp, ...rest] = result.stdout.trim().split('\n');
  assert.match(offset, /^offset=10[01]$/);
  assert.equal(passed, 'past deadline passed');
  assert.deepEqual(rest, []);
  assert.match(timestamp, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
  const skewSeconds = (Date.now() - Date.parse(timestamp)) / 1_000;
  assert.ok(skewSeconds >= 119 && skewSeconds < 135, `skew ${skewSeconds}s`);
});

test('cap_publish_deadline holds a publisher to five hours, inside the sweep of releases idle for six', () => {
  for (const [value, expected] of [
    ['7200', '7200'], ['18000', '18000'], ['18001', '18000'], ['86400', '18000'], ['99999999999999999999999', '18000'],
  ]) {
    const result = bash('log() { echo "log: $*"; }\ncap_publish_deadline\necho "deadline=$PUBLISH_DEADLINE_SECONDS"', {
      PUBLISH_DEADLINE_SECONDS: value,
    });
    assert.equal(result.status, 0, result.stderr);
    const capped = value === expected ? [] : [
      `log: PUBLISH_DEADLINE_SECONDS=${value} would outlast the sweep, which deletes a release idle for six hours; capping it at 18000s`,
    ];
    assert.deepEqual(result.stdout.trim().split('\n'), [...capped, `deadline=${expected}`], value);
  }
});

test('gh_bounded limits a stalled GitHub call and never lets it read the caller input', () => {
  const root = mkdtempSync(join(tmpdir(), 'dictprop-gh-bounded-'));
  try {
    const slowGh = join(root, 'slow-gh');
    writeFileSync(slowGh, '#!/bin/sh\nsleep 30\n');
    const readingGh = join(root, 'reading-gh');
    writeFileSync(readingGh, '#!/bin/sh\nif read -r line; then echo "read $line"; else echo closed; fi\n');
    chmodSync(slowGh, 0o700);
    chmodSync(readingGh, 0o700);

    const started = Date.now();
    const slow = bash('status=0; gh_bounded run list || status=$?; echo "status=$status"', {
      GH_BIN: slowGh,
      GH_CALL_TIMEOUT_SECONDS: '1',
    });
    assert.equal(slow.stdout.trim(), 'status=124', slow.stderr);
    assert.ok(Date.now() - started < 10_000);

    const reading = bash('gh_bounded run list', { GH_BIN: readingGh }, 'secret\n');
    assert.equal(reading.stdout.trim(), 'closed', reading.stderr);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
