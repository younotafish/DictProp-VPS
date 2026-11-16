import assert from 'node:assert/strict';
import test from 'node:test';
import { applyMerges, dryRunMerge } from '../../services/mergeDuplicates.ts';
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

test('forms are deduplicated by their normalized spelling, keeping the first one seen', () => {
  const merged = applyMerges(
    [card('run', 'run', { forms: ['runs', 'Running', ' RUNS '] }), card('running', 'running'), card('Running', 'Running')],
    [{ baseWords: ['run', 'running'], canonical: 'run' }],
  );
  assert.deepEqual(vocabOf(merged[0]).forms, ['runs', 'Running']);
  assert.deepEqual(vocabOf(merged[2]).forms, ['runs', 'Running']);
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

  const tie = applyMerges(
    [card('first', 'leave', { sense: 'verb: depart' }), card('second', 'left', { sense: 'verb: depart' })],
    [{ baseWords: ['leave', 'left'], canonical: 'leave' }],
  );
  assert.deepEqual(tie.map(item => !!item.isDeleted), [false, true], 'a tie keeps the first');
});

test('cards without a sense label are never merged into one another: both are relabeled and stay', () => {
  const merged = applyMerges(
    [card('find', 'find', { definition: 'to discover' }), card('found', 'found', { definition: 'to establish' })],
    [{ baseWords: ['find', 'found'], canonical: 'find' }],
  );
  assert.deepEqual(merged.map(item => [vocabOf(item).word, !!item.isDeleted, vocabOf(item).definition]),
    [['find', false, 'to discover'], ['find', false, 'to establish']]);
  // A labeled card doesn't collide with an unlabeled one either.
  const mixed = applyMerges([card('a', 'leave', { sense: 'verb: depart' }), card('b', 'left')], [{ baseWords: ['leave', 'left'], canonical: 'leave' }]);
  assert.deepEqual(mixed.map(item => !!item.isDeleted), [false, false]);
});

test('a member already spelled and formed as the merge leaves it keeps its identity, and isn’t pushed again', () => {
  const settled = card('run', 'run', { sense: 'verb: move', forms: ['ran'] });
  const loser = card('ran', 'ran', { sense: 'verb: move' });
  const merged = applyMerges([settled, loser], [{ baseWords: ['run', 'ran'], canonical: 'run' }]);
  assert.equal(merged[0], settled);
  assert.deepEqual(merged[1], { ...loser, isDeleted: true, updatedAt: NOW });
  // A headword listing every form already keeps them in its order, so merging a variant in touches only the variant.
  const run = card('run', 'run', { forms: ['runs', 'running', 'ran'] });
  const ran = card('ran', 'ran', { forms: ['run'] });
  const intoRun = applyMerges([ran, run], [{ baseWords: ['ran', 'run'], canonical: 'run' }]);
  assert.equal(intoRun[1], run);
  assert.deepEqual(vocabOf(intoRun[0]), { ...vocabOf(ran), word: 'run', forms: ['runs', 'running', 'ran'] });
  // Missing forms are not the empty list the merge would write.
  const formless = card('move', 'go', { sense: 'verb: move' });
  const emptyForms = card('travel', 'go', { sense: 'verb: travel', forms: [] });
  const relabeled = applyMerges([formless, emptyForms], [{ baseWords: ['go'], canonical: 'go' }]);
  assert.notEqual(relabeled[0], formless);
  assert.deepEqual(vocabOf(relabeled[0]).forms, []);
  assert.equal(relabeled[1], emptyForms);
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
    [card('a', 'go', { sense: 'move' }), card('b', 'went', { sense: 'move' }), card('c', 'see', { sense: 'look' }), card('d', 'saw', { sense: 'look' })],
    [{ baseWords: ['go', 'went'], canonical: 'go' }, { baseWords: ['see', 'saw'], canonical: 'see' }],
  );
  assert.deepEqual(merged.map(item => [vocabOf(item).word, !!item.isDeleted]), [['go', false], ['went', true], ['see', false], ['saw', true]]);
});

test('a dry run counts exactly what the merge changes: the cards relabeled and the cards removed', () => {
  const fixtures: Array<[StoredItem[], Array<{ baseWords: string[]; canonical: string }>]> = [
    [[card('run', 'Run', { sense: 'verb: move fast', forms: ['runs'] }), card('ran', 'ran', { sense: 'verb: past tense' }), card('other', 'walk')],
      [{ baseWords: ['run', 'ran'], canonical: 'run' }]],
    [[card('plain', 'leave', { sense: 'verb: depart' }), card('rich', 'left', { sense: 'Verb: Depart ', examples: ['a'] }), reviewed(card('studied', 'leaves', { sense: 'verb: depart' }), 1)],
      [{ baseWords: ['leave', 'left', 'leaves'], canonical: 'leave' }]],
    [[card('settled', 'run', { sense: 'verb: move', forms: ['ran'] }), card('loser', 'ran', { sense: 'verb: move' })],
      [{ baseWords: ['run', 'ran'], canonical: 'run' }]],
    [[card('a', 'go'), card('b', 'went'), card('c', 'see', { sense: 'look' }), card('d', 'saw', { sense: 'look' }), { ...card('gone', 'saw'), isDeleted: true }],
      [{ baseWords: ['go', 'went'], canonical: 'go' }, { baseWords: ['see', 'saw'], canonical: 'see' }]],
    [[card('run', 'run'), card('ran', 'ran')], []],
  ];
  for (const [items, merges] of fixtures) {
    const merged = applyMerges(items, merges);
    const changed = merged.filter((item, index) => item !== items[index]);
    assert.deepEqual(dryRunMerge(items, merges), {
      relabeled: changed.filter(item => !item.isDeleted).length,
      removed: changed.filter(item => item.isDeleted).length,
    });
  }
  assert.deepEqual(dryRunMerge(fixtures[1][0], fixtures[1][1]), { relabeled: 1, removed: 2 });
  assert.deepEqual(dryRunMerge(fixtures[2][0], fixtures[2][1]), { relabeled: 0, removed: 1 });
  assert.deepEqual(dryRunMerge(fixtures[3][0], fixtures[3][1]), { relabeled: 3, removed: 1 });
});
