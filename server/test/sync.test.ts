import assert from 'node:assert/strict';
import test from 'node:test';
import { getItemContentHash } from '../../services/api.ts';
import { mergeDatasets } from '../../services/sync.ts';
import type { StoredItem, VocabCard } from '../../types.ts';

function vocab(id: string, imageUrl?: string): VocabCard {
  return {
    id,
    word: id,
    chinese: '',
    ipa: '',
    definition: `definition ${id}`,
    synonyms: [],
    antonyms: [],
    confusables: [],
    examples: [],
    history: '',
    register: '',
    mnemonic: '',
    imageUrl,
  };
}

function phrase(vocabs: VocabCard[], updatedAt: number): StoredItem {
  return {
    type: 'phrase',
    data: {
      id: 'phrase', query: 'query', translation: '', grammar: '', visualKeyword: '',
      pronunciation: '', timestamp: 1, vocabs,
    },
    savedAt: 1,
    updatedAt,
    srs: {
      id: 'phrase', type: 'phrase', nextReview: 0, interval: 0, memoryStrength: 0,
      lastReviewDate: 0, totalReviews: 0, correctStreak: 0, stability: 0.5,
    },
  };
}

test('phrase image merge follows vocab ids after reordering', () => {
  const local = phrase([vocab('alpha', 'idb:alpha'), vocab('beta', 'idb:beta')], 1);
  const remote = phrase([vocab('beta', 'server:beta'), vocab('alpha', 'server:alpha')], 2);

  const merged = mergeDatasets([local], [remote])[0].data as any;
  assert.equal(merged.vocabs[0].id, 'beta');
  assert.equal(merged.vocabs[0].imageUrl, 'idb:beta');
  assert.equal(merged.vocabs[1].id, 'alpha');
  assert.equal(merged.vocabs[1].imageUrl, 'idb:alpha');
});

test('legacy project metadata no longer affects content identity', () => {
  const item = phrase([], 1);
  const moved = { ...item, project: 'project-b' };
  assert.equal(getItemContentHash(item), getItemContentHash(moved));
});

test('newer complete sentence content is not mistaken for a lightweight cache entry', () => {
  const base = phrase([], 1);
  const remote: StoredItem = {
    ...base,
    type: 'sentence',
    data: { id: 'sentence', text: 'old sentence', sourceWord: 'old' },
    srs: { ...base.srs, id: 'sentence', type: 'sentence' },
    updatedAt: 1,
  };
  const local: StoredItem = {
    ...remote,
    data: { id: 'sentence', text: 'new sentence', sourceWord: 'new' },
    updatedAt: 2,
  };

  const merged = mergeDatasets([local], [remote])[0];
  assert.equal((merged.data as any).text, 'new sentence');
});

test('server revision outranks a skewed device timestamp', () => {
  const local = { ...phrase([], 9_999_999), serverRevision: 4 };
  const remote = { ...phrase([], 1), serverRevision: 5 };
  (local.data as any).translation = 'stale local edit';
  (remote.data as any).translation = 'server revision wins';
  const merged = mergeDatasets([local], [remote])[0];
  assert.equal((merged.data as any).translation, 'server revision wins');
  assert.equal(merged.serverRevision, 5);
});
