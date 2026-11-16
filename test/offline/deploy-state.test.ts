import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { writeExecutable } from '../support/fs.ts';
import { repoPath } from '../support/paths.ts';

// Answers like gh, --jq included, from JSON files in FAKE_STATE: successful-deploys.json for the successful deploy
// runs, compare-<head>.json for GitHub's comparison of a commit with <head>, runs-<workflow>.json for a workflow's
// newest runs. A missing run list is empty; a file that holds "fail" answers like a failed API call.
const FAKE_GH = `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >> "$FAKE_STATE/gh.log"
filter=.
workflow=
previous=
for arg in "$@"; do
  if [ "$previous" = --jq ]; then filter="$arg"; fi
  if [ "$previous" = --workflow ]; then workflow="$arg"; fi
  previous="$arg"
done
answer() {
  local file="$FAKE_STATE/$1" body="$2"
  if [ -f "$file" ]; then body="$(cat "$file")"; fi
  if [ "$body" = fail ]; then echo 'HTTP 502: Bad Gateway' >&2; exit 1; fi
  printf '%s\\n' "$body" | jq -r "$filter"
}
case "$*" in
  "run list "*"--status success"*) answer successful-deploys.json '[]' ;;
  "api repos/"*"/compare/"*) answer "compare-\${2##*...}.json" fail ;;
  "run list "*"--json status "*) answer "runs-$workflow.json" '[]' ;;
  *) echo "unexpected gh invocation: $*" >&2; exit 1 ;;
esac
`;

const SHA = 'a'.repeat(40);
const NEWER = 'b'.repeat(40);
const OLDER = 'c'.repeat(40);
const OTHER = 'd'.repeat(40);

/** Sources deploy-state.sh as the scripts do, with gh answering from `files`, and runs one call. */
function call(command: string, files: Record<string, unknown> = {}) {
  const state = mkdtempSync(join(tmpdir(), 'deploy-state-'));
  try {
    const gh = join(state, 'gh');
    writeExecutable(gh, FAKE_GH);
    for (const [name, value] of Object.entries(files)) {
      writeFileSync(join(state, name), value === 'fail' ? 'fail' : JSON.stringify(value));
    }
    writeFileSync(join(state, 'gh.log'), '');
    // The callers run under set -u and pipefail, and the cycle and the backup under set -e too, which a function
    // called with || to keep its status leaves off.
    const result = spawnSync('bash', ['-c', [
      'set -euo pipefail',
      `. '${repoPath('scripts', 'offline', 'deadline.sh')}'`,
      `. '${repoPath('scripts', 'offline', 'deploy-state.sh')}'`,
      `status=0; ${command} || status=$?; echo "status=$status"`,
    ].join('\n')], {
      encoding: 'utf8',
      env: { PATH: process.env.PATH, GH_BIN: gh, GITHUB_REPOSITORY: 'owner/repo', FAKE_STATE: state },
    });
    assert.equal(result.status, 0, result.stderr);
    return {
      status: Number(/status=(\d+)\s*$/.exec(result.stdout)?.[1]),
      calls: readFileSync(join(state, 'gh.log'), 'utf8').split('\n').filter(line => line !== ''),
    };
  } finally {
    rmSync(state, { recursive: true, force: true });
  }
}

const deploys = (...heads: string[]) => heads.map(headSha => ({ headSha }));
const compare = (status: string) => ({ status });
const runs = (...statuses: string[]) => statuses.map(status => ({ status }));

test('production carries a commit that a successful deployment from main ran or contains', () => {
  const exact = call(`production_carries ${SHA}`, { 'successful-deploys.json': deploys(SHA) });
  assert.equal(exact.status, 0);
  assert.deepEqual(exact.calls, [
    'run list --repo owner/repo --workflow deploy.yml --branch main --status success --limit 5 --json headSha --jq .[].headSha',
  ]);

  // The newest successful run is a rerun of an older commit; the one before it deployed a commit containing SHA.
  const ahead = call(`production_carries ${SHA}`, {
    'successful-deploys.json': deploys(OLDER, NEWER),
    [`compare-${OLDER}.json`]: compare('behind'),
    [`compare-${NEWER}.json`]: compare('ahead'),
  });
  assert.equal(ahead.status, 0);
  assert.deepEqual(ahead.calls.slice(1), [
    `api repos/owner/repo/compare/${SHA}...${OLDER} --jq .status`,
    `api repos/owner/repo/compare/${SHA}...${NEWER} --jq .status`,
  ]);
  assert.equal(call(`production_carries ${SHA}`, {
    'successful-deploys.json': deploys(NEWER), [`compare-${NEWER}.json`]: compare('identical'),
  }).status, 0);
});

test('production does not carry a commit no successful deployment contains, and a failed query cannot tell', () => {
  assert.equal(call(`production_carries ${SHA}`, {
    'successful-deploys.json': deploys(OLDER, OTHER),
    [`compare-${OLDER}.json`]: compare('behind'),
    [`compare-${OTHER}.json`]: compare('diverged'),
  }).status, 1);
  assert.equal(call(`production_carries ${SHA}`).status, 1, 'no successful deployment at all');

  assert.equal(call(`production_carries ${SHA}`, { 'successful-deploys.json': 'fail' }).status, 2);
  assert.equal(call(`production_carries ${SHA}`, {
    'successful-deploys.json': deploys(OLDER, OTHER),
    [`compare-${OLDER}.json`]: 'fail',
    [`compare-${OTHER}.json`]: compare('behind'),
  }).status, 2);
  // A comparison that fails says nothing; another deployment that contains the commit still proves it.
  assert.equal(call(`production_carries ${SHA}`, {
    'successful-deploys.json': deploys(OLDER, NEWER),
    [`compare-${OLDER}.json`]: 'fail',
    [`compare-${NEWER}.json`]: compare('ahead'),
  }).status, 0);
});

test('a workflow is in flight while one of its newest runs has not completed', () => {
  for (const status of ['queued', 'in_progress', 'waiting', 'requested', 'pending']) {
    const result = call('workflow_in_flight sentence-backfill.yml', { 'runs-sentence-backfill.yml.json': runs('completed', status) });
    assert.equal(result.status, 0, status);
  }
  const idle = call('workflow_in_flight sentence-backfill.yml', { 'runs-sentence-backfill.yml.json': runs('completed', 'completed') });
  assert.equal(idle.status, 1);
  assert.deepEqual(idle.calls, [
    'run list --repo owner/repo --workflow sentence-backfill.yml --limit 10 --json status --jq [.[] | select(.status != "completed")] | length',
  ]);
  assert.equal(call('workflow_in_flight sentence-backfill.yml').status, 1, 'no runs at all');
  assert.equal(call('workflow_in_flight sentence-backfill.yml', { 'runs-sentence-backfill.yml.json': 'fail' }).status, 2);

  const deploy = call('deploy_in_flight', { 'runs-deploy.yml.json': runs('in_progress') });
  assert.equal(deploy.status, 0);
  assert.match(deploy.calls[0], /--workflow deploy\.yml /);
});

test('production is busy while any workflow with a dictprop-production job has a run in flight', () => {
  const idle = call('production_busy');
  assert.equal(idle.status, 1);
  assert.deepEqual(idle.calls.map(line => /--workflow (\S+)/.exec(line)?.[1]),
    ['deploy.yml', 'sentence-backfill.yml', 'recover-production.yml', 'offsite-backup.yml']);

  for (const workflow of ['deploy.yml', 'sentence-backfill.yml', 'recover-production.yml', 'offsite-backup.yml']) {
    assert.equal(call('production_busy', { [`runs-${workflow}.json`]: runs('queued') }).status, 0, workflow);
  }
  assert.equal(call('production_busy', { 'runs-sentence-backfill.yml.json': 'fail' }).status, 2);
  // A run known to be in flight settles it, whatever another query says.
  assert.equal(call('production_busy', {
    'runs-sentence-backfill.yml.json': 'fail', 'runs-recover-production.yml.json': runs('pending'),
  }).status, 0);
});
