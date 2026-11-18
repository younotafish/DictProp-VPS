import assert from 'node:assert/strict';
import test from 'node:test';
import type { SentenceData, StoredItem } from '../../types.ts';
import { THEME_DOMAINS } from '../../server/src/shared/item-themes.ts';
import { loopCard } from '../../services/learningLoop/cues.ts';
import type { PlannedSet, ThemePlan } from '../../services/learningLoop/planner.ts';
import {
  PRACTICE_SESSION_CAP,
  answerAttempt,
  chooseInMeet,
  finishEncoding,
  revealAnswer,
  settleSession,
  startPracticeSession,
  startSetSession,
  takeHint,
  type LoopSession,
  type MeetChoice,
  type SetSession,
} from '../../services/learningLoop/session.ts';
import { localDayStart } from '../../services/learningLoop/standing.ts';
import { DAILY_SET_GOAL, PRACTICE_FIRST_AT } from '../../services/learningLoop/stats.ts';
import {
  MEET_CHOICES,
  UNSORTED,
  answerSpeech,
  attemptLabel,
  cardFooter,
  formatPlanDate,
  itemText,
  meetReceipt,
  pickRestore,
  planCardModel,
  practiceReturn,
  recordNeedsWrite,
  resumeLabel,
  runCaptions,
  runReceipt,
  sessionHasProgress,
  summaryActions,
  summaryHeadline,
  themeLabel,
  themesBrowserModel,
  todayHandlers,
  todayMode,
  upcomingSentences,
  withLoopMode,
  type PlanCardInput,
} from '../../views/today/todayModel.ts';
import { DAY, HOUR, practicing, sentenceItem, vocabItem } from '../support/loop-fixtures.ts';

const NOW = new Date(2026, 10, 18, 15, 0).getTime();
// Two themes from different domains, read from the taxonomy so a renamed scene doesn't break the tests.
const FIRST = THEME_DOMAINS[0].themes[0];
const SECOND = THEME_DOMAINS[0].themes[1];
const OTHER = THEME_DOMAINS[2].themes[0];

let ids = 0;
const nextId = () => `id-${ids++}`;

const withStyle = (item: StoredItem, style: SentenceData['preferredSpeechStyle']): StoredItem =>
  ({ ...item, data: { ...item.data, preferredSpeechStyle: style } } as StoredItem);

const WORDS = ['a', 'b', 'c'].map(id => vocabItem(id, `word-${id}`));
const byId = (items: readonly StoredItem[]) => {
  const map = new Map(items.map(item => [item.data.id, item]));
  return (id: string) => map.get(id);
};
const getWord = byId(WORDS);

/** The set over a, b and c with the given choices made in order, each item revealed first, practice said twice. */
function setAfter(choices: readonly MeetChoice[]): SetSession {
  let session = startSetSession('s', { themeId: FIRST.id, itemIds: ['a', 'b', 'c'] }, NOW);
  for (const [index, choice] of choices.entries()) {
    session = revealAnswer(session);
    const step = chooseInMeet(session, WORDS[index], choice, nextId(), NOW);
    assert.ok(step, `${choice} on ${WORDS[index].data.id}`);
    session = step.advance(session);
    if (choice === 'practice') session = finishEncoding(session, NOW);
  }
  return settleSession(session, getWord, nextId, NOW);
}

/** `session` answered on its run's card: revealed, then Not yet or Got it. */
function answered<S extends LoopSession>(session: S, gotIt: boolean, getItem = getWord): S {
  const revealed = revealAnswer(session);
  const id = revealed.kind === 'set' ? revealed.round.queue[revealed.round.index] : revealed.queue[revealed.index];
  const step = answerAttempt(revealed, getItem(id)!, gotIt, NOW, 'speak');
  assert.ok(step, `an answer on ${id}`);
  return settleSession(step.advance(revealed), getItem, nextId, NOW);
}

test('a theme is named by the taxonomy\'s emoji and title; none, or one this build doesn\'t know, is Unsorted', () => {
  assert.deepEqual(themeLabel(FIRST.id), { emoji: FIRST.emoji, title: FIRST.title });
  assert.deepEqual(themeLabel(null), UNSORTED);
  assert.deepEqual(themeLabel('retired-scene'), UNSORTED);
  assert.equal(UNSORTED.title, 'Unsorted');
});

test('Today shows one mode at a time, a session as its kind', () => {
  const set = startSetSession('s', { themeId: null, itemIds: ['a'] }, NOW);
  const practice = startPracticeSession('p', ['x'], 'speak', NOW, nextId);
  assert.equal(todayMode('plan', set), 'plan', 'a session kept behind the plan');
  assert.equal(todayMode('session', set), 'set');
  assert.equal(todayMode('session', practice), 'practice');
  assert.equal(todayMode('session', null), 'plan');
  assert.equal(todayMode('themes', null), 'themes');
  assert.equal(todayMode('classic', practice), 'classic');
});

test('Today listens for its keys on the plan and in a session and for Esc in the themes browser and a session, never over Card review', () => {
  assert.deepEqual(todayHandlers('plan', false, false), { keys: true, escape: false }, 'Esc on the plan is the app\'s');
  assert.deepEqual(todayHandlers('plan', true, false), { keys: true, escape: false });
  assert.deepEqual(todayHandlers('session', true, false), { keys: true, escape: true });
  assert.deepEqual(todayHandlers('session', false, false), { keys: false, escape: false }, 'nothing to end');
  assert.deepEqual(todayHandlers('themes', false, false), { keys: false, escape: true });
  assert.deepEqual(todayHandlers('classic', true, false), { keys: false, escape: false }, 'Card review has classic Study\'s own');
  for (const screen of ['plan', 'session', 'themes', 'classic'] as const) {
    assert.deepEqual(todayHandlers(screen, true, true), { keys: false, escape: false }, `${screen} under the card view`);
  }
});

test('the plan\'s date line names the weekday, the month and the day', () => {
  assert.equal(formatPlanDate(NOW), 'Wednesday, November 18');
});

test('Today takes up the newer of its own session and classic Study\'s, its own on a tie, or neither', () => {
  assert.equal(pickRestore(null, null), null);
  assert.equal(pickRestore(NOW, null), 'loop');
  assert.equal(pickRestore(null, NOW), 'classic');
  assert.equal(pickRestore(NOW, NOW - 1), 'loop');
  assert.equal(pickRestore(NOW - 1, NOW), 'classic');
  assert.equal(pickRestore(NOW, NOW), 'loop');
});

const NEXT: PlannedSet = { themeId: FIRST.id, itemIds: Array.from({ length: DAILY_SET_GOAL }, (_, i) => `n${i}`) };
const planCard = (input: Partial<PlanCardInput> & { due?: number; practicing?: number } = {}) => {
  const { due = 0, practicing: inPractice = due, ...rest } = input;
  return planCardModel({
    progress: { practiceDue: due, practicing: inPractice }, todayCount: 0, historyLoaded: true, next: NEXT, themes: 'ready',
    sortingPercent: null, ...rest,
  });
};

test('the practice row counts what is due, says Practiced once it is all done, and says when nothing is in practice yet', () => {
  assert.deepEqual(planCard({ due: 7 }).practice, { kind: 'due', due: 7 });
  assert.deepEqual(planCard({ due: 0, practicing: 12 }).practice, { kind: 'done' });
  assert.deepEqual(planCard({ due: 0, practicing: 0 }).practice, { kind: 'empty' });
});

test('the set row names the next set, the goal met, practice first, or why there is no set', () => {
  assert.deepEqual(planCard().set, { kind: 'set', theme: { emoji: FIRST.emoji, title: FIRST.title }, size: DAILY_SET_GOAL });
  assert.deepEqual(planCard({ next: { themeId: null, itemIds: ['x'] } }).set, { kind: 'set', theme: UNSORTED, size: 1 });
  assert.deepEqual(planCard({ todayCount: DAILY_SET_GOAL }).set, { kind: 'met', count: DAILY_SET_GOAL });
  assert.deepEqual(planCard({ todayCount: DAILY_SET_GOAL + 4 }).set, { kind: 'met', count: DAILY_SET_GOAL + 4 });
  assert.equal(planCard({ todayCount: DAILY_SET_GOAL - 1 }).set.kind, 'set', 'one short of the goal');
  assert.equal(planCard({ todayCount: DAILY_SET_GOAL, historyLoaded: false }).set.kind, 'set', 'met only once the history is in');
  assert.deepEqual(planCard({ due: PRACTICE_FIRST_AT }).set, { kind: 'practice-first', due: PRACTICE_FIRST_AT });
  assert.equal(planCard({ due: PRACTICE_FIRST_AT - 1 }).set.kind, 'set');
  assert.deepEqual(planCard({ next: null, themes: 'loading' }).set, { kind: 'loading' });
  assert.deepEqual(planCard({ next: null, themes: 'offline' }).set, { kind: 'offline' });
  assert.deepEqual(planCard({ next: null, sortingPercent: 42 }).set, { kind: 'sorting', percent: 42 });
  assert.deepEqual(planCard({ next: null }).set, { kind: 'empty' });
  assert.equal(planCard({ themes: 'loading' }).set.kind, 'set', 'a kept theme map plans while the server answers');
});

test('the one button offers practice while any is due, then a set until the goal is met, then Done with Another set', () => {
  assert.deepEqual(planCard({ due: 3 }).action, { kind: 'practice', count: 3 });
  assert.deepEqual(planCard({ due: 45 }).action, { kind: 'practice', count: PRACTICE_SESSION_CAP });
  assert.deepEqual(planCard().action, { kind: 'set' });
  assert.equal(planCard().another, null);
  assert.deepEqual(planCard({ next: null }).action, { kind: 'no-set' });
  const done = planCard({ todayCount: DAILY_SET_GOAL });
  assert.deepEqual(done.action, { kind: 'done' });
  assert.deepEqual(done.another, { set: NEXT, theme: { emoji: FIRST.emoji, title: FIRST.title } });
  assert.equal(planCard({ todayCount: DAILY_SET_GOAL, next: null }).another, null, 'no set left to offer');
  assert.equal(planCard({ todayCount: DAILY_SET_GOAL, due: 2 }).another, null, 'practice comes first');
});

test('a practice item comes back tomorrow at the earliest, and later ones read in calendar days', () => {
  assert.equal(practiceReturn(NOW + 10 * 60_000, NOW), 'tomorrow', 'due again today waits for tomorrow');
  assert.equal(practiceReturn(localDayStart(NOW, 1) + 20 * HOUR, NOW), 'tomorrow');
  assert.equal(practiceReturn(localDayStart(NOW, 2) + HOUR, NOW), 'in 2d');
  assert.equal(practiceReturn(NOW + 6 * DAY, NOW), 'in 6d');
  assert.equal(practiceReturn(localDayStart(NOW, 31), NOW), 'in 31d');
});

test('the run\'s captions say where Not yet and Got it lead on each try', () => {
  const next = { again: NOW + 10 * 60_000, hard: localDayStart(NOW, 2) + HOUR, good: NOW + 4 * DAY };
  assert.deepEqual(runCaptions('first', false, next, false, NOW), { notYet: 'again soon', gotIt: 'in 4d' });
  assert.deepEqual(runCaptions('first', false, next, true, NOW), { notYet: 'again soon', gotIt: 'can say it' });
  assert.deepEqual(runCaptions('first', true, next, true, NOW), { notYet: 'again soon', gotIt: 'in 2d' }, 'with the hint, Hard');
  assert.deepEqual(runCaptions('second', true, next, true, NOW), { notYet: 'tomorrow', gotIt: 'in 2d' });
});

test('the Meet\'s choices are Practice, Passive and Can say it, each with its colour, and a choice\'s receipt names it', () => {
  assert.deepEqual(MEET_CHOICES.map(({ label, tone }) => `${label}:${tone}`), ['Practice:amber', 'Passive:slate', 'Can say it:emerald']);
  assert.deepEqual(meetReceipt('crestfallen', 'say'), { word: 'crestfallen', label: 'Can say it', tone: 'emerald' });
  assert.deepEqual(meetReceipt('crestfallen', 'practice'), { word: 'crestfallen', label: 'Practice', tone: 'amber' });
});

test('a run\'s receipt says Got it, Got it with a hint or on the second try, or Not yet, with where the item goes', () => {
  assert.deepEqual(runReceipt('run', 'good', 1, 'next in 4d'), { word: 'run', label: 'Got it', tone: 'emerald', detail: 'next in 4d' });
  assert.deepEqual(runReceipt('run', 'hard', 1, 'back tomorrow'), { word: 'run', label: 'Got it with a hint', tone: 'amber', detail: 'back tomorrow' });
  assert.deepEqual(runReceipt('run', 'hard', 2, 'back tomorrow'), { word: 'run', label: 'Got it on the second try', tone: 'amber', detail: 'back tomorrow' });
  assert.deepEqual(runReceipt('run', 'again', 2, 'back tomorrow'), { word: 'run', label: 'Not yet', tone: 'rose', detail: 'back tomorrow' });
});

test('an item reads as its word, or its sentence without markers', () => {
  assert.equal(itemText(vocabItem('v', ' crestfallen ')), 'crestfallen');
  assert.equal(itemText(sentenceItem('s', 'Keep {{an eye on}} it. ')), 'Keep an eye on it.');
  assert.equal(itemText({ type: 'phrase', data: { id: 'p', query: 'x' }, srs: WORDS[0].srs, savedAt: 0 } as unknown as StoredItem), '');
});

test('the footer follows the card: Hint and Reveal on a cue, the Meet\'s choices, saying it twice, a run\'s answers and the last look', () => {
  const meeting = startSetSession('s', { themeId: FIRST.id, itemIds: ['a', 'b', 'c'] }, NOW);
  assert.equal(cardFooter(meeting), 'cue');
  assert.equal(cardFooter(revealAnswer(meeting)), 'meet');
  const step = chooseInMeet(revealAnswer(meeting), WORDS[0], 'practice', nextId(), NOW);
  assert.equal(cardFooter(step!.advance(revealAnswer(meeting))), 'encode');

  const round = setAfter(['practice', 'passive', 'say']);
  assert.equal(round.phase, 'round');
  assert.equal(cardFooter(round), 'cue');
  assert.equal(cardFooter(revealAnswer(round)), 'run');
  assert.equal(attemptLabel(round), null);
  const second = answered(round, false);
  assert.equal(cardFooter(revealAnswer(second)), 'run');
  assert.equal(attemptLabel(second), 'Second try');
  assert.equal(second.hintShown, true, 'the second try shows the hint by itself');
  const look = answered(second, false);
  assert.equal(cardFooter(look), 'cue');
  assert.equal(cardFooter(revealAnswer(look)), 'look');
  assert.equal(attemptLabel(look), 'One more look');
  assert.equal(attemptLabel(revealAnswer(meeting)), null, 'the Meet has no tries');

  const summary = setAfter(['passive', 'say', 'passive']);
  assert.equal(summary.phase, 'summary');
  assert.equal(cardFooter(summary), null);
});

test('a session has progress once it has a Meet choice or a run answer, a first Not yet included', () => {
  assert.equal(sessionHasProgress(startSetSession('s', { themeId: null, itemIds: ['a'] }, NOW)), false);
  assert.equal(sessionHasProgress(setAfter(['passive'])), true);
  const items = ['x', 'y'].map(id => vocabItem(id, id, { srs: practicing(NOW - 3 * DAY, { lastReviewDate: NOW - 2 * DAY }) }));
  const practice = startPracticeSession('p', ['x', 'y'], 'speak', NOW, nextId);
  assert.equal(sessionHasProgress(practice), false);
  assert.equal(sessionHasProgress(revealAnswer(practice)), false, 'a reveal does nothing');
  assert.equal(sessionHasProgress(answered(practice, false, byId(items))), true);
});

test('the mode chip switches a practice session\'s mode, which its record keeps; a set records in the current mode anyway', () => {
  const practice = startPracticeSession('p', ['x'], 'speak', NOW, nextId);
  const quiet = withLoopMode(practice, 'quiet');
  assert.equal(quiet.mode, 'quiet');
  assert.equal(withLoopMode(practice, 'speak'), practice, 'unchanged');
  const set = setAfter([]);
  assert.equal(withLoopMode(set, 'quiet'), set);

  assert.equal(recordNeedsWrite(null, practice), true);
  assert.equal(recordNeedsWrite(practice, revealAnswer(practice)), false, 'a reveal isn\'t kept');
  assert.equal(recordNeedsWrite(practice, takeHint(practice)), true, 'a hint is kept with the attempt');
  assert.equal(recordNeedsWrite(practice, quiet), true, 'and so is a mode change');
  assert.equal(recordNeedsWrite(set, setAfter(['say'])), true);
});

test('a word\'s answer is said as the word; a sentence\'s plays its text in the voice it was last heard in', () => {
  const word = vocabItem('w', 'crestfallen', { chinese: '垂头丧气', definition: 'sad' });
  assert.deepEqual(answerSpeech(word, loopCard(word, 'speak')), { kind: 'word', text: 'crestfallen' });
  const plain = sentenceItem('s', 'Keep {{an eye on}} it.', { sourceWord: 'keep an eye on' });
  assert.deepEqual(answerSpeech(plain, loopCard(plain, 'speak')), { kind: 'sentence', text: 'Keep an eye on it.' });
  const casual = withStyle(plain, 'casual');
  assert.deepEqual(answerSpeech(casual, loopCard(casual, 'speak')), { kind: 'sentence', text: 'Keep an eye on it.', style: 'casual' });
});

test('the sentences coming next, which their clips are fetched for, are the items still to meet or the run\'s next cards', () => {
  const items = [
    vocabItem('w1', 'one'),
    sentenceItem('s1', 'First {{line}}.'),
    withStyle(sentenceItem('s2', 'Second line.'), 'casual'),
    vocabItem('w2', 'two'),
    sentenceItem('s3', 'Third line.'),
  ];
  const getItem = byId(items);
  const set = startSetSession('s', { themeId: null, itemIds: items.map(item => item.data.id) }, NOW);
  assert.deepEqual(upcomingSentences(set, getItem), [
    { kind: 'sentence', text: 'First line.' },
    { kind: 'sentence', text: 'Second line.', style: 'casual' },
  ]);
  assert.deepEqual(upcomingSentences(set, getItem, 3).map(speech => speech.text), ['First line.', 'Second line.', 'Third line.']);
  assert.deepEqual(upcomingSentences(set, id => (id === 's1' ? undefined : getItem(id)), 1), [
    { kind: 'sentence', text: 'Second line.', style: 'casual' },
  ], 'an item gone meanwhile is passed over');

  const practiceItems = ['s1', 's3', 'w1'].map(id => {
    const item = getItem(id)!;
    return { ...item, srs: { ...item.srs, ...practicing(NOW - 3 * DAY, { lastReviewDate: NOW - 2 * DAY }) } };
  });
  const practice = startPracticeSession('p', ['w1', 's1', 's1', 's3'], 'speak', NOW, nextId);
  assert.deepEqual(upcomingSentences(practice, byId(practiceItems)).map(speech => speech.text), ['First line.', 'Third line.'], 'each once');
});

test('a summary\'s buttons put more practice first while some is due, then the next set while the goal is open, then Done', () => {
  const theme = { emoji: FIRST.emoji, title: FIRST.title };
  assert.deepEqual(summaryActions('practice', 5, 0, NEXT), [{ kind: 'practice', count: 5 }, { kind: 'done' }]);
  assert.deepEqual(summaryActions('practice', 50, 0, NEXT)[0], { kind: 'practice', count: PRACTICE_SESSION_CAP });
  assert.deepEqual(summaryActions('practice', 0, 0, NEXT), [{ kind: 'set', set: NEXT, theme, label: 'Start a set' }, { kind: 'done' }]);
  assert.deepEqual(summaryActions('set', 0, DAILY_SET_GOAL - 1, NEXT), [{ kind: 'set', set: NEXT, theme, label: 'Next set' }, { kind: 'done' }]);
  assert.deepEqual(summaryActions('set', 0, DAILY_SET_GOAL, NEXT), [{ kind: 'done' }, { kind: 'set', set: NEXT, theme, label: 'Next set' }]);
  assert.equal(summaryActions('set', 3, 0, NEXT)[0].kind, 'set', 'a set\'s summary offers the next set, practice waits for the plan');
  assert.deepEqual(summaryActions('set', 0, 0, null), [{ kind: 'done' }]);
  assert.deepEqual(summaryActions('practice', 0, 0, null), [{ kind: 'done' }]);
});

const themePlan = (themeId: string | null, fields: Partial<ThemePlan> = {}): ThemePlan => ({
  themeId, newCount: 0, practicingCount: 0, sayableCount: 0, total: 0, recentCount: 0, nextSet: [], ...fields,
});

test('the themes browser lists the domains and themes that hold items in the taxonomy\'s order, then Unsorted', () => {
  const plan = {
    themes: new Map([
      [OTHER.id, themePlan(OTHER.id, { newCount: 2, total: 5, sayableCount: 3, nextSet: ['o1', 'o2'] })],
      [SECOND.id, themePlan(SECOND.id, { practicingCount: 4, total: 4 })],
      [FIRST.id, themePlan(FIRST.id, { newCount: 30, total: 31, nextSet: ['f1'] })],
    ]),
    unsorted: themePlan(null, { newCount: 1, total: 1, nextSet: ['u1'] }),
  };
  const model = themesBrowserModel(plan);
  assert.deepEqual(model.domains.map(domain => domain.id), [THEME_DOMAINS[0].id, THEME_DOMAINS[2].id]);
  assert.deepEqual(model.domains[0].themes.map(row => row.themeId), [FIRST.id, SECOND.id]);
  assert.deepEqual(model.domains[0].themes[0], {
    themeId: FIRST.id, theme: { emoji: FIRST.emoji, title: FIRST.title }, newCount: 30, practicingCount: 0, sayableCount: 0, total: 31,
    set: { themeId: FIRST.id, itemIds: ['f1'] },
  });
  assert.equal(model.domains[0].themes[1].set, null, 'no new items: nothing to start');
  assert.deepEqual(model.unsorted?.set, { themeId: null, itemIds: ['u1'] });
  assert.deepEqual(model.unsorted?.theme, UNSORTED);
  assert.equal(themesBrowserModel({ themes: new Map(), unsorted: themePlan(null) }).unsorted, null);
  assert.deepEqual(themesBrowserModel({ themes: new Map(), unsorted: themePlan(null) }).domains, []);
});

test('a summary\'s headline says what was met or practiced, and how far a session ended early got', () => {
  assert.equal(summaryHeadline(setAfter(['passive', 'say', 'passive']), false), 'Set complete · 3 met');
  assert.equal(summaryHeadline(setAfter(['passive']), true), 'Ended early · 1 of 3 met');
  const items = ['x', 'y'].map(id => vocabItem(id, id, { srs: practicing(NOW - 3 * DAY, { lastReviewDate: NOW - 2 * DAY }) }));
  const practice = startPracticeSession('p', ['x', 'y'], 'speak', NOW, nextId);
  const one = answered(practice, true, byId(items));
  assert.equal(summaryHeadline(one, true), 'Ended early · 1 of 2 practiced');
  assert.equal(summaryHeadline(answered(one, true, byId(items)), false), 'Practice complete · 2 items');
  const single = answered(startPracticeSession('q', ['x'], 'speak', NOW, nextId), true, byId(items));
  assert.equal(summaryHeadline(single, false), 'Practice complete · 1 item');
});

test('the plan\'s Resume row names the kept session and where it stands', () => {
  assert.equal(resumeLabel(startPracticeSession('p', ['x', 'y'], 'speak', NOW, nextId), 1, 2), 'Resume practice · 1 of 2');
  assert.equal(resumeLabel(setAfter([]), 1, 3), `Resume set: ${FIRST.emoji} ${FIRST.title} · 1 of 3`);
  assert.equal(resumeLabel(startSetSession('u', { themeId: null, itemIds: ['a'] }, NOW), 1, 1), `Resume set: ${UNSORTED.emoji} Unsorted · 1 of 1`);
});
