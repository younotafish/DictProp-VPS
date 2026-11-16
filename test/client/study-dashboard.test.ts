import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ReviewHistory, StoredItem } from '../../types.ts';
import { StudyDashboard } from '../../components/StudyDashboard.tsx';

const DAY = 86_400_000;
// Mid-afternoon local time, so "today" has room on both sides.
const NOW = new Date(2026, 10, 16, 15, 30).getTime();

function vocab(id: string, { reviews = 0, due = NOW + DAY, strength = 0, streak = 0 } = {}): StoredItem {
  return {
    type: 'vocab',
    data: {
      id, word: id, chinese: '', ipa: '', definition: '', synonyms: [], antonyms: [], confusables: [], examples: [],
      history: '', register: '', mnemonic: '',
    },
    savedAt: 0,
    srs: {
      id, type: 'vocab', nextReview: due, interval: 0, memoryStrength: strength, lastReviewDate: reviews > 0 ? NOW - DAY : 0,
      totalReviews: reviews, correctStreak: streak, stability: 1,
    },
  };
}

const EMPTY_HISTORY: ReviewHistory = { recent: [], olderTimes: [], olderCount: 0 };

/** The dashboard's markup, rendered as the server would, with the history given. Tests set the clock to NOW first. */
const render = (items: StoredItem[], reviewHistory: ReviewHistory = EMPTY_HISTORY) =>
  renderToStaticMarkup(createElement(StudyDashboard, { items, reviewHistory, onStart: () => {} }));

const textOf = (markup: string) => markup.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

test('Most Practiced lists only reviewed cards, each once', t => {
  t.mock.method(Date, 'now', () => NOW);
  const markup = render([vocab('walk'), vocab('run', { reviews: 5 }), vocab('jump')]);
  assert.match(textOf(markup), /Most Practiced run \(5x\)$/);
  assert.doesNotMatch(markup, /\(0x\)/);
  assert.doesNotMatch(render([vocab('walk'), vocab('jump')]), /Most Practiced/);
});
