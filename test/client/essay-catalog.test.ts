import assert from 'node:assert/strict';
import test from 'node:test';
import { ESSAYS, withPrivateEssays, type RawEssayCatalog } from '../../services/essayCatalog.ts';

type RawEssay = RawEssayCatalog['essays'][number];

function privateEssay(id: string, sentenceIds: string[], overrides: Partial<RawEssay> = {}): RawEssay {
  return {
    id,
    title: `Essay ${id}`,
    author: 'An Author',
    year: 2024,
    publication: 'A Magazine',
    eyebrow: 'Modern',
    description: 'A private study text.',
    level: 'C1',
    accent: 'violet',
    themes: ['work'],
    modernityNote: 'Contemporary prose.',
    sourceLabel: 'Source',
    sourceUrl: 'https://example.com/essay',
    publicDomainNote: '',
    wordCount: 20,
    readingMinutes: 1,
    sentenceCount: sentenceIds.length,
    paragraphs: [{
      kind: 'body',
      id: `${id}-p1`,
      sentences: sentenceIds.map(sentenceId => ({ id: sentenceId, text: `The work matters (${sentenceId}).`, focus: 'work' })),
    }],
    ...overrides,
  };
}

const catalog = (essays: RawEssay[]): RawEssayCatalog => ({
  version: 1,
  generatedAt: '2026-11-15T00:00:00.000Z',
  editorialNote: '',
  essays,
});

test('private essays follow the public ones, in the modern collection unless they name theirs', () => {
  const publicEssays = [...ESSAYS];
  const essays = withPrivateEssays(catalog([
    privateEssay('private-a', ['private-a-1', 'private-a-2']),
    privateEssay('private-b', ['private-b-1'], { collection: 'classic' }),
  ]));

  assert.deepEqual(essays.slice(0, publicEssays.length), publicEssays);
  assert.deepEqual(essays.slice(publicEssays.length).map(essay => [essay.id, essay.collection]), [
    ['private-a', 'modern'],
    ['private-b', 'classic'],
  ]);
  const [first, second] = essays[publicEssays.length].sentences;
  assert.deepEqual(
    [first.position, first.markedText, first.essayId, first.paragraphId],
    [1, 'The {{work}} matters (private-a-1).', 'private-a', 'private-a-p1'],
  );
  assert.equal(second.position, 2);
});

test('an empty private catalog leaves the public essays alone', () => {
  assert.deepEqual(withPrivateEssays(catalog([])), [...ESSAYS]);
});

test('a private essay or sentence may not reuse a public id', () => {
  const publicEssay = ESSAYS[0];
  assert.throws(
    () => withPrivateEssays(catalog([privateEssay(publicEssay.id, ['fresh-1'])])),
    /Private essay duplicates a public essay/,
  );
  assert.throws(
    () => withPrivateEssays(catalog([privateEssay('fresh', [publicEssay.sentences[0].id])])),
    /Private essay sentence duplicates a public sentence/,
  );
});

test('loading a private catalog never changes the public list', () => {
  const before = [...ESSAYS];
  withPrivateEssays(catalog([privateEssay('private-a', ['private-a-1'])]));
  assert.throws(() => withPrivateEssays(catalog([privateEssay(ESSAYS[0].id, ['x-1'])])));
  assert.deepEqual([...ESSAYS], before);
  assert.equal(ESSAYS.length, 5);
});
