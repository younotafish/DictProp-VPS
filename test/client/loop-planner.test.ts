import assert from 'node:assert/strict';
import test from 'node:test';
import type { StoredItem } from '../../types.ts';
import { THEMES } from '../../server/src/shared/item-themes.ts';
import { glossSegments, planLoop, setSize, SET_START_PENALTY_MS, themeScore, type PlanInput } from '../../services/learningLoop/planner.ts';
import { localDayKey } from '../../services/learningLoop/standing.ts';
import { DAILY_SET_GOAL } from '../../services/learningLoop/stats.ts';
import { DAY, HOUR, practicing, reviewed, sayable, sentenceItem, vocabItem } from '../support/loop-fixtures.ts';

const NOW = new Date(2026, 10, 18, 15, 0).getTime();
const TODAY = localDayKey(NOW);
// Theme ids come from the taxonomy, which the designed one replaces: the tests take the first few, in id order.
const [A, B, C] = THEMES.map(theme => theme.id).sort();

/** `count` new words in `theme`, saved `daysAgo` days back and then a minute apart, the last saved newest. */
function words(prefix: string, count: number, daysAgo = 30): StoredItem[] {
  return Array.from({ length: count }, (_, i) =>
    vocabItem(`${prefix}${i}`, `${prefix}-word-${i}`, { chinese: `${prefix}释义${i}`, savedAt: NOW - daysAgo * DAY + i * 60_000 }));
}

function plan(items: StoredItem[], themeOf: Record<string, string>, extra: Partial<PlanInput> = {}) {
  return planLoop({ items, themeOf: new Map(Object.entries(themeOf)), now: NOW, recentStarts: {}, pin: null, ...extra });
}

const inTheme = (items: StoredItem[], theme: string) => Object.fromEntries(items.map(item => [item.data.id, theme]));

test('a theme with up to 20 new items gives them all; a bigger one is split into equal sets near 15, none below the day\'s goal', () => {
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

test('gloss segments split at Chinese and Latin separators, leave out notes in brackets and single characters', () => {
  assert.deepEqual(glossSegments('虚假；虚伪；做作'), ['虚假', '虚伪', '做作']);
  assert.deepEqual(glossSegments('（正式文件的）序言；开篇说明'), ['序言', '开篇说明']);
  assert.deepEqual(glossSegments('（in stitches）笑得停不下来；笑得前仰后合'), ['笑得停不下来', '笑得前仰后合']);
  assert.deepEqual(glossSegments('跑；走, 行走 / 步行、(informal) 溜达'), ['行走', '步行', '溜达']);
  assert.deepEqual(glossSegments(''), []);
});

test('the plan counts each theme\'s items by standing, sends unknown and missing themes to Unsorted, and counts sentences waiting for a translation', () => {
  const items = [
    vocabItem('n1', 'one', { savedAt: NOW - DAY }),
    vocabItem('n2', 'two', { savedAt: NOW - 20 * DAY }),
    vocabItem('p', 'three', { srs: practicing(NOW - DAY) }),
    vocabItem('s', 'four', { srs: sayable(NOW - DAY) }),
    vocabItem('r', 'five', { srs: reviewed(NOW - DAY) }),
    vocabItem('gone', 'six', { isDeleted: true }),
    vocabItem('kept', 'seven', { isArchived: true }),
    vocabItem('future', 'eight'),
    vocabItem('loose', 'nine'),
    sentenceItem('untranslated', 'Soon {{translated}}.', { translation: null }),
    sentenceItem('untranslated-reviewed', 'Old.', { translation: null, srs: reviewed(NOW - DAY) }),
    sentenceItem('untranslated-archived', 'Kept.', { translation: null, isArchived: true }),
    sentenceItem('real-life-sentence:x:y:01', 'Line.', { translation: null, catalogKind: 'real-life', catalogSentenceId: 'x:y:01', catalogCollectionId: 'x' }),
  ];
  const result = plan(items, { n1: A, n2: A, p: A, s: A, r: A, gone: A, kept: A, future: 'a-theme-from-a-newer-taxonomy' });
  assert.deepEqual([...result.themes.keys()], [A]);
  const { nextSet, ...counts } = result.themes.get(A)!;
  assert.deepEqual(counts, { themeId: A, newCount: 2, practicingCount: 1, sayableCount: 1, total: 5, recentCount: 1 });
  assert.deepEqual(nextSet, ['n1', 'n2']);
  assert.deepEqual({ ...result.unsorted, nextSet: [...result.unsorted.nextSet].sort() }, {
    themeId: null, newCount: 2, practicingCount: 0, sayableCount: 0, total: 2, recentCount: 0, nextSet: ['future', 'loose'],
  });
  assert.equal(result.awaitingTranslation, 1);
});

test('a set takes two thirds from the newest saves and the rest from the oldest', () => {
  const items = words('a', 30);
  const { today } = plan(items, inTheme(items, A));
  // 30 new items make two sets of 15: the newest 10 (a29 back to a20), then the oldest 5 (a0 up to a4).
  assert.deepEqual(today, { themeId: A, itemIds: ['a29', 'a28', 'a27', 'a26', 'a25', 'a24', 'a23', 'a22', 'a21', 'a20', 'a0', 'a1', 'a2', 'a3', 'a4'] });
});

test('filling a set skips a second meaning of a spelling, which stays for a later set', () => {
  const items = [
    vocabItem('lead-verb', 'lead', { sense: 'verb: guide', savedAt: NOW - 3 * HOUR }),
    vocabItem('lead-metal', 'Lead ', { sense: 'noun: metal', savedAt: NOW - 2 * HOUR }),
    vocabItem('walk', 'walk', { savedAt: NOW - HOUR }),
  ];
  const result = plan(items, inTheme(items, A));
  assert.deepEqual(result.today?.itemIds, ['walk', 'lead-metal']);
  assert.equal(result.themes.get(A)?.newCount, 3, 'the skipped meaning is still new in the theme');
  assert.deepEqual(result.upNext, [{ themeId: A, itemIds: ['lead-verb'] }], 'the next set from the theme takes it');
});

test('a sentence and the card it came from go to different sets, matched by spelling, sense or a listed form', () => {
  const items = [
    vocabItem('run', 'run', { sense: 'verb: move fast', forms: ['ran', 'running'], savedAt: NOW - 5 * HOUR }),
    sentenceItem('s-ran', 'He {{ran}} home.', { sourceWord: 'ran', savedAt: NOW - 4 * HOUR }),
    vocabItem('run-noun', 'run', { sense: 'noun: a jog', savedAt: NOW - 3 * HOUR }),
    sentenceItem('s-make-time', 'She is {{making time}} for it.', { sourceWord: 'making time', savedAt: NOW - 2 * HOUR }),
    vocabItem('make-time', 'make time', { forms: ['making time'], savedAt: NOW - HOUR }),
    sentenceItem('s-other', 'An {{unrelated}} line.', { sourceWord: 'unrelated', savedAt: NOW }),
  ];
  const result = plan(items, inTheme(items, A));
  // Newest first: s-other, make-time (s-make-time asks for it through its forms), run-noun (s-ran asks for 'run'
  // through the verb's forms, and the verb is another meaning of it).
  assert.deepEqual(result.today?.itemIds, ['make-time', 'run-noun', 's-other']);
  assert.deepEqual(result.upNext.map(set => set.itemIds), [['s-make-time', 's-ran'], ['run']]);
});

test('two cards whose glosses share a segment, or that list each other as synonyms, go to different sets', () => {
  const items = [
    vocabItem('alliance', 'alliance', { chinese: '联盟；同盟', savedAt: NOW - 4 * HOUR }),
    vocabItem('coalition', 'coalition', { chinese: '（政党的）联盟', savedAt: NOW - 3 * HOUR }),
    vocabItem('glad', 'glad', { chinese: '高兴的', synonyms: ['Happy'], savedAt: NOW - 2 * HOUR }),
    vocabItem('happy', 'happy', { chinese: '快乐的', savedAt: NOW - HOUR }),
    vocabItem('joyful', 'joyful', { chinese: '喜悦的', savedAt: NOW - 30 * 60_000 }),
    vocabItem('cheerful', 'cheerful', { chinese: '开朗的', savedAt: NOW - 20 * 60_000 }),
    vocabItem('elated', 'elated', { chinese: '兴高采烈的', synonyms: ['cheerful'], savedAt: NOW - 10 * 60_000 }),
  ];
  const result = plan(items, inTheme(items, A));
  // Newest first: elated (lists cheerful), joyful, happy (glad lists it), coalition (alliance shares 联盟).
  assert.deepEqual(result.today?.itemIds, ['elated', 'joyful', 'happy', 'coalition']);
  assert.deepEqual(result.upNext[0], { themeId: A, itemIds: ['cheerful', 'glad', 'alliance'] });
});

test('in a set the words come first, their parts of speech taking turns where they can, then the sentences', () => {
  const pos = (id: string, sense: string, minutes: number) => vocabItem(id, id, { sense, savedAt: NOW - minutes * 60_000 });
  const items = [
    pos('n1', 'noun: a', 1), pos('n2', 'noun: b', 2), sentenceItem('s1', 'A {{line}}.', { sourceWord: 'line', savedAt: NOW - 3 * 60_000 }),
    pos('n3', 'noun: c', 4), pos('v1', 'verb: d', 5), pos('v2', 'verb: e', 6), pos('a1', 'adjective: f', 7),
  ];
  assert.deepEqual(plan(items, inTheme(items, A)).today?.itemIds, ['n1', 'v1', 'n2', 'v2', 'n3', 'a1', 's1']);
});

test('today\'s set comes from the best theme, and Unsorted is never picked however big it is', () => {
  const a = words('a', 12, 30);
  const b = words('b', 12, 1); // saved yesterday: 12 recent saves
  const loose = words('u', 50, 1);
  const result = plan([...a, ...b, ...loose], { ...inTheme(a, A), ...inTheme(b, B) });
  assert.equal(result.today?.themeId, B);
  assert.deepEqual(result.pin, { day: TODAY, themeId: B });
  assert.equal(result.unsorted.newCount, 50);
  assert.equal(result.unsorted.nextSet.length, 17, 'its set is offered from the themes browser');
  assert.ok(result.upNext.every(set => set.themeId !== null));
  // Recently started, B is held back for two days.
  assert.equal(plan([...a, ...b], { ...inTheme(a, A), ...inTheme(b, B) }, { recentStarts: { [B]: NOW - HOUR } }).today?.themeId, A);
  // Equal scores go to the lower id.
  const c = words('c', 12, 30);
  assert.equal(plan([...a, ...c], { ...inTheme(a, A), ...inTheme(c, C) }).today?.themeId, A < C ? A : C);
  assert.deepEqual(plan(loose, {}), { themes: new Map(), unsorted: plan(loose, {}).unsorted, today: null, pin: null, upNext: [], awaitingTranslation: 0 });
});

test('the day pin keeps today\'s theme while it has new items, and gives way on a new day or once they run out', () => {
  const a = words('a', 12, 30);
  const b = words('b', 12, 1);
  const themeOf = { ...inTheme(a, A), ...inTheme(b, B) };
  // B scores higher, but A is pinned for today.
  const pinned = plan([...a, ...b], themeOf, { pin: { day: TODAY, themeId: A } });
  assert.equal(pinned.today?.themeId, A);
  assert.deepEqual(pinned.pin, { day: TODAY, themeId: A });
  assert.equal(plan([...a, ...b], themeOf, { pin: { day: localDayKey(NOW - DAY), themeId: A } }).today?.themeId, B, 'yesterday\'s pin');
  const metA = a.map(item => ({ ...item, srs: { ...item.srs, ...reviewed(NOW - HOUR) } }));
  const repicked = plan([...metA, ...b], themeOf, { pin: { day: TODAY, themeId: A } });
  assert.deepEqual(repicked.pin, { day: TODAY, themeId: B }, 'A has no new items left');
  assert.equal(plan([...a, ...b], themeOf, { pin: { day: TODAY, themeId: 'retired-theme' } }).today?.themeId, B);
});

test('up next simulates three more sets, each holding its theme back, and a theme with items left can come round again', () => {
  const a = words('a', 40, 1);
  const b = words('b', 12, 1);
  const c = words('c', 10, 30);
  const result = plan([...a, ...b, ...c], { ...inTheme(a, A), ...inTheme(b, B), ...inTheme(c, C) });
  assert.equal(result.today?.themeId, A);
  // A's 40 make three sets of 14; held back after today's, it comes round again once B and C are used up, with 26 left.
  assert.equal(result.today?.itemIds.length, 14);
  assert.deepEqual(result.upNext.map(set => [set.themeId, set.itemIds.length]), [[B, 12], [C, 10], [A, 13]]);
  const all = [result.today!, ...result.upNext].flatMap(set => set.itemIds);
  assert.equal(new Set(all).size, all.length, 'no item is in two sets');
  // With fewer themes the simulation stops when no new item is left.
  const only = words('o', 5);
  assert.deepEqual(plan(only, inTheme(only, A)).upNext, []);
});

test('the plan is the same whatever order the library holds the items in', () => {
  const items = [...words('a', 25, 3), ...words('b', 9, 1), vocabItem('dup', 'a-word-3', { savedAt: NOW - HOUR })];
  const themeOf = { ...inTheme(items, A), ...inTheme(words('b', 9, 1), B) };
  const forward = plan(items, themeOf);
  const backward = plan([...items].reverse(), themeOf);
  assert.deepEqual(backward, forward);
});

test('planning a library of 17,000 items stays fast: items are compared only with the set being filled', () => {
  const items = Array.from({ length: 17_000 }, (_, i) => vocabItem(`i${i}`, `word${i}`, {
    chinese: `释义${i % 997}；说明${i}`, synonyms: [`word${(i * 7) % 17_000}`], sense: i % 2 ? 'noun: x' : 'verb: y', savedAt: i * 1_000,
  }));
  const themeOf = Object.fromEntries(items.slice(0, 12_000).map((item, i) => [item.data.id, THEMES[i % THEMES.length].id]));
  const started = performance.now();
  const result = plan(items, themeOf);
  const elapsed = performance.now() - started;
  assert.equal(result.unsorted.newCount, 5_000);
  assert.ok(result.today && result.today.itemIds.length > 0);
  assert.ok(elapsed < 2_000, `planned in ${Math.round(elapsed)} ms`);
});
