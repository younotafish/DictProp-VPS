import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { REMOTE_SHELL, scriptEnv, stub } from './support/deploy.ts';
import { block, readWorkflow, steps } from './support/workflow.ts';

// The Content Enrichment Audit's report and alert steps, run as GitHub runs a step without `shell:`: `bash -e`, no
// pipefail. They read the audit's report from ssh-action's captured output, so these cases feed them that output.
const hasJq = spawnSync('/bin/sh', ['-c', 'command -v jq']).status === 0;
const workflow = readWorkflow('incremental-enrichment.yml');

function stepScript(name: string): string {
  const step = steps(workflow).find(text => text.trimStart().startsWith(`- name: ${name}\n`));
  assert.ok(step, name);
  return block(step, 'run');
}

/** ssh-action's captured stdout: what the remote script printed, then the action's own closing banner. */
const captured = (...lines: string[]): string => [
  ...lines,
  '==============================================',
  '✅ Successfully executed commands to all hosts.',
  '==============================================',
].join('\n');

const report = (alerts: string[]): string => JSON.stringify({ mode: 'audit-only', complete: alerts.length === 0, stall: { alerts } });

function runStep(name: string, env: Record<string, string>) {
  const dir = mkdtempSync(join(tmpdir(), 'enrichment-audit-'));
  try {
    const summary = join(dir, 'summary.md');
    writeFileSync(summary, '');
    const result = spawnSync('bash', ['-e', '-c', stepScript(name)], {
      encoding: 'utf8',
      env: { PATH: process.env.PATH, GITHUB_STEP_SUMMARY: summary, ...env },
    });
    return { status: result.status, output: `${result.stdout}${result.stderr}`, summary: readFileSync(summary, 'utf8') };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const ALERT = 'Alert when local enrichment has stalled';
const COVERAGE = 'Report content coverage';

test('the coverage summary holds exactly the audit report, whatever else the step captured', () => {
  const line = report([]);
  const run = runStep(COVERAGE, { ENRICHMENT_STDOUT: captured('Container dictprop-vps-app-1 Running', line) });
  assert.equal(run.status, 0, run.output);
  assert.equal(run.summary, `### Content enrichment audit (no generation)\n\`\`\`json\n${line}\n\`\`\`\n`);

  // Without a report the summary is empty but the step still passes; the alert step is the one that fails.
  const missing = runStep(COVERAGE, { ENRICHMENT_STDOUT: captured('Container dictprop-vps-app-1 Running') });
  assert.equal(missing.status, 0, missing.output);
  assert.equal(missing.summary, '### Content enrichment audit (no generation)\n```json\n```\n');
});

test('the alert passes on a report without alerts and fails with one error line per alert', { skip: !hasJq && 'jq is not installed' }, () => {
  const quiet = runStep(ALERT, { AUDIT_OUTCOME: 'success', ENRICHMENT_STDOUT: captured('log line', report([])) });
  assert.equal(quiet.status, 0, quiet.output);
  assert.doesNotMatch(quiet.output, /::error::/);

  const stalled = runStep(ALERT, {
    AUDIT_OUTCOME: 'success',
    ENRICHMENT_STDOUT: captured('log line', report(['examples overdue', 'images overdue'])),
  });
  assert.equal(stalled.status, 1, stalled.output);
  assert.deepEqual(stalled.output.trim().split('\n'), ['::error::examples overdue', '::error::images overdue']);
});

test('the alert fails when the audit did not report, or its step failed', { skip: !hasJq && 'jq is not installed' }, () => {
  const cases: Record<string, string>[] = [
    { AUDIT_OUTCOME: 'success', ENRICHMENT_STDOUT: captured('log line') },
    { AUDIT_OUTCOME: 'success', ENRICHMENT_STDOUT: '' },
    { AUDIT_OUTCOME: 'success', ENRICHMENT_STDOUT: captured('{"mode":"audit-only","stall":{}}') },
    { AUDIT_OUTCOME: 'failure', ENRICHMENT_STDOUT: captured(report([])) },
  ];
  for (const env of cases) {
    const run = runStep(ALERT, env);
    assert.equal(run.status, 1, JSON.stringify(env));
    assert.equal(run.output.trim(), '::error::The enrichment audit did not report; see the audit step log.', JSON.stringify(env));
  }
});

/**
 * Runs the audit step's remote script in zsh as on the VPS. Each docker call answers with the next of `answers`: a
 * report without alerts, one with alerts (the audit then exits 1), or an audit killed midway by a container swap.
 */
function audit(answers: ('report' | 'alerts' | 'killed')[]) {
  const dir = mkdtempSync(join(tmpdir(), 'enrichment-audit-remote-'));
  try {
    const bin = join(dir, 'bin');
    const app = join(dir, 'app');
    mkdirSync(bin);
    mkdirSync(app);
    const calls = join(dir, 'calls');
    stub(bin, 'docker', String.raw`
echo "$*" >> "$CALLS"
case "$(echo "$ANSWERS" | cut -d' ' -f"$(wc -l < "$CALLS" | tr -d ' ')")" in
  report) echo '${report([])}' ;;
  alerts) echo '${report(['images overdue'])}'; exit 1 ;;
  *) exit 137 ;;
esac`);
    stub(bin, 'curl', 'exit 0');
    stub(bin, 'sleep', 'exit 0');
    const script = block(readWorkflow('incremental-enrichment.yml'), 'script').replace('cd /opt/dictprop-vps', 'cd "$DEPLOY_DIR"');
    const result = spawnSync(REMOTE_SHELL[0], [...REMOTE_SHELL.slice(1), '-c', script], {
      encoding: 'utf8',
      env: scriptEnv(bin, { DEPLOY_DIR: app, CALLS: calls, ANSWERS: answers.join(' ') }),
    });
    return {
      status: result.status,
      stdout: result.stdout,
      calls: existsSync(calls) ? readFileSync(calls, 'utf8').trim().split('\n').length : 0,
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('an audit that finishes runs once, whether or not it found alerts', () => {
  for (const [answer, alerts] of [['report', []], ['alerts', ['images overdue']]] as const) {
    const run = audit([answer]);
    assert.equal(run.status, 0, run.stdout);
    assert.equal(run.calls, 1, answer);
    assert.equal(run.stdout, `${report([...alerts])}\n`, answer);
  }
});

test('an audit a container swap cut short runs again, and the alert step reads the report of the run that finished', { skip: !hasJq && 'jq is not installed' }, () => {
  const run = audit(['killed', 'report']);
  assert.equal(run.status, 0, run.stdout);
  assert.equal(run.calls, 2);
  assert.match(run.stdout, /The audit printed no report; it runs again once the app answers/);
  const alert = runStep(ALERT, { AUDIT_OUTCOME: 'success', ENRICHMENT_STDOUT: captured(run.stdout.trimEnd()) });
  assert.equal(alert.status, 0, alert.output);

  // Three attempts at most; the alert step then reports that the audit did not report.
  const gone = audit(['killed', 'killed', 'killed', 'report']);
  assert.equal(gone.status, 0, gone.stdout);
  assert.equal(gone.calls, 3);
  assert.doesNotMatch(gone.stdout, /^\{/m);
});
