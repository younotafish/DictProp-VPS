import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { writeJson } from '../support/fs.ts';
import { repoPath } from '../support/paths.ts';

// The cycle always passes prepare-incremental-example-source.mjs a previous source, '-' on its first run, so '-' must
// mean exactly what leaving the argument out does. How the sources are combined is tested in
// server/test/offline-incremental-example-source.test.ts.

const script = repoPath('scripts', 'offline', 'prepare-incremental-example-source.mjs');

const sentence = (id: string, text: string, coverage: { hasAnalysis?: boolean; hasImage?: boolean } = {}) =>
  ({ id, text, textHash: `${id}-hash`, hasAnalysis: false, hasImage: false, ...coverage });

function prepare(root: string, name: string, ...previous: string[]) {
  const output = join(root, `${name}.json`);
  const result = spawnSync(process.execPath, [
    script, join(root, 'current.json'), join(root, 'baseline.json'), output, ...previous,
  ], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const { exportedAt: _exportedAt, ...source } = JSON.parse(readFileSync(output, 'utf8'));
  return { source, summary: JSON.parse(result.stdout) };
}

test("'-' as the previous source is the same as none", t => {
  const root = mkdtempSync(join(tmpdir(), 'incremental-example-source-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeJson(join(root, 'current.json'), {
    version: 1,
    sentences: [sentence('a', 'An older sentence.'), sentence('b', 'A newer sentence.'), sentence('c', 'Covered.', { hasAnalysis: true, hasImage: true })],
    stats: { exampleEnrichmentCoverageAvailable: true, corpusRecords: 3 },
  });
  writeJson(join(root, 'baseline.json'), { version: 1, sentences: [sentence('a', 'An older sentence.')] });
  // The previous cycle saw b with other text; a source passed on keeps that first identity.
  writeJson(join(root, 'previous.json'), { version: 1, sentences: [sentence('b', 'A newer sentence, first seen.')] });

  const omitted = prepare(root, 'omitted');
  const dash = prepare(root, 'dash', '-');
  assert.deepEqual(dash, omitted);
  assert.deepEqual(omitted.source.sentences.map(({ id, text }: { id: string; text: string }) => [id, text]), [
    ['a', 'An older sentence.'], ['b', 'A newer sentence.'],
  ]);
  assert.equal(omitted.summary.previousIncremental, 0);

  const carried = prepare(root, 'carried', join(root, 'previous.json'));
  assert.equal(carried.source.sentences[1].text, 'A newer sentence, first seen.');
  assert.equal(carried.summary.previousIncremental, 1);
});
