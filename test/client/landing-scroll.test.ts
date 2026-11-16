import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ESSAYS } from '../../services/essayCatalog.ts';
import { indexEssayProgress } from '../../services/essayProgress.ts';
import { readingPosition, type ReadingPosition } from '../../services/readingPosition.ts';
import { EssayIndex } from '../../views/reading/EssayIndex.tsx';
import { restoredScrollTop } from '../../views/reading/landingScroll.ts';

// views/reading/landingScroll.ts: where Back from an essay puts the Essays page, and the Continue card's slot in
// views/reading/EssayIndex.tsx that it measures.

// The page's header ends, and the card's slot starts, 300 px down; a phone's card takes 115 px with the space under it.
const SLOT_TOP = 300;
const CARD = 115;

test('a page left past the card\'s slot comes back with its tiles where they were, though the card came or went meanwhile', () => {
  // No unfinished essay when it opened, and the one just left is unfinished: the card is new above the tiles.
  assert.equal(restoredScrollTop({ scrollTop: 1500, cardSpace: 0 }, SLOT_TOP, CARD), 1615);
  // The only unfinished essay was read to its end: the card has gone.
  assert.equal(restoredScrollTop({ scrollTop: 1500, cardSpace: CARD }, SLOT_TOP, 0), 1385);
  // The same card, or a card for another essay, takes the same room: the page comes back as it was.
  assert.equal(restoredScrollTop({ scrollTop: 1500, cardSpace: CARD }, SLOT_TOP, CARD), 1500);
  // From sm up the card takes more room; a page left on a phone and shown wider moves by the difference.
  assert.equal(restoredScrollTop({ scrollTop: 1500, cardSpace: CARD }, SLOT_TOP, 136), 1521);
  // Left with the slot at the top of the screen, and left halfway down the card that has since gone.
  assert.equal(restoredScrollTop({ scrollTop: SLOT_TOP, cardSpace: 0 }, SLOT_TOP, CARD), SLOT_TOP + CARD);
  assert.equal(restoredScrollTop({ scrollTop: 350, cardSpace: CARD }, SLOT_TOP, 0), 235);
});

test('a page left with some of its header in view comes back as it was, a new card showing under the header', () => {
  assert.equal(restoredScrollTop({ scrollTop: 0, cardSpace: 0 }, SLOT_TOP, CARD), 0);
  assert.equal(restoredScrollTop({ scrollTop: 120, cardSpace: 0 }, SLOT_TOP, CARD), 120);
  assert.equal(restoredScrollTop({ scrollTop: SLOT_TOP - 1, cardSpace: CARD }, SLOT_TOP, 0), SLOT_TOP - 1);
  // Never above the page.
  assert.equal(restoredScrollTop({ scrollTop: SLOT_TOP, cardSpace: 400 }, SLOT_TOP, 0), 0);
});

const [selfReliance] = ESSAYS;
const landing = (readingPositions: ReadingPosition[]) => renderToStaticMarkup(createElement(EssayIndex, {
  essays: ESSAYS, catalogStatus: 'ready', onRetryCatalog: () => {}, progressIndex: indexEssayProgress([]), now: 0,
  onOpenEssay: () => {}, onScroll: () => {}, readingPositions,
}));

test('the card sits in a slot that holds the card and the space under it, and stays on the page, empty, with no card', () => {
  const unfinished = readingPosition(selfReliance, selfReliance.sentences[131], false, 0);
  assert.match(landing([unfinished]), /<\/header><div class="flow-root"><button type="button" class="mb-7 flex w-full[^"]*">/);
  assert.match(landing([]), /<\/header><div class="flow-root"><\/div><div class="mb-3 flex items-center justify-between">/);
});
