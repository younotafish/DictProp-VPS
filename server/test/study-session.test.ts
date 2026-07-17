import assert from 'node:assert/strict';
import test from 'node:test';
import type { StoredItem } from '../../types.ts';
import {
  buildReviewQueue,
  createClozePrompt,
  formatReviewInterval,
  selectReviewTask,
} from '../../services/studySession.ts';

function vocab(
  id: string,
  word: string,
  options: {
    sense?: string;
    reviews?: number;
    nextReview?: number;
    strength?: number;
    example?: string;
    savedAt?: number;
  } = {},
): StoredItem {
  const reviews = options.reviews || 0;
  return {
    type: 'vocab',
    data: {
      id,
      word,
      sense: options.sense,
      chinese: 'meaning',
      ipa: '',
      definition: 'definition',
      synonyms: [],
      antonyms: [],
      confusables: [],
      examples: options.example ? [options.example] : [],
      history: '',
      register: '',
      mnemonic: '',
    },
    srs: {
      id,
      type: 'vocab',
      nextReview: options.nextReview ?? 0,
      interval: 0,
      memoryStrength: options.strength || 0,
      lastReviewDate: 0,
      totalReviews: reviews,
      correctStreak: reviews,
      stability: 0.5,
    },
    savedAt: options.savedAt ?? 0,
  };
}

test('review queue prioritizes due cards, limits new cards, and buries same-spelling senses', () => {
  const queue = buildReviewQueue([
    vocab('lead-metal', 'lead', { sense: 'metal', reviews: 2, nextReview: 20 }),
    vocab('lead-guide', 'lead', { sense: 'guide', reviews: 2, nextReview: 10 }),
    vocab('other-due', 'other', { reviews: 1, nextReview: 15 }),
    vocab('lead-new', 'lead', { sense: 'new', savedAt: 1 }),
    vocab('fresh', 'fresh', { savedAt: 2 }),
    vocab('later', 'later', { reviews: 1, nextReview: 2_000 }),
  ], 1_000, 40, 1);

  assert.deepEqual(queue.map(item => item.data.id), ['lead-guide', 'other-due', 'fresh']);
});

test('review task selection increases recall difficulty only when the prompt contains the answer', () => {
  assert.equal(selectReviewTask(vocab('new', 'lead', { strength: 10 })), 'meaning');
  assert.equal(selectReviewTask(vocab('mid-even', 'lead', { strength: 40, reviews: 2 })), 'production');
  assert.equal(selectReviewTask(vocab('mid-odd', 'lead', { strength: 40, reviews: 3 })), 'meaning');
  assert.equal(selectReviewTask(vocab('mature-even', 'lead', {
    strength: 70,
    reviews: 4,
    example: 'They {{led}} the group.',
  })), 'cloze');
  assert.equal(selectReviewTask(vocab('mature-odd', 'lead', {
    strength: 70,
    reviews: 5,
    example: 'They {{led}} the group.',
  })), 'listening');
  assert.equal(selectReviewTask(vocab('missing-answer', 'lead', {
    strength: 70,
    reviews: 4,
    example: 'Nothing relevant appears here.',
  })), 'production');
});

test('cloze prompts hide marked inflections and strip secondary markers', () => {
  assert.equal(
    createClozePrompt('They {{led}} the group with [[aplomb]].', 'lead'),
    'They _____ the group with aplomb.',
  );
  assert.equal(createClozePrompt('Please lead the way.', 'lead'), 'Please _____ the way.');
});

test('rating interval labels remain compact', () => {
  assert.equal(formatReviewInterval(10), '10m');
  assert.equal(formatReviewInterval(120), '2h');
  assert.equal(formatReviewInterval(4_320), '3d');
});
