import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { indexCatalogProgress, type CatalogProgressIndex } from '../../services/catalogProgress.ts';
import { buildCatalogQueue, dueNewLine, studyButtonLabel } from '../../services/catalogQueue.ts';
import { ESSAYS } from '../../services/essayCatalog.ts';
import { createEssayProgressItem } from '../../services/essayProgress.ts';
import { REAL_LIFE_COLLECTIONS, type RealLifeCollection } from '../../services/realLifeCatalog.ts';
import { createRealLifeProgressItem } from '../../services/realLifeProgress.ts';
import { SRSAlgorithm } from '../../services/srsAlgorithm.ts';
import type { SRSData, StoredItem } from '../../types.ts';
import { summarizeReviewStates } from '../../services/sentenceReviewState.ts';
import { filterRealLifeSentences } from '../../views/reading/realLifeFilter.ts';
import { EssayIndex } from '../../views/reading/EssayIndex.tsx';
import { EssayReader } from '../../views/reading/EssayReader.tsx';
import { RealLifeCollectionScreen } from '../../views/reading/RealLifeCollectionScreen.tsx';
import { RealLifeIndex } from '../../views/reading/RealLifeIndex.tsx';

const NOW = Date.UTC(2026, 10, 15, 12);
const DAY = 86_400_000;

/** Schedules, as a line's progress record holds them at NOW. */
const DUE: Partial<SRSData> = { totalReviews: 2, nextReview: NOW - DAY, memoryStrength: 40 };
const MEMORIZED: Partial<SRSData> = { totalReviews: 3, nextReview: NOW + 3 * DAY, memoryStrength: 70 };
/** Listened to, never reviewed: an exposure leaves the line new. */
const LISTENED: Partial<SRSData> = { totalReviews: 0, lastExposureDate: NOW - DAY };

const withSchedule = (item: StoredItem, srs: Partial<SRSData>): StoredItem => ({ ...item, srs: { ...item.srs, ...srs } });

const lines = (...ids: string[]) => ids.map(id => ({ id }));
const record = (lineId: string, srs: Partial<SRSData>): StoredItem => {
  const id = `real-life-sentence:${lineId}`;
  return {
    type: 'sentence',
    data: { id, text: 'A line.', sourceWord: 'line', catalogKind: 'real-life', catalogSentenceId: lineId, catalogCollectionId: 'c' },
    savedAt: 1,
    srs: { ...SRSAlgorithm.createNew(id, 'sentence', 1), ...srs },
  };
};
const index = (schedules: Record<string, Partial<SRSData>>): CatalogProgressIndex =>
  indexCatalogProgress(Object.entries(schedules).map(([lineId, srs]) => record(lineId, srs)), 'real-life');
const ids = (sentences: readonly { id: string }[]) => sentences.map(sentence => sentence.id);

test('a run takes the due lines first and then the new ones, each in catalog order, and leaves memorized lines out', () => {
  const queue = buildCatalogQueue(
    lines('a', 'b', 'c', 'd', 'e', 'f'),
    index({ b: DUE, c: MEMORIZED, d: LISTENED, f: DUE }),
    NOW,
  );
  assert.deepEqual(ids(queue.sentences), ['b', 'f', 'a', 'd', 'e']);
  assert.equal(queue.practice, false);
  assert.equal(queue.due, 2);
  assert.equal(queue.fresh, 3, 'a line only listened to is still new');
  assert.equal(studyButtonLabel(queue), 'Study 5');
});

test('a line falls due at its next review, not before', () => {
  const schedules = index({ a: { totalReviews: 1, nextReview: NOW }, b: { totalReviews: 1, nextReview: NOW + 1 } });
  assert.deepEqual(ids(buildCatalogQueue(lines('a', 'b'), schedules, NOW).sentences), ['a']);
  assert.deepEqual(ids(buildCatalogQueue(lines('a', 'b'), schedules, NOW + 1).sentences), ['a', 'b']);
});

test('with nothing due or new in view, the run practices every line in view; with nothing in view it has none', () => {
  const practice = buildCatalogQueue(lines('a', 'b'), index({ a: MEMORIZED, b: MEMORIZED }), NOW);
  assert.deepEqual(ids(practice.sentences), ['a', 'b']);
  assert.deepEqual([practice.practice, practice.due, practice.fresh], [true, 0, 0]);
  assert.equal(studyButtonLabel(practice), 'Practice');

  const nothing = buildCatalogQueue([], index({}), NOW);
  assert.deepEqual(nothing.sentences, []);
  assert.equal(studyButtonLabel(nothing), 'Study');
});

test('Study over a theme takes that theme\'s due lines and then its new ones, and the search narrows it further', () => {
  const travel = REAL_LIFE_COLLECTIONS.find(collection => collection.id === 'travel-conversations')!;
  const theme = (sectionId: string) => travel.sentences.filter(sentence => sentence.sectionId === sectionId);
  const airport = theme('airport-checkin-and-baggage');
  const later = theme('hotel-arrival-and-checkin');
  const progress = indexCatalogProgress([
    withSchedule(createRealLifeProgressItem(airport[4], 1), DUE),
    withSchedule(createRealLifeProgressItem(airport[1], 1), MEMORIZED),
    withSchedule(createRealLifeProgressItem(later[2], 1), DUE),
  ], 'real-life');
  const scope = (sectionId: string, query = '') =>
    filterRealLifeSentences(travel.sentences, { sectionId, reviewFilter: 'all', query }, progress, NOW);

  const inTheme = buildCatalogQueue(scope('airport-checkin-and-baggage'), progress, NOW);
  assert.deepEqual(ids(inTheme.sentences), ids([airport[4], ...airport.filter((_, i) => i !== 4 && i !== 1)]));
  assert.equal(studyButtonLabel(inTheme), `Study ${airport.length - 1}`);

  // Without a theme, a review due in a later theme comes before every new line.
  const everything = buildCatalogQueue(scope('all'), progress, NOW);
  assert.deepEqual(ids(everything.sentences.slice(0, 3)), ids([airport[4], later[2], travel.sentences[0]]));
  assert.equal(everything.sentences.length, travel.sentences.length - 1);

  const searched = buildCatalogQueue(scope('airport-checkin-and-baggage', 'passport'), progress, NOW);
  assert.ok(searched.sentences.length > 0 && searched.sentences.length < inTheme.sentences.length);
  assert.ok(searched.sentences.every(sentence => sentence.sectionId === 'airport-checkin-and-baggage' && /passport/i.test(sentence.text)));
});

test('a tile\'s line says how many lines are due and how many are new, and only what is left', () => {
  const line = (...schedules: (Partial<SRSData> | undefined)[]) => dueNewLine(summarizeReviewStates(
    schedules.map(srs => srs && { ...SRSAlgorithm.createNew('line', 'sentence', 1), ...srs }),
    NOW,
  ));
  assert.deepEqual(line(DUE, DUE, undefined, LISTENED, MEMORIZED), { due: '2 due', rest: ' · 2 new' });
  assert.deepEqual(line(undefined, MEMORIZED), { due: null, rest: '1 new' });
  assert.deepEqual(line(DUE, MEMORIZED), { due: '1 due', rest: '' });
  assert.deepEqual(line(MEMORIZED, MEMORIZED), { due: null, rest: 'all reviewed' });
});

// The screens, rendered as markup.
const noop = () => {};
const studyButton = (markup: string) => markup.match(/<button type="button"( disabled="")? class="([^"]*)" title="Study [^"]*">.*?<\/button>/);

// A collection counts what's due from the time it opens, so the tests that open one set the clock to NOW.
const renderCollection = (collection: RealLifeCollection, progressIndex: CatalogProgressIndex) => renderToStaticMarkup(createElement(
  RealLifeCollectionScreen,
  {
    collection, progressIndex, onClose: noop, onOpenSentence: noop, onUpdateSRS: async () => true,
    isSentenceSaved: () => false, onScroll: noop,
  },
));

test('the collection\'s Study button counts the run and keeps a fixed width; with nothing in view it is disabled', (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: NOW });
  const career = REAL_LIFE_COLLECTIONS[0];
  const progress = indexCatalogProgress([
    withSchedule(createRealLifeProgressItem(career.sentences[3], 1), DUE),
    withSchedule(createRealLifeProgressItem(career.sentences[9], 1), MEMORIZED),
  ], 'real-life');
  const button = studyButton(renderCollection(career, progress));
  assert.ok(button, 'the Study button');
  assert.equal(button[1], undefined, 'enabled');
  assert.equal(
    button[2],
    'flex min-h-10 min-w-[6.5rem] shrink-0 items-center justify-center gap-1.5 rounded-xl bg-slate-900 px-3 text-xs font-bold text-white transition-colors hover:bg-slate-700 disabled:cursor-not-allowed disabled:bg-slate-300',
  );
  assert.match(button[0], /<\/svg> <span class="tabular-nums">Study 233<\/span><\/button>$/);
  assert.match(button[0], new RegExp(`title="Study ${career.title}"`));

  const allMemorized = indexCatalogProgress(
    career.sentences.map(sentence => withSchedule(createRealLifeProgressItem(sentence, 1), MEMORIZED)),
    'real-life',
  );
  assert.match(studyButton(renderCollection(career, allMemorized))![0], />Practice<\/span>/);

  const empty = studyButton(renderCollection({ ...career, sections: [], sentences: [] }, progress))!;
  assert.equal(empty[1], ' disabled=""');
  assert.match(empty[0], />Study<\/span>/);
});

test('the essay\'s Study button replaces Review, counting its due and new sentences', () => {
  const essay = ESSAYS.find(candidate => candidate.id === 'why-i-wrote-the-yellow-wallpaper')!;
  const render = (progressIndex: CatalogProgressIndex) => renderToStaticMarkup(createElement(EssayReader, {
    essay, progressIndex, now: NOW, onBack: noop, onOpenSentence: noop, onScroll: noop,
  }));

  const fresh = render(indexCatalogProgress([], 'essay'));
  const button = studyButton(fresh);
  assert.ok(button, 'the Study button');
  assert.equal(button[1], undefined, 'enabled');
  assert.equal(
    button[2],
    'flex min-h-10 min-w-[6.5rem] shrink-0 items-center justify-center gap-1.5 rounded-xl bg-slate-950 px-3 text-xs font-bold text-white transition-colors hover:bg-slate-700 disabled:cursor-not-allowed disabled:bg-slate-300 sm:px-4',
  );
  assert.match(button[0], new RegExp(`title="Study ${essay.title}"`));
  assert.match(button[0], new RegExp(`<span class="tabular-nums">Study ${essay.sentences.length}</span>`));
  assert.doesNotMatch(fresh, /Review/);

  const memorized = indexCatalogProgress(
    essay.sentences.map(sentence => withSchedule(createEssayProgressItem(sentence, 1), MEMORIZED)),
    'essay',
  );
  assert.match(studyButton(render(memorized))![0], />Practice<\/span>/);
});

const DUE_PILL = '<span class="rounded-full bg-orange-500/90 px-1.5 py-0.5 text-white">';

test('each Real Life tile says how many lines are due, as an orange pill, and how many are new', () => {
  const [career, shopping, executive, restaurant, travel] = REAL_LIFE_COLLECTIONS;
  const progress = indexCatalogProgress([
    withSchedule(createRealLifeProgressItem(career.sentences[0], 1), DUE),
    withSchedule(createRealLifeProgressItem(career.sentences[5], 1), DUE),
    withSchedule(createRealLifeProgressItem(career.sentences[7], 1), MEMORIZED),
    ...restaurant.sentences.map(sentence => withSchedule(createRealLifeProgressItem(sentence, 1), MEMORIZED)),
    ...travel.sentences.map((sentence, i) => withSchedule(createRealLifeProgressItem(sentence, 1), i === 3 ? DUE : MEMORIZED)),
  ], 'real-life');
  const markup = renderToStaticMarkup(createElement(RealLifeIndex, { progressIndex: progress, now: NOW, onOpenCollection: noop, onScroll: noop }));
  const lines = [...markup.matchAll(/<p class="text-\[10px\] font-semibold uppercase tracking-wider text-white\/70 sm:text-xs">(.*?)<\/p>/g)]
    .map(match => match[1]);
  assert.deepEqual(lines, [
    `${DUE_PILL}2 due</span> · ${career.sentences.length - 3} new`,
    `${shopping.sentences.length} new`,
    `${executive.sentences.length} new`,
    'all reviewed',
    `${DUE_PILL}1 due</span>`,
  ]);
  assert.doesNotMatch(markup, /to review|review complete/);
});

test('each essay tile has the same line under its length', () => {
  const [selfReliance, ...rest] = ESSAYS;
  const progress = indexCatalogProgress([
    withSchedule(createEssayProgressItem(selfReliance.sentences[0], 1), DUE),
    withSchedule(createEssayProgressItem(selfReliance.sentences[1], 1), MEMORIZED),
  ], 'essay');
  const markup = renderToStaticMarkup(createElement(EssayIndex, {
    essays: ESSAYS, catalogStatus: 'ready', onRetryCatalog: noop, progressIndex: progress, now: NOW, onOpenEssay: noop, onScroll: noop,
  }));
  const lines = [...markup.matchAll(/sentences · \d+ min<\/p><p class="mt-1\.5 text-\[10px\] font-semibold uppercase tracking-wider text-white\/65 sm:text-xs">(.*?)<\/p>/g)]
    .map(match => match[1]);
  assert.deepEqual(lines, [
    `${DUE_PILL}1 due</span> · ${selfReliance.sentences.length - 2} new`,
    ...rest.map(essay => `${essay.sentences.length} new`),
  ]);
});

test('the collection\'s stats strip and the essay\'s progress card count due reviews, with the new lines as the caption', (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: NOW });
  const career = REAL_LIFE_COLLECTIONS[0];
  const careerProgress = indexCatalogProgress([
    withSchedule(createRealLifeProgressItem(career.sentences[0], 1), DUE),
    withSchedule(createRealLifeProgressItem(career.sentences[1], 1), MEMORIZED),
  ], 'real-life');
  assert.ok(renderCollection(career, careerProgress).includes(
    `<div><p class="text-sm font-bold text-orange-600">1</p><p class="text-[10px] text-slate-400">due · ${career.sentences.length - 2} new</p></div>`,
  ));

  const essay = ESSAYS.find(candidate => candidate.id === 'why-i-wrote-the-yellow-wallpaper')!;
  const essayProgress = indexCatalogProgress([withSchedule(createEssayProgressItem(essay.sentences[0], 1), DUE)], 'essay');
  const reader = renderToStaticMarkup(createElement(EssayReader, {
    essay, progressIndex: essayProgress, now: NOW, onBack: noop, onOpenSentence: noop, onScroll: noop,
  }));
  assert.ok(reader.includes(
    `<div><p class="text-lg font-bold text-orange-600">1</p><p class="text-[10px] uppercase tracking-wider text-stone-400">due · ${essay.sentences.length - 1} new</p></div>`,
  ));
});

test('on a phone the collection header drops its stats strip and shows mastery and reviewed under the title instead', (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: NOW });
  const career = REAL_LIFE_COLLECTIONS[0];
  const progress = indexCatalogProgress([
    withSchedule(createRealLifeProgressItem(career.sentences[0], 1), { ...DUE, memoryStrength: 50 }),
    withSchedule(createRealLifeProgressItem(career.sentences[1], 1), { ...MEMORIZED, memoryStrength: 90 }),
  ], 'real-life');
  const markup = renderCollection(career, progress);
  const mastery = Math.round(140 / career.sentences.length);
  assert.ok(markup.includes(
    `<p class="truncate text-[11px] text-slate-500 sm:hidden">${mastery}% mastery · 2/${career.sentences.length} reviewed</p>`,
  ));
  // From sm up, the description, the level badge and the strip as before.
  assert.ok(markup.includes(`<p class="hidden truncate text-[11px] text-slate-500 sm:block sm:text-xs">${career.description}</p>`));
  assert.ok(markup.includes(`<span class="hidden rounded-full px-2.5 py-1 text-xs font-bold sm:inline-flex bg-indigo-50 text-indigo-700">${career.level}</span>`));
  assert.ok(markup.includes('<div class="mt-3 hidden grid-cols-3 gap-2 rounded-xl bg-slate-50 px-3 py-2 text-center sm:grid">'));
});
