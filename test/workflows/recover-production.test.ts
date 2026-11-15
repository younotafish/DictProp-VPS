import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { REMOTE_SHELL, RUN_ID, scriptEnv, stub } from './support/deploy.ts';
import { block, readWorkflow } from './support/workflow.ts';

// Recover Production App exists for an app that is down, so it must work on a container that is stopped or
// crash-looping, which refuses `docker compose exec`.

const script = (name: string): string => block(readWorkflow(name), 'script', { 'github.run_id': RUN_ID, 'github.run_attempt': '1' });

/** A shell function's definition in a script, without its comments. */
function definition(text: string, name: string): string {
  const lines = text.split('\n');
  const start = lines.indexOf(`${name}() {`);
  assert.notEqual(start, -1, name);
  const end = lines.indexOf('}', start);
  return lines.slice(start, end + 1).filter(line => !/^\s*#/.test(line)).join('\n');
}

test("Recover waits for health and reports the container exactly as the deploy does", () => {
  for (const name of ['wait_for_health', 'report_container']) {
    assert.equal(definition(script('recover-production.yml'), name), definition(script('deploy.yml'), name), name);
  }
});

function recover(variables: Record<string, string>) {
  const dir = mkdtempSync(join(tmpdir(), 'recover-production-'));
  try {
    const bin = join(dir, 'bin');
    const app = join(dir, 'app');
    mkdirSync(bin);
    mkdirSync(app);
    const calls = join(dir, 'calls.log');
    const state = join(dir, 'state');
    writeFileSync(state, 'restarting');
    stub(bin, 'docker', String.raw`
printf 'docker %s %s\n' "$1" "$2" >> "$CALLS"
case "$1 $2" in
  'compose restart') echo running > "$STATE" ;;
  'compose ps') echo app-container ;;
  'compose exec') echo 'Error response from daemon: Container app-container is restarting' >&2; exit 1 ;;
  'inspect --format') echo "App container: $(cat "$STATE"), exit code 1, 4 restarts, OOM-killed false" ;;
  'logs --timestamps')
    echo '2026-11-15T00:00:00Z Server running on port 3000'
    echo '2026-11-15T00:00:01Z Error: could not save "a private sentence"' ;;
  *) echo "unexpected docker $*" >&2; exit 97 ;;
esac`);
    stub(bin, 'curl', String.raw`[ "$(cat "$STATE")" = running ] && [ -z "$FAIL_HEALTH" ]`);
    stub(bin, 'sleep', 'exit 0');
    // Three health checks decide what 120 would against a stub that always answers the same way.
    const text = script('recover-production.yml')
      .replace('cd /opt/dictprop-vps', 'cd "$DEPLOY_DIR"')
      .replace('for attempt in $(seq 1 120); do', 'for attempt in $(seq 1 3); do');
    const result = spawnSync(REMOTE_SHELL[0], [...REMOTE_SHELL.slice(1), '-c', text], {
      cwd: app,
      encoding: 'utf8',
      env: scriptEnv(bin, { DEPLOY_DIR: app, CALLS: calls, STATE: state, ...variables }),
    });
    const logs = join(app, 'data', 'deploy-logs');
    return {
      status: result.status,
      output: `${result.stdout}${result.stderr}`,
      calls: existsSync(calls) ? readFileSync(calls, 'utf8').trim().split('\n') : [],
      logsMode: existsSync(logs) ? statSync(logs).mode & 0o777 : undefined,
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('a crash-looping app is restarted without an exec into it, and recovers', () => {
  const run = recover({});
  assert.equal(run.status, 0, run.output);
  assert.match(run.output, /Production app recovered/);
  // The state before the restart, which the restart resets, reaches the log first.
  assert.match(run.output, /App container: restarting, exit code 1, 4 restarts, OOM-killed false/);
  assert.deepEqual(run.calls.filter(call => call.startsWith('docker compose')), ['docker compose ps', 'docker compose restart']);
});

test('an app that stays unhealthy fails red with its state and masked log lines', () => {
  const run = recover({ FAIL_HEALTH: '1' });
  assert.equal(run.status, 1, run.output);
  assert.match(run.output, /::error::The app did not become healthy after the restart/);
  assert.match(run.output, /App container: running, exit code 1/);
  assert.match(run.output, /Error: could not save "\.\.\."/);
  assert.doesNotMatch(run.output, /private sentence/);
  assert.match(run.output, new RegExp(`/opt/dictprop-vps/data/deploy-logs/${RUN_ID}-1-recover\\.log`));
  assert.equal(run.logsMode, 0o700);
});
