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
  isMeetItemLive,
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
import { DAY, HOUR, passive, practicing, reviewed, sayable, sentenceItem, vocabItem } from '../support/loop-fixtures.ts';

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

/** `count` new sentences, each of its own word. */
const lines = (count: number) => Array.from({ length: count }, (_, i) =>
  sentenceItem(`line${i}`, `A line about {{word${i}}}.`, { sourceWord: `word${i}`, savedAt: T0 - DAY + i }));

test('a set session starts meeting its first item, at the cue, with nothing chosen and no round yet', () => {
  assert.deepEqual(startSetSession('s1', { themeId: 'theme', itemIds: ['a', 'b'] }, T0), {
    kind: 'set', id: 's1', themeId: 'theme', itemIds: ['a', 'b'], startedAt: T0, phase: 'meet',
    meet: { index: 0, choices: {} }, round: { queue: [], index: 0, attempts: {} }, step: 'cue', hintShown: false, promptStartedAt: T0,
  });
  assert.equal(reviewSessionId({ kind: 'set', id: 's1' }), 'set:s1');
  assert.equal(reviewSessionId({ kind: 'practice', id: 'p1' }), 'practice:p1');
});

test('each Meet choice records its triage review at once: Practice is Again, Passive Good, Can say it Easy', () => {
  const lib = library(lines(3));
  const run = driver(lib, startSetSession('s1', { themeId: 'theme', itemIds: ['line0', 'line1', 'line2'] }, T0));
  run.tick(4_000);
  const first = run.choose('passive', 'e-1');
  assert.deepEqual(first.review, {
    itemId: 'line0', rating: 'good',
    context: { taskType: 'triage', durationMs: 5_000, sessionId: 'set:s1', eventId: 'e-1', reviewedAt: T0 + 5_000 },
  });
  assert.equal(currentItemId(run.session), 'line1');
  assert.equal(run.session.step, 'cue');
  run.choose('say', 'e-2');
  run.choose('practice', 'e-3');
  assert.deepEqual(lib.recorded.map(review => [review.itemId, review.rating, review.context.taskType]), [
    ['line0', 'good', 'triage'], ['line1', 'easy', 'triage'], ['line2', 'again', 'triage'],
  ]);
  const { meet } = run.session as SetSession;
  assert.deepEqual(meet.choices.line1, { choice: 'say', eventId: 'e-2', at: T0 + 6_000, totalReviews: 1 });
  // The new schedules: Can say it marks the sentence, Practice joins practice, Passive keeps it passive. Each is a
  // decision, which a set never offers again.
  assert.equal(lib.get('line1')!.srs.sayableAt, T0 + 6_000);
  assert.equal(lib.get('line2')!.srs.practiceSince, T0 + 7_000);
  const kept = lib.get('line0')!.srs;
  assert.deepEqual([kept.practiceSince, kept.sayableAt, kept.practiceChangedAt], [undefined, undefined, T0 + 5_000]);
  assert.equal(['line0', 'line1', 'line2'].some(id => isMeetItemLive(lib.get(id))), false);
});

test('after Practice the card stays on its answer to say it twice, and Next moves on', () => {
  const lib = library(lines(2));
  let session: SetSession = revealAnswer(startSetSession('s1', { themeId: null, itemIds: ['line0', 'line1'] }, T0));
  const step = chooseInMeet(session, lib.get('line0')!, 'practice', 'e-1', T0 + 1_000)!;
  lib.record(step.review);
  session = settleSession(step.advance(session), lib.get, idMaker(), T0 + 1_000);
  assert.equal(session.step, 'encode');
  assert.equal(currentItemId(session), 'line0', 'settling keeps the card being said twice');
  assert.equal(revealAnswer(session), session);
  session = finishEncoding(session, T0 + 9_000);
  assert.deepEqual([currentItemId(session), session.step, session.promptStartedAt], ['line1', 'cue', T0 + 9_000]);
  assert.equal(finishEncoding(session, T0 + 9_500), session, 'only from saying it twice');
});

test('a choice waits for the answer, and is refused for a sentence decided elsewhere meanwhile, deleted or archived, never for a Got it', () => {
  const lib = library(lines(2));
  const session = startSetSession('s1', { themeId: null, itemIds: ['line0', 'line1'] }, T0);
  assert.equal(chooseInMeet(session, lib.get('line0')!, 'say', 'e', T0), null, 'its answer isn\'t showing');
  const revealed = revealAnswer(session);
  assert.equal(chooseInMeet(revealed, lib.get('line1')!, 'say', 'e', T0), null, 'not the item being met');
  lib.reviewElsewhere('line0', 'good', 'quick', T0 + 500);
  assert.ok(chooseInMeet(revealed, lib.get('line0')!, 'say', 'e', T0 + 1_000), 'a Got it in the Sentences tab decides nothing');
  lib.reviewElsewhere('line0', 'again', 'triage', T0 + 600);
  assert.equal(chooseInMeet(revealed, lib.get('line0')!, 'say', 'e', T0 + 1_000), null, 'joined practice with the pill meanwhile');
  assert.equal(chooseInMeet(revealed, { ...lines(1)[0], isArchived: true }, 'say', 'e', T0), null);
  assert.equal(chooseInMeet({ ...revealed, phase: 'round' }, lines(1)[0], 'say', 'e', T0), null);
});

test('a sentence Got it\'d before is met like a new one: its choice is recorded on the count it had, and its round follows', () => {
  const [line] = lines(1);
  const lib = library([{ ...line, srs: { ...line.srs, ...reviewed(T0 - 3 * DAY, { totalReviews: 4, stability: 30 }) } }]);
  const run = driver(lib, startSetSession('s1', { themeId: null, itemIds: ['line0'] }, T0), idMaker('attempt'));
  assert.equal(currentItemId(run.session), 'line0');
  const step = run.choose('practice', 'e-0');
  assert.equal(step.review.context.taskType, 'triage');
  assert.deepEqual((run.session as SetSession).meet.choices.line0, { choice: 'practice', eventId: 'e-0', at: T0 + 1_000, totalReviews: 5 });
  assert.equal(lib.get('line0')!.srs.practiceSince, T0 + 1_000);
  assert.deepEqual([(run.session as SetSession).phase, currentItemId(run.session)], ['round', 'line0']);
  assert.equal(isRunItemLive(run.session, lib.get('line0')), true);
});

test('once the hint has shown, Can say it stays closed for that item, also after Back, while Practice and Passive stay open', () => {
  const lib = library(lines(2));
  const hinted = revealAnswer(takeHint(startSetSession('s1', { themeId: null, itemIds: ['line0', 'line1'] }, T0)));
  assert.deepEqual((['practice', 'passive', 'say'] as const).map(choice => meetChoiceOpen(hinted, choice)), [true, true, false]);
  assert.equal(chooseInMeet(hinted, lib.get('line0')!, 'say', 'e', T0 + 1_000), null);
  const step = chooseInMeet(hinted, lib.get('line0')!, 'passive', 'e-1', T0 + 1_000)!;
  lib.record(step.review);
  const moved = settleSession(step.advance(hinted), lib.get, idMaker(), T0 + 1_000);
  assert.deepEqual(moved.meet.choices.line0, { choice: 'passive', eventId: 'e-1', at: T0 + 1_000, totalReviews: 1, hinted: true });
  assert.deepEqual([currentItemId(moved), meetChoiceOpen(moved, 'say')], ['line1', true], 'the next card starts without the hint');
  const back = applyMeetBack(moved, meetBackTarget(moved)!, T0 + 2_000)!;
  assert.deepEqual([currentItemId(back), back.step, back.hintShown, meetChoiceOpen(back, 'say')], ['line0', 'answer', true, false]);
});

test('the Meet passes sentences decided elsewhere, deleted or archived, and its end starts the round over those chosen for practice, in the order met', () => {
  const items = lines(6);
  const lib = library(items);
  lib.set({ ...items[1], isDeleted: true });
  lib.set({ ...items[3], isArchived: true });
  lib.reviewElsewhere('line4', 'good', 'triage', T0 - HOUR);
  lib.reviewElsewhere('line5', 'good', 'quick', T0 - HOUR);
  const run = driver(lib, startSetSession('s1', { themeId: 'theme', itemIds: items.map(item => item.data.id) }, T0), idMaker('attempt'));
  assert.equal(currentItemId(run.session), 'line0');
  run.choose('practice', 'e-1');
  assert.equal(currentItemId(run.session), 'line2', 'line1 is gone');
  run.choose('passive', 'e-2');
  assert.equal(currentItemId(run.session), 'line5', 'line3 is archived and line4 was kept passive elsewhere; line5\'s Got it decided nothing');
  run.choose('practice', 'e-3');
  const session = run.session as SetSession;
  assert.equal(session.phase, 'round');
  assert.deepEqual(session.round.queue, ['line0', 'line5']);
  assert.deepEqual(session.round.attempts, {
    line0: { tries: 0, hinted: false, eventId: 'attempt-1' },
    line5: { tries: 0, hinted: false, eventId: 'attempt-2' },
  });
  assert.deepEqual([session.step, session.hintShown, currentItemId(session)], ['cue', false, 'line0']);
});

test('a set with nothing chosen for practice goes from the Meet to its summary', () => {
  const lib = library(lines(2));
  const run = driver(lib, startSetSession('s1', { themeId: null, itemIds: ['line0', 'line1'] }, T0));
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
  const lib = library(lines(3));
  const run = driver(lib, startSetSession('s1', { themeId: null, itemIds: ['line0', 'line1', 'line2'] }, T0));
  assert.equal(meetBackTarget(run.session as SetSession), null, 'nothing chosen yet');
  run.choose('passive', 'e-1');
  assert.deepEqual(meetBackTarget(run.session as SetSession), { sessionId: 's1', itemId: 'line0', eventId: 'e-1', index: 0 });

  // Practice on line1: while it is said twice, Back takes back its own choice.
  run.reveal();
  const step = chooseInMeet(run.session as SetSession, lib.get('line1')!, 'practice', 'e-2', run.tick())!;
  lib.record(step.review);
  run.session = step.advance(run.session as SetSession);
  const target = meetBackTarget(run.session as SetSession)!;
  assert.deepEqual(target, { sessionId: 's1', itemId: 'line1', eventId: 'e-2', index: 1 });

  // Once the server has taken the review back, the session returns to line1's answer without its choice.
  const back = applyMeetBack(run.session as SetSession, target, T0 + 60_000)!;
  assert.deepEqual([back.meet.index, back.step, 'line1' in back.meet.choices, back.phase], [1, 'answer', false, 'meet']);
  assert.equal(applyMeetBack(back, target, T0 + 61_000), back, 'the same undo twice changes nothing');
  const another = { ...back, id: 'another' };
  assert.equal(applyMeetBack(another, target, T0), another, 'another session');
  assert.equal(applyMeetBack(null, target, T0), null);
});

test('Back reaches into a round that has answered nothing, which is made again when the Meet ends, but not past an answer', () => {
  const lib = library(lines(2));
  const run = driver(lib, startSetSession('s1', { themeId: null, itemIds: ['line0', 'line1'] }, T0), idMaker('attempt'));
  run.choose('practice', 'e-1');
  run.choose('say', 'e-2');
  let session = run.session as SetSession;
  assert.equal(session.phase, 'round');
  const target = meetBackTarget(session)!;
  assert.equal(target.itemId, 'line1');
  const back = applyMeetBack(session, target, T0 + 10_000)!;
  assert.deepEqual([back.phase, back.meet.index, back.round], ['meet', 1, { queue: [], index: 0, attempts: {} }]);

  // A round that has answered something keeps its own undo instead.
  run.answer(false);
  session = run.session as SetSession;
  assert.equal(meetBackTarget(session), null);
});

test('a run records one review per item: Good on the first try unaided, Hard with the hint', () => {
  const lib = library(lines(3));
  const run = driver(lib, startSetSession('s1', { themeId: null, itemIds: ['line0', 'line1', 'line2'] }, T0), idMaker('attempt'));
  for (const id of ['line0', 'line1', 'line2']) run.choose('practice', `e-${id}`);
  const good = run.answer(true);
  assert.deepEqual(good.review, {
    itemId: 'line0', rating: 'good',
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
  const lib = library(lines(5));
  const ids = ['line0', 'line1', 'line2', 'line3', 'line4'];
  const run = driver(lib, startSetSession('s1', { themeId: null, itemIds: ids }, T0), idMaker('attempt'));
  for (const id of ids) run.choose('practice', `e-${id}`);
  const recordedBefore = lib.recorded.length;

  const miss = run.answer(false);
  assert.equal(miss.review, undefined);
  assert.equal(miss.undo, undefined);
  let round = (run.session as SetSession).round;
  assert.deepEqual(round.queue, ['line0', 'line1', 'line2', 'line3', 'line0', 'line4']);
  assert.deepEqual(round.attempts.line0, { tries: 1, hinted: true, eventId: 'attempt-1' });
  assert.equal(attemptStage(round.attempts.line0), 'second');

  run.answer(true); // line1
  run.answer(false); // line2: back after line3, line0, line4
  run.answer(true); // line3
  assert.equal(currentItemId(run.session), 'line0');
  assert.equal(run.session.hintShown, true, 'the second try shows the hint by itself');
  const again = run.answer(false);
  assert.equal(again.review?.rating, 'again');
  round = (run.session as SetSession).round;
  assert.deepEqual(round.queue, ['line0', 'line1', 'line2', 'line3', 'line0', 'line4', 'line2', 'line0']);
  assert.equal(attemptStage(round.attempts.line0), 'look');

  run.answer(true); // line4
  const hard = run.answer(true); // line2's second try
  assert.equal(hard.review?.rating, 'hard');
  assert.equal(currentItemId(run.session), 'line0', 'the look after two misses');
  assert.equal(answerAttempt(revealAnswer(run.session), lib.get('line0')!, true, run.tick(), 'speak'), null, 'a look records nothing');
  run.session = finishLook(revealAnswer(run.session), run.tick());
  run.settle();
  assert.equal((run.session as SetSession).phase, 'summary');
  // One review per item: line0 again, line1 good, line2 hard, line3 good, line4 good.
  assert.deepEqual(lib.recorded.slice(recordedBefore).map(review => [review.itemId, review.rating]), [
    ['line1', 'good'], ['line3', 'good'], ['line0', 'again'], ['line4', 'good'], ['line2', 'hard'],
  ]);
});

test('an item missed near the end of the run comes back last', () => {
  const lib = library(lines(2));
  const run = driver(lib, startSetSession('s1', { themeId: null, itemIds: ['line0', 'line1'] }, T0), idMaker('attempt'));
  run.choose('practice', 'e-0');
  run.choose('practice', 'e-1');
  run.answer(false);
  assert.deepEqual((run.session as SetSession).round.queue, ['line0', 'line1', 'line0']);
});

test('an answer waits for the reveal and is refused for a card that left the run', () => {
  const lib = library(lines(2));
  const run = driver(lib, startSetSession('s1', { themeId: null, itemIds: ['line0', 'line1'] }, T0), idMaker('attempt'));
  run.choose('practice', 'e-0');
  run.choose('practice', 'e-1');
  const session = run.session;
  assert.equal(answerAttempt(session, lib.get('line0')!, true, T0, 'speak'), null, 'its answer isn\'t showing');
  assert.equal(answerAttempt(revealAnswer(session), lib.get('line1')!, true, T0, 'speak'), null, 'not the run\'s card');
  assert.equal(answerAttempt(revealAnswer(session), { ...lib.get('line0')!, isDeleted: true }, true, T0, 'speak'), null);
});

test('a run passes over an item reviewed elsewhere since its own last review, no longer practicing, deleted or archived', () => {
  const lib = library(lines(4));
  const run = driver(lib, startSetSession('s1', { themeId: null, itemIds: ['line0', 'line1', 'line2', 'line3'] }, T0), idMaker('attempt'));
  for (const id of ['line0', 'line1', 'line2', 'line3']) run.choose('practice', `e-${id}`);
  // line0: a Got it in the sentence lesson; line1: marked as one you can say with its practice pill; line2: archived.
  lib.reviewElsewhere('line0', 'good', 'quick', run.tick());
  lib.reviewElsewhere('line1', 'easy', 'triage', run.tick());
  lib.set({ ...lib.get('line2')!, isArchived: true });
  run.settle();
  assert.equal(currentItemId(run.session), 'line3');
  assert.equal(isRunItemLive(run.session, lib.get('line0')), false);
  assert.equal(isRunItemLive(run.session, lib.get('line1')), false);
  assert.equal(isRunItemLive(run.session, undefined), false);
});

test('a run keeps an item whose own review hasn\'t reached the device yet, unless a reset came after it', () => {
  const lib = library(lines(1));
  const session = startSetSession('s1', { themeId: null, itemIds: ['line0'] }, T0);
  const revealed = revealAnswer(session);
  const step = chooseInMeet(revealed, lib.get('line0')!, 'practice', 'e-0', T0 + 1_000)!;
  // The choice is kept, but its review isn't applied on this device yet: the item still reads as new.
  const met = settleSession(finishEncoding(step.advance(revealed), T0 + 2_000), lib.get, idMaker('attempt'), T0 + 2_000);
  assert.equal(met.phase, 'round');
  assert.equal(currentItemId(met), 'line0');
  assert.equal(isRunItemLive(met, lib.get('line0')), true);
  // A reset elsewhere zeroes the count and stamps the item's clock after the choice.
  const reset = { ...lib.get('line0')!, srs: { ...SRSAlgorithm.createNew('line0', 'sentence', T0 + 3_000), lastReviewDate: T0 + 3_000 } };
  assert.equal(isRunItemLive(met, reset), false);
});

test('undoing a run\'s review goes back to its card, answer showing, the attempt as before under a new event, and takes back the return it queued', () => {
  const lib = library(lines(5));
  const ids = ['line0', 'line1', 'line2', 'line3', 'line4'];
  const run = driver(lib, startSetSession('s1', { themeId: null, itemIds: ids }, T0), idMaker('attempt'));
  for (const id of ids) run.choose('practice', `e-${id}`);
  run.answer(false); // line0 comes back after line1, line2, line3
  run.answer(true);
  run.answer(true);
  run.answer(true);
  const before = run.session as SetSession;
  const again = run.answer(false); // line0's second try: Again, and one more look
  assert.ok(again.undo);
  assert.deepEqual(again.undo, {
    sessionId: 's1', itemId: 'line0', eventId: 'attempt-1', index: 4, previous: before.round.attempts.line0, requeued: true,
  });
  const undone = applyUndoneAttempt(run.session as SetSession, again.undo, 'attempt-new', run.tick())!;
  assert.deepEqual(undone.round.queue, before.round.queue, 'the look it queued is taken back');
  assert.deepEqual(undone.round.attempts.line0, { ...before.round.attempts.line0, eventId: 'attempt-new' });
  assert.deepEqual([undone.round.index, undone.step, undone.hintShown, undone.phase], [4, 'answer', true, 'round']);
  assert.equal(applyUndoneAttempt(undone, again.undo, 'x', T0), undone, 'the same undo twice changes nothing');
  assert.equal(applyUndoneAttempt(null, again.undo, 'x', T0), null);

  // Undoing the last review from the summary goes back into the round.
  const lib2 = library(lines(1));
  const single = driver(lib2, startSetSession('s2', { themeId: null, itemIds: ['line0'] }, T0), idMaker('attempt'));
  single.choose('practice', 'e-0');
  const last = single.answer(true);
  assert.equal((single.session as SetSession).phase, 'summary');
  const reopened = applyUndoneAttempt(single.session as SetSession, last.undo!, 'attempt-9', single.tick())!;
  assert.deepEqual([reopened.phase, currentItemId(reopened), reopened.step], ['round', 'line0', 'answer']);
});

test('practice takes the due practice sentences, the most overdue first and ties by id, at most 30 a session', () => {
  const now = new Date(2026, 10, 18, 15).getTime();
  const midnight = new Date(2026, 10, 18).getTime();
  const due = (id: string, nextReview: number, lastReviewDate = midnight - DAY) =>
    sentenceItem(id, `Practicing ${id}.`, { srs: practicing(now - 9 * DAY, { nextReview, lastReviewDate }) });
  const items = [
    due('b', now - HOUR), due('a', now - HOUR), due('c', now - 3 * DAY), due('later', now + 1), due('today', now - DAY, midnight + HOUR),
    sentenceItem('got-it', 'Got it, due in the Sentences tab.', { srs: reviewed(midnight - DAY, { nextReview: now - DAY }) }),
    sentenceItem('passive', 'Kept passive.', { srs: passive(midnight - DAY, { nextReview: now - DAY }) }),
    sentenceItem('say', 'Can say it.', { srs: sayable(midnight - DAY, { nextReview: now - DAY }) }),
    vocabItem('word', 'word', { srs: practicing(now - 9 * DAY, { nextReview: now - DAY, lastReviewDate: midnight - DAY }) }),
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

test('a practice session keeps its mode, passes over sentences reviewed since it began, and sums up with its recall rate', () => {
  const now = new Date(2026, 10, 18, 15).getTime();
  const items = ['p0', 'p1', 'p2', 'p3'].map(id =>
    sentenceItem(id, `Practicing ${id}.`, { srs: practicing(now - 9 * DAY, { nextReview: now - HOUR, lastReviewDate: now - 2 * DAY, stability: 2 }) }));
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

test('a spoken Good after a long enough gap with enough stability graduates the sentence, which the summary lists', () => {
  const now = new Date(2026, 10, 18, 15).getTime();
  // In practice for weeks, stability past 21 days, last reviewed 20 days ago.
  const ready = sentenceItem('ready', 'I\'m ready when you are.', { srs: practicing(now - 60 * DAY, {
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
  const lib = library(lines(3));
  const run = driver(lib, startSetSession('s1', { themeId: null, itemIds: ['line0', 'line1', 'line2'] }, T0), idMaker('attempt'));
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
  const lib = library([sentenceItem('line0', 'A {{line}}.', { srs: practicing(T0 - 9 * DAY, { nextReview: T0 - HOUR, lastReviewDate: T0 - 2 * DAY }) })]);
  const meeting = startSetSession('s1', { themeId: null, itemIds: ['line0'] }, T0);
  const hinted = takeHint(meeting);
  assert.deepEqual([hinted.hintShown, hinted.meet, hinted.round], [true, meeting.meet, meeting.round]);
  assert.equal(takeHint(hinted), hinted);
  assert.equal(takeHint(revealAnswer(meeting)).hintShown, false, 'not once the answer shows');
  const practice = settleSession(startPracticeSession('p', ['line0'], 'speak', T0, idMaker()), lib.get, idMaker(), T0);
  assert.equal(takeHint(practice).attempts.line0.hinted, true);
});

test('a session kept from before Today took sentences only passes over its words, whatever they were doing', () => {
  const practiceDue = practicing(T0 - 9 * DAY, { nextReview: T0 - HOUR, lastReviewDate: T0 - 2 * DAY });
  const lib = library([
    vocabItem('word-new', 'crestfallen'),
    vocabItem('word-practicing', 'keep an eye on', { srs: practiceDue }),
    ...lines(1),
    sentenceItem('due', 'A practice {{line}}.', { srs: practiceDue }),
  ]);
  // A set meeting a word first, then a sentence, then a word.
  const set = driver(lib, startSetSession('old-set', { themeId: null, itemIds: ['word-new', 'line0', 'word-practicing'] }, T0), idMaker('attempt'));
  assert.equal(currentItemId(set.session), 'line0');
  set.choose('passive', 'e-0');
  assert.equal((set.session as SetSession).phase, 'summary');
  assert.deepEqual(summarizeSet(set.session as SetSession), { sayable: 0, passive: 1, practicing: 0, firstTry: 0, rounded: 0 });
  // A set whose round holds a word chosen for practice before.
  const round: SetSession = {
    ...startSetSession('old-round', { themeId: null, itemIds: ['word-practicing', 'due'] }, T0),
    phase: 'round',
    meet: {
      index: 2,
      choices: {
        'word-practicing': { choice: 'practice', eventId: 'e-w', at: T0 - DAY, totalReviews: 1 },
        due: { choice: 'practice', eventId: 'e-d', at: T0 - DAY, totalReviews: 1 },
      },
    },
    round: {
      queue: ['word-practicing', 'due'], index: 0,
      attempts: { 'word-practicing': { tries: 0, hinted: false, eventId: 'a-w' }, due: { tries: 0, hinted: false, eventId: 'a-d' } },
    },
  };
  assert.equal(currentItemId(settleSession(round, lib.get, idMaker(), T0)), 'due');
  // A practice session over a word and a sentence.
  const practice = settleSession(startPracticeSession('old-practice', ['word-practicing', 'due'], 'speak', T0, idMaker()), lib.get, idMaker(), T0);
  assert.equal(currentItemId(practice), 'due');
  // Nothing but words: the set goes to its summary having done nothing, and the practice session is over.
  const words = settleSession(startSetSession('words', { themeId: null, itemIds: ['word-new', 'word-practicing'] }, T0), lib.get, idMaker(), T0);
  assert.deepEqual([words.phase, Object.keys(words.meet.choices).length], ['summary', 0]);
  assert.equal(isSessionOver(settleSession(startPracticeSession('w', ['word-practicing'], 'quiet', T0, idMaker()), lib.get, idMaker(), T0)), true);
});
