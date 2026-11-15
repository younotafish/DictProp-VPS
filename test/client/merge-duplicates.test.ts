import assert from 'node:assert/strict';
import test from 'node:test';
import { applyMerges } from '../../services/mergeDuplicates.ts';
import type { StoredItem, VocabCard } from '../../types.ts';

// Characterization of the duplicate merge the Notebook's "Merge duplicates" applies: which card survives each sense,
// what the survivors are relabeled to, and what the losers keep.

const NOW = 1_700_000_000_000;
const realNow = Date.now;
Date.now = () => NOW;
test.after(() => { Date.now = realNow; });

const card = (id: string, word: string, fields: Partial<VocabCard> = {}): StoredItem => ({
  type: 'vocab',
  data: {
    id, word, chinese: '', ipa: '', definition: '', synonyms: [], antonyms: [], confusables: [], examples: [],
    history: '', register: '', mnemonic: '', ...fields,
  },
  savedAt: 1,
  updatedAt: 1,
  srs: { id, type: 'vocab', nextReview: 0, interval: 0, memoryStrength: 0, lastReviewDate: 0, totalReviews: 0, correctStreak: 0, stability: 0.5 },
});
const reviewed = (item: StoredItem, totalReviews: number): StoredItem => ({ ...item, srs: { ...item.srs, totalReviews } });
const vocabOf = (item: StoredItem) => item.data as VocabCard;

test('no merges returns the library itself, and a merge with nothing to merge changes no item', () => {
  const items = [card('run', 'run'), card('ran', 'ran')];
  assert.equal(applyMerges(items, []), items);
  const unmatched = applyMerges(items, [{ baseWords: ['run', 'walk'], canonical: 'run' }]);
  assert.deepEqual(unmatched, items);
  assert.ok(unmatched.every((item, index) => item === items[index]));
  assert.ok(applyMerges(items, [{ baseWords: ['run', 'ran'], canonical: '  ' }]).every((item, index) => item === items[index]),
    'a canonical word that normalizes to nothing is skipped');
});

test('members are relabeled to the canonical spelling and share every form', () => {
  const items = [
    card('run', 'Run', { sense: 'verb: move fast', forms: ['runs'] }),
    card('ran', 'ran', { sense: 'verb: past tense', forms: ['ran ', ''] }),
    card('other', 'walk'),
  ];
  const merged = applyMerges(items, [{ baseWords: ['run', 'ran'], canonical: 'run' }]);
  // The existing card's spelling wins over the canonical word as typed.
  assert.deepEqual(merged.slice(0, 2).map(item => vocabOf(item).word), ['Run', 'Run']);
  assert.deepEqual(vocabOf(merged[0]).forms, ['runs', 'ran']);
  assert.deepEqual(vocabOf(merged[1]).forms, ['runs', 'ran']);
  assert.ok(merged.slice(0, 2).every(item => item.updatedAt === NOW && !item.isDeleted));
  assert.equal(merged[2], items[2], 'other cards keep their identity');

  // Without a member spelled like the canonical word, its trimmed spelling is used.
  const relabeled = applyMerges(
    [card('a', 'colour', { sense: 'noun' }), card('b', 'colours', { sense: 'verb' })],
    [{ baseWords: ['colour', 'colours'], canonical: ' color ' }],
  );
  assert.deepEqual(relabeled.map(item => vocabOf(item).word), ['color', 'color']);
  assert.deepEqual(vocabOf(relabeled[0]).forms, ['colour', 'colours']);
});

test('forms are deduplicated by exact spelling today, so case-only variants both stay', () => {
  // client-data-10 (wave 2) collapses these to one; this pins the current result.
  const merged = applyMerges(
    [card('run', 'run', { forms: ['runs', 'Running'] }), card('running', 'running'), card('Running', 'Running')],
    [{ baseWords: ['run', 'running'], canonical: 'run' }],
  );
  assert.deepEqual(vocabOf(merged[0]).forms, ['runs', 'Running', 'running']);
});

test('one card survives each sense, chosen by reviews, then richness, and a tie keeps the first', () => {
  const plain = card('plain', 'leave', { sense: 'verb: depart' });
  const rich = card('rich', 'left', { sense: 'Verb: Depart ', definition: 'x'.repeat(30), examples: ['a', 'b'] });
  const studied = reviewed(card('studied', 'leaves', { sense: 'verb: depart' }), 1);
  const merged = applyMerges([plain, rich, studied], [{ baseWords: ['leave', 'left', 'leaves'], canonical: 'leave' }]);
  assert.deepEqual(merged.map(item => [item.data.id, !!item.isDeleted]), [['plain', true], ['rich', true], ['studied', false]]);

  // A loser keeps its content and spelling, and gains only the deletion and its time.
  assert.deepEqual(merged[0], { ...plain, isDeleted: true, updatedAt: NOW });
  assert.deepEqual(merged[1], { ...rich, isDeleted: true, updatedAt: NOW });

  const withPicture = card('picture', 'left', { sense: 'verb: depart', imageUrl: 'idb:stored' });
  const byRichness = applyMerges([plain, withPicture], [{ baseWords: ['leave', 'left'], canonical: 'leave' }]);
  assert.deepEqual(byRichness.map(item => !!item.isDeleted), [true, false], 'a picture counts for 1000');

  const tie = applyMerges([card('first', 'leave'), card('second', 'left')], [{ baseWords: ['leave', 'left'], canonical: 'leave' }]);
  assert.deepEqual(tie.map(item => !!item.isDeleted), [false, true], 'two cards without a sense share one, and the first stays');
});

test('deleted cards and other kinds of item are never merged', () => {
  const gone = { ...card('gone', 'leave'), isDeleted: true };
  const phrase = { ...card('phrase', 'left'), type: 'phrase' } as StoredItem;
  const merged = applyMerges([gone, phrase, card('live', 'left')], [{ baseWords: ['leave', 'left'], canonical: 'leave' }]);
  assert.equal(merged[0], gone);
  assert.equal(merged[1], phrase);
  assert.equal(merged[2].isDeleted, undefined, 'one live member is nothing to merge');
  assert.equal(vocabOf(merged[2]).word, 'left');
});

test('every merge in the list applies, each to its own cluster', () => {
  const merged = applyMerges(
    [card('a', 'go'), card('b', 'went'), card('c', 'see'), card('d', 'saw')],
    [{ baseWords: ['go', 'went'], canonical: 'go' }, { baseWords: ['see', 'saw'], canonical: 'see' }],
  );
  assert.deepEqual(merged.map(item => [vocabOf(item).word, !!item.isDeleted]), [['go', false], ['went', true], ['see', false], ['saw', true]]);
});
