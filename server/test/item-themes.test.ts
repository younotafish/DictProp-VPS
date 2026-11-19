import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { THEMES } from '../src/shared/item-themes.js';
import { MAX_SENTENCE_CHARS, themeInput } from '../src/themes/input.js';
import { srs } from './support/fixtures.js';

const { db, deleteNonSentenceThemes, getThemeRowsAfter, listThemeCandidates, recordThemeResults, upsertItem } = await import('../src/db.js');
const { themeStmts } = await import('../src/db/item-themes.js');

const [FIRST, SECOND] = THEMES.map(theme => theme.id);
const THEME_IDS = new Set(THEMES.map(theme => theme.id));
const VERSION = 7;
const context = { model: 'test-model', taxonomyVersion: VERSION, now: 1_000 };

function save(userId: string, id: string, type: string, data: Record<string, unknown>, fields: Record<string, unknown> = {}) {
  upsertItem({ type, data: { ...data, id }, srs: srs(id, type), savedAt: 1, updatedAt: 1, ...fields }, userId);
}
/** Saves one of the user's own sentences. */
const saveSentence = (userId: string, id: string, text: string, fields: Record<string, unknown> = {}) =>
  save(userId, id, 'sentence', { text, sourceWord: 'word' }, fields);
const reviewed = (id: string, type: string) => ({ ...srs(id, type), totalReviews: 2, lastReviewDate: 5 });
const hashOf = (text: string) => themeInput({ type: 'sentence', text })!.inputHash;
const candidateIds = async (userId: string, version = VERSION, ids: ReadonlySet<string> = THEME_IDS) =>
  (await listThemeCandidates(userId, version, ids)).map(candidate => candidate.itemId);
const themeRowIds = (userId: string) =>
  (db.prepare('SELECT item_id FROM item_themes WHERE user_id = ? ORDER BY item_id').pluck().all(userId) as string[]);

test("the classifier reads a sentence's plain text, cut to its opening, and nothing from a word, a phrase or a blank", () => {
  assert.deepEqual(themeInput({ type: 'sentence', text: 'We {{pressure-test}} the\n[[assumption]] first.' })?.item, {
    kind: 'sentence', text: 'We pressure-test the assumption first.',
  });
  assert.equal(themeInput({ type: 'sentence', text: 'y'.repeat(MAX_SENTENCE_CHARS + 1) })?.item.text.length, MAX_SENTENCE_CHARS);
  for (const fields of [
    { type: 'vocab', word: 'lucid', text: 'Clear.' }, { type: 'phrase', text: 'see it clearly' },
    { type: 'sentence', text: '{{ }}' }, { type: 'sentence', text: 7 }, { type: 'sentence' },
  ]) {
    assert.equal(themeInput(fields), null, JSON.stringify(fields));
  }
});

test("a sentence's hash ignores its markers and spacing, and changes with its words", () => {
  assert.equal(hashOf('Sit by the {{bank}}.'), hashOf('Sit by the bank.'));
  assert.equal(hashOf(' Sit  by the\n[[bank]]. '), hashOf('Sit by the bank.'));
  assert.notEqual(hashOf('Sit by the bank.'), hashOf('Sit by the river.'));
  // Cut to its opening for the classifier, but hashed whole: a change past the cut is still a new input.
  const opening = 'z'.repeat(MAX_SENTENCE_CHARS);
  assert.notEqual(hashOf(`${opening} one`), hashOf(`${opening} two`));
  // The SHA-256 of the plain text, as the stored rows were made: any other hash would have every sentence labelled again.
  assert.equal(hashOf('Sit by the {{bank}}.'), createHash('sha256').update('Sit by the bank.').digest('hex'));
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

test('the candidates are the live own sentences without a usable theme for their input, never-reviewed ones first', async () => {
  const user = 'themes-candidates';
  saveSentence(user, 'old-sentence', 'Sit by the {{bank}}.', { savedAt: 1 });
  saveSentence(user, 'new-sentence', 'The river is high today.', { savedAt: 3 });
  upsertItem({
    type: 'sentence', data: { id: 'got-it-sentence', text: 'We waded across.', sourceWord: 'wade' },
    srs: reviewed('got-it-sentence', 'sentence'), savedAt: 9,
  }, user);
  // Never candidates: words, even never reviewed and saved last, a phrase, catalog lines (a record with its kind, an
  // early Real Life record without one, a catalog line saved to the Sentences tab), deleted and archived sentences,
  // and another user's sentence.
  save(user, 'new-word', 'vocab', { word: 'serene', sense: 'calm', definition: 'untroubled' }, { savedAt: 20 });
  save(user, 'phrase', 'phrase', { query: 'see it clearly', vocabs: [] }, { savedAt: 21 });
  save(user, 'catalog-line', 'sentence', { text: 'A line.', sourceWord: 'line', catalogKind: 'essay' }, { savedAt: 22 });
  save(user, 'real-life-sentence:x:01', 'sentence', { text: 'An early line.', sourceWord: 'line' }, { savedAt: 23 });
  save(user, 'saved-line', 'sentence', { text: 'A saved line.', sourceWord: 'line', catalogSentenceId: 'x:02' }, { savedAt: 24 });
  saveSentence(user, 'deleted', 'Gone now.', { isDeleted: true, savedAt: 25 });
  saveSentence(user, 'archived', 'Put away.', { isArchived: true, savedAt: 26 });
  saveSentence('someone-else', 'theirs', 'Their sentence.', { savedAt: 27 });

  const candidates = await listThemeCandidates(user, VERSION, THEME_IDS);
  assert.deepEqual(candidates.map(candidate => candidate.itemId), ['new-sentence', 'old-sentence', 'got-it-sentence']);
  assert.deepEqual(candidates[1], {
    itemId: 'old-sentence', item: { kind: 'sentence', text: 'Sit by the bank.' }, inputHash: hashOf('Sit by the bank.'),
    isNew: true, savedAt: 1,
  });
  assert.equal(candidates[2].isNew, false);
});

test('a sentence stops being a candidate once themed for its input, and comes back when its words or its theme go', async () => {
  const user = 'themes-needs';
  saveSentence(user, 'sentence', 'Sit by the bank.');
  const [candidate] = await listThemeCandidates(user, VERSION, THEME_IDS);
  recordThemeResults(user, [{ itemId: 'sentence', inputHash: candidate.inputHash, themeId: FIRST }], context);
  assert.deepEqual(await candidateIds(user), []);

  // Marking another expression in it keeps the theme.
  saveSentence(user, 'sentence', 'Sit by the {{bank}}.', { updatedAt: 2 });
  assert.deepEqual(await candidateIds(user), []);
  // A new taxonomy labels the sentence again, even one that still has its theme, and so do new words.
  assert.deepEqual(await candidateIds(user, VERSION + 1), ['sentence']);
  assert.deepEqual(await candidateIds(user, VERSION + 1, new Set([SECOND])), ['sentence']);
  saveSentence(user, 'sentence', 'Sit by the river.', { updatedAt: 3 });
  assert.deepEqual(await candidateIds(user), ['sentence']);
});

test('a sentence the classifier missed three times on its input waits for a new input or a new taxonomy', async () => {
  const user = 'themes-exhausted';
  saveSentence(user, 'opt', 'I opt out.');
  const [{ inputHash }] = await listThemeCandidates(user, VERSION, THEME_IDS);
  for (let miss = 1; miss <= 3; miss++) {
    assert.deepEqual(await candidateIds(user), ['opt'], `before miss ${miss}`);
    recordThemeResults(user, [{ itemId: 'opt', inputHash, themeId: null }], context);
  }
  assert.deepEqual(await candidateIds(user), []);
  assert.deepEqual(await candidateIds(user, VERSION + 1), ['opt']);
});

test("the theme rows of a user's items that aren't sentences are deleted, without moving the seq; sentences keep theirs", () => {
  const user = 'themes-prune';
  const record = (userId: string, itemId: string, themeId: string | null) =>
    recordThemeResults(userId, [{ itemId, inputHash: 'p'.repeat(64), themeId }], context);
  // Rows the sweep gave words while Today took them: live, archived and deleted, missed ones included.
  save(user, 'prune-word', 'vocab', { word: 'lucid' });
  save(user, 'prune-archived-word', 'vocab', { word: 'shelved' }, { isArchived: true });
  save(user, 'prune-deleted-word', 'vocab', { word: 'gone' }, { isDeleted: true });
  save(user, 'prune-missed-word', 'vocab', { word: 'opt' });
  for (const id of ['prune-word', 'prune-archived-word', 'prune-deleted-word']) record(user, id, FIRST);
  record(user, 'prune-missed-word', null);
  // Sentences keep theirs, whatever their state, and so do other users' words.
  saveSentence(user, 'prune-sentence', 'Sit by the bank.');
  saveSentence(user, 'prune-archived-sentence', 'Put away.', { isArchived: true });
  save(user, 'real-life-sentence:prune:01', 'sentence', { text: 'An early line.', sourceWord: 'line' });
  for (const id of ['prune-sentence', 'prune-archived-sentence', 'real-life-sentence:prune:01']) record(user, id, SECOND);
  save('someone-else', 'prune-their-word', 'vocab', { word: 'theirs' });
  record('someone-else', 'prune-their-word', FIRST);

  const seq = themeStmts.headSeq.get() as number;
  assert.equal(deleteNonSentenceThemes(user), 4);
  assert.deepEqual(themeRowIds(user), ['prune-archived-sentence', 'prune-sentence', 'real-life-sentence:prune:01']);
  assert.deepEqual(themeRowIds('someone-else'), ['prune-their-word']);
  assert.equal(themeStmts.headSeq.get(), seq, 'no device is told of the deletion');
  assert.deepEqual(getThemeRowsAfter(user, 0).rows.map(([itemId]) => itemId).sort(),
    ['prune-archived-sentence', 'prune-sentence', 'real-life-sentence:prune:01']);
  assert.equal(deleteNonSentenceThemes(user), 0, 'nothing is left to delete');
});
