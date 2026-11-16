import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ESSAYS } from '../../services/essayCatalog.ts';
import { indexEssayProgress } from '../../services/essayProgress.ts';
import {
  continueCandidate,
  decodeReadingPositions,
  encodeReadingPositions,
  keepRecentPositions,
  lastSentenceReached,
  MAX_ENCODED_POSITIONS,
  readingPosition,
  readingPositionsKey,
  readReadingPositions,
  returnTarget,
  scrollTopToShow,
  sentenceAtReadingLine,
  writeReadingPosition,
  type ReadingPosition,
  type SentenceBox,
} from '../../services/readingPosition.ts';
import { EssaysView } from '../../views/EssaysView.tsx';
import { EssayIndex } from '../../views/reading/EssayIndex.tsx';
import { EssayReader } from '../../views/reading/EssayReader.tsx';
import type { PrivateCatalogStatus } from '../../views/reading/useEssayCatalog.ts';
import { MemoryStorage } from '../support/memory-storage.ts';

const AT = Date.UTC(2026, 10, 16, 12);
const [selfReliance, cornPone] = ESSAYS;
/** An essay left at its sentence `index` (0-based), `minutesAgo` minutes before AT. */
const leftAt = (essay = selfReliance, index = 131, minutesAgo = 0, finished = false) =>
  readingPosition(essay, essay.sentences[index], finished, AT - minutesAgo * 60_000);

test('positions are kept per user, under reading_positions_v1:<userId>, and read back as written', () => {
  const storage = new MemoryStorage();
  assert.equal(readingPositionsKey('u1'), 'reading_positions_v1:u1');
  const entry = leftAt();
  assert.deepEqual(entry, {
    id: 'self-reliance', s: selfReliance.sentences[131].id, p: 132, n: selfReliance.sentences.length, t: 'Self-Reliance', at: AT,
  });
  assert.deepEqual(writeReadingPosition('u1', entry, storage), [entry]);
  assert.deepEqual(readReadingPositions('u1', storage), [entry]);
  assert.deepEqual(readReadingPositions('u2', storage), [], 'another account sees none of it');
  // Stored compactly: the sentence id without the essay id it starts with.
  assert.equal(storage.getItem('reading_positions_v1:u1'), JSON.stringify([{ ...entry, s: entry.s.slice('self-reliance'.length) }]));

  // Leaving the essay again replaces its place, and the newest essay comes first.
  const later = leftAt(selfReliance, 200, -5);
  const other = leftAt(cornPone, 10, -1, true);
  writeReadingPosition('u1', other, storage);
  assert.deepEqual(writeReadingPosition('u1', later, storage), [later, other]);
  assert.deepEqual(readReadingPositions('u1', storage), [later, other]);
});

test('at most the eight most recent essays are kept, in under 1 KB', () => {
  // The five public essays and four more with ids and titles as long as the longest public one's.
  const longest = ESSAYS.reduce((a, b) => (a.id.length > b.id.length ? a : b));
  const essays = [
    ...ESSAYS,
    ...[1, 2, 3, 4].map(k => ({ ...longest, id: `${longest.id}-${k}`, sentences: longest.sentences.map(s => ({ ...s, id: s.id.replace(longest.id, `${longest.id}-${k}`) })) })),
  ];
  const entries = essays.map((essay, i) => readingPosition(essay, essay.sentences[essay.sentences.length - 1], false, AT + i));
  const kept = keepRecentPositions(entries);
  assert.deepEqual(kept.map(entry => entry.id), entries.slice(1).reverse().map(entry => entry.id), 'the oldest of nine goes');
  assert.ok(encodeReadingPositions(kept).length <= MAX_ENCODED_POSITIONS, `${encodeReadingPositions(kept).length} characters`);
  assert.deepEqual(decodeReadingPositions(encodeReadingPositions(kept)), kept);

  // Ids far longer than any catalog's: fewer essays are kept, still under 1 KB.
  const huge = Array.from({ length: 8 }, (_, i): ReadingPosition =>
    ({ id: `e${i}-${'x'.repeat(90)}`, s: `s-${'y'.repeat(120)}`, p: 1, n: 1, t: 'T'.repeat(60), at: AT + i }));
  const fewer = keepRecentPositions(huge);
  assert.ok(fewer.length < 8 && fewer.length > 0);
  assert.ok(encodeReadingPositions(fewer).length <= MAX_ENCODED_POSITIONS);
  assert.equal(fewer[0].at, AT + 7, 'the newest stays');
});

test('a damaged or foreign value reads as no positions, and bad entries are dropped one by one', () => {
  const good = leftAt();
  for (const raw of [null, '', 'not json', '{"id":"self-reliance"}', '42', 'null', '"text"']) {
    assert.deepEqual(decodeReadingPositions(raw), [], String(raw));
  }
  const bad: unknown[] = [
    null, 'x', [], { ...good, id: '' }, { ...good, s: 7 }, { ...good, s: ':' }, { ...good, p: 0 }, { ...good, p: 1.5 },
    { ...good, n: '504' }, { ...good, t: null }, { ...good, at: 'yesterday' }, { ...good, at: Infinity }, { ...good, f: 2 },
  ];
  assert.deepEqual(decodeReadingPositions(JSON.stringify([...bad, good])), [good]);
  // A title longer than 60 characters is cut, a full sentence id is kept as it is, and of two entries for one essay
  // the newer wins.
  const long = { ...good, id: 'other', s: 'elsewhere:7', t: 'T'.repeat(80), at: AT - 1 };
  const older = { ...good, s: `${good.id}:p001:s01`, at: AT - 2 };
  assert.deepEqual(decodeReadingPositions(JSON.stringify([older, long, good])), [good, { ...long, t: 'T'.repeat(60) }]);
});

test('storage that refuses access or is full loses nothing but the saving', () => {
  const refusing = { getItem: () => { throw new Error('denied'); }, setItem: () => { throw new Error('full'); }, removeItem: () => {} };
  assert.deepEqual(readReadingPositions('u1', refusing), []);
  assert.deepEqual(writeReadingPosition('u1', leftAt(), refusing), [leftAt()]);
  assert.deepEqual(writeReadingPosition('u1', leftAt(), null), [leftAt()]);
});

test('the sentence to return to is the one left at, else the one now at its position, else the last', () => {
  const sentences = [{ id: 'a', position: 1 }, { id: 'c', position: 2 }, { id: 'd', position: 3 }];
  assert.equal(returnTarget({ id: 'c', position: 2 }, sentences)?.id, 'c');
  assert.equal(returnTarget({ id: 'c', position: 9 }, sentences)?.id, 'c', 'found by id wherever it moved');
  assert.equal(returnTarget({ id: 'b', position: 2 }, sentences)?.id, 'c', 'a removed sentence: the next by position');
  assert.equal(returnTarget({ id: 'z', position: 7 }, sentences)?.id, 'd', 'past the end: the last');
  assert.equal(returnTarget({ id: 'a', position: 1 }, []), null);
});

test('Continue offers the most recently left essay not read to its end; an unknown one waits for the private catalog', () => {
  const essays = [selfReliance, cornPone];
  const finished = leftAt(cornPone, 96, 0, true);
  const reading = leftAt(selfReliance, 131, 5);
  assert.deepEqual(continueCandidate([reading, finished], essays, true), { entry: reading, essay: selfReliance });
  assert.equal(continueCandidate([finished], essays, true), null);

  const privateEssay: ReadingPosition = { id: 'great-work', s: 'great-work:p003:s02', p: 20, n: 300, t: 'How to Do Great Work', at: AT };
  assert.deepEqual(continueCandidate([reading, privateEssay], essays, false), { entry: privateEssay, essay: null },
    'while the private catalog loads, its essay shows with the stored title, unopenable');
  assert.deepEqual(continueCandidate([privateEssay, reading], essays, true), { entry: reading, essay: selfReliance },
    'once it has loaded without that essay, the essay is gone and the next one is offered');
  assert.equal(continueCandidate([privateEssay], essays, true), null);
  assert.equal(continueCandidate([], essays, false), null);
});

test('a sentence out of view, or cut off, comes onto the line a third of the way down; one in view stays put', () => {
  const height = 600;
  assert.equal(scrollTopToShow({ top: 1300, bottom: 1360 }, 1000, height), null, 'wholly in view');
  assert.equal(scrollTopToShow({ top: 3000, bottom: 3060 }, 1000, height), 2800, 'below the view');
  assert.equal(scrollTopToShow({ top: 400, bottom: 460 }, 1000, height), 200, 'above the view');
  assert.equal(scrollTopToShow({ top: 1580, bottom: 1640 }, 1000, height), 1380, 'cut off at the bottom');
  assert.equal(scrollTopToShow({ top: 990, bottom: 1050 }, 1000, height), 790, 'cut off at the top');
  assert.equal(scrollTopToShow({ top: 150, bottom: 210 }, 1000, height), 0, 'never above the page');
});

// An essay's sentences as laid out: lines 30 px apart, the text starting 700 px down; sentences 2 and 3 start on the
// same line, as short sentences in a paragraph do.
const boxes: SentenceBox[] = [
  { top: 700, bottom: 760 }, { top: 760, bottom: 790 }, { top: 790, bottom: 820 }, { top: 790, bottom: 850 },
  { top: 850, bottom: 940 }, { top: 1000, bottom: 1030 }, { top: 1030, bottom: 1120 }, { top: 2400, bottom: 2430 },
];

test('the place a reader leaves at is the sentence on the reading line', () => {
  const height = 600;
  assert.equal(sentenceAtReadingLine(boxes, 0, 600), -1, 'still in the opening pages');
  assert.equal(sentenceAtReadingLine(boxes, 200, height), 0, 'the text in view, below the line');
  assert.equal(sentenceAtReadingLine(boxes, 600, height), 4, 'the first sentence starting on or below the line');
  assert.equal(sentenceAtReadingLine(boxes, 2300, height), 7, 'past the last sentence\'s start: the last');
  assert.equal(sentenceAtReadingLine([], 0, height), -1);
});

test('coming back puts a sentence on the reading line, and leaving again without scrolling keeps that place', () => {
  const height = 600;
  for (const [index, box] of boxes.entries()) {
    const scrollTop = scrollTopToShow(box, 0, height)!;
    const kept = sentenceAtReadingLine(boxes, scrollTop, height);
    // A sentence starting on the line of an earlier one gives way to it once, and then the place holds.
    assert.equal(kept, boxes.findIndex(other => Math.abs(other.top - box.top) < 1), `sentence ${index}`);
    assert.equal(sentenceAtReadingLine(boxes, scrollTopToShow(boxes[kept], 0, height)!, height), kept, `sentence ${index} again`);
  }
});

test('the last sentence counts as reached once it is in view or scrolled past', () => {
  assert.equal(lastSentenceReached(boxes, 1700, 600), false);
  assert.equal(lastSentenceReached(boxes, 1900, 600), true);
  assert.equal(lastSentenceReached(boxes, 3000, 600), true);
  assert.equal(lastSentenceReached([], 0, 600), false);
});

const noop = () => {};
const landing = (readingPositions: ReadingPosition[], catalogStatus: PrivateCatalogStatus = 'ready') =>
  renderToStaticMarkup(createElement(EssayIndex, {
    essays: ESSAYS, catalogStatus, onRetryCatalog: noop, progressIndex: indexEssayProgress([]), now: AT, onOpenEssay: noop,
    onScroll: noop, readingPositions,
  }));

test('the Essays page offers to continue the essay left most recently, above the tiles', () => {
  const page = landing([leftAt(selfReliance, 131, 5), leftAt(cornPone, 96, 0, true)]);
  const card = page.match(/<button type="button" class="mb-7 flex w-full[^"]*">(.*?)<\/button>/)?.[1] ?? '';
  assert.match(card, /Continue reading<\/span>/);
  assert.match(card, />Self-Reliance<\/span>/);
  assert.ok(card.includes(`Sentence 132 of ${selfReliance.sentences.length}`));
  assert.ok(page.indexOf('Continue reading') < page.indexOf('The collection'));
  assert.doesNotMatch(landing([leftAt(cornPone, 96, 0, true)]), /Continue reading/, 'an essay read to its end is not offered');
  assert.doesNotMatch(landing([]), /Continue reading/);
});

test('a private essay is offered with its stored title, unopenable, until the private catalog has loaded', () => {
  const privateEssay: ReadingPosition = { id: 'great-work', s: 'great-work:p003:s02', p: 20, n: 300, t: 'How to Do Great Work', at: AT };
  const loading = landing([privateEssay], 'loading');
  assert.match(loading, /<button type="button" disabled="" class="mb-7 flex w-full[^"]*">/);
  assert.match(loading, />How to Do Great Work<\/span>/);
  assert.ok(loading.includes('Sentence 20 of 300'));
  assert.match(landing([privateEssay], 'error'), /disabled=""[^>]*>.*How to Do Great Work/);
  assert.doesNotMatch(landing([privateEssay], 'ready'), /Continue reading/, 'loaded without it: gone');
});

test('the tab reads the signed-in user\'s positions as it opens, and keeps none without a user', () => {
  const storage = new MemoryStorage();
  writeReadingPosition('u1', leftAt(), storage);
  const globals = globalThis as { localStorage?: unknown };
  globals.localStorage = storage;
  try {
    const tab = (userId?: string) => renderToStaticMarkup(createElement(EssaysView, { onOpenSentence: noop, progressItems: [], onScroll: noop, userId }));
    assert.match(tab('u1'), /Continue reading/);
    assert.doesNotMatch(tab('u2'), /Continue reading/);
    assert.doesNotMatch(tab(), /Continue reading/);
  } finally {
    delete globals.localStorage;
  }
});

test('each body sentence in the reader is marked with its id, for finding it again', () => {
  const reader = renderToStaticMarkup(createElement(EssayReader, {
    essay: cornPone, progressIndex: indexEssayProgress([]), now: AT, onBack: noop, onOpenSentence: noop, onScroll: noop,
  }));
  const ids = [...reader.matchAll(/data-sentence-id="([^"]+)"/g)].map(([, id]) => id);
  assert.deepEqual(ids, cornPone.sentences.map(sentence => sentence.id));
});
