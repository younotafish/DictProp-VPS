import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
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
  const run = runStep(COVERAGE, { ENRICHMENT_STDOUT: captured('Container dictprop-vps-app-1 Running', line), ENRICHMENT_STDERR: '' });
  assert.equal(run.status, 0, run.output);
  assert.equal(run.summary, `### Content enrichment audit (no generation)\n\`\`\`json\n${line}\n\`\`\`\n`);

  // Without a report the summary is empty but the step still passes; the alert step is the one that fails.
  const missing = runStep(COVERAGE, { ENRICHMENT_STDOUT: captured('Container dictprop-vps-app-1 Running'), ENRICHMENT_STDERR: '' });
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
