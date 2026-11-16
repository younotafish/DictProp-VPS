import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { indexCatalogProgress, type CatalogProgressIndex } from '../../services/catalogProgress.ts';
import { buildCatalogQueue, studyButtonLabel } from '../../services/catalogQueue.ts';
import { ESSAYS } from '../../services/essayCatalog.ts';
import { createEssayProgressItem } from '../../services/essayProgress.ts';
import { REAL_LIFE_COLLECTIONS, type RealLifeCollection } from '../../services/realLifeCatalog.ts';
import { createRealLifeProgressItem } from '../../services/realLifeProgress.ts';
import { SRSAlgorithm } from '../../services/srsAlgorithm.ts';
import type { SRSData, StoredItem } from '../../types.ts';
import { filterRealLifeSentences } from '../../views/reading/realLifeFilter.ts';
import { EssayReader } from '../../views/reading/EssayReader.tsx';
import { RealLifeCollectionScreen } from '../../views/reading/RealLifeCollectionScreen.tsx';

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

// The screens, rendered as markup.
const noop = () => {};
const studyButton = (markup: string) => markup.match(/<button type="button"( disabled="")? class="([^"]*)" title="Study [^"]*">.*?<\/button>/);

const renderCollection = (collection: RealLifeCollection, progressIndex: CatalogProgressIndex) => renderToStaticMarkup(createElement(
  RealLifeCollectionScreen,
  {
    collection, progressIndex, now: NOW, onClose: noop, onOpenSentence: noop, onUpdateSRS: async () => true,
    isSentenceSaved: () => false, onScroll: noop,
  },
));

test('the collection\'s Study button counts the run and keeps a fixed width; with nothing in view it is disabled', () => {
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
