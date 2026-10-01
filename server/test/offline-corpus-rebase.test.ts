import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import assert from 'node:assert/strict';
import test from 'node:test';

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function hash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

test('corpus rebasing accepts an ordered chain of verified predecessors', () => {
  const root = mkdtempSync(join(tmpdir(), 'dictprop-rebase-'));
  const paths = Object.fromEntries(['production', 'base', 'target', 'first', 'second', 'output']
    .map(name => [name, join(root, `${name}.json`)]));
  const baseData = { id: 'card-1', word: 'base' };
  const firstData = { id: 'card-1', word: 'first' };
  const secondData = { id: 'card-1', word: 'second' };
  const targetData = { id: 'card-1', word: 'target' };
  const wrap = (data: unknown, sourceHash = hash(baseData)) => ({
    id: 'card-1',
    type: 'vocab',
    data,
    sourceHash,
  });

  writeJson(paths.production, { items: [wrap(secondData)] });
  writeJson(paths.base, { entries: [wrap(baseData)] });
  writeJson(paths.target, { entries: [wrap(targetData)] });
  writeJson(paths.first, { entries: [wrap(firstData)] });
  writeJson(paths.second, { entries: [wrap(secondData, hash(firstData))] });

  const stdout = execFileSync(process.execPath, [
    resolve('..', 'scripts', 'offline', 'prepare-rebased-corpus-delta.mjs'),
    paths.production,
    paths.base,
    paths.target,
    paths.output,
    paths.first,
    paths.second,
  ], { encoding: 'utf8' });
  const report = JSON.parse(stdout);
  const output = JSON.parse(readFileSync(paths.output, 'utf8'));
  assert.equal(report.conflicts, 0);
  assert.equal(report.rebasedFromPredecessor, 1);
  assert.equal(output.entries[0].sourceHash, hash(secondData));
  assert.deepEqual(output.entries[0].data, targetData);
});

function writeExecutable(path: string, contents: string): void {
  writeFileSync(path, contents);
  chmodSync(path, 0o755);
}

// Answers like gh for the corrections publisher. A dispatched export becomes run 43, a run's artifacts
// come from artifacts-<run>.json through the publisher's own --jq filter, and every download fails.
const correctionsGh = `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >> "$FAKE_GH_STATE/gh.log"
case "$*" in
  "workflow run sentence-backfill.yml "* | "run watch "*) ;;
  "run list "*) echo 43 ;;
  "run view 43 "*) echo corpus-export ;;
  "api repos/owner/repo/actions/runs/"*"/artifacts --jq "*)
    run="\${2#repos/owner/repo/actions/runs/}"
    jq -r "$4" "$FAKE_GH_STATE/artifacts-\${run%/artifacts}.json" ;;
  "run download "*) exit 1 ;;
  *)
    echo "unexpected gh invocation: $*" >&2
    exit 1 ;;
esac
`;

test('corrections publisher drops a saved export run whose artifact is gone, and the next run requests a fresh export', () => {
  const root = mkdtempSync(join(tmpdir(), 'dictprop-corrections-'));
  try {
    const bin = join(root, 'bin');
    const ghState = join(root, 'gh-state');
    const work = join(root, 'work');
    mkdirSync(bin);
    mkdirSync(ghState);
    mkdirSync(work);
    writeExecutable(join(bin, 'gh'), correctionsGh);
    writeExecutable(join(bin, 'sleep'), '#!/bin/sh\nexit 0\n');
    for (const name of ['ready', 'base.json', 'target.json', 'key']) writeFileSync(join(root, name), 'x\n');
    const runIdFile = join(work, 'production-export-run-id');
    const publish = () => spawnSync('bash', [
      resolve('..', 'scripts', 'offline', 'publish-ready-corpus-corrections.sh'),
      join(root, 'ready'), join(root, 'base.json'), join(root, 'target.json'),
    ], {
      cwd: resolve('..'),
      encoding: 'utf8',
      timeout: 60_000,
      env: {
        ...process.env,
        CORPUS_FINAL_WAVE_STATE_ROOT: join(root, 'waves'),
        CORPUS_REBASE_WORK_ROOT: work,
        FAKE_GH_STATE: ghState,
        GH_BIN: join(bin, 'gh'),
        GITHUB_REPOSITORY: 'owner/repo',
        PATH: `${bin}:${process.env.PATH ?? ''}`,
        SENTENCE_BRIDGE_KEY_FILE: join(root, 'key'),
        TMPDIR: root,
      },
    });
    const ghLog = () => readFileSync(join(ghState, 'gh.log'), 'utf8');

    // Run 42's artifact was deleted by an earlier fetch, or expired, so waiting on that run again is useless.
    for (const artifacts of [[], [{ id: 7, name: 'corpus-export', expired: true }]]) {
      writeFileSync(runIdFile, '42\n');
      writeJson(join(ghState, 'artifacts-42.json'), { total_count: artifacts.length, artifacts });
      const stale = publish();
      assert.equal(stale.status, 1, stale.stderr);
      assert.match(stale.stdout,
        /artifact corpus-export of run 42 is gone; removed the saved run id, so the next run requests a fresh export/);
      assert.equal(existsSync(runIdFile), false);
      assert.match(ghLog(), /^run watch 42 --repo owner\/repo --exit-status$/m);
      assert.doesNotMatch(ghLog(), /^(workflow run|run download) /m);
    }

    // The next run dispatches a fresh export and goes on to fetch its artifact.
    writeJson(join(ghState, 'artifacts-43.json'), { total_count: 2, artifacts: [
      { id: 8, name: 'sentence-export', expired: false },
      { id: 9, name: 'corpus-export', expired: false },
    ] });
    const fresh = publish();
    assert.equal(fresh.status, 1);
    assert.match(ghLog(), /^workflow run sentence-backfill\.yml --repo owner\/repo --ref main -f operation=corpus-export$/m);
    assert.match(ghLog(), /^run download 43 --repo owner\/repo -n corpus-export -D /m);
    assert.match(fresh.stderr, /Could not download artifact corpus-export of run 43 after 5 attempts/);
    assert.equal(readFileSync(runIdFile, 'utf8'), '43\n');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
