import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { StoredItem, VocabCard } from '../../types.ts';
import { StudySummary } from '../../components/study/StudySummary.tsx';
import { previewRatings, updateAfterRating } from '../../services/fsrsScheduler.ts';
import { HttpError } from '../../services/http.ts';
import { formatReviewInterval, formatTimeUntil } from '../../services/reviewTime.ts';
import { SRSAlgorithm } from '../../services/srsAlgorithm.ts';
import {
  acceptFooterTap,
  advanceSession,
  applyUndoneGrade,
  buildReviewQueue,
  endSessionEarly,
  cappedDuration,
  findSessionCard,
  getStudyContent,
  gradeSessionCard,
  isDueForReview,
  isSessionCardLive,
  listeningPrompt,
  moveSessionTo,
  openCardGroup,
  receiptText,
  requeueShortStep,
  resumeSession,
  selectReviewTask,
  sessionRatings,
  sessionSiblingCounts,
  startStudySession,
  summarizeSession,
  undoFailureText,
  undoSessionGrade,
  upcomingListeningPrompts,
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
    examples?: string[];
    savedAt?: number;
    lastReviewed?: number;
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
      examples: options.examples ?? (options.example ? [options.example] : []),
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
      lastReviewDate: options.lastReviewed ?? 0,
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

test('cloze and listening take turns through a card\'s examples, and the cloze check uses the example the prompt will', () => {
  const examples = ['They {{led}} the group.', 'Nothing relevant appears here.'];
  const at = (reviews: number) => vocab(`r${reviews}`, 'lead', { strength: 70, reviews, examples });
  assert.deepEqual([4, 5, 6, 7, 8, 9].map(reviews => getStudyContent(at(reviews)).example), [
    examples[0], examples[0], examples[1], examples[1], examples[0], examples[0],
  ]);
  // Two reviews each: cloze, then listening, with the first example; then the second, which has no blank to make.
  assert.deepEqual([4, 5, 6, 7].map(reviews => selectReviewTask(at(reviews))), ['cloze', 'listening', 'production', 'production']);
});

test('study content carries the forms and synonyms a typed answer is checked against', () => {
  const lead = vocab('a', 'lead', { sense: 'verb: guide' });
  const leadCard = { ...lead, data: { ...lead.data, forms: ['leads, led'], synonyms: ['guide'] } };
  assert.deepEqual(getStudyContent(leadCard), {
    word: 'lead', sense: 'verb: guide', chinese: 'meaning', definition: 'definition', example: '',
    forms: ['leads, led'], synonyms: ['guide'], ipa: '',
  });

  const giveUp: VocabCard = {
    id: 'v', word: 'give up', chinese: '放弃', ipa: '', definition: 'stop trying', forms: ['gave up'], synonyms: ['quit'],
    antonyms: [], confusables: [], examples: [], history: '', register: '', mnemonic: '',
  };
  const phrase = (query: string): StoredItem => ({
    type: 'phrase',
    data: { id: query, query, translation: '', grammar: '', visualKeyword: '', pronunciation: '', timestamp: 0, vocabs: [giveUp] },
    srs: lead.srs,
    savedAt: 0,
  });
  const own = getStudyContent(phrase('Give up'));
  assert.deepEqual([own.sense, own.forms, own.synonyms], ['', ['gave up'], ['quit']]);
  // Another word's card fills in the meaning, but its forms and synonyms aren't the phrase's.
  const other = getStudyContent(phrase('give up smoking'));
  assert.deepEqual([other.chinese, other.definition, other.forms, other.synonyms], ['放弃', 'stop trying', [], []]);
});

test('study content says how the card is said: a word\'s IPA, a phrase\'s pronunciation', () => {
  const word = vocab('w', 'crestfallen');
  assert.equal(getStudyContent({ ...word, data: { ...word.data, ipa: '/ˈkrestˌfɔːlən/' } }).ipa, '/ˈkrestˌfɔːlən/');
  assert.equal(getStudyContent(word).ipa, '');
  const phrase: StoredItem = {
    type: 'phrase',
    data: { id: 'p', query: 'give up', translation: '放弃', grammar: '', visualKeyword: '', pronunciation: '/ɡɪv ˈʌp/', timestamp: 0, vocabs: [] },
    srs: word.srs,
    savedAt: 0,
  };
  assert.equal(getStudyContent(phrase).ipa, '/ɡɪv ˈʌp/');
});

test('a card\'s listening prompt is the example it plays while its task is listening, and none otherwise', () => {
  const examples = ['She looked {{crestfallen}}.'];
  assert.equal(listeningPrompt(vocab('l', 'crestfallen', { strength: 70, reviews: 5, examples })), examples[0]);
  assert.equal(listeningPrompt(vocab('c', 'crestfallen', { strength: 70, reviews: 4, examples })), null, 'cloze');
  assert.equal(listeningPrompt(vocab('m', 'crestfallen', { examples })), null, 'meaning');
});

test('rating interval labels remain compact', () => {
  assert.equal(formatReviewInterval(10), '10m');
  assert.equal(formatReviewInterval(120), '2h');
  assert.equal(formatReviewInterval(4_320), '3d');
});

test('a grade whose step is under a day brings the card back once more at the end of the session', () => {
  const NOW = Date.UTC(2026, 10, 15, 12);
  const fresh = SRSAlgorithm.createNew('a', 'vocab', NOW - 1_000);
  const freshSteps = previewRatings(fresh, NOW);
  // The scheduler's own steps: Hard on a new card is 15 minutes, Good two days.
  assert.equal(freshSteps.hard.interval, 15);
  assert.equal(freshSteps.good.interval, 2_880);
  const ids = ['a', 'b', 'c'];
  assert.deepEqual(requeueShortStep(ids, 0, freshSteps.hard.interval), ['a', 'b', 'c', 'a']);
  assert.equal(requeueShortStep(ids, 0, freshSteps.good.interval), ids);
  assert.equal(requeueShortStep(ids, 0, freshSteps.easy.interval), ids);

  // On a card in review, Again is a 10-minute relearning step and Hard is days away.
  const reviewed = updateAfterRating(fresh, 'good', NOW);
  const reviewSteps = previewRatings(reviewed, reviewed.nextReview);
  assert.equal(reviewSteps.again.interval, 10);
  assert.deepEqual(requeueShortStep(['a', 'b', 'c', 'a'], 3, reviewSteps.again.interval), ['a', 'b', 'c', 'a', 'a']);
  assert.equal(requeueShortStep(ids, 1, reviewSteps.hard.interval), ids);

  assert.equal(requeueShortStep(ids, 1, 1_440), ids, 'a whole day is the next session\'s');
  assert.equal(requeueShortStep(ids, 3, 10), ids, 'past the end there is no card to bring back');
  assert.deepEqual(ids, ['a', 'b', 'c']);
});

test('a prompt counts at most two minutes, and no time for a clock that went back', () => {
  assert.equal(cappedDuration(1_000, 4_000), 3_000);
  assert.equal(cappedDuration(0, 10 * 60_000), 120_000);
  assert.equal(cappedDuration(5_000, 1_000), 0);
  assert.equal(cappedDuration(0, 10_000, 5_000), 5_000);
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

/** The card's schedule after a grade, as updateSRS makes it: the interval in minutes, and the card's review count then. */
const scheduled = (interval: number, totalReviews = 1) => ({ interval, totalReviews });

const session = (overrides: Partial<StudySession> = {}): StudySession => ({
  id: 'session',
  itemIds: ['a', 'b', 'c'],
  index: 1,
  revealed: true,
  typedAnswer: 'ran',
  promptStartedAt: 1_000,
  startedAt: 500,
  grades: [{ itemId: 'a', rating: 'good', at: 1_000, totalReviews: 1 }],
  siblingCounts: {},
  ...overrides,
});

test('a session starts at its first card, unrevealed, with no grades', () => {
  const started = startStudySession('s1', [vocab('a', 'run'), vocab('b', 'walk')], 5_000, { a: 2 });
  assert.deepEqual(started, {
    id: 's1', itemIds: ['a', 'b'], index: 0, revealed: false, typedAnswer: '', promptStartedAt: 5_000,
    startedAt: 5_000, grades: [], siblingCounts: { a: 2 },
  });
  assert.deepEqual(sessionRatings(started), { again: 0, hard: 0, good: 0, easy: 0 });
});

test('a session knows how many study items share each queued card\'s spelling, when others do', () => {
  const items = [
    vocab('lead-verb', 'lead'), vocab('lead-noun', 'Lead '), vocab('lead-metal', 'lead'),
    vocab('walk', 'walk'), vocab('run-1', 'run'), vocab('run-2', 'run'),
  ];
  const queue = [items[0], items[3], items[4]];
  assert.deepEqual(sessionSiblingCounts(queue, items), { 'lead-verb': 3, 'run-1': 2 });
  assert.deepEqual(sessionSiblingCounts([], items), {});
});

test('the session counts each grade that stands', () => {
  assert.deepEqual(sessionRatings(session({
    grades: [{ itemId: 'a', rating: 'again', at: 600, totalReviews: 1 }, { itemId: 'b', rating: 'good', at: 700, totalReviews: 1 }, { itemId: 'a', rating: 'good', at: 800, totalReviews: 1 }],
  })), { again: 1, hard: 0, good: 2, easy: 0 });
});

test('a card reviewed elsewhere since the session began is passed over; the session\'s own grades are not', () => {
  const current = session({ startedAt: 1_000, grades: [{ itemId: 'graded', rating: 'again', at: 1_500, totalReviews: 1 }] });
  assert.equal(isSessionCardLive(vocab('before', 'a', { reviews: 2, lastReviewed: 900 }), current), true);
  assert.equal(isSessionCardLive(vocab('never', 'a'), current), true);
  assert.equal(isSessionCardLive(vocab('elsewhere', 'a', { reviews: 3, lastReviewed: 1_500 }), current), false);
  assert.equal(isSessionCardLive(vocab('graded', 'a', { reviews: 1, lastReviewed: 1_500 }), current), true, 'its own review');
  assert.equal(isSessionCardLive(vocab('graded', 'a', { reviews: 2, lastReviewed: 1_501 }), current), false, 'a review after its grade');
  assert.equal(isSessionCardLive(undefined, current), false, 'deleted or archived');
  // A graded card goes by its review count, whatever time its reviews were stamped with.
  assert.equal(isSessionCardLive(vocab('graded', 'a', { reviews: 1, lastReviewed: 9_000 }), current), true, 'its own review, stamped late');
  assert.equal(isSessionCardLive(vocab('graded', 'a', { reviews: 2, lastReviewed: 1_200 }), current), false, 'a later review, stamped early');
  // The latest of a card's grades counts: one given after a reset elsewhere left a lower count than the grade before.
  const twice = session({
    startedAt: 1_000,
    grades: [{ itemId: 'graded', rating: 'again', at: 2_000, totalReviews: 5 }, { itemId: 'graded', rating: 'good', at: 3_000, totalReviews: 1 }],
  });
  assert.equal(isSessionCardLive(vocab('graded', 'a', { reviews: 1, lastReviewed: 3_000 }), twice), true);
  assert.equal(isSessionCardLive(vocab('graded', 'a', { reviews: 2, lastReviewed: 4_000 }), twice), false);

  // The session moves past such a card the way it moves past a deleted one.
  const cards = new Map([['x', vocab('x', 'x')], ['y', vocab('y', 'y', { reviews: 1, lastReviewed: 2_000 })], ['z', vocab('z', 'z')]]);
  const live = (id: string) => isSessionCardLive(cards.get(id), current);
  assert.equal(findSessionCard(['x', 'y', 'z'], 1, undefined, live), 2);
});

test('a card the session brought back is passed over once a Got it elsewhere comes after its grade, and stays while only its own reviews stand', () => {
  const T0 = Date.UTC(2026, 10, 16, 9);
  const cards = new Map([['x', vocab('x', 'crestfallen', { reviews: 2, nextReview: T0, lastReviewed: T0 - 86_400_000 })], ['y', vocab('y', 'walk')]]);
  /** A review as updateSRS records it, stamped `reviewedAt`. */
  const review = (id: string, rating: 'again' | 'good', reviewedAt: number) => {
    const card = cards.get(id)!;
    cards.set(id, { ...card, srs: updateAfterRating(SRSAlgorithm.ensure(card.srs, id, card.type), rating, reviewedAt) });
  };
  let current = startStudySession('s', [cards.get('x')!, cards.get('y')!], T0, {});
  /** A grade as the study screen gives it: scheduled at `now`, its review recorded as gradeSessionCard returns it. */
  const grade = (rating: 'again' | 'good', now: number) => {
    const item = cards.get(current.itemIds[current.index])!;
    const next = updateAfterRating(SRSAlgorithm.ensure(item.srs, item.data.id, item.type), rating, now);
    const graded = gradeSessionCard({ ...current, revealed: true }, item, rating, `event-${now}`, now, next);
    review(item.data.id, rating, graded.review.reviewedAt);
    current = graded.advance(current);
  };
  const live = (id: string) => isSessionCardLive(cards.get(id), current);

  grade('again', T0 + 5_000);
  grade('good', T0 + 9_000);
  assert.deepEqual(current.itemIds, ['x', 'y', 'x'], 'Again brought x back to the end');
  assert.equal(findSessionCard(current.itemIds, current.index, current.passedOverFrom, live), 2, 'its own review keeps it');

  // Open card, then Got it in the card view: the session moves on past x, to the end.
  review('x', 'good', T0 + 20_000);
  assert.equal(live('x'), false);
  assert.equal(findSessionCard(current.itemIds, current.index, current.passedOverFrom, live), 3);
});

test('a card brought back stays passed over after a Got it elsewhere though a phone clock running ahead stamps that review before its grade', () => {
  const T0 = Date.UTC(2026, 10, 16, 9);
  // The phone's clock runs 10 minutes ahead of the server's, which stamps each review at most 5 minutes past its own
  // (server/src/db/reviews.ts), so every review from the phone is stamped 5 minutes before the phone's time.
  const AHEAD = 10 * 60_000;
  const cards = new Map([['x', vocab('x', 'crestfallen', { reviews: 2, nextReview: T0, lastReviewed: T0 - 86_400_000 })], ['y', vocab('y', 'walk')]]);
  /** A review from the phone as the server applies it, and the phone then adopts it. */
  const serverReview = (id: string, rating: 'again' | 'good', reviewedAt: number) => {
    const card = cards.get(id)!;
    const serverNow = reviewedAt - AHEAD;
    const stamped = Math.max(card.srs.lastReviewDate || 0, Math.min(reviewedAt, serverNow + 5 * 60_000));
    cards.set(id, { ...card, srs: updateAfterRating(SRSAlgorithm.ensure(card.srs, id, card.type), rating, stamped) });
  };
  let current = startStudySession('s', [cards.get('x')!, cards.get('y')!], T0 + AHEAD, {});
  const grade = (rating: 'again' | 'good', now: number) => {
    const item = cards.get(current.itemIds[current.index])!;
    const next = updateAfterRating(SRSAlgorithm.ensure(item.srs, item.data.id, item.type), rating, now);
    const graded = gradeSessionCard({ ...current, revealed: true }, item, rating, `event-${now}`, now, next);
    serverReview(item.data.id, rating, graded.review.reviewedAt);
    current = graded.advance(current);
  };
  const live = (id: string) => isSessionCardLive(cards.get(id), current);

  grade('again', T0 + AHEAD + 5_000);
  grade('good', T0 + AHEAD + 9_000);
  assert.equal(findSessionCard(current.itemIds, current.index, current.passedOverFrom, live), 2, 'x comes back');

  // Open card, then Got it: its review is stamped before the time x's grade keeps, and still moves the session on.
  serverReview('x', 'good', T0 + AHEAD + 20_000);
  assert.ok(cards.get('x')!.srs.lastReviewDate < current.grades[0].at);
  assert.equal(live('x'), false);
  assert.equal(findSessionCard(current.itemIds, current.index, current.passedOverFrom, live), 3, 'on to the end, not back to x');
});

test('the next three listening prompts after the card shown are fetched ahead, skipping cards that left the session', () => {
  const examples = (word: string) => [`They were ${word} today.`];
  const listening = (id: string, extra: { lastReviewed?: number } = {}) =>
    vocab(id, id, { strength: 70, reviews: 5, examples: examples(id), ...extra });
  const cards = new Map([
    ['now', listening('now')],
    ['meaning', vocab('meaning', 'meaning')],
    ['one', listening('one')],
    ['elsewhere', listening('elsewhere', { lastReviewed: 2_000 })],
    ['two', listening('two')],
    ['three', listening('three')],
    ['four', listening('four')],
  ]);
  const current = session({ itemIds: ['now', 'meaning', 'gone', 'one', 'elsewhere', 'two', 'three', 'four'], startedAt: 1_000, grades: [] });
  const get = (id: string) => cards.get(id);
  assert.deepEqual(upcomingListeningPrompts(current, 0, get), ['They were one today.', 'They were two today.', 'They were three today.']);
  assert.deepEqual(upcomingListeningPrompts(current, 5, get, 2), ['They were three today.', 'They were four today.']);
  assert.deepEqual(upcomingListeningPrompts(current, 7, get), [], 'the last card has none after it');
});

test('Open card lists the card among the study items that share its spelling, so the card view reaches its other senses', () => {
  const items = [
    vocab('lead-verb', 'lead'), vocab('walk', 'walk'), vocab('lead-noun', 'Lead '), vocab('lead-metal', 'lead'),
  ];
  assert.deepEqual(openCardGroup(items[2], items), { group: { title: 'Lead ', items: [items[0], items[2], items[3]] }, index: 1 });
  assert.deepEqual(openCardGroup(items[1], items), { group: { title: 'walk', items: [items[1]] }, index: 0 });
  const outside = vocab('lead-new', 'lead');
  assert.deepEqual(openCardGroup(outside, items), { group: { title: 'lead', items: [outside] }, index: 0 }, 'a card the list lacks');
});

test('moving past cards that left marks where they begin; moving back to one that returned keeps the mark', () => {
  const forward = moveSessionTo(session(), 3, 9_000);
  assert.deepEqual(forward, { ...session(), index: 3, passedOverFrom: 1, revealed: false, typedAnswer: '', promptStartedAt: 9_000 });
  // A run already open keeps its start, so a card passed over earlier can still come back.
  assert.equal(moveSessionTo(session({ index: 2, passedOverFrom: 1 }), 3, 9_000).passedOverFrom, 1);
  const back = moveSessionTo(session({ index: 3, passedOverFrom: 1 }), 2, 9_500);
  assert.deepEqual(back, { ...session(), index: 2, passedOverFrom: 1, revealed: false, typedAnswer: '', promptStartedAt: 9_500 });
});

test('a grade records the card, its word and interval, its task, the time on its prompt and the typed answer', () => {
  const current = session();
  const card = vocab('b', 'walk', { strength: 40, reviews: 2 });
  const { grade, advance } = gradeSessionCard(current, card, 'good', 'event-1', 4_000, scheduled(2_880));
  assert.deepEqual(grade, {
    eventId: 'event-1', sessionId: 'session', itemId: 'b', itemIndex: 1, word: 'walk', intervalMinutes: 2_880,
    rating: 'good', taskType: 'production', durationMs: 3_000, typedAnswer: 'ran', requeuedAt: undefined,
  });
  assert.equal(advance(current).itemIds, current.itemIds, 'a grade a day or more away doesn\'t queue the card again');
  assert.equal(gradeSessionCard(current, card, 'good', 'event-2', 500, scheduled(2_880)).grade.durationMs, 0, 'a clock that went back counts no time');
  assert.equal(gradeSessionCard(current, card, 'good', 'event-3', 1_000 + 30 * 60_000, scheduled(2_880)).grade.durationMs, 120_000, 'time away isn\'t counted');
});

test('a grade\'s review is stamped with the time the grade keeps in the session, and carries its task, prompt time and event', () => {
  const current = session();
  const card = vocab('b', 'walk', { strength: 40, reviews: 2 });
  const next = updateAfterRating(SRSAlgorithm.ensure(card.srs, 'b', 'vocab'), 'good', 4_000);
  const { review, advance } = gradeSessionCard(current, card, 'good', 'event-1', 4_000, next);
  assert.deepEqual(review, { taskType: 'production', durationMs: 3_000, sessionId: 'session', eventId: 'event-1', reviewedAt: 4_000 });
  const standing = advance(current).grades.at(-1);
  assert.deepEqual(standing, { itemId: 'b', rating: 'good', at: 4_000, totalReviews: 3 }, 'the count its review leaves');
  assert.equal(review.reviewedAt, standing?.at);
});

test('a grade with a short step queues the card once more at the end, and the grade remembers where', () => {
  for (const [rating, intervalMinutes] of [['again', 10], ['hard', 15]] as const) {
    const { grade, advance } = gradeSessionCard(session(), vocab('b', 'walk'), rating, 'event', 2_000, scheduled(intervalMinutes));
    assert.deepEqual(advance(session()).itemIds, ['a', 'b', 'c', 'b'], rating);
    assert.equal(grade.requeuedAt, 3, rating);
  }
});

test('after a grade the session moves on to the next card, unrevealed, with the grade standing', () => {
  const advanced = advanceSession(session({ passedOverFrom: 0 }), ['a', 'b', 'c', 'b'], { itemId: 'b', rating: 'again', at: 6_000, totalReviews: 1 }, 6_000);
  assert.deepEqual(advanced, {
    ...session(), itemIds: ['a', 'b', 'c', 'b'], index: 2, passedOverFrom: undefined, revealed: false, typedAnswer: '',
    promptStartedAt: 6_000, grades: [{ itemId: 'a', rating: 'good', at: 1_000, totalReviews: 1 }, { itemId: 'b', rating: 'again', at: 6_000, totalReviews: 1 }],
  });
});

test('undoing a grade goes back to its card, revealed, and takes back the grade and its extra showing', () => {
  const before = session();
  for (const [rating, intervalMinutes] of [['again', 10], ['hard', 15]] as const) {
    const { grade, advance } = gradeSessionCard(before, vocab('b', 'walk'), rating, 'event', 2_000, scheduled(intervalMinutes));
    const after = advance(before);
    const undone = undoSessionGrade(after, grade, 7_000);
    assert.deepEqual(undone, { ...before, passedOverFrom: undefined, promptStartedAt: 7_000 }, rating);
  }

  // An extra showing that has moved is left alone, and so is a grade that isn't the last one standing.
  const { grade, advance } = gradeSessionCard(before, vocab('b', 'walk'), 'again', 'event', 2_000, scheduled(10));
  const after = advance(before);
  const moved = undoSessionGrade({ ...after, itemIds: ['a', 'b', 'c', 'x', 'b'], grades: [{ itemId: 'a', rating: 'good', at: 1_000, totalReviews: 1 }] }, grade, 7_000);
  assert.deepEqual(moved.itemIds, ['a', 'b', 'c', 'x', 'b']);
  assert.deepEqual(moved.grades, [{ itemId: 'a', rating: 'good', at: 1_000, totalReviews: 1 }]);
});

test('a footer tap within 350 ms of a reveal or a grade is the second tap of a double tap', () => {
  assert.equal(acceptFooterTap(undefined, 1_000), true, 'nothing revealed or graded yet');
  assert.equal(acceptFooterTap(1_000, 1_349), false);
  assert.equal(acceptFooterTap(1_000, 1_350), true);
  assert.equal(acceptFooterTap(1_000, 900), true, 'a clock that went back holds nothing back');
  assert.equal(acceptFooterTap(1_000, 1_100, 50), true);
});

test('the receipt names the word, the grade and when the card comes back, and says when it waits or is undoing', () => {
  const good = { word: 'crestfallen', rating: 'good', intervalMinutes: 59 * 1_440, requeued: false, undoing: false, waiting: false } as const;
  assert.deepEqual(receiptText(good), { word: 'crestfallen', rating: 'good', ratingLabel: 'Good', detail: 'next in 59d' });
  assert.equal(receiptText({ ...good, intervalMinutes: 180 }).detail, 'next in 3h');
  const again = { ...good, rating: 'again', intervalMinutes: 10, requeued: true } as const;
  assert.deepEqual(receiptText(again), { word: 'crestfallen', rating: 'again', ratingLabel: 'Again', detail: 'again later this session' });
  assert.equal(receiptText({ ...good, waiting: true }).detail, 'next in 59d · saved on this device');
  assert.equal(receiptText({ ...again, waiting: true }).detail, 'again later this session · saved on this device');
  assert.equal(receiptText({ ...good, undoing: true }).detail, 'Undoing…');
  assert.equal(receiptText({ ...good, undoing: true, waiting: true }).detail, 'Undoing…');
  assert.deepEqual(['again', 'hard', 'good', 'easy'].map(rating => receiptText({ ...good, rating: rating as 'good' }).ratingLabel), ['Again', 'Hard', 'Good', 'Easy']);
});

test('a failed undo is said in words: a card that has changed since, a review still syncing, or offline, to reconnect first', () => {
  const failed = (status: number, body: string) => ({ error: new HttpError(`Undo review failed (${status}): ${body}`, status, body) });
  assert.equal(undoFailureText(failed(409, 'Review is no longer the latest change for this item'), true), 'This card has changed since, so the review can’t be undone.');
  assert.equal(undoFailureText(failed(404, 'Review event not found'), true), 'The review could not be undone.');
  assert.equal(undoFailureText({ error: new TypeError('Failed to fetch') }, true), 'The review could not be undone.', 'the server out of reach');
  assert.equal(undoFailureText({ error: new TypeError('Failed to fetch') }, false), 'Reconnect to undo this review.');
  assert.equal(undoFailureText('waiting', true), 'This review is still syncing. Try undo again.');
  assert.equal(undoFailureText('waiting', false), 'Reconnect to undo this review.');
});

test('an undo that comes back changes only the session its grade was made in', () => {
  const before = session();
  const { grade, advance } = gradeSessionCard(before, vocab('b', 'walk'), 'again', 'event', 2_000, scheduled(10));
  const after = advance(before);
  assert.deepEqual(applyUndoneGrade(after, grade, 7_000), undoSessionGrade(after, grade, 7_000));
  // The session ended, or another started, while the undo was on its way.
  assert.equal(applyUndoneGrade(null, grade, 7_000), null);
  const next = { ...after, id: 'next-session' };
  assert.equal(applyUndoneGrade(next, grade, 7_000), next);
});

test('time until a review reads in whole days, else hours, else minutes, and now when under a minute', () => {
  const now = 1_000_000_000;
  const MINUTE = 60_000, HOUR = 60 * MINUTE, DAY = 24 * HOUR;
  const cases: [offset: number, label: string][] = [
    [-DAY, 'now'], [0, 'now'], [1, 'now'], [MINUTE - 1, 'now'], [MINUTE, '1m'], [59 * MINUTE + 59_999, '59m'],
    [HOUR, '1h'], [23 * HOUR + 59 * MINUTE, '23h'], [DAY, '1d'], [10 * DAY + 23 * HOUR, '10d'],
  ];
  for (const [offset, label] of cases) assert.equal(formatTimeUntil(now + offset, now), label, String(offset));
});

test('the summary counts each card once, and lists the cards missed (Again or Hard) once each, in the order first missed', () => {
  const graded = session({
    itemIds: ['a', 'b', 'c', 'd', 'b', 'c'],
    grades: [
      { itemId: 'a', rating: 'good', at: 600, totalReviews: 1 }, { itemId: 'b', rating: 'again', at: 700, totalReviews: 1 }, { itemId: 'c', rating: 'hard', at: 800, totalReviews: 1 },
      { itemId: 'd', rating: 'easy', at: 900, totalReviews: 1 }, { itemId: 'b', rating: 'again', at: 1_000, totalReviews: 1 },
    ],
  });
  assert.deepEqual(summarizeSession(graded), {
    total: 4, graded: 4, counts: { again: 2, hard: 1, good: 1, easy: 1 }, missedIds: ['b', 'c'],
  });
  // Good and Easy miss nothing; a card missed once stays missed after a later Good.
  assert.deepEqual(summarizeSession(session({ grades: [{ itemId: 'a', rating: 'good', at: 600, totalReviews: 1 }, { itemId: 'a', rating: 'easy', at: 700, totalReviews: 1 }] })).missedIds, []);
  assert.deepEqual(summarizeSession(session({ grades: [{ itemId: 'a', rating: 'again', at: 600, totalReviews: 1 }, { itemId: 'a', rating: 'good', at: 700, totalReviews: 1 }] })).missedIds, ['a']);
  assert.deepEqual(summarizeSession(session({ itemIds: ['a', 'b'], grades: [] })), {
    total: 2, graded: 0, counts: { again: 0, hard: 0, good: 0, easy: 0 }, missedIds: [],
  });
});

test('undoing a miss takes the card off the missed list, unless another Again or Hard of it still stands', () => {
  const before = session({ itemIds: ['a', 'b', 'c'], index: 1, grades: [{ itemId: 'a', rating: 'again', at: 1_000, totalReviews: 1 }] });
  const { grade, advance } = gradeSessionCard(before, vocab('b', 'walk'), 'hard', 'event', 2_000, scheduled(15));
  const after = advance(before);
  assert.deepEqual(summarizeSession(after).missedIds, ['a', 'b']);
  assert.deepEqual(summarizeSession(undoSessionGrade(after, grade, 3_000)).missedIds, ['a']);

  // The card's extra showing is graded Again too; undoing that grade leaves the first one standing.
  const requeued = session({ itemIds: ['a', 'b', 'a'], index: 2, grades: [{ itemId: 'a', rating: 'again', at: 600, totalReviews: 1 }, { itemId: 'b', rating: 'good', at: 1_000, totalReviews: 1 }] });
  const again = gradeSessionCard(requeued, vocab('a', 'run'), 'again', 'event-2', 4_000, scheduled(10, 2));
  const regraded = again.advance(requeued);
  assert.deepEqual(summarizeSession(undoSessionGrade(regraded, again.grade, 5_000)).missedIds, ['a']);
});

const summaryMarkup = (props: Partial<Parameters<typeof StudySummary>[0]> = {}) => renderToStaticMarkup(createElement(StudySummary, {
  // crestfallen was rated Again, then Good when it came back at the end; give up was rated Hard.
  summary: { total: 50, graded: 50, counts: { again: 1, hard: 1, good: 44, easy: 5 }, missedIds: ['a', 'b'] },
  endedEarly: false,
  missed: [{ id: 'a', title: 'crestfallen' }, { id: 'b', title: 'give up' }],
  onOpenMissed: () => {}, canUndo: false, undoing: false, undoError: '', onUndo: () => {}, onDone: () => {},
  ...props,
}));
const summaryText = (markup: string) => markup.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

test('the summary names the session\'s cards, the words to look at again in order, and ends with Done; with none there is no list', () => {
  const markup = summaryMarkup();
  assert.match(markup, /<h2 class="text-2xl font-bold text-slate-800">Session complete · 50 cards<\/h2>/);
  assert.match(summaryText(markup), /Recalled 50 of 51 prompts\. To look at again \(2\) Open these cards crestfallen give up Done$/);
  assert.match(markup, /<button class="px-2\.5 py-1 rounded-full bg-rose-50 text-rose-700 text-sm hover:bg-rose-100">crestfallen<\/button><button [^>]*>give up<\/button>/);
  assert.match(markup, /<button class="w-full h-12 bg-slate-900 text-white font-semibold rounded-lg hover:bg-slate-800" aria-keyshortcuts="Enter">Done<\/button><\/div>$/);
  assert.doesNotMatch(markup, /Return to study/);
  const noneMissed = summaryMarkup({ summary: { total: 1, graded: 1, counts: { again: 0, hard: 0, good: 1, easy: 0 }, missedIds: [] }, missed: [] });
  assert.match(noneMissed, />Session complete · 1 card</);
  assert.doesNotMatch(noneMissed, /To look at again|Open these cards/, 'with none rated Again or Hard there is no list');
});

test('Hard counts as recalled, as FSRS and the dashboard count it, and its words are listed to look at again, never as missed', () => {
  const ids = ['w0', 'w1', 'w2'];
  const allHard = session({ itemIds: ids, grades: ids.map((itemId, at) => ({ itemId, rating: 'hard', at, totalReviews: 1 })) });
  const summary = summarizeSession(allHard);
  const text = summaryText(summaryMarkup({ summary, missed: summary.missedIds.map(id => ({ id, title: `word ${id}` })) }));
  assert.match(text, /Recalled 3 of 3 prompts\. To look at again \(3\) Open these cards word w0 word w1 word w2 Done$/);
  assert.doesNotMatch(text, /[Mm]issed/);
});

test('the summary keeps its undo for the last rating, and says when an undo failed', () => {
  const markup = summaryMarkup({ canUndo: true, undoError: 'Reconnect to undo this review.' });
  assert.match(summaryText(markup), /Undo last rating Reconnect to undo this review\. Done$/);
  assert.match(summaryMarkup({ canUndo: true, undoing: true }), /disabled="" [^>]*aria-keyshortcuts="U">.*Undoing…<\/button>/);
});

test('a session ended early keeps its place: Resume takes it up at the same card, unrevealed, and an undo runs it again', () => {
  const running = session({ index: 1, revealed: true, typedAnswer: 'wal', passedOverFrom: 1 });
  const ended = endSessionEarly(running);
  assert.deepEqual(ended, { ...running, ended: true });
  const resumed = resumeSession(ended, 9_000);
  assert.deepEqual(resumed, { ...running, revealed: false, typedAnswer: '', promptStartedAt: 9_000 });
  assert.equal('ended' in resumed, false);

  // Undoing the last grade from the summary goes back to that card, revealed, as from a finished session's summary.
  const before = session();
  const { grade, advance } = gradeSessionCard(before, vocab('b', 'walk'), 'good', 'event', 2_000, scheduled(2_880));
  const undone = undoSessionGrade(endSessionEarly(advance(before)), grade, 7_000);
  assert.deepEqual(undone, { ...before, passedOverFrom: undefined, promptStartedAt: 7_000 });
});

test('a session ended early says how many of its cards were reviewed, and offers Resume while a card is left', () => {
  const markup = summaryMarkup({
    summary: { total: 50, graded: 23, counts: { again: 1, hard: 1, good: 20, easy: 2 }, missedIds: [] },
    endedEarly: true,
    missed: [],
    onResume: () => {},
  });
  assert.match(markup, /<h2 class="text-2xl font-bold text-slate-800">Ended early · 23 of 50 reviewed<\/h2>/);
  assert.match(markup, /aria-keyshortcuts="R"><svg[^]*?<\/svg> Resume<\/button><button [^>]*aria-keyshortcuts="Enter">Done<\/button>/);
  assert.doesNotMatch(summaryMarkup({ endedEarly: true }), /Resume/, 'no card is left to resume at');
  assert.doesNotMatch(summaryMarkup(), /Resume|Ended early/);
});
