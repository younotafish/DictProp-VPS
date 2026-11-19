import assert from 'node:assert/strict';
import test from 'node:test';
import { Activity, act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { useListClock } from '../../hooks/useNow.ts';
import { indexCatalogProgress } from '../../services/catalogProgress.ts';
import { buildCatalogQueue } from '../../services/catalogQueue.ts';
import { createRealLifeProgressItem } from '../../services/realLifeProgress.ts';
import { REAL_LIFE_COLLECTIONS } from '../../services/realLifeCatalog.ts';
import { orderSentencesForReview, type SentenceReviewFilter } from '../../services/sentenceOrdering.ts';
import { needsReview } from '../../services/sentenceReviewState.ts';
import { SRSAlgorithm } from '../../services/srsAlgorithm.ts';
import type { SentenceData, SRSData, StoredItem } from '../../types.ts';
import { EssaysView } from '../../views/EssaysView.tsx';
import { RealLifeView } from '../../views/RealLifeView.tsx';
import { SentenceRow, SentencesView } from '../../views/SentencesView.tsx';

// Rule 10: the reading tabs' lists move only when the reader changes the view, never when a sync lands.

const NOW = Date.UTC(2026, 10, 15, 12);
const HOUR = 3_600_000;
const DAY = 86_400_000;
const noop = () => {};

/** A saved sentence whose schedule is a new one's, saved at `savedAt`, with `srs` laid over it. */
const sentence = (id: string, srs: Partial<SRSData> = {}, savedAt = NOW - DAY): StoredItem & { type: 'sentence'; data: SentenceData } => ({
  type: 'sentence',
  data: { id, text: `The ${id} sentence.`, sourceWord: id },
  savedAt,
  srs: { ...SRSAlgorithm.createNew(id, 'sentence', savedAt), ...srs },
});

const renderRow = (item: ReturnType<typeof sentence>, toReview: boolean, restingLabel?: string) => renderToStaticMarkup(createElement(SentenceRow, {
  item, toReview, restingLabel, confirmingDelete: false, onOpen: noop, onUpdateSRS: async () => true, onDelete: noop,
  onConfirmDelete: noop, onSearch: noop,
}));
const bar = (markup: string) => markup.match(/<div class="absolute left-0 top-3 bottom-3 w-1 rounded-full ([^"]*)"><\/div>/)?.[1];
const REVIEWED = 'title="Mark as reviewed"';

test('a Sentences row never reviewed has the slate bar, whatever its seed strength; a reviewed row\'s bar follows its strength', () => {
  const fresh = renderRow(sentence('fresh'), true);
  assert.equal(bar(fresh), 'bg-slate-300');
  assert.ok(fresh.includes('hover:shadow-sm border-orange-200 bg-orange-50/30"'), 'to review: the orange row');
  assert.ok(fresh.includes(REVIEWED));

  // Display strength from stability: 1 day -> 12, 12 days -> 46, 47 days -> 70.
  const reviewed = (stability: number) => sentence(`s${stability}`, { totalReviews: 3, stability, nextReview: NOW + 3 * DAY });
  assert.equal(bar(renderRow(reviewed(1), false, 'in 3d')), 'bg-red-400');
  assert.equal(bar(renderRow(reviewed(12), false, 'in 3d')), 'bg-amber-400');
  const strong = renderRow(reviewed(47), false, 'in 3d');
  assert.equal(bar(strong), 'bg-emerald-400');
  assert.ok(strong.includes('hover:shadow-sm border-slate-100 bg-white"'));
  assert.ok(strong.includes('<span class="text-xs text-slate-400">in 3d</span>'));
  assert.ok(!strong.includes(REVIEWED));
});

// Due an hour ago and weak; memorized until an hour from now; never reviewed.
const weak = () => sentence('weak', { totalReviews: 2, stability: 1, memoryStrength: 12, nextReview: NOW - HOUR });
const soon = () => sentence('soon', { totalReviews: 4, stability: 12, memoryStrength: 46, nextReview: NOW + HOUR });
const fresh = () => sentence('fresh');
/** What a sync that changes only content (an enrichment, an edit) hands the list: new objects, same schedules. */
const synced = <T extends StoredItem>(items: T[]): T[] =>
  items.map(item => ({ ...item, data: { ...item.data, text: `${(item.data as SentenceData).text} Enriched.` }, updatedAt: NOW }));

test('at one clock the Sentences order, filters and row states follow schedules, not content, and a sentence falls due only when the clock moves', () => {
  const items = [weak(), soon(), fresh()];
  const order = (list: StoredItem[], filter: SentenceReviewFilter, now: number) =>
    orderSentencesForReview(list, filter, now).map(item => item.data.id);
  assert.deepEqual(order(items, 'all', NOW), ['fresh', 'weak', 'soon']);
  assert.deepEqual(order(items, 'due', NOW), ['weak']);
  assert.deepEqual(items.map(item => needsReview(item.srs, NOW)), [true, false, true]);

  const afterSync = synced(items);
  assert.deepEqual(order(afterSync, 'all', NOW), ['fresh', 'weak', 'soon']);
  assert.deepEqual(order(afterSync, 'due', NOW), ['weak']);
  assert.deepEqual(afterSync.map(item => needsReview(item.srs, NOW)), [true, false, true]);

  // Only a later clock brings 'soon' into Due and makes its row one to review.
  assert.deepEqual(order(afterSync, 'due', NOW + 2 * HOUR), ['weak', 'soon']);
  assert.equal(needsReview(afterSync[1].srs, NOW + 2 * HOUR), true);
  // A sentence saved after the list took its time is to review at once, at the list's time.
  assert.equal(needsReview(sentence('saved later', {}, NOW + HOUR).srs, NOW), true);
});

test('at one clock a Study run keeps its order through content changes and listens, and a line joins it only when the clock moves', () => {
  const lines = REAL_LIFE_COLLECTIONS[0].sentences.slice(0, 4);
  const record = (index: number, srs: Partial<SRSData>) => {
    const item = createRealLifeProgressItem(lines[index], 1);
    return { ...item, srs: { ...item.srs, ...srs } };
  };
  const records = [
    record(1, { totalReviews: 2, nextReview: NOW - HOUR }),
    record(2, { totalReviews: 3, nextReview: NOW + HOUR }),
    record(3, { totalReviews: 0, lastExposureDate: NOW - HOUR }),
  ];
  const queue = (items: StoredItem[], now: number) =>
    buildCatalogQueue(lines, indexCatalogProgress(items, 'real-life'), now).sentences.map(line => line.id);
  const ids = (...indexes: number[]) => indexes.map(index => lines[index].id);

  assert.deepEqual(queue(records, NOW), ids(1, 0, 3));
  const listenedAndSynced = synced(records).map((item, index) => index === 0 ? { ...item, srs: { ...item.srs, lastExposureDate: NOW } } : item);
  assert.deepEqual(queue(listenedAndSynced, NOW), ids(1, 0, 3));
  assert.deepEqual(queue(listenedAndSynced, NOW + 2 * HOUR), ids(1, 2, 0, 3));
});

// Just enough of a browser for React to mount a component that draws nothing, and the page's visibility, as in
// use-now.test.ts. It is installed only while a test mounts one, so the markup renders below see no window.
const page = Object.assign(new EventTarget(), {
  nodeType: 9, visibilityState: 'visible' as DocumentVisibilityState, activeElement: null, defaultView: null as unknown,
});
const browser = { document: page, event: undefined, HTMLIFrameElement: class {} };
page.defaultView = browser;
const globals = globalThis as Record<string, unknown>;

async function withPage(run: () => Promise<void>) {
  Object.assign(globals, { window: browser, document: page, IS_REACT_ACT_ENVIRONMENT: true });
  try {
    await run();
  } finally {
    delete globals.window;
    delete globals.document;
    delete globals.IS_REACT_ACT_ENVIRONMENT;
  }
}

const resumePage = () => act(() => {
  page.visibilityState = 'hidden';
  page.dispatchEvent(new Event('visibilitychange'));
  page.visibilityState = 'visible';
  page.dispatchEvent(new Event('visibilitychange'));
});

/** A tab whose list keeps its clock with useListClock(view), shown in an <Activity> as App shows its tabs. */
async function mountList(view: unknown, items: unknown) {
  const clocks: ReturnType<typeof useListClock>[] = [];
  const List = ({ view: shownView }: { view: unknown; items: unknown }) => {
    clocks.push(useListClock(shownView));
    return null;
  };
  const container = Object.assign(new EventTarget(), {
    nodeType: 1, nodeName: 'DIV', tagName: 'DIV', namespaceURI: 'http://www.w3.org/1999/xhtml', ownerDocument: page, textContent: '',
  });
  const root = createRoot(container as unknown as Element);
  const render = (shown: boolean, nextView: unknown, nextItems: unknown) => act(() => {
    root.render(createElement(Activity, { mode: shown ? 'visible' : 'hidden', children: createElement(List, { view: nextView, items: nextItems }) }));
  });
  await render(true, view, items);
  return {
    render,
    now: () => clocks[clocks.length - 1].now,
    /** A sentence opens over the list, as its rows and its Study button do. */
    openSentence: () => act(() => clocks[clocks.length - 1].noteOpened()),
    close: () => act(() => root.unmount()),
  };
}

test('a list\'s clock holds through syncs and moves when the view changes, when a sentence opens over it, and when it is shown again', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: NOW });
  await withPage(async () => {
    const list = await mountList('all', [1]);
    assert.equal(list.now(), NOW);

    t.mock.timers.tick(HOUR);
    await list.render(true, 'all', [1, 2]);
    assert.equal(list.now(), NOW, 'a sync hands the list new items, and the clock stays');

    await list.openSentence();
    assert.equal(list.now(), NOW + HOUR, 'it catches up behind the sentence that opened');

    t.mock.timers.tick(HOUR);
    await list.render(true, 'due', [1, 2]);
    assert.equal(list.now(), NOW + 2 * HOUR, 'a new filter or search');

    t.mock.timers.tick(HOUR);
    await resumePage();
    assert.equal(list.now(), NOW + 3 * HOUR, 'the app comes back to the foreground');

    await list.render(false, 'due', [1, 2, 3]);
    t.mock.timers.tick(HOUR);
    await list.render(true, 'due', [1, 2, 3]);
    assert.equal(list.now(), NOW + 4 * HOUR, 'the tab is shown again');
    await list.close();
  });
});

test('the reading tabs render to markup, counting what is due from the clock', (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: NOW });
  const sentences = () => renderToStaticMarkup(createElement(SentencesView, {
    items: [weak(), soon(), fresh()], onUpdateSRS: async () => true, onDelete: noop, onSearch: noop, onScroll: noop, onOpenSentence: noop,
  }));
  assert.match(sentences(), />2 to review</);
  t.mock.timers.tick(2 * HOUR);
  assert.match(sentences(), />3 to review</);

  const career = REAL_LIFE_COLLECTIONS[0];
  const due = createRealLifeProgressItem(career.sentences[0], 1);
  const realLife = renderToStaticMarkup(createElement(RealLifeView, {
    onOpenSentence: noop, progressItems: [{ ...due, srs: { ...due.srs, totalReviews: 1, nextReview: NOW } }], onUpdateSRS: async () => true,
    isSentenceSaved: () => false, onScroll: noop,
  }));
  assert.ok(realLife.includes(`1 due</span> · ${career.sentences.length - 1} new`));

  const essays = renderToStaticMarkup(createElement(EssaysView, { onOpenSentence: noop, progressItems: [], onScroll: noop, userId: 'u1' }));
  assert.match(essays, /American Essays/);
  assert.match(essays, /\d+ new<\/p>/);
});
