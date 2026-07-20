import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
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
