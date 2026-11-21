import assert from 'node:assert/strict';
import test from 'node:test';
import type { SRSData, StoredItem } from '../../types.ts';
import { THEMES } from '../../server/src/shared/item-themes.ts';
import { planLoop, setSize, SET_START_PENALTY_MS, themeScore, type PlanInput } from '../../services/learningLoop/planner.ts';
import { localDayKey } from '../../services/learningLoop/standing.ts';
import { DAILY_SET_GOAL } from '../../services/learningLoop/stats.ts';
import { DAY, HOUR, memorized, reviewed, sentenceItem, vocabItem } from '../support/loop-fixtures.ts';

const NOW = new Date(2026, 10, 18, 15, 0).getTime();
const TODAY = localDayKey(NOW);
// Theme ids come from the taxonomy, which the designed one replaces: the tests take the first few, in id order.
const [A, B, C] = THEMES.map(theme => theme.id).sort();

/** `count` sentences never reviewed, each of its own word, saved `daysAgo` days back and then a minute apart, the last
 *  saved newest. */
function sentences(prefix: string, count: number, daysAgo = 30): StoredItem[] {
  return Array.from({ length: count }, (_, i) =>
    sentenceItem(`${prefix}${i}`, `A ${prefix} line, number ${i}.`, { sourceWord: `${prefix}-word-${i}`, savedAt: NOW - daysAgo * DAY + i * 60_000 }));
}

function plan(items: StoredItem[], themeOf: Record<string, string>, extra: Partial<PlanInput> = {}) {
  return planLoop({ items, themeOf: new Map(Object.entries(themeOf)), now: NOW, recentStarts: {}, pin: null, ...extra });
}

const inTheme = (items: StoredItem[], theme: string) => Object.fromEntries(items.map(item => [item.data.id, theme]));
const withSrs = (item: StoredItem, srs: Partial<SRSData>): StoredItem => ({ ...item, srs: { ...item.srs, ...srs } });

test('a theme with up to 20 sentences to review gives them all; a bigger one is split into equal units near 15, none below the day\'s goal', () => {
  const cases: [size: number, set: number][] = [
    [0, 0], [1, 1], [8, 8], [20, 20], [21, 21], [23, 23], [24, 12], [30, 15], [37, 19], [38, 13], [60, 15], [61, 16], [1000, 15],
  ];
  for (const [size, set] of cases) assert.equal(setSize(size), set, String(size));
  for (let size = 21; size <= 500; size++) assert.ok(setSize(size) >= DAILY_SET_GOAL && setSize(size) <= 23, String(size));
});

test('a theme scores for its recent saves and its size, and is held back after a recent unit or when too small', () => {
  const theme = { themeId: A, size: 30, recentCount: 5 };
  assert.equal(themeScore(theme, {}, NOW), 3 * 5 + 30 / 4);
  assert.equal(themeScore({ ...theme, size: 100, recentCount: 25 }, {}, NOW), 3 * 20 + 60 / 4, 'both parts are capped');
  assert.equal(themeScore(theme, { [A]: NOW - DAY }, NOW), 3 * 5 + 30 / 4 - 100);
  assert.equal(themeScore(theme, { [A]: NOW - SET_START_PENALTY_MS }, NOW), 3 * 5 + 30 / 4, 'two days on, no longer');
  assert.equal(themeScore(theme, { [B]: NOW }, NOW), 3 * 5 + 30 / 4, 'another theme\'s unit');
  assert.equal(themeScore({ ...theme, size: 11, recentCount: 0 }, {}, NOW), 11 / 4 - 30, 'too few for the day\'s goal');
  assert.equal(themeScore({ ...theme, size: 12, recentCount: 0 }, {}, NOW), 12 / 4);
  assert.equal(themeScore({ ...theme, themeId: 'constructor' }, {}, NOW), 22.5, 'starts are looked up as own keys');
});

test('the plan counts each theme\'s sentences to review and memorized, sends unknown and missing themes to Unsorted, and needs no translation', () => {
  const items = [
    sentenceItem('n1', 'One.', { savedAt: NOW - DAY }),
    sentenceItem('n2', 'Two.', { savedAt: NOW - 20 * DAY }),
    sentenceItem('due', 'Got it once, and due again.', { srs: reviewed(NOW - 3 * DAY, { nextReview: NOW - HOUR }) }),
    sentenceItem('resting', 'Got it, resting.', { srs: memorized(NOW - DAY) }),
    sentenceItem('untranslated', 'Soon {{translated}}.', { translation: null, savedAt: NOW - HOUR }),
    sentenceItem('gone', 'Deleted.', { isDeleted: true }),
    sentenceItem('kept', 'Archived.', { isArchived: true }),
    vocabItem('word', 'word', { chinese: '词' }),
    sentenceItem('future', 'A theme from a newer taxonomy.'),
    sentenceItem('loose', 'No theme yet.', { srs: memorized(NOW - HOUR) }),
    sentenceItem('real-life-sentence:x:y:01', 'Line.', { catalogKind: 'real-life', catalogSentenceId: 'x:y:01', catalogCollectionId: 'x' }),
  ];
  const result = plan(items, {
    n1: A, n2: A, due: A, resting: A, untranslated: A, gone: A, kept: A, word: A, 'real-life-sentence:x:y:01': A,
    future: 'a-theme-from-a-newer-taxonomy',
  });
  assert.deepEqual([...result.themes.keys()], [A]);
  const { nextSet, ...counts } = result.themes.get(A)!;
  assert.deepEqual(counts, { themeId: A, toReviewCount: 4, memorizedCount: 1, total: 5, recentCount: 2 });
  assert.deepEqual([...nextSet].sort(), ['due', 'n1', 'n2', 'untranslated'], 'the word card and the catalog line in the theme are no part of it');
  assert.deepEqual(result.unsorted, { themeId: null, toReviewCount: 1, memorizedCount: 1, total: 2, recentCount: 0, nextSet: ['future'] });
});

test('a unit takes only sentences that need review, never reviewed or due again; a memorized one counts as memorized and waits', () => {
  const items = [
    sentenceItem('fresh', 'Never reviewed.', { sourceWord: 'fresh', savedAt: NOW - 3 * HOUR }),
    sentenceItem('due', 'Got it twice, due again.', { sourceWord: 'due', savedAt: NOW - 2 * HOUR, srs: reviewed(NOW - 9 * DAY, { totalReviews: 2, nextReview: NOW }) }),
    sentenceItem('resting', 'Got it yesterday.', { sourceWord: 'rest', savedAt: NOW - HOUR, srs: memorized(NOW - DAY) }),
    sentenceItem('strong', 'Got it often.', { sourceWord: 'strong', savedAt: NOW - HOUR, srs: reviewed(NOW - DAY, { totalReviews: 6, nextReview: NOW + 40 * DAY }) }),
  ];
  const result = plan(items, inTheme(items, A));
  assert.deepEqual(result.today, { themeId: A, itemIds: ['due', 'fresh'] });
  const theme = result.themes.get(A)!;
  assert.deepEqual([theme.toReviewCount, theme.memorizedCount, theme.total], [2, 2, 4]);
  // Once its rest is over, the memorized sentence needs review again, and the plan takes it.
  const later = plan(items, inTheme(items, A), { now: NOW + 2 * DAY });
  assert.deepEqual([...(later.today?.itemIds ?? [])].sort(), ['due', 'fresh', 'resting']);
  assert.equal(later.themes.get(A)?.memorizedCount, 1);
});

test('the unfinished active unit\'s sentences are left out of every unit the plan composes, and still count as to review', () => {
  const a = sentences('a', 30, 1);
  const b = sentences('b', 12, 30);
  const themeOf = { ...inTheme(a, A), ...inTheme(b, B) };
  const whole = plan([...a, ...b], themeOf);
  assert.equal(whole.today?.themeId, A);
  const active = new Set(whole.today?.itemIds);
  assert.equal(active.size, 15);

  const result = plan([...a, ...b], themeOf, { exclude: active });
  const theme = result.themes.get(A)!;
  // To review counts all 30, as the Sentences tab does; the theme's units, and its score's recent saves, take the 15 left.
  assert.deepEqual([theme.toReviewCount, theme.memorizedCount, theme.total, theme.recentCount], [30, 0, 30, 15]);
  const composed = [result.today, ...result.upNext].flatMap(set => set?.itemIds ?? []);
  assert.ok(composed.length > 0);
  assert.ok(composed.every(id => !active.has(id)), 'no unit overlaps the active one');
  assert.ok(theme.nextSet.every(id => !active.has(id)), 'nor does the themes browser\'s');
  // A sentence of the active unit that was Got it'd since counts as memorized, as anywhere.
  assert.ok(active.has('a29'));
  const gotIt = a.map(item => (item.data.id === 'a29' ? withSrs(item, memorized(NOW - HOUR)) : item));
  assert.equal(plan([...gotIt, ...b], themeOf, { exclude: active }).themes.get(A)?.memorizedCount, 1);
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

test('sentences joined through a card count as one word even when they share no word directly; one asking for nothing is its own', () => {
  // Two cards list the form 'fork'. s-alpha reaches alpha through it and s-beta reaches beta, so the two share 'fork';
  // s-beta-card asks for beta itself and shares nothing with s-alpha, yet joins it through s-beta.
  const items = [
    vocabItem('alpha', 'alpha', { sense: 'n1', forms: ['fork'], savedAt: NOW - 9 * DAY }),
    vocabItem('beta', 'beta', { sense: 'n2', forms: ['fork'], savedAt: NOW - 9 * DAY }),
    sentenceItem('s-alpha', 'Take the {{fork}}.', { sourceWord: 'fork', sourceSense: 'n1', savedAt: NOW - HOUR }),
    sentenceItem('s-beta-card', 'A {{beta}} test.', { sourceWord: 'beta', savedAt: NOW - 2 * HOUR }),
    sentenceItem('s-beta', 'The road will {{fork}}.', { sourceWord: 'fork', sourceSense: 'n2', savedAt: NOW - 3 * HOUR }),
    sentenceItem('none-1', 'A line with nothing marked.', { savedAt: NOW - 4 * HOUR }),
    sentenceItem('none-2', 'Another line with nothing marked.', { savedAt: NOW - 5 * HOUR }),
    ...sentences('d', 20, 2),
  ];
  // 25 new sentences make two sets of 13: the first takes one of the three joined sentences, and both unmarked ones.
  const today = plan(items, inTheme(items, A)).today?.itemIds ?? [];
  assert.equal(today.length, 13);
  assert.deepEqual(today.filter(id => id.startsWith('s-')), ['s-alpha']);
  assert.ok(today.includes('none-1') && today.includes('none-2'));
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

test('today\'s unit comes from the best theme, and Unsorted is never picked however big it is', () => {
  const a = sentences('a', 12, 30);
  const b = sentences('b', 12, 1); // saved yesterday: 12 recent saves
  const loose = sentences('u', 50, 1);
  const result = plan([...a, ...b, ...loose], { ...inTheme(a, A), ...inTheme(b, B) });
  assert.equal(result.today?.themeId, B);
  assert.deepEqual(result.pin, { day: TODAY, themeId: B });
  assert.equal(result.unsorted.toReviewCount, 50);
  assert.equal(result.unsorted.nextSet.length, 17, 'its unit is offered from the themes browser');
  assert.ok(result.upNext.every(set => set.themeId !== null));
  // Recently started, B is held back for two days.
  assert.equal(plan([...a, ...b], { ...inTheme(a, A), ...inTheme(b, B) }, { recentStarts: { [B]: NOW - HOUR } }).today?.themeId, A);
  // Equal scores go to the lower id.
  const c = sentences('c', 12, 30);
  assert.equal(plan([...a, ...c], { ...inTheme(a, A), ...inTheme(c, C) }).today?.themeId, A < C ? A : C);
  assert.deepEqual(plan(loose, {}), { themes: new Map(), unsorted: plan(loose, {}).unsorted, today: null, pin: null, upNext: [] });
});

test('the day pin keeps today\'s theme while it has sentences to review, and gives way on a new day or once they are all memorized', () => {
  const a = sentences('a', 12, 30);
  const b = sentences('b', 12, 1);
  const themeOf = { ...inTheme(a, A), ...inTheme(b, B) };
  // B scores higher, but A is pinned for today.
  const pinned = plan([...a, ...b], themeOf, { pin: { day: TODAY, themeId: A } });
  assert.equal(pinned.today?.themeId, A);
  assert.deepEqual(pinned.pin, { day: TODAY, themeId: A });
  assert.equal(plan([...a, ...b], themeOf, { pin: { day: localDayKey(NOW - DAY), themeId: A } }).today?.themeId, B, 'yesterday\'s pin');
  const dueAgain = a.map(item => withSrs(item, reviewed(NOW - 3 * DAY, { nextReview: NOW - HOUR })));
  assert.deepEqual(plan([...dueAgain, ...b], themeOf, { pin: { day: TODAY, themeId: A } }).pin, { day: TODAY, themeId: A }, 'due again: still to review');
  const gotIt = a.map(item => withSrs(item, memorized(NOW - HOUR)));
  assert.deepEqual(plan([...gotIt, ...b], themeOf, { pin: { day: TODAY, themeId: A } }).pin, { day: TODAY, themeId: B }, 'A has nothing left to review');
  const inUnit = new Set(a.map(item => item.data.id));
  assert.deepEqual(plan([...a, ...b], themeOf, { pin: { day: TODAY, themeId: A }, exclude: inUnit }).pin, { day: TODAY, themeId: B }, 'all of A in the active unit');
  assert.equal(plan([...a, ...b], themeOf, { pin: { day: TODAY, themeId: 'retired-theme' } }).today?.themeId, B);
});

test('up next simulates three more units, each holding its theme back, and a theme with sentences left can come round again', () => {
  const a = sentences('a', 40, 1);
  const b = sentences('b', 12, 1);
  const c = sentences('c', 10, 30);
  const result = plan([...a, ...b, ...c], { ...inTheme(a, A), ...inTheme(b, B), ...inTheme(c, C) });
  assert.equal(result.today?.themeId, A);
  // A's 40 make three units of 14; held back after today's, it comes round again once B and C are used up, with 26 left.
  assert.equal(result.today?.itemIds.length, 14);
  assert.deepEqual(result.upNext.map(set => [set.themeId, set.itemIds.length]), [[B, 12], [C, 10], [A, 13]]);
  const all = [result.today!, ...result.upNext].flatMap(set => set.itemIds);
  assert.equal(new Set(all).size, all.length, 'no sentence is in two units');
  // With fewer themes the simulation stops when no sentence to review is left.
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

test('planning a library of 20,000 sentences beside 13,000 cards stays fast: sentences are compared only with the unit being filled', () => {
  const cards = Array.from({ length: 13_000 }, (_, i) => vocabItem(`c${i}`, `word${i}`, { forms: [`word${i}s`], savedAt: i * 1_000 }));
  // Four sentences of each of 5,000 words, half of them reaching their card through a form, some due again or memorized.
  const lines = Array.from({ length: 20_000 }, (_, i) => sentenceItem(`s${i}`, `A line about word${i % 5_000}, number ${i}.`, {
    sourceWord: i % 2 ? `word${i % 5_000}` : `word${i % 5_000}s`,
    savedAt: i * 1_000,
    ...(i % 7 === 0 ? { srs: reviewed(NOW - 9 * DAY) } : i % 11 === 0 ? { srs: memorized(NOW - DAY) } : {}),
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
