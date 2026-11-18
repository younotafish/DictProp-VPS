import assert from 'node:assert/strict';
import test from 'node:test';
import type { ReviewRating, ReviewTaskType, StoredItem } from '../../types.ts';
import { applyPracticeMembership } from '../../server/src/shared/practice.ts';
import { updateAfterRating } from '../../services/fsrsScheduler.ts';
import { SRSAlgorithm } from '../../services/srsAlgorithm.ts';
import {
  answerAttempt,
  applyMeetBack,
  applyUndoneAttempt,
  attemptStage,
  chooseInMeet,
  currentItemId,
  finishEncoding,
  finishLook,
  isRunItemLive,
  isSessionOver,
  meetBackTarget,
  meetChoiceOpen,
  practiceQueue,
  reviewSessionId,
  revealAnswer,
  sessionProgress,
  settleSession,
  startPracticeSession,
  startSetSession,
  summarizePractice,
  summarizeSet,
  takeHint,
  type LoopReview,
  type LoopSession,
  type PracticeSession,
  type SetSession,
} from '../../services/learningLoop/session.ts';
import { DAY, HOUR, practicing, reviewed, sayable, sentenceItem, vocabItem } from '../support/loop-fixtures.ts';

const T0 = new Date(2026, 10, 18, 9).getTime();

/** Ids in order, as the screen's crypto.randomUUID would make them. */
function idMaker(prefix = 'event') {
  let next = 0;
  return () => `${prefix}-${++next}`;
}

/**
 * A library the session runs against, which records reviews as updateSRS does on this device: the FSRS step plus
 * practice membership (server/src/shared/practice.ts), at the review's own time.
 */
function library(items: StoredItem[]) {
  const byId = new Map(items.map(item => [item.data.id, item]));
  const recorded: LoopReview[] = [];
  return {
    get: (id: string) => byId.get(id),
    set: (item: StoredItem) => byId.set(item.data.id, item),
    recorded,
    record(review: LoopReview) {
      recorded.push(review);
      const item = byId.get(review.itemId)!;
      const before = SRSAlgorithm.ensure(item.srs, item.data.id, item.type);
      const at = review.context.reviewedAt;
      const after = applyPracticeMembership(before, updateAfterRating(before, review.rating, at), review.context.taskType, review.rating, at, at);
      byId.set(item.data.id, { ...item, srs: after });
    },
    /** A review made elsewhere: the card view's Got it, or another device. */
    reviewElsewhere(id: string, rating: ReviewRating, taskType: ReviewTaskType, at: number) {
      this.record({ itemId: id, rating, context: { taskType, durationMs: 0, sessionId: 'elsewhere', eventId: `elsewhere-${at}`, reviewedAt: at } });
      recorded.pop();
    },
  };
}

type Library = ReturnType<typeof library>;

/** The session as the screen keeps it: settled after every change. */
function driver<S extends LoopSession>(lib: Library, start: S, createId = idMaker('attempt')) {
  let session = settleSession(start, lib.get, createId, start.startedAt);
  let clock = start.startedAt;
  const settle = () => { session = settleSession(session, lib.get, createId, clock); };
  return {
    get session() { return session; },
    set session(next: S) { session = next; },
    tick(ms = 1_000) { clock += ms; return clock; },
    get now() { return clock; },
    settle,
    reveal() { session = revealAnswer(session); },
    hint() { session = takeHint(session); },
    /** Meets the current item with `choice`, recording its review; Next after Practice. */
    choose(choice: 'practice' | 'passive' | 'say', eventId: string) {
      this.reveal();
      const item = lib.get(currentItemId(session)!)!;
      const step = chooseInMeet(session as unknown as SetSession, item, choice, eventId, this.tick());
      assert.ok(step, `can choose ${item.data.id}`);
      lib.record(step.review);
      session = step.advance(session as unknown as SetSession) as unknown as S;
      if (choice === 'practice') session = finishEncoding(session as unknown as SetSession, this.tick()) as unknown as S;
      settle();
      return step;
    },
    /** Answers the run's card, recording its review if it makes one. */
    answer(gotIt: boolean, mode: 'speak' | 'quiet' = 'speak') {
      this.reveal();
      const item = lib.get(currentItemId(session)!)!;
      const step = answerAttempt(session, item, gotIt, this.tick(), mode);
      assert.ok(step, `can answer ${item.data.id}`);
      if (step.review) lib.record(step.review);
      session = step.advance(session);
      settle();
      return step;
    },
  };
}

const words = (count: number) => Array.from({ length: count }, (_, i) =>
  vocabItem(`w${i}`, `word${i}`, { chinese: `释义${i}`, definition: `meaning ${i}`, savedAt: T0 - DAY + i }));

test('a set session starts meeting its first item, at the cue, with nothing chosen and no round yet', () => {
  assert.deepEqual(startSetSession('s1', { themeId: 'theme', itemIds: ['a', 'b'] }, T0), {
    kind: 'set', id: 's1', themeId: 'theme', itemIds: ['a', 'b'], startedAt: T0, phase: 'meet',
    meet: { index: 0, choices: {} }, round: { queue: [], index: 0, attempts: {} }, step: 'cue', hintShown: false, promptStartedAt: T0,
  });
  assert.equal(reviewSessionId({ kind: 'set', id: 's1' }), 'set:s1');
  assert.equal(reviewSessionId({ kind: 'practice', id: 'p1' }), 'practice:p1');
});

test('each Meet choice records its triage review at once: Practice is Again, Passive Good, Can say it Easy', () => {
  const lib = library(words(3));
  const run = driver(lib, startSetSession('s1', { themeId: 'theme', itemIds: ['w0', 'w1', 'w2'] }, T0));
  run.tick(4_000);
  const first = run.choose('passive', 'e-1');
  assert.deepEqual(first.review, {
    itemId: 'w0', rating: 'good',
    context: { taskType: 'triage', durationMs: 5_000, sessionId: 'set:s1', eventId: 'e-1', reviewedAt: T0 + 5_000 },
  });
  assert.equal(currentItemId(run.session), 'w1');
  assert.equal(run.session.step, 'cue');
  run.choose('say', 'e-2');
  run.choose('practice', 'e-3');
  assert.deepEqual(lib.recorded.map(review => [review.itemId, review.rating, review.context.taskType]), [
    ['w0', 'good', 'triage'], ['w1', 'easy', 'triage'], ['w2', 'again', 'triage'],
  ]);
  const { meet } = run.session as SetSession;
  assert.deepEqual(meet.choices.w1, { choice: 'say', eventId: 'e-2', at: T0 + 6_000, totalReviews: 1 });
  // The new schedules: Can say it marks the item, Practice joins practice, Passive neither.
  assert.equal(lib.get('w1')!.srs.sayableAt, T0 + 6_000);
  assert.equal(lib.get('w2')!.srs.practiceSince, T0 + 7_000);
  assert.equal(lib.get('w0')!.srs.practiceSince, undefined);
});

test('after Practice the card stays on its answer to say it twice, and Next moves on', () => {
  const lib = library(words(2));
  let session: SetSession = revealAnswer(startSetSession('s1', { themeId: null, itemIds: ['w0', 'w1'] }, T0));
  const step = chooseInMeet(session, lib.get('w0')!, 'practice', 'e-1', T0 + 1_000)!;
  lib.record(step.review);
  session = settleSession(step.advance(session), lib.get, idMaker(), T0 + 1_000);
  assert.equal(session.step, 'encode');
  assert.equal(currentItemId(session), 'w0', 'settling keeps the card being said twice');
  assert.equal(revealAnswer(session), session);
  session = finishEncoding(session, T0 + 9_000);
  assert.deepEqual([currentItemId(session), session.step, session.promptStartedAt], ['w1', 'cue', T0 + 9_000]);
  assert.equal(finishEncoding(session, T0 + 9_500), session, 'only from saying it twice');
});

test('a choice waits for the answer, and is refused for an item no longer new, deleted or archived', () => {
  const lib = library(words(2));
  const session = startSetSession('s1', { themeId: null, itemIds: ['w0', 'w1'] }, T0);
  assert.equal(chooseInMeet(session, lib.get('w0')!, 'say', 'e', T0), null, 'its answer isn\'t showing');
  const revealed = revealAnswer(session);
  assert.equal(chooseInMeet(revealed, lib.get('w1')!, 'say', 'e', T0), null, 'not the item being met');
  lib.reviewElsewhere('w0', 'good', 'quick', T0 + 500);
  assert.equal(chooseInMeet(revealed, lib.get('w0')!, 'say', 'e', T0 + 1_000), null, 'met elsewhere meanwhile');
  assert.equal(chooseInMeet(revealed, { ...vocabItem('w0', 'word0'), isArchived: true }, 'say', 'e', T0), null);
  assert.equal(chooseInMeet({ ...revealed, phase: 'round' }, vocabItem('w0', 'word0'), 'say', 'e', T0), null);
});

test('once the hint has shown, Can say it stays closed for that item, also after Back, while Practice and Passive stay open', () => {
  const lib = library(words(2));
  const hinted = revealAnswer(takeHint(startSetSession('s1', { themeId: null, itemIds: ['w0', 'w1'] }, T0)));
  assert.deepEqual((['practice', 'passive', 'say'] as const).map(choice => meetChoiceOpen(hinted, choice)), [true, true, false]);
  assert.equal(chooseInMeet(hinted, lib.get('w0')!, 'say', 'e', T0 + 1_000), null);
  const step = chooseInMeet(hinted, lib.get('w0')!, 'passive', 'e-1', T0 + 1_000)!;
  lib.record(step.review);
  const moved = settleSession(step.advance(hinted), lib.get, idMaker(), T0 + 1_000);
  assert.deepEqual(moved.meet.choices.w0, { choice: 'passive', eventId: 'e-1', at: T0 + 1_000, totalReviews: 1, hinted: true });
  assert.deepEqual([currentItemId(moved), meetChoiceOpen(moved, 'say')], ['w1', true], 'the next card starts without the hint');
  const back = applyMeetBack(moved, meetBackTarget(moved)!, T0 + 2_000)!;
  assert.deepEqual([currentItemId(back), back.step, back.hintShown, meetChoiceOpen(back, 'say')], ['w0', 'answer', true, false]);
});

test('the Meet passes items that are no longer new, deleted or archived, and its end starts the round over the items chosen for practice, in the order met', () => {
  const items = words(6);
  const lib = library(items);
  lib.set({ ...items[1], isDeleted: true });
  lib.set({ ...items[3], isArchived: true });
  lib.reviewElsewhere('w4', 'good', 'quick', T0 - HOUR);
  const run = driver(lib, startSetSession('s1', { themeId: 'theme', itemIds: items.map(item => item.data.id) }, T0), idMaker('attempt'));
  assert.equal(currentItemId(run.session), 'w0');
  run.choose('practice', 'e-1');
  assert.equal(currentItemId(run.session), 'w2', 'w1 is gone');
  run.choose('passive', 'e-2');
  assert.equal(currentItemId(run.session), 'w5', 'w3 is archived and w4 was met elsewhere');
  run.choose('practice', 'e-3');
  const session = run.session as SetSession;
  assert.equal(session.phase, 'round');
  assert.deepEqual(session.round.queue, ['w0', 'w5']);
  assert.deepEqual(session.round.attempts, {
    w0: { tries: 0, hinted: false, eventId: 'attempt-1' },
    w5: { tries: 0, hinted: false, eventId: 'attempt-2' },
  });
  assert.deepEqual([session.step, session.hintShown, currentItemId(session)], ['cue', false, 'w0']);
});

test('a set with nothing chosen for practice goes from the Meet to its summary', () => {
  const lib = library(words(2));
  const run = driver(lib, startSetSession('s1', { themeId: null, itemIds: ['w0', 'w1'] }, T0));
  run.choose('say', 'e-1');
  run.choose('passive', 'e-2');
  assert.equal((run.session as SetSession).phase, 'summary');
  assert.equal(isSessionOver(run.session), true);
  assert.equal(currentItemId(run.session), undefined);
  assert.deepEqual(summarizeSet(run.session as SetSession), { sayable: 1, passive: 1, practicing: 0, firstTry: 0, rounded: 0 });
  // Settling a finished session changes nothing.
  assert.equal(settleSession(run.session, lib.get, idMaker(), T0 + DAY), run.session);
});

test('Back takes back the latest choice, from the card said twice or the next item, and stops at the first', () => {
  const lib = library(words(3));
  const run = driver(lib, startSetSession('s1', { themeId: null, itemIds: ['w0', 'w1', 'w2'] }, T0));
  assert.equal(meetBackTarget(run.session as SetSession), null, 'nothing chosen yet');
  run.choose('passive', 'e-1');
  assert.deepEqual(meetBackTarget(run.session as SetSession), { sessionId: 's1', itemId: 'w0', eventId: 'e-1', index: 0 });

  // Practice on w1: while it is said twice, Back takes back its own choice.
  run.reveal();
  const step = chooseInMeet(run.session as SetSession, lib.get('w1')!, 'practice', 'e-2', run.tick())!;
  lib.record(step.review);
  run.session = step.advance(run.session as SetSession);
  const target = meetBackTarget(run.session as SetSession)!;
  assert.deepEqual(target, { sessionId: 's1', itemId: 'w1', eventId: 'e-2', index: 1 });

  // Once the server has taken the review back, the session returns to w1's answer without its choice.
  const back = applyMeetBack(run.session as SetSession, target, T0 + 60_000)!;
  assert.deepEqual([back.meet.index, back.step, 'w1' in back.meet.choices, back.phase], [1, 'answer', false, 'meet']);
  assert.equal(applyMeetBack(back, target, T0 + 61_000), back, 'the same undo twice changes nothing');
  const another = { ...back, id: 'another' };
  assert.equal(applyMeetBack(another, target, T0), another, 'another session');
  assert.equal(applyMeetBack(null, target, T0), null);
});

test('Back reaches into a round that has answered nothing, which is made again when the Meet ends, but not past an answer', () => {
  const lib = library(words(2));
  const run = driver(lib, startSetSession('s1', { themeId: null, itemIds: ['w0', 'w1'] }, T0), idMaker('attempt'));
  run.choose('practice', 'e-1');
  run.choose('say', 'e-2');
  let session = run.session as SetSession;
  assert.equal(session.phase, 'round');
  const target = meetBackTarget(session)!;
  assert.equal(target.itemId, 'w1');
  const back = applyMeetBack(session, target, T0 + 10_000)!;
  assert.deepEqual([back.phase, back.meet.index, back.round], ['meet', 1, { queue: [], index: 0, attempts: {} }]);

  // A round that has answered something keeps its own undo instead.
  run.answer(false);
  session = run.session as SetSession;
  assert.equal(meetBackTarget(session), null);
});

test('a run records one review per item: Good on the first try unaided, Hard with the hint', () => {
  const lib = library(words(3));
  const run = driver(lib, startSetSession('s1', { themeId: null, itemIds: ['w0', 'w1', 'w2'] }, T0), idMaker('attempt'));
  for (const id of ['w0', 'w1', 'w2']) run.choose('practice', `e-${id}`);
  const good = run.answer(true);
  assert.deepEqual(good.review, {
    itemId: 'w0', rating: 'good',
    context: { taskType: 'speak', durationMs: 1_000, sessionId: 'set:s1', eventId: 'attempt-1', reviewedAt: run.now },
  });
  run.hint();
  assert.equal(run.session.hintShown, true);
  const hard = run.answer(true, 'quiet');
  assert.equal(hard.review?.rating, 'hard');
  assert.equal(hard.review?.context.taskType, 'recall', 'the round records in the mode now chosen');
  assert.equal(run.answer(true).review?.rating, 'good');
  assert.equal((run.session as SetSession).phase, 'summary');
  assert.deepEqual(summarizeSet(run.session as SetSession), { sayable: 0, passive: 0, practicing: 3, firstTry: 2, rounded: 3 });
});

test('Not yet records nothing and brings the item back three cards later with its hint; then Got it is Hard, and Not yet again is Again with one last look', () => {
  const lib = library(words(5));
  const ids = ['w0', 'w1', 'w2', 'w3', 'w4'];
  const run = driver(lib, startSetSession('s1', { themeId: null, itemIds: ids }, T0), idMaker('attempt'));
  for (const id of ids) run.choose('practice', `e-${id}`);
  const recordedBefore = lib.recorded.length;

  const miss = run.answer(false);
  assert.equal(miss.review, undefined);
  assert.equal(miss.undo, undefined);
  let round = (run.session as SetSession).round;
  assert.deepEqual(round.queue, ['w0', 'w1', 'w2', 'w3', 'w0', 'w4']);
  assert.deepEqual(round.attempts.w0, { tries: 1, hinted: true, eventId: 'attempt-1' });
  assert.equal(attemptStage(round.attempts.w0), 'second');

  run.answer(true); // w1
  run.answer(false); // w2: back after w3, w0, w4
  run.answer(true); // w3
  assert.equal(currentItemId(run.session), 'w0');
  assert.equal(run.session.hintShown, true, 'the second try shows the hint by itself');
  const again = run.answer(false);
  assert.equal(again.review?.rating, 'again');
  round = (run.session as SetSession).round;
  assert.deepEqual(round.queue, ['w0', 'w1', 'w2', 'w3', 'w0', 'w4', 'w2', 'w0']);
  assert.equal(attemptStage(round.attempts.w0), 'look');

  run.answer(true); // w4
  const hard = run.answer(true); // w2's second try
  assert.equal(hard.review?.rating, 'hard');
  assert.equal(currentItemId(run.session), 'w0', 'the look after two misses');
  assert.equal(answerAttempt(revealAnswer(run.session), lib.get('w0')!, true, run.tick(), 'speak'), null, 'a look records nothing');
  run.session = finishLook(revealAnswer(run.session), run.tick());
  run.settle();
  assert.equal((run.session as SetSession).phase, 'summary');
  // One review per item: w0 again, w1 good, w2 hard, w3 good, w4 good.
  assert.deepEqual(lib.recorded.slice(recordedBefore).map(review => [review.itemId, review.rating]), [
    ['w1', 'good'], ['w3', 'good'], ['w0', 'again'], ['w4', 'good'], ['w2', 'hard'],
  ]);
});

test('an item missed near the end of the run comes back last', () => {
  const lib = library(words(2));
  const run = driver(lib, startSetSession('s1', { themeId: null, itemIds: ['w0', 'w1'] }, T0), idMaker('attempt'));
  run.choose('practice', 'e-0');
  run.choose('practice', 'e-1');
  run.answer(false);
  assert.deepEqual((run.session as SetSession).round.queue, ['w0', 'w1', 'w0']);
});

test('an answer waits for the reveal and is refused for a card that left the run', () => {
  const lib = library(words(2));
  const run = driver(lib, startSetSession('s1', { themeId: null, itemIds: ['w0', 'w1'] }, T0), idMaker('attempt'));
  run.choose('practice', 'e-0');
  run.choose('practice', 'e-1');
  const session = run.session;
  assert.equal(answerAttempt(session, lib.get('w0')!, true, T0, 'speak'), null, 'its answer isn\'t showing');
  assert.equal(answerAttempt(revealAnswer(session), lib.get('w1')!, true, T0, 'speak'), null, 'not the run\'s card');
  assert.equal(answerAttempt(revealAnswer(session), { ...lib.get('w0')!, isDeleted: true }, true, T0, 'speak'), null);
});

test('a run passes over an item reviewed elsewhere since its own last review, no longer practicing, deleted or archived', () => {
  const lib = library(words(4));
  const run = driver(lib, startSetSession('s1', { themeId: null, itemIds: ['w0', 'w1', 'w2', 'w3'] }, T0), idMaker('attempt'));
  for (const id of ['w0', 'w1', 'w2', 'w3']) run.choose('practice', `e-${id}`);
  // w0: a Got it in the card view; w1: marked as one you can say from its card; w2: archived.
  lib.reviewElsewhere('w0', 'good', 'quick', run.tick());
  lib.reviewElsewhere('w1', 'easy', 'triage', run.tick());
  lib.set({ ...lib.get('w2')!, isArchived: true });
  run.settle();
  assert.equal(currentItemId(run.session), 'w3');
  assert.equal(isRunItemLive(run.session, lib.get('w0')), false);
  assert.equal(isRunItemLive(run.session, lib.get('w1')), false);
  assert.equal(isRunItemLive(run.session, undefined), false);
});

test('a run keeps an item whose own review hasn\'t reached the device yet, unless a reset came after it', () => {
  const lib = library(words(1));
  const session = startSetSession('s1', { themeId: null, itemIds: ['w0'] }, T0);
  const revealed = revealAnswer(session);
  const step = chooseInMeet(revealed, lib.get('w0')!, 'practice', 'e-0', T0 + 1_000)!;
  // The choice is kept, but its review isn't applied on this device yet: the item still reads as new.
  const met = settleSession(finishEncoding(step.advance(revealed), T0 + 2_000), lib.get, idMaker('attempt'), T0 + 2_000);
  assert.equal(met.phase, 'round');
  assert.equal(currentItemId(met), 'w0');
  assert.equal(isRunItemLive(met, lib.get('w0')), true);
  // A reset elsewhere zeroes the count and stamps the item's clock after the choice.
  const reset = { ...lib.get('w0')!, srs: { ...SRSAlgorithm.createNew('w0', 'vocab', T0 + 3_000), lastReviewDate: T0 + 3_000 } };
  assert.equal(isRunItemLive(met, reset), false);
});

test('undoing a run\'s review goes back to its card, answer showing, the attempt as before under a new event, and takes back the return it queued', () => {
  const lib = library(words(5));
  const ids = ['w0', 'w1', 'w2', 'w3', 'w4'];
  const run = driver(lib, startSetSession('s1', { themeId: null, itemIds: ids }, T0), idMaker('attempt'));
  for (const id of ids) run.choose('practice', `e-${id}`);
  run.answer(false); // w0 comes back after w1, w2, w3
  run.answer(true);
  run.answer(true);
  run.answer(true);
  const before = run.session as SetSession;
  const again = run.answer(false); // w0's second try: Again, and one more look
  assert.ok(again.undo);
  assert.deepEqual(again.undo, {
    sessionId: 's1', itemId: 'w0', eventId: 'attempt-1', index: 4, previous: before.round.attempts.w0, requeued: true,
  });
  const undone = applyUndoneAttempt(run.session as SetSession, again.undo, 'attempt-new', run.tick())!;
  assert.deepEqual(undone.round.queue, before.round.queue, 'the look it queued is taken back');
  assert.deepEqual(undone.round.attempts.w0, { ...before.round.attempts.w0, eventId: 'attempt-new' });
  assert.deepEqual([undone.round.index, undone.step, undone.hintShown, undone.phase], [4, 'answer', true, 'round']);
  assert.equal(applyUndoneAttempt(undone, again.undo, 'x', T0), undone, 'the same undo twice changes nothing');
  assert.equal(applyUndoneAttempt(null, again.undo, 'x', T0), null);

  // Undoing the last review from the summary goes back into the round.
  const lib2 = library(words(1));
  const single = driver(lib2, startSetSession('s2', { themeId: null, itemIds: ['w0'] }, T0), idMaker('attempt'));
  single.choose('practice', 'e-0');
  const last = single.answer(true);
  assert.equal((single.session as SetSession).phase, 'summary');
  const reopened = applyUndoneAttempt(single.session as SetSession, last.undo!, 'attempt-9', single.tick())!;
  assert.deepEqual([reopened.phase, currentItemId(reopened), reopened.step], ['round', 'w0', 'answer']);
});

test('practice takes the due practice items, the most overdue first and ties by id, at most 30 a session', () => {
  const now = new Date(2026, 10, 18, 15).getTime();
  const midnight = new Date(2026, 10, 18).getTime();
  const due = (id: string, nextReview: number, lastReviewDate = midnight - DAY) =>
    vocabItem(id, id, { srs: practicing(now - 9 * DAY, { nextReview, lastReviewDate }) });
  const items = [
    due('b', now - HOUR), due('a', now - HOUR), due('c', now - 3 * DAY), due('later', now + 1), due('today', now - DAY, midnight + HOUR),
    vocabItem('passive', 'passive', { srs: reviewed(midnight - DAY, { nextReview: now - DAY }) }),
    vocabItem('say', 'say', { srs: sayable(midnight - DAY, { nextReview: now - DAY }) }),
    { ...due('kept', now - DAY), isArchived: true },
  ];
  assert.deepEqual(practiceQueue(items, now), { itemIds: ['c', 'a', 'b'], due: 3 });
  const many = Array.from({ length: 35 }, (_, i) => due(`m${String(i).padStart(2, '0')}`, now - i * HOUR));
  const queue = practiceQueue(many, now);
  assert.equal(queue.itemIds.length, 30);
  assert.equal(queue.due, 35);
  assert.equal(queue.itemIds[0], 'm34');
  assert.deepEqual(practiceQueue(many, now, 2).itemIds, ['m34', 'm33']);
});

test('a practice session keeps its mode, passes over items reviewed since it began, and sums up with its recall rate', () => {
  const now = new Date(2026, 10, 18, 15).getTime();
  const items = ['p0', 'p1', 'p2', 'p3'].map(id =>
    vocabItem(id, id, { srs: practicing(now - 9 * DAY, { nextReview: now - HOUR, lastReviewDate: now - 2 * DAY, stability: 2 }) }));
  const lib = library(items);
  const start = startPracticeSession('ps', ['p0', 'p1', 'p2', 'p3'], 'quiet', now, idMaker('attempt'));
  assert.deepEqual(start.attempts.p0, { tries: 0, hinted: false, eventId: 'attempt-1' });
  assert.deepEqual(sessionProgress(start), { position: 1, total: 4 });
  const run = driver(lib, start as PracticeSession);
  const first = run.answer(true, 'speak');
  assert.deepEqual([first.review?.rating, first.review?.context.taskType, first.review?.context.sessionId], ['good', 'recall', 'practice:ps']);
  lib.reviewElsewhere('p2', 'good', 'quick', run.tick());
  run.answer(false); // p1: back last
  assert.equal(currentItemId(run.session), 'p3', 'p2 was reviewed elsewhere');
  run.hint();
  run.answer(true); // p3: Hard
  run.answer(false); // p1's second try: Again
  run.session = finishLook(revealAnswer(run.session), run.tick());
  run.settle();
  assert.equal(isSessionOver(run.session), true);
  assert.deepEqual(summarizePractice(run.session as PracticeSession, lib.get), {
    firstTry: 1, withHint: 1, notYet: 1, recallRate: 33, graduated: [],
  });
});

test('a spoken Good after a long enough gap with enough stability graduates the item, which the summary lists', () => {
  const now = new Date(2026, 10, 18, 15).getTime();
  // In practice for weeks, stability past 21 days, last reviewed 20 days ago.
  const ready = vocabItem('ready', 'ready', { srs: practicing(now - 60 * DAY, {
    totalReviews: 5, nextReview: now - DAY, lastReviewDate: now - 20 * DAY, stability: 24, difficulty: 5, fsrsState: 2,
    scheduler: 'fsrs-v6', scheduledDays: 19, memoryStrength: 58,
  }) });
  const quiet = { ...ready, data: { ...ready.data, id: 'quiet' }, srs: { ...ready.srs, id: 'quiet' } };
  const lib = library([ready, quiet]);
  const speak = driver(lib, startPracticeSession('ps', ['ready'], 'speak', now, idMaker('a')) as PracticeSession);
  speak.answer(true);
  assert.equal(lib.get('ready')!.srs.sayableAt, speak.now);
  assert.deepEqual(summarizePractice(speak.session as PracticeSession, lib.get).graduated, ['ready']);
  // Quiet never graduates.
  const silent = driver(lib, startPracticeSession('pq', ['quiet'], 'quiet', now, idMaker('b')) as PracticeSession);
  silent.answer(true);
  assert.equal(lib.get('quiet')!.srs.practiceSince, now - 60 * DAY);
  assert.deepEqual(summarizePractice(silent.session as PracticeSession, lib.get).graduated, []);
});

test('the session says which card it shows and how far it has got', () => {
  const lib = library([...words(2), sentenceItem('s', 'A {{line}}.', { sourceWord: 'line' })]);
  const run = driver(lib, startSetSession('s1', { themeId: null, itemIds: ['w0', 'w1', 's'] }, T0), idMaker('attempt'));
  assert.deepEqual(sessionProgress(run.session), { position: 1, total: 3 });
  run.choose('practice', 'e-0');
  run.choose('practice', 'e-1');
  assert.deepEqual(sessionProgress(run.session), { position: 3, total: 3 });
  run.choose('passive', 'e-2');
  assert.deepEqual(sessionProgress(run.session), { position: 1, total: 2 });
  run.answer(false);
  assert.deepEqual(sessionProgress(run.session), { position: 2, total: 3 }, 'a missed item lengthens the run');
});

test('the hint shows once per card; in the Meet it records nothing, in a run it stays with the attempt', () => {
  const lib = library([vocabItem('w0', 'word0', { srs: practicing(T0 - 9 * DAY, { nextReview: T0 - HOUR, lastReviewDate: T0 - 2 * DAY }) })]);
  const meeting = startSetSession('s1', { themeId: null, itemIds: ['w0'] }, T0);
  const hinted = takeHint(meeting);
  assert.deepEqual([hinted.hintShown, hinted.meet, hinted.round], [true, meeting.meet, meeting.round]);
  assert.equal(takeHint(hinted), hinted);
  assert.equal(takeHint(revealAnswer(meeting)).hintShown, false, 'not once the answer shows');
  const practice = settleSession(startPracticeSession('p', ['w0'], 'speak', T0, idMaker()), lib.get, idMaker(), T0);
  assert.equal(takeHint(practice).attempts.w0.hinted, true);
});
