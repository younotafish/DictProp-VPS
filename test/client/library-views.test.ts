import assert from 'node:assert/strict';
import test from 'node:test';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { useLibraryViews } from '../../hooks/useLibraryViews.ts';
import { REAL_LIFE_COLLECTIONS } from '../../services/realLifeCatalog.ts';
import { createRealLifeProgressItem } from '../../services/realLifeProgress.ts';
import { summarizeReviewStates } from '../../services/sentenceReviewState.ts';
import { SRSAlgorithm } from '../../services/srsAlgorithm.ts';
import type { SRSData, StoredItem } from '../../types.ts';

// hooks/useLibraryViews.ts: the Sentences tab's badge.

const NOW = Date.UTC(2026, 10, 16, 12);
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/** A saved sentence with a new schedule made at NOW, `srs` laid over it. */
const sentence = (id: string, srs: Partial<SRSData> = {}, wrapper: Partial<StoredItem> = {}): StoredItem => ({
  type: 'sentence',
  data: { id, text: `The ${id} sentence.`, sourceWord: id },
  savedAt: NOW,
  srs: { ...SRSAlgorithm.createNew(id, 'sentence', NOW), ...srs },
  ...wrapper,
});

// Just enough of a browser for React to mount a component that draws nothing (as in reading-clock.test.ts), with the
// window's timers, which the badge's recount waits on.
const page = Object.assign(new EventTarget(), {
  nodeType: 9, visibilityState: 'visible' as DocumentVisibilityState, activeElement: null, defaultView: null as unknown,
});
const browser = {
  document: page, event: undefined, HTMLIFrameElement: class {},
  setTimeout: (run: () => void, ms?: number) => setTimeout(run, ms),
  clearTimeout: (timer?: ReturnType<typeof setTimeout>) => clearTimeout(timer),
};
page.defaultView = browser;
const globals = globalThis as Record<string, unknown>;

/** Mounts a component that reads the badge for `library`, noting each render; `t` mocks Date and setTimeout first. */
async function mountBadge(library: StoredItem[]) {
  const seen = { badge: -1, renders: 0 };
  const Probe = () => {
    seen.renders += 1;
    seen.badge = useLibraryViews(library).sentenceDueCount;
    return null;
  };
  const container = Object.assign(new EventTarget(), {
    nodeType: 1, nodeName: 'DIV', tagName: 'DIV', namespaceURI: 'http://www.w3.org/1999/xhtml', ownerDocument: page, textContent: '',
  });
  const root = createRoot(container as unknown as Element);
  await act(() => root.render(createElement(Probe)));
  return { seen, unmount: () => act(() => root.unmount()) };
}

test('the Sentences badge counts the saved sentences to review by the header\'s rule, and counts again when the next one falls due', async (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: NOW });
  Object.assign(globals, { window: browser, document: page, IS_REACT_ACT_ENVIRONMENT: true });
  try {
    const saved = [
      sentence('new'),
      // Saved, or reset, on a device whose clock runs an hour ahead: never reviewed, so it is to review already.
      sentence('stamped ahead', { nextReview: NOW + HOUR }),
      sentence('due', { totalReviews: 2, nextReview: NOW - HOUR }),
      sentence('memorized', { totalReviews: 3, nextReview: NOW + 2 * HOUR }),
    ];
    const library = [
      ...saved,
      sentence('archived', {}, { isArchived: true }),
      // A Real Life line never reviewed: its own tab's, not the Sentences tab's.
      createRealLifeProgressItem(REAL_LIFE_COLLECTIONS[0].sentences[0], NOW),
    ];
    const { seen, unmount } = await mountBadge(library);

    assert.equal(seen.badge, 3, 'the new one, the one stamped ahead and the due one');
    assert.equal(seen.badge, summarizeReviewStates(saved.map(item => item.srs), NOW).toReview, 'the header\'s "to review"');

    // The sentence stamped ahead is counted already, so its time passing changes nothing; the memorized one joins
    // the count when it falls due.
    await act(() => { t.mock.timers.tick(HOUR + 1_000); });
    assert.equal(seen.badge, 3);
    await act(() => { t.mock.timers.tick(HOUR); });
    assert.equal(seen.badge, 4);
    await unmount();
  } finally {
    delete globals.window;
    delete globals.document;
    delete globals.IS_REACT_ACT_ENVIRONMENT;
  }
});

test('the badge leaves out the saved sentences Today practises or is done with, and never waits on their dates', async (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: NOW });
  Object.assign(globals, { window: browser, document: page, IS_REACT_ACT_ENVIRONMENT: true });
  try {
    const saved = [
      sentence('new'),
      // In Today's practice, its date a day past; and one you can say, its date an hour off.
      sentence('practicing', { totalReviews: 1, nextReview: NOW - DAY, practiceSince: NOW - 2 * DAY, practiceChangedAt: NOW - 2 * DAY }),
      sentence('sayable', { totalReviews: 3, nextReview: NOW + HOUR, sayableAt: NOW - DAY, practiceChangedAt: NOW - DAY }),
      // Kept passive: decided in Today, but the Sentences tab's to review again once it falls due.
      sentence('passive', { totalReviews: 1, nextReview: NOW + 2 * HOUR, practiceChangedAt: NOW - DAY }),
    ];
    const { seen, unmount } = await mountBadge(saved);
    assert.equal(seen.badge, 1, 'only the new one');
    assert.equal(seen.badge, summarizeReviewStates(saved.map(item => item.srs), NOW).toReview, 'the header\'s "to review"');

    // No timer is set for the owned sentences' dates, past or to come, so time passing them counts nothing again.
    const settled = seen.renders;
    for (let step = 0; step < 3; step += 1) await act(() => { t.mock.timers.tick(HOUR / 2); });
    assert.equal(seen.badge, 1);
    assert.equal(seen.renders, settled, 'no recount: the sayable one\'s date passed, and the practicing one\'s long ago');
    // The passive one falls due at its date, and only that wakes the badge.
    await act(() => { t.mock.timers.tick(HOUR / 2 + 1_000); });
    assert.equal(seen.badge, 2);
    await unmount();
  } finally {
    delete globals.window;
    delete globals.document;
    delete globals.IS_REACT_ACT_ENVIRONMENT;
  }
});
