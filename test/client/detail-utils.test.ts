import assert from 'node:assert/strict';
import test from 'node:test';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { formatNextReview, mergePreparedSentence } from '../../views/detail/detailUtils.ts';
import { useRememberToast } from '../../views/detail/useRememberToast.ts';
import { RememberToast } from '../../views/detail/RememberToast.tsx';
import { updateAfterRating } from '../../services/fsrsScheduler.ts';
import { reviewIntervalDays } from '../../services/reviewTime.ts';
import { SRSAlgorithm } from '../../services/srsAlgorithm.ts';
import type { SentenceAnalysis, SentenceData, StoredItem } from '../../types.ts';
import { detailedAnalysis } from '../support/detail-view-fixtures.ts';

test('the Remembered toast says tomorrow, then days, then months to the half', () => {
  assert.equal(formatNextReview(0), 'tomorrow');
  assert.equal(formatNextReview(1), 'tomorrow');
  assert.equal(formatNextReview(2), 'in 2 days');
  assert.equal(formatNextReview(30), 'in 30 days');
  assert.equal(formatNextReview(31), 'in ~1 month');
  assert.equal(formatNextReview(45), 'in ~1.5 months');
  assert.equal(formatNextReview(60), 'in ~2 months');
  assert.equal(formatNextReview(200), 'in ~6.5 months');
});

// Just enough of a browser for React to mount a hook that draws nothing, as in library-views.test.ts.
const page = Object.assign(new EventTarget(), {
  nodeType: 9, visibilityState: 'visible' as DocumentVisibilityState, activeElement: null, defaultView: null as unknown,
});
const browser = { document: page, event: undefined, HTMLIFrameElement: class {} };
page.defaultView = browser;
const globals = globalThis as Record<string, unknown>;

test('Got it on a sentence carrying membership from Today\'s v3 loop confirms with its next review, as on any card', async (t) => {
  const NOW = Date.UTC(2026, 10, 16, 9);
  const DAY = 86_400_000;
  // The confirmation's timer, so none outlives the test.
  t.mock.timers.enable({ apis: ['setTimeout'] });
  Object.assign(globals, { window: browser, document: page, IS_REACT_ACT_ENVIRONMENT: true });
  try {
    let remember: ReturnType<typeof useRememberToast> | undefined;
    const Probe = () => { remember = useRememberToast(); return null; };
    const container = Object.assign(new EventTarget(), {
      nodeType: 1, nodeName: 'DIV', tagName: 'DIV', namespaceURI: 'http://www.w3.org/1999/xhtml', ownerDocument: page, textContent: '',
    });
    const root = createRoot(container as unknown as Element);
    await act(() => root.render(createElement(Probe)));
    // Met in a set three weeks ago: Practice (a triage Again), Passive (Good) or Can say it (Easy). Got it schedules
    // the sentence and leaves what the set decided on it.
    for (const rating of ['again', 'good', 'easy'] as const) {
      const id = `sentence-${rating}`;
      const fresh = SRSAlgorithm.createNew(id, 'sentence', NOW - 22 * DAY);
      const met = updateAfterRating(fresh, rating, NOW - 21 * DAY, 'triage');
      const gotIt = updateAfterRating(met, 'good', NOW);
      assert.equal(gotIt.practiceChangedAt, met.practiceChangedAt, `${rating}: the membership stays`);
      await act(() => remember!.showRemembered(gotIt, NOW, id));
      assert.deepEqual(remember!.toast, { id, intervalDays: reviewIntervalDays(gotIt.nextReview, NOW) }, rating);
    }
    await act(() => root.unmount());
  } finally {
    delete globals.window;
    delete globals.document;
    delete globals.IS_REACT_ACT_ENVIRONMENT;
  }
  // The toast says it; without an interval it would say only Remembered!.
  const toast = (intervalDays: number | null) => renderToStaticMarkup(createElement(RememberToast, { intervalDays }));
  assert.match(toast(4), /Remembered!.*Next review (?:<!-- -->)?in 4 days/);
  assert.doesNotMatch(toast(null), /Next review/);
});

const srs = (id: string, totalReviews: number) => ({
  id, type: 'sentence' as const, nextReview: 0, interval: 0, memoryStrength: 0, lastReviewDate: 0, totalReviews, correctStreak: 0, stability: 0,
});
const sentence = (data: Partial<SentenceData>, totalReviews = 0): StoredItem => ({
  type: 'sentence', data: { id: 's1', text: 'Text.', sourceWord: 'word', ...data }, srs: srs('s1', totalReviews), savedAt: 1,
});
const legacyAnalysis = { translation: 'old', americanEnglish: { status: 'shared', explanation: 'Fine.' }, terms: [], imagePrompt: 'p' } as SentenceAnalysis;

test('a prepared analysis replaces a legacy one, under the live copy\'s progress and fields', () => {
  const live = sentence({ analysis: legacyAnalysis, analysisGeneratedAt: 1, preferredSpeechStyle: 'casual' }, 6);
  const prepared = sentence({ analysis: detailedAnalysis, analysisGeneratedAt: 2, imageUrl: 'data:image/png;base64,AA' });
  const merged = mergePreparedSentence(live, prepared);
  const data = merged.data as SentenceData;
  assert.equal(data.analysis, detailedAnalysis);
  assert.equal(data.analysisGeneratedAt, 2);
  assert.equal(data.imageUrl, 'data:image/png;base64,AA');
  assert.equal(data.preferredSpeechStyle, 'casual');
  assert.equal(merged.srs.totalReviews, 6);
});

test('a detailed live analysis and a live image win over prepared ones', () => {
  const live = sentence({ analysis: detailedAnalysis, analysisGeneratedAt: 1, imageUrl: 'idb:stored' });
  const prepared = sentence({ analysis: legacyAnalysis, analysisGeneratedAt: 2, imageUrl: 'data:image/png;base64,AA' });
  const data = mergePreparedSentence(live, prepared).data as SentenceData;
  assert.equal(data.analysis, detailedAnalysis);
  assert.equal(data.analysisGeneratedAt, 1);
  assert.equal(data.imageUrl, 'idb:stored');
});

test('without anything prepared the live copy is returned as is', () => {
  const live = sentence({});
  assert.equal(mergePreparedSentence(live), live);
});
