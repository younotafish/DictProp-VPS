import assert from 'node:assert/strict';
import test from 'node:test';
import { THEMES } from '../src/shared/item-themes.js';
import { MAX_DEFINITION_CHARS, MAX_SENTENCE_CHARS, themeInput } from '../src/themes/input.js';
import { srs } from './support/fixtures.js';

const { db, getThemeRowsAfter, listThemeCandidates, recordThemeResults, upsertItem } = await import('../src/db.js');
const { themeStmts } = await import('../src/db/item-themes.js');

const [FIRST, SECOND] = THEMES.map(theme => theme.id);
const THEME_IDS = new Set(THEMES.map(theme => theme.id));
const VERSION = 7;
const context = { model: 'test-model', taxonomyVersion: VERSION, now: 1_000 };

function save(userId: string, id: string, type: string, data: Record<string, unknown>, fields: Record<string, unknown> = {}) {
  upsertItem({ type, data: { ...data, id }, srs: srs(id, type), savedAt: 1, updatedAt: 1, ...fields }, userId);
}
const reviewed = (id: string, type: string) => ({ ...srs(id, type), totalReviews: 2, lastReviewDate: 5 });
const hashOf = (fields: Parameters<typeof themeInput>[0]) => themeInput(fields)!.inputHash;
const candidateIds = async (userId: string, version = VERSION, ids: ReadonlySet<string> = THEME_IDS) =>
  (await listThemeCandidates(userId, version, ids)).map(candidate => candidate.itemId);

test("the classifier reads a word with its sense and a cut definition, or a sentence's plain text, never a phrase", () => {
  const definition = 'x'.repeat(MAX_DEFINITION_CHARS + 40);
  assert.deepEqual(themeInput({ type: 'vocab', word: ' draw  on ', sense: 'use a resource', definition })?.item, {
    kind: 'word', text: `draw on — use a resource — ${'x'.repeat(MAX_DEFINITION_CHARS)}`,
  });
  assert.equal(themeInput({ type: 'vocab', word: 'lucid' })?.item.text, 'lucid');
  assert.deepEqual(themeInput({ type: 'sentence', text: 'We {{pressure-test}} the\n[[assumption]] first.' })?.item, {
    kind: 'sentence', text: 'We pressure-test the assumption first.',
  });
  assert.equal(themeInput({ type: 'sentence', text: 'y'.repeat(MAX_SENTENCE_CHARS + 1) })?.item.text.length, MAX_SENTENCE_CHARS);
  for (const fields of [{ type: 'vocab', word: '  ' }, { type: 'vocab', word: 7 }, { type: 'sentence', text: '{{ }}' }, { type: 'phrase', word: 'x' }]) {
    assert.equal(themeInput(fields), null, JSON.stringify(fields));
  }
});

test("an input's hash ignores what doesn't change the item: its definition, a sentence's markers, spacing", () => {
  const word = { type: 'vocab', word: 'bank', sense: 'noun: river' };
  assert.equal(hashOf({ ...word, definition: 'one' }), hashOf({ ...word, definition: 'a rewrite' }));
  assert.equal(hashOf({ ...word, word: ' bank ' }), hashOf(word));
  assert.notEqual(hashOf({ ...word, sense: 'noun: finance' }), hashOf(word));
  assert.equal(hashOf({ type: 'sentence', text: 'Sit by the {{bank}}.' }), hashOf({ type: 'sentence', text: 'Sit by the bank.' }));
  assert.notEqual(hashOf({ type: 'sentence', text: 'Sit by the bank.' }), hashOf({ type: 'sentence', text: 'Sit by the river.' }));
});

test('a theme row takes a new seq only when its theme changes, and the client gets the changes after its seq', () => {
  const user = 'themes-delta';
  const hash = 'h'.repeat(64);
  const start = themeStmts.headSeq.get() as number;
  recordThemeResults(user, [{ itemId: 'a', inputHash: hash, themeId: FIRST }, { itemId: 'b', inputHash: hash, themeId: SECOND }], context);
  recordThemeResults(user, [{ itemId: 'c', inputHash: hash, themeId: null }], context);
  const first = getThemeRowsAfter(user, 0);
  assert.deepEqual(first, { rows: [['a', FIRST], ['b', SECOND]], latestSeq: start + 2 });

  // The same theme again changes nothing; a new one moves the row past the client's seq, and so does losing it.
  recordThemeResults(user, [{ itemId: 'a', inputHash: hash, themeId: FIRST }], context);
  assert.deepEqual(getThemeRowsAfter(user, first.latestSeq), { rows: [], latestSeq: first.latestSeq });
  recordThemeResults(user, [{ itemId: 'a', inputHash: hash, themeId: SECOND }], context);
  recordThemeResults(user, [{ itemId: 'b', inputHash: 'other'.padEnd(64, '0'), themeId: null }], context);
  const next = getThemeRowsAfter(user, first.latestSeq);
  assert.deepEqual(next, { rows: [['a', SECOND], ['b', null]], latestSeq: start + 4 });
  // A full fetch leaves out what has no theme, and another user's rows are theirs.
  assert.deepEqual(getThemeRowsAfter(user, 0).rows, [['a', SECOND]]);
  assert.deepEqual(getThemeRowsAfter('someone-else', 0).rows, []);
});

test('misses count against the input and taxonomy they were made on, and a theme clears them', () => {
  const user = 'themes-misses';
  const miss = (inputHash: string, taxonomyVersion = VERSION) =>
    recordThemeResults(user, [{ itemId: 'item', inputHash, themeId: null }], { ...context, taxonomyVersion }).exhausted;
  const failures = () => (themeStmts.row.get(user, 'item') as { failures: number }).failures;
  const one = '1'.repeat(64);
  const two = '2'.repeat(64);
  assert.equal(miss(one), 0);
  assert.equal(miss(one), 0);
  assert.equal(miss(one), 1, 'the third miss on one input exhausts it');
  assert.equal(failures(), 3);
  assert.equal(miss(two), 0);
  assert.equal(failures(), 1, 'a new input starts again');
  miss(two, VERSION + 1);
  assert.equal(failures(), 1, 'so does a new taxonomy');
  recordThemeResults(user, [{ itemId: 'item', inputHash: two, themeId: FIRST }], context);
  assert.equal(failures(), 0);
  assert.deepEqual(db.prepare('SELECT model, classified_at, taxonomy_version FROM item_themes WHERE user_id = ?').get(user), {
    model: 'test-model', classified_at: 1_000, taxonomy_version: VERSION,
  });
});

test('the candidates are live words and own sentences without a usable theme for their input, new ones first', async () => {
  const user = 'themes-candidates';
  save(user, 'old-word', 'vocab', { word: 'lucid', sense: 'clear', definition: 'easy to understand' }, { savedAt: 1 });
  save(user, 'new-word', 'vocab', { word: 'serene' }, { savedAt: 3 });
  upsertItem({ type: 'vocab', data: { id: 'seen-word', word: 'placid' }, srs: reviewed('seen-word', 'vocab'), savedAt: 9 }, user);
  save(user, 'own-sentence', 'sentence', { text: 'Sit by the {{bank}}.', sourceWord: 'bank' }, { savedAt: 2 });
  // Out of the loop: a phrase, catalog lines with and without their kind, deleted and archived items.
  save(user, 'phrase', 'phrase', { query: 'see it clearly', vocabs: [] });
  save(user, 'catalog-line', 'sentence', { text: 'A line.', sourceWord: 'line', catalogKind: 'essay' });
  save(user, 'real-life-sentence:x:01', 'sentence', { text: 'An early line.', sourceWord: 'line' });
  save(user, 'deleted', 'vocab', { word: 'gone' }, { isDeleted: true });
  save(user, 'archived', 'vocab', { word: 'shelved' }, { isArchived: true });
  save('someone-else', 'theirs', 'vocab', { word: 'theirs' });

  const candidates = await listThemeCandidates(user, VERSION, THEME_IDS);
  assert.deepEqual(candidates.map(candidate => candidate.itemId), ['new-word', 'own-sentence', 'old-word', 'seen-word']);
  assert.deepEqual(candidates[2], {
    itemId: 'old-word', item: { kind: 'word', text: 'lucid — clear — easy to understand' },
    inputHash: hashOf({ type: 'vocab', word: 'lucid', sense: 'clear' }), isNew: true, savedAt: 1,
  });
  assert.equal(candidates[3].isNew, false);
});

test('an item stops being a candidate once themed for its input, and comes back when its input or its theme goes', async () => {
  const user = 'themes-needs';
  save(user, 'word', 'vocab', { word: 'bank', sense: 'noun: river', definition: 'land beside a river' });
  const [candidate] = await listThemeCandidates(user, VERSION, THEME_IDS);
  recordThemeResults(user, [{ itemId: 'word', inputHash: candidate.inputHash, themeId: FIRST }], context);
  assert.deepEqual(await candidateIds(user), []);

  // A rewritten definition keeps the theme.
  save(user, 'word', 'vocab', { word: 'bank', sense: 'noun: river', definition: 'rewritten' }, { updatedAt: 2 });
  assert.deepEqual(await candidateIds(user), []);
  // A new taxonomy labels the item again, even one that still has its theme, and so does a new sense label.
  assert.deepEqual(await candidateIds(user, VERSION + 1), ['word']);
  assert.deepEqual(await candidateIds(user, VERSION + 1, new Set([SECOND])), ['word']);
  save(user, 'word', 'vocab', { word: 'bank', sense: 'noun: finance', definition: 'a lender' }, { updatedAt: 3 });
  assert.deepEqual(await candidateIds(user), ['word']);
});

test('an item the classifier missed three times on its input waits for a new input or a new taxonomy', async () => {
  const user = 'themes-exhausted';
  save(user, 'opt', 'vocab', { word: 'opt' });
  const [{ inputHash }] = await listThemeCandidates(user, VERSION, THEME_IDS);
  for (let miss = 1; miss <= 3; miss++) {
    assert.deepEqual(await candidateIds(user), ['opt'], `before miss ${miss}`);
    recordThemeResults(user, [{ itemId: 'opt', inputHash, themeId: null }], context);
  }
  assert.deepEqual(await candidateIds(user), []);
  assert.deepEqual(await candidateIds(user, VERSION + 1), ['opt']);
});
