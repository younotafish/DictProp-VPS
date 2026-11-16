import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { exampleSentenceId, sentenceLookupHash } from '../../scripts/offline/sentence-pool.mjs';
import { writeJson } from '../support/fs.ts';
import { repoPath } from '../support/paths.ts';

const script = repoPath('scripts', 'offline', 'build-real-life-sentence-pool.mjs');

interface PoolRecord {
  id: string;
  text: string;
  sourceSense: string;
  lookupHash: string;
  provenance: Array<{ catalogSentenceId: string; collectionId: string; sectionId: string }>;
}

// The ids are the lines' own, not their positions: airport's 02 was removed, and hotel's line is its 07.
const catalog = {
  version: 1,
  collections: [
    {
      id: 'travel',
      title: 'Travel',
      sections: [
        { id: 'airport', title: 'Airport', sentences: [
          { id: '01', text: 'Could you walk me through the check-in process?', focus: 'walk me through' },
          { id: '03', text: 'Is this the line for oversized bags?', focus: 'oversized bags' },
        ] },
        { id: 'hotel', title: 'Hotel', sentences: [{ id: '07', text: 'I’d like a late checkout, please.', focus: 'late checkout' }] },
      ],
    },
    {
      id: 'food',
      title: 'Food',
      sections: [{ id: 'ordering', title: 'Ordering', sentences: [{ id: '01', text: 'Could we get the check?', focus: 'get the check' }] }],
    },
  ],
};

function build(value: unknown, ...selection: string[]) {
  const root = mkdtempSync(join(tmpdir(), 'dictprop-real-life-pool-'));
  writeJson(join(root, 'catalog.json'), value);
  const child = spawnSync(process.execPath, [script, join(root, 'catalog.json'), join(root, 'pool.json'), ...selection], {
    encoding: 'utf8',
  });
  return {
    child,
    sentences: child.status === 0
      ? (JSON.parse(readFileSync(join(root, 'pool.json'), 'utf8')).sentences as PoolRecord[])
      : [],
  };
}

test('the Real Life pool names each sentence by its catalog id and keys it by lookup hash', () => {
  const { child, sentences } = build(catalog);

  assert.equal(child.status, 0, child.stderr);
  assert.deepEqual(sentences.map(sentence => sentence.provenance[0].catalogSentenceId), [
    'travel:airport:01', 'travel:airport:03', 'travel:hotel:07', 'food:ordering:01',
  ]);
  for (const sentence of sentences) {
    assert.equal(sentence.lookupHash, sentenceLookupHash(sentence.text));
    assert.equal(sentence.id, exampleSentenceId(sentence.lookupHash));
  }
  assert.equal(sentences[2].sourceSense, 'Travel — Hotel');
});

test('the Real Life pool builds a selection and refuses duplicates and malformed entries, selected or not', () => {
  assert.deepEqual(
    build(catalog, 'travel', 'hotel').sentences.map(sentence => sentence.provenance[0].catalogSentenceId),
    ['travel:hotel:07'],
  );
  assert.match(build(catalog, 'food', 'airport').child.stderr, /No Real Life sentences matched collection selection food section airport/);

  const duplicate = structuredClone(catalog);
  duplicate.collections[1].sections[0].sentences.push({ id: '02', text: 'Could we get the CHECK?', focus: 'get the CHECK' });
  assert.match(build(duplicate).child.stderr, /food\/ordering duplicates a normalized sentence/);

  // Without its id a line has no name its progress could be kept under, so the pool refuses it.
  for (const id of [undefined, '', ' ']) {
    const unnamed = structuredClone(catalog) as { collections: Array<{ sections: Array<{ sentences: Array<{ id?: string }> }> }> };
    unnamed.collections[0].sections[1].sentences[0].id = id;
    const result = build(unnamed);
    assert.notEqual(result.child.status, 0);
    assert.match(result.child.stderr, /travel\/hotel sentence 1 has no id/);
  }

  for (const broken of [null, { id: 'empty', title: 'Empty' }]) {
    const result = build({ ...catalog, collections: [...catalog.collections, broken] }, 'travel');
    assert.notEqual(result.child.status, 0);
    assert.match(result.child.stderr, /Real Life catalog contains an invalid collection/);
  }
  const brokenSection = structuredClone(catalog) as { collections: Array<{ sections: unknown[] }> };
  brokenSection.collections[0].sections.push(null);
  const result = build(brokenSection, 'travel', 'airport');
  assert.notEqual(result.child.status, 0);
  assert.match(result.child.stderr, /travel contains an invalid section/);
});
