import assert from 'node:assert/strict';
import test from 'node:test';
import type { SRSData, StoredItem } from '../../types.ts';
import { THEMES } from '../../server/src/shared/item-themes.ts';
import { planLoop, setSize, SET_START_PENALTY_MS, themeScore, type PlanInput } from '../../services/learningLoop/planner.ts';
import { localDayKey } from '../../services/learningLoop/standing.ts';
import { DAILY_SET_GOAL } from '../../services/learningLoop/stats.ts';
import { DAY, HOUR, passive, practicing, reviewed, sayable, sentenceItem, vocabItem } from '../support/loop-fixtures.ts';

const NOW = new Date(2026, 10, 18, 15, 0).getTime();
const TODAY = localDayKey(NOW);
// Theme ids come from the taxonomy, which the designed one replaces: the tests take the first few, in id order.
const [A, B, C] = THEMES.map(theme => theme.id).sort();

/** `count` new sentences, each of its own word, saved `daysAgo` days back and then a minute apart, the last saved newest. */
function sentences(prefix: string, count: number, daysAgo = 30): StoredItem[] {
  return Array.from({ length: count }, (_, i) =>
    sentenceItem(`${prefix}${i}`, `A ${prefix} line, number ${i}.`, { sourceWord: `${prefix}-word-${i}`, savedAt: NOW - daysAgo * DAY + i * 60_000 }));
}

function plan(items: StoredItem[], themeOf: Record<string, string>, extra: Partial<PlanInput> = {}) {
  return planLoop({ items, themeOf: new Map(Object.entries(themeOf)), now: NOW, recentStarts: {}, pin: null, ...extra });
}

const inTheme = (items: StoredItem[], theme: string) => Object.fromEntries(items.map(item => [item.data.id, theme]));
const withSrs = (item: StoredItem, srs: Partial<SRSData>): StoredItem => ({ ...item, srs: { ...item.srs, ...srs } });

test('a theme with up to 20 new sentences gives them all; a bigger one is split into equal sets near 15, none below the day\'s goal', () => {
  const cases: [size: number, set: number][] = [
    [0, 0], [1, 1], [8, 8], [20, 20], [21, 21], [23, 23], [24, 12], [30, 15], [37, 19], [38, 13], [60, 15], [61, 16], [1000, 15],
  ];
  for (const [size, set] of cases) assert.equal(setSize(size), set, String(size));
  for (let size = 21; size <= 500; size++) assert.ok(setSize(size) >= DAILY_SET_GOAL && setSize(size) <= 23, String(size));
});

test('a theme scores for its recent saves and its size, and is held back after a recent set or when too small', () => {
  const theme = { themeId: A, size: 30, recentCount: 5 };
  assert.equal(themeScore(theme, {}, NOW), 3 * 5 + 30 / 4);
  assert.equal(themeScore({ ...theme, size: 100, recentCount: 25 }, {}, NOW), 3 * 20 + 60 / 4, 'both parts are capped');
  assert.equal(themeScore(theme, { [A]: NOW - DAY }, NOW), 3 * 5 + 30 / 4 - 100);
  assert.equal(themeScore(theme, { [A]: NOW - SET_START_PENALTY_MS }, NOW), 3 * 5 + 30 / 4, 'two days on, no longer');
  assert.equal(themeScore(theme, { [B]: NOW }, NOW), 3 * 5 + 30 / 4, 'another theme\'s set');
  assert.equal(themeScore({ ...theme, size: 11, recentCount: 0 }, {}, NOW), 11 / 4 - 30, 'too few for the day\'s goal');
  assert.equal(themeScore({ ...theme, size: 12, recentCount: 0 }, {}, NOW), 12 / 4);
  assert.equal(themeScore({ ...theme, themeId: 'constructor' }, {}, NOW), 22.5, 'starts are looked up as own keys');
});

test('the plan counts each theme\'s sentences by standing, sends unknown and missing themes to Unsorted, and counts sentences waiting for a translation', () => {
  const items = [
    sentenceItem('n1', 'One.', { savedAt: NOW - DAY }),
    sentenceItem('n2', 'Two.', { savedAt: NOW - 20 * DAY }),
    sentenceItem('got-it', 'Got it in the Sentences tab.', { srs: reviewed(NOW - DAY) }),
    sentenceItem('p', 'Practicing.', { srs: practicing(NOW - DAY) }),
    sentenceItem('s', 'Can say it.', { srs: sayable(NOW - DAY) }),
    sentenceItem('kept-passive', 'Kept passive.', { srs: passive(NOW - DAY) }),
    sentenceItem('gone', 'Deleted.', { isDeleted: true }),
    sentenceItem('kept', 'Archived.', { isArchived: true }),
    vocabItem('word', 'word', { chinese: '词' }),
    sentenceItem('future', 'A theme from a newer taxonomy.'),
    sentenceItem('loose', 'No theme yet.'),
    sentenceItem('untranslated', 'Soon {{translated}}.', { translation: null }),
    sentenceItem('untranslated-got-it', 'Got it, then waiting.', { translation: null, srs: reviewed(NOW - DAY) }),
    sentenceItem('untranslated-passive', 'Decided, then its translation went.', { translation: null, srs: passive(NOW - DAY) }),
    sentenceItem('untranslated-archived', 'Kept.', { translation: null, isArchived: true }),
    sentenceItem('real-life-sentence:x:y:01', 'Line.', { translation: null, catalogKind: 'real-life', catalogSentenceId: 'x:y:01', catalogCollectionId: 'x' }),
  ];
  const result = plan(items, {
    n1: A, n2: A, 'got-it': A, p: A, s: A, 'kept-passive': A, gone: A, kept: A, word: A, future: 'a-theme-from-a-newer-taxonomy',
  });
  assert.deepEqual([...result.themes.keys()], [A]);
  const { nextSet, ...counts } = result.themes.get(A)!;
  assert.deepEqual(counts, { themeId: A, newCount: 3, practicingCount: 1, sayableCount: 1, total: 6, recentCount: 1 });
  assert.deepEqual(nextSet, ['n1', 'n2', 'got-it'], 'the word card in the theme is no part of it');
  assert.deepEqual({ ...result.unsorted, nextSet: [...result.unsorted.nextSet].sort() }, {
    themeId: null, newCount: 2, practicingCount: 0, sayableCount: 0, total: 2, recentCount: 0, nextSet: ['future', 'loose'],
  });
  assert.equal(result.awaitingTranslation, 2, 'new to the loop, a Got it\'d one included');
});

test('a sentence Got it\'d in the Sentences tab enters a set; one decided in Today, passive included, never does', () => {
  const items = [
    sentenceItem('fresh', 'Never reviewed.', { sourceWord: 'fresh', savedAt: NOW - 3 * HOUR }),
    sentenceItem('got-it', 'Got it twice.', { sourceWord: 'got', savedAt: NOW - 2 * HOUR, srs: reviewed(NOW - DAY, { totalReviews: 2, stability: 30 }) }),
    sentenceItem('passive', 'Kept passive.', { sourceWord: 'kept', savedAt: NOW - HOUR, srs: passive(NOW - DAY) }),
    sentenceItem('practicing', 'Practicing.', { sourceWord: 'practice', savedAt: NOW - HOUR, srs: practicing(NOW - DAY) }),
    sentenceItem('sayable', 'Can say it.', { sourceWord: 'say', savedAt: NOW - HOUR, srs: sayable(NOW - DAY) }),
  ];
  const result = plan(items, inTheme(items, A));
  assert.deepEqual(result.today, { themeId: A, itemIds: ['got-it', 'fresh'] });
  assert.equal(result.themes.get(A)?.newCount, 2);
  assert.equal(result.themes.get(A)?.total, 5);
});

test('a set takes two thirds from the newest saves and the rest from the oldest, in the order filling them gives', () => {
  const items = sentences('a', 30);
  const { today } = plan(items, inTheme(items, A));
  // 30 new sentences make two sets of 15: the newest 10 (a29 back to a20), then the oldest 5 (a0 up to a4).
  assert.deepEqual(today, { themeId: A, itemIds: ['a29', 'a28', 'a27', 'a26', 'a25', 'a24', 'a23', 'a22', 'a21', 'a20', 'a0', 'a1', 'a2', 'a3', 'a4'] });
});

/** Whether any two sentences next to each other in `ids` ask for the same word, by `wordOf`. */
const adjacentPair = (ids: readonly string[], wordOf: (id: string) => string) =>
  ids.some((id, index) => index > 0 && wordOf(id) === wordOf(ids[index - 1]));

test('a set prefers sentences of different words: while others can fill it, a word\'s second sentence waits for a later set', () => {
  // 13 words with one sentence and 6 with two (the pairs saved newest): 25 sentences make two sets of 13.
  const singles = sentences('s', 13, 30);
  const pairs = Array.from({ length: 12 }, (_, i) =>
    sentenceItem(`p${i}`, `Pair line ${i}.`, { sourceWord: `pair-word-${i % 6}`, savedAt: NOW - DAY + i * 60_000 }));
  const items = [...singles, ...pairs];
  const words = new Map(items.map(item => [item.data.id, (item.data as { sourceWord: string }).sourceWord]));
  const { today, upNext } = plan(items, inTheme(items, A));
  assert.equal(today?.itemIds.length, 13);
  assert.equal(new Set(today?.itemIds.map(id => words.get(id))).size, 13, 'thirteen different words');
  assert.ok(upNext[0].itemIds.some(id => id.startsWith('p')), 'a pair\'s second sentence comes in a later set');
});

test('when sentences of other words can\'t fill a set, it takes a word\'s second sentence, set apart from the first, so one set still meets the goal', () => {
  // 14 sentences over 7 words, two each: all 14 make one set, never the same word twice in a row.
  const items = Array.from({ length: 14 }, (_, i) =>
    sentenceItem(`t${i}`, `Twin line ${i}.`, { sourceWord: `twin-${i % 7}`, savedAt: NOW - DAY + i * 60_000 }));
  const words = new Map(items.map(item => [item.data.id, (item.data as { sourceWord: string }).sourceWord]));
  const { today } = plan(items, inTheme(items, A));
  assert.equal(today?.itemIds.length, 14);
  assert.ok((today?.itemIds.length ?? 0) >= DAILY_SET_GOAL, 'one set meets the day\'s goal');
  assert.equal(adjacentPair(today?.itemIds ?? [], id => words.get(id) ?? ''), false);

  // A small theme takes all it has, its two sentences of 'lead' kept apart.
  const small = [
    sentenceItem('lead-1', 'She will {{lead}} the team.', { sourceWord: 'lead', savedAt: NOW - 3 * HOUR }),
    sentenceItem('lead-2', 'Who {{leads}} today?', { sourceWord: 'Lead ', savedAt: NOW - 2 * HOUR }),
    sentenceItem('walk', 'Let\'s {{walk}}.', { sourceWord: 'walk', savedAt: NOW - HOUR }),
  ];
  assert.deepEqual(plan(small, inTheme(small, A)).today?.itemIds, ['lead-2', 'walk', 'lead-1']);
});

test('two sentences that reach one card, by its spelling, sense or a listed form, count as one word: set apart in a set', () => {
  const items = [
    vocabItem('run', 'run', { sense: 'verb: move fast', forms: ['ran', 'running'], savedAt: NOW - 9 * HOUR }),
    vocabItem('make-time', 'make time', { forms: ['making time'], savedAt: NOW - 9 * HOUR }),
    sentenceItem('s-ran', 'He {{ran}} home.', { sourceWord: 'ran', savedAt: NOW - 5 * HOUR }),
    sentenceItem('s-run', 'I {{run}} every morning.', { sourceWord: 'run', savedAt: NOW - 4 * HOUR }),
    sentenceItem('s-making-time', 'She is {{making time}} for it.', { sourceWord: 'making time', savedAt: NOW - 3 * HOUR }),
    sentenceItem('s-make-time', 'Please {{make time}} for this.', { sourceWord: 'make time', savedAt: NOW - 2 * HOUR }),
    sentenceItem('s-other', 'An {{unrelated}} line.', { sourceWord: 'unrelated', savedAt: NOW }),
  ];
  const result = plan(items, inTheme(items, A));
  // Filling takes s-other, s-make-time and s-run first; s-making-time reaches the make-time card through a form and
  // s-ran the run card, so they come in only to fill the set, and no two of one card stand together.
  assert.deepEqual(result.today?.itemIds, ['s-make-time', 's-run', 's-other', 's-making-time', 's-ran']);
  assert.deepEqual(result.upNext, []);
});

test('topping up a set gives every word a second sentence before any word a third', () => {
  // 24 sentences over six words, word A's four saved newest: two sets of 12, each word twice in the first.
  const items = Array.from({ length: 24 }, (_, i) =>
    sentenceItem(`r${i}`, `Round line ${i}.`, { sourceWord: i >= 18 ? 'word-a' : `word-${i % 5}`, savedAt: NOW - DAY + i * 60_000 }));
  const words = new Map(items.map(item => [item.data.id, (item.data as { sourceWord: string }).sourceWord]));
  const { today } = plan(items, inTheme(items, A));
  const counts = new Map<string, number>();
  for (const id of today?.itemIds ?? []) counts.set(words.get(id) ?? '', (counts.get(words.get(id) ?? '') ?? 0) + 1);
  assert.equal(today?.itemIds.length, 12);
  assert.deepEqual([...counts.values()], [2, 2, 2, 2, 2, 2]);
  assert.equal(adjacentPair(today?.itemIds ?? [], id => words.get(id) ?? ''), false);
});

test('a word with many sentences in a set is spread across it, alternating with the others where the set allows', () => {
  // Seven of thirteen sentences ask for one word: only strict alternation keeps them apart, and the set finds it.
  const items = 'ABCDEFCCCCCCA'.split('').map((word, i) =>
    sentenceItem(`g${i}`, `Spread line ${i}.`, { sourceWord: `word-${word}`, savedAt: NOW - DAY + i * 60_000 }));
  const words = new Map(items.map(item => [item.data.id, (item.data as { sourceWord: string }).sourceWord]));
  const ids = plan(items, inTheme(items, A)).today?.itemIds ?? [];
  assert.equal(ids.length, 13);
  assert.equal(ids.map(id => words.get(id)?.slice(-1)).join(''), 'CACFCECDCBCAC');
});

test('today\'s set comes from the best theme, and Unsorted is never picked however big it is', () => {
  const a = sentences('a', 12, 30);
  const b = sentences('b', 12, 1); // saved yesterday: 12 recent saves
  const loose = sentences('u', 50, 1);
  const result = plan([...a, ...b, ...loose], { ...inTheme(a, A), ...inTheme(b, B) });
  assert.equal(result.today?.themeId, B);
  assert.deepEqual(result.pin, { day: TODAY, themeId: B });
  assert.equal(result.unsorted.newCount, 50);
  assert.equal(result.unsorted.nextSet.length, 17, 'its set is offered from the themes browser');
  assert.ok(result.upNext.every(set => set.themeId !== null));
  // Recently started, B is held back for two days.
  assert.equal(plan([...a, ...b], { ...inTheme(a, A), ...inTheme(b, B) }, { recentStarts: { [B]: NOW - HOUR } }).today?.themeId, A);
  // Equal scores go to the lower id.
  const c = sentences('c', 12, 30);
  assert.equal(plan([...a, ...c], { ...inTheme(a, A), ...inTheme(c, C) }).today?.themeId, A < C ? A : C);
  assert.deepEqual(plan(loose, {}), { themes: new Map(), unsorted: plan(loose, {}).unsorted, today: null, pin: null, upNext: [], awaitingTranslation: 0 });
});

test('the day pin keeps today\'s theme while it has new sentences, and gives way on a new day or once they are all decided', () => {
  const a = sentences('a', 12, 30);
  const b = sentences('b', 12, 1);
  const themeOf = { ...inTheme(a, A), ...inTheme(b, B) };
  // B scores higher, but A is pinned for today.
  const pinned = plan([...a, ...b], themeOf, { pin: { day: TODAY, themeId: A } });
  assert.equal(pinned.today?.themeId, A);
  assert.deepEqual(pinned.pin, { day: TODAY, themeId: A });
  assert.equal(plan([...a, ...b], themeOf, { pin: { day: localDayKey(NOW - DAY), themeId: A } }).today?.themeId, B, 'yesterday\'s pin');
  const gotIt = a.map(item => withSrs(item, reviewed(NOW - HOUR)));
  assert.deepEqual(plan([...gotIt, ...b], themeOf, { pin: { day: TODAY, themeId: A } }).pin, { day: TODAY, themeId: A }, 'Got it decides nothing');
  const decided = a.map(item => withSrs(item, passive(NOW - HOUR)));
  assert.deepEqual(plan([...decided, ...b], themeOf, { pin: { day: TODAY, themeId: A } }).pin, { day: TODAY, themeId: B }, 'A has no new sentence left');
  assert.equal(plan([...a, ...b], themeOf, { pin: { day: TODAY, themeId: 'retired-theme' } }).today?.themeId, B);
});

test('up next simulates three more sets, each holding its theme back, and a theme with sentences left can come round again', () => {
  const a = sentences('a', 40, 1);
  const b = sentences('b', 12, 1);
  const c = sentences('c', 10, 30);
  const result = plan([...a, ...b, ...c], { ...inTheme(a, A), ...inTheme(b, B), ...inTheme(c, C) });
  assert.equal(result.today?.themeId, A);
  // A's 40 make three sets of 14; held back after today's, it comes round again once B and C are used up, with 26 left.
  assert.equal(result.today?.itemIds.length, 14);
  assert.deepEqual(result.upNext.map(set => [set.themeId, set.itemIds.length]), [[B, 12], [C, 10], [A, 13]]);
  const all = [result.today!, ...result.upNext].flatMap(set => set.itemIds);
  assert.equal(new Set(all).size, all.length, 'no sentence is in two sets');
  // With fewer themes the simulation stops when no new sentence is left.
  const only = sentences('o', 5);
  assert.deepEqual(plan(only, inTheme(only, A)).upNext, []);
});

test('the plan is the same whatever order the library holds the items in', () => {
  const b = sentences('b', 9, 1);
  const items = [
    ...sentences('a', 25, 3), ...b, vocabItem('card', 'a-word-3', { savedAt: NOW - HOUR }),
    sentenceItem('dup', 'Another a line.', { sourceWord: 'a-word-3', savedAt: NOW - HOUR }),
  ];
  const themeOf = { ...inTheme(items, A), ...inTheme(b, B) };
  const forward = plan(items, themeOf);
  const backward = plan([...items].reverse(), themeOf);
  assert.deepEqual(backward, forward);
});

test('planning a library of 20,000 sentences beside 13,000 cards stays fast: sentences are compared only with the set being filled', () => {
  const cards = Array.from({ length: 13_000 }, (_, i) => vocabItem(`c${i}`, `word${i}`, { forms: [`word${i}s`], savedAt: i * 1_000 }));
  // Four sentences of each of 5,000 words, half of them reaching their card through a form, some Got it'd or decided.
  const lines = Array.from({ length: 20_000 }, (_, i) => sentenceItem(`s${i}`, `A line about word${i % 5_000}, number ${i}.`, {
    sourceWord: i % 2 ? `word${i % 5_000}` : `word${i % 5_000}s`,
    savedAt: i * 1_000,
    ...(i % 7 === 0 ? { srs: reviewed(NOW - DAY) } : i % 11 === 0 ? { srs: passive(NOW - DAY) } : {}),
  }));
  const items = [...cards, ...lines];
  const themeOf = Object.fromEntries([...lines.slice(0, 15_000), ...cards].map((item, i) => [item.data.id, THEMES[i % THEMES.length].id]));
  const started = performance.now();
  const result = plan(items, themeOf);
  const elapsed = performance.now() - started;
  assert.equal(result.unsorted.total, 5_000);
  assert.ok(result.today && result.today.itemIds.length >= DAILY_SET_GOAL);
  assert.ok(elapsed < 2_000, `planned in ${Math.round(elapsed)} ms`);
});
