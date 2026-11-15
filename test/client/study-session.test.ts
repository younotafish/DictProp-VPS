import assert from 'node:assert/strict';
import test from 'node:test';
import type { StoredItem } from '../../types.ts';
import {
  advanceSession,
  buildReviewQueue,
  createClozePrompt,
  findSessionCard,
  formatReviewInterval,
  gradeSessionCard,
  isDueForReview,
  moveSessionTo,
  requeueLapse,
  selectReviewTask,
  startStudySession,
  undoSessionGrade,
  type StudySession,
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

test('a card is due once studied and its next review has come; a never-studied card waits with the new ones', () => {
  assert.equal(isDueForReview(vocab('due', 'a', { reviews: 1, nextReview: 1_000 }), 1_000), true);
  assert.equal(isDueForReview(vocab('later', 'a', { reviews: 3, nextReview: 1_001 }), 1_000), false);
  assert.equal(isDueForReview(vocab('new', 'a', { nextReview: 0 }), 1_000), false);
  const withoutSrs = { ...vocab('bare', 'a'), srs: undefined } as unknown as StoredItem;
  assert.equal(isDueForReview(withoutSrs, 1_000), false);
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

test('a card rated Again comes back once more at the end of the session', () => {
  const ids = ['a', 'b', 'c'];
  assert.deepEqual(requeueLapse(ids, 0, 'again'), ['a', 'b', 'c', 'a']);
  assert.deepEqual(requeueLapse(['a', 'b', 'c', 'a'], 3, 'again'), ['a', 'b', 'c', 'a', 'a']);
  for (const rating of ['hard', 'good', 'easy'] as const) assert.equal(requeueLapse(ids, 1, rating), ids, rating);
  assert.equal(requeueLapse(ids, 3, 'again'), ids);
  assert.deepEqual(ids, ['a', 'b', 'c']);
});

test('a session passes over cards that left the study list, and goes back to one that returns before the next grade', () => {
  const ids = ['a', 'b', 'c', 'd'];
  const present = (...kept: string[]) => (id: string) => kept.includes(id);
  assert.equal(findSessionCard(ids, 1, undefined, present('a', 'b', 'c', 'd')), 1);
  assert.equal(findSessionCard(ids, 1, undefined, present('a', 'd')), 3, 'b and c were deleted');
  assert.equal(findSessionCard(ids, 1, undefined, present('a')), 4, 'nothing left to show');
  // b and c were passed over from 1 to 3; c came back, then b did too.
  assert.equal(findSessionCard(ids, 3, 1, present('a', 'c', 'd')), 2);
  assert.equal(findSessionCard(ids, 3, 1, present('a', 'b', 'c', 'd')), 1);
  // Cards before the run (already graded) stay behind.
  assert.equal(findSessionCard(ids, 3, 2, present('a', 'b', 'd')), 3);
});

const session = (overrides: Partial<StudySession> = {}): StudySession => ({
  id: 'session',
  itemIds: ['a', 'b', 'c'],
  index: 1,
  revealed: true,
  typedAnswer: 'ran',
  promptStartedAt: 1_000,
  ratings: { again: 0, hard: 1, good: 2, easy: 0 },
  ...overrides,
});

test('a session starts at its first card, unrevealed, with nothing counted', () => {
  const started = startStudySession('s1', [vocab('a', 'run'), vocab('b', 'walk')], 5_000);
  assert.deepEqual(started, {
    id: 's1', itemIds: ['a', 'b'], index: 0, revealed: false, typedAnswer: '', promptStartedAt: 5_000,
    ratings: { again: 0, hard: 0, good: 0, easy: 0 },
  });
});

test('moving past cards that left marks where they begin; moving back to one that returned keeps the mark', () => {
  const forward = moveSessionTo(session(), 3, 9_000);
  assert.deepEqual(forward, { ...session(), index: 3, passedOverFrom: 1, revealed: false, typedAnswer: '', promptStartedAt: 9_000 });
  // A run already open keeps its start, so a card passed over earlier can still come back.
  assert.equal(moveSessionTo(session({ index: 2, passedOverFrom: 1 }), 3, 9_000).passedOverFrom, 1);
  const back = moveSessionTo(session({ index: 3, passedOverFrom: 1 }), 2, 9_500);
  assert.deepEqual(back, { ...session(), index: 2, passedOverFrom: 1, revealed: false, typedAnswer: '', promptStartedAt: 9_500 });
});

test('a grade records the card, its task, the time on its prompt and the typed answer', () => {
  const current = session();
  const card = vocab('b', 'walk', { strength: 40, reviews: 2 });
  const { grade, itemIds } = gradeSessionCard(current, card, 'good', 'event-1', 4_000);
  assert.deepEqual(grade, {
    eventId: 'event-1', sessionId: 'session', itemId: 'b', itemIndex: 1, rating: 'good', taskType: 'production',
    durationMs: 3_000, typedAnswer: 'ran', requeuedAt: undefined,
  });
  assert.equal(itemIds, current.itemIds, 'only Again queues the card again');
  assert.equal(gradeSessionCard(current, card, 'good', 'event-2', 500).grade.durationMs, 0, 'a clock that went back counts no time');
});

test('an Again grade queues the card once more at the end, and the grade remembers where', () => {
  const { grade, itemIds } = gradeSessionCard(session(), vocab('b', 'walk'), 'again', 'event', 2_000);
  assert.deepEqual(itemIds, ['a', 'b', 'c', 'b']);
  assert.equal(grade.requeuedAt, 3);
});

test('after a grade the session moves on to the next card, unrevealed, with the grade counted', () => {
  const advanced = advanceSession(session({ passedOverFrom: 0 }), ['a', 'b', 'c', 'b'], 'again', 6_000);
  assert.deepEqual(advanced, {
    ...session(), itemIds: ['a', 'b', 'c', 'b'], index: 2, passedOverFrom: undefined, revealed: false, typedAnswer: '',
    promptStartedAt: 6_000, ratings: { again: 1, hard: 1, good: 2, easy: 0 },
  });
});

test('undoing a grade goes back to its card, revealed, and takes back its count and its extra showing', () => {
  const before = session();
  const { grade, itemIds } = gradeSessionCard(before, vocab('b', 'walk'), 'again', 'event', 2_000);
  const after = advanceSession(before, itemIds, 'again', 2_000);
  const undone = undoSessionGrade(after, grade, 7_000);
  assert.deepEqual(undone, { ...before, passedOverFrom: undefined, promptStartedAt: 7_000 });

  // An extra showing that has moved is left alone, and a count never goes below zero.
  const moved = undoSessionGrade({ ...after, itemIds: ['a', 'b', 'c', 'x', 'b'], ratings: { again: 0, hard: 0, good: 0, easy: 0 } }, grade, 7_000);
  assert.deepEqual(moved.itemIds, ['a', 'b', 'c', 'x', 'b']);
  assert.equal(moved.ratings.again, 0);
});
