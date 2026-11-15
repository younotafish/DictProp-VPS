import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { exampleSentenceId, sentenceLookupHash, sentenceTextHash } from '../../scripts/offline/sentence-pool.mjs';
import { writeJson } from '../support/fs.ts';
import { repoPath } from '../support/paths.ts';

const script = repoPath('scripts', 'offline', 'build-essay-sentence-pool.mjs');

interface PoolRecord {
  id: string;
  text: string;
  sourceWord: string;
  sourceSense: string;
  contextBefore?: string;
  contextAfter?: string;
  textHash: string;
  lookupHash: string;
  provenance: Array<{ essaySentenceId: string; essayId: string }>;
}

const body = (id: string, sentences: Array<[string, string, string]>) => ({
  kind: 'body', id, sentences: sentences.map(([sentenceId, text, focus]) => ({ id: sentenceId, text, focus })),
});
const catalog = {
  version: 1,
  essays: [
    {
      id: 'first',
      title: 'First Essay',
      author: 'A. Writer',
      paragraphs: [
        { kind: 'epigraph', text: 'An epigraph that is not studied.' },
        body('first:p001', [
          ['first:p001:s01', 'The opening line sets the tone.', 'sets the tone'],
          ['first:p001:s02', 'A “second” line follows it.', 'follows'],
        ]),
        body('first:p002', [['first:p002:s01', 'The closing line ends it.', 'closing']]),
      ],
    },
    {
      id: 'second',
      title: 'Second Essay',
      author: 'B. Writer',
      paragraphs: [body('second:p001', [['second:p001:s01', 'A "second" line follows it.', 'second']])],
    },
  ],
};

function build(value: unknown, selection?: string) {
  const root = mkdtempSync(join(tmpdir(), 'dictprop-essay-pool-'));
  writeJson(join(root, 'catalog.json'), value);
  const args = [script, join(root, 'catalog.json'), join(root, 'pool.json')];
  if (selection) args.push(selection);
  const child = spawnSync(process.execPath, args, { encoding: 'utf8' });
  return {
    child,
    sentences: child.status === 0
      ? (JSON.parse(readFileSync(join(root, 'pool.json'), 'utf8')).sentences as PoolRecord[])
      : [],
  };
}

test('the essay pool gives each sentence its neighbours and merges a sentence repeated across essays', () => {
  const { child, sentences } = build(catalog);

  assert.equal(child.status, 0, child.stderr);
  assert.deepEqual(sentences.map(sentence => sentence.text), [
    'The opening line sets the tone.', 'A “second” line follows it.', 'The closing line ends it.',
  ]);
  const [opening, second, closing] = sentences;
  assert.deepEqual(
    { before: opening.contextBefore, after: opening.contextAfter },
    { before: undefined, after: 'A “second” line follows it.' },
  );
  // Context runs across paragraphs, in reading order.
  assert.equal(closing.contextBefore, 'A “second” line follows it.');
  assert.equal(second.sourceSense, 'First Essay — A. Writer');
  assert.equal(second.lookupHash, sentenceLookupHash(second.text));
  assert.equal(second.id, exampleSentenceId(second.lookupHash));
  assert.equal(second.textHash, sentenceTextHash(second.text));
  // The straight-quoted copy in the second essay is the same lookup identity, so it adds a provenance entry.
  assert.deepEqual(second.provenance.map(entry => entry.essaySentenceId), ['first:p001:s02', 'second:p001:s01']);
});

test('the essay pool builds only the selected essays and refuses a malformed catalog entry, selected or not', () => {
  const selected = build(catalog, 'second');
  assert.equal(selected.child.status, 0, selected.child.stderr);
  assert.deepEqual(selected.sentences.map(sentence => sentence.provenance[0].essayId), ['second']);

  assert.match(build(catalog, 'missing').child.stderr, /No essay sentences matched selection missing/);
  for (const broken of [null, { id: 'third', title: 'Third' }]) {
    const result = build({ ...catalog, essays: [...catalog.essays, broken] }, 'first');
    assert.notEqual(result.child.status, 0);
    assert.match(result.child.stderr, /Essay catalog contains an invalid essay/);
  }
});
