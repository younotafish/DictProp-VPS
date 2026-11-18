import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { StoredItem } from '../../types.ts';
import { HttpError } from '../../services/http.ts';
import { updateAfterRating } from '../../services/fsrsScheduler.ts';
import { SRSAlgorithm } from '../../services/srsAlgorithm.ts';
import { isPracticeDue } from '../../services/learningLoop/standing.ts';
import { MEET_RATINGS } from '../../services/learningLoop/session.ts';
import {
  PRACTICE_PRESS_WINDOW_MS, acceptPracticePress, createPracticePress, practiceChange, practicePillLabel, practicePillText,
  practiceToggleFor, practiceUndoFailureText, undoPracticeChange, type PracticeToggle,
} from '../../views/detail/practiceToggle.ts';
import { PracticePill, PracticeUndoFailure } from '../../views/detail/PracticePill.tsx';
import { usePracticeToggle } from '../../views/detail/usePracticeToggle.ts';
import { DAY, practicing, reviewed, sayable, sentenceItem, vocabItem } from '../support/loop-fixtures.ts';

// The practice pill of the card view and the sentence lesson (views/detail/practiceToggle.ts, usePracticeToggle.ts and
// PracticePill.tsx): where it shows, what a press records, its undo and what a failed undo says, and how it looks.

const NOW = Date.UTC(2026, 10, 18, 9);
const braise = vocabItem('braise-1', 'braise');
const out: PracticeToggle = { itemId: 'braise-1', practicing: false, name: 'braise', noun: 'card' };
const inPractice: PracticeToggle = { ...out, practicing: true };

/** Runs a hook once, in a server render, and hands back what it returned; refs and callbacks keep working after. */
function capture<T>(useHook: () => T): T {
  let result: T | undefined;
  const Probe = () => { result = useHook(); return null; };
  renderToStaticMarkup(createElement(Probe));
  return result as T;
}

/** Lets every settled promise's callbacks run. */
const settle = () => new Promise<void>(resolve => setTimeout(resolve, 0));

test('the pill shows on what Today\'s loop takes: a live word card, and the learner\'s own sentence with a translation', () => {
  assert.deepEqual(practiceToggleFor(braise), out);
  // A sentence is quoted as it reads, without its studied-item and uncommon-word markers, on one line.
  const sentence = sentenceItem('s-1', 'She finally {{came clean}}\nabout the [[ledger]].');
  assert.deepEqual(practiceToggleFor(sentence), {
    itemId: 's-1', practicing: false, name: 'She finally came clean about the ledger.', noun: 'sentence',
  });
});

test('the pill is pressed while the item is in practice, and only then: not for one you can say, reviewed or new', () => {
  const standing = (srs: Partial<StoredItem['srs']>) => practiceToggleFor(vocabItem('braise-1', 'braise', { srs }))?.practicing;
  assert.equal(standing(practicing(NOW - DAY)), true);
  assert.equal(standing(sayable(NOW - DAY)), false, 'one you can say can be added back');
  assert.equal(standing(reviewed(NOW - DAY)), false);
  assert.equal(standing({}), false);
  assert.equal(practiceToggleFor(sentenceItem('s-1', 'Text.', { srs: practicing(NOW) }))?.practicing, true);
});

test('no pill where practice could never bring the item back, nor without a library copy', () => {
  const phrase = { type: 'phrase', data: { id: 'p-1', query: 'come clean', vocabs: [] }, savedAt: 0, srs: braise.srs } as unknown as StoredItem;
  const hidden: Record<string, StoredItem | undefined> = {
    'an unsaved card or an example\'s preview, which has no library copy': undefined,
    'an archived card': vocabItem('a-1', 'braise', { isArchived: true }),
    'a deleted card': vocabItem('d-1', 'braise', { isDeleted: true }),
    'a card with no word': vocabItem('w-1', '  '),
    'a phrase': phrase,
    'a Real Life line': sentenceItem('real-life-sentence:cafe:order:01', 'A flat white, please.', {
      catalogKind: 'real-life', catalogSentenceId: 'cafe:order:01', catalogCollectionId: 'cafe',
    }),
    'an essay line': sentenceItem('essay-sentence:e1:3', 'It was the best of times.', {
      catalogKind: 'essay', catalogSentenceId: 'e1:3', catalogCollectionId: 'e1',
    }),
    'a sentence the Mac hasn\'t translated yet': sentenceItem('s-2', 'She came clean.', { translation: null }),
    'a sentence with a blank translation': sentenceItem('s-3', 'She came clean.', { translation: '  ' }),
  };
  for (const [what, item] of Object.entries(hidden)) assert.equal(practiceToggleFor(item), null, what);
});

test('a press records what the Meet records for the same choice: Practice adds with Again, Can say it takes out with Easy', () => {
  assert.equal(practiceChange(out).rating, MEET_RATINGS.practice);
  assert.equal(practiceChange(inPractice).rating, MEET_RATINGS.say);
  // The undo offer leads with the new standing, so a phone's narrow pill cuts only the name.
  assert.equal(practiceChange(out).undoMessage, 'Practicing “braise”');
  assert.equal(practiceChange(inPractice).undoMessage, 'Can say “braise”');
});

test('through the real scheduler a press adds a new card to practice for tomorrow, the next marks it as one you can say', () => {
  const press = (item: StoredItem, at: number): StoredItem => {
    const toggle = practiceToggleFor(item)!;
    const srs = updateAfterRating(SRSAlgorithm.ensure(item.srs, item.data.id, item.type), practiceChange(toggle).rating, at, 'triage');
    return { ...item, srs };
  };
  const added = press(braise, NOW);
  assert.equal(practiceToggleFor(added)?.practicing, true);
  assert.equal(added.srs.practiceSince, NOW);
  // Joined today, it waits for tomorrow's practice (services/learningLoop/standing.ts).
  assert.equal(isPracticeDue(added, NOW + 60_000), false);
  assert.equal(isPracticeDue(added, NOW + DAY), true);

  const takenOut = press(added, NOW + DAY);
  assert.equal(practiceToggleFor(takenOut)?.practicing, false);
  assert.equal(takenOut.srs.practiceSince, undefined);
  assert.equal(takenOut.srs.sayableAt, NOW + DAY);
  assert.equal(practiceToggleFor(press(takenOut, NOW + 2 * DAY))?.practicing, true, 'and one you can say can be added back');
});

test('the pill offers "+ Practice", shows "Practicing" while in practice, and its name says what a press does', () => {
  assert.equal(practicePillText(false), '+ Practice');
  assert.equal(practicePillText(true), 'Practicing');
  assert.equal(practicePillLabel(out), 'Add “braise” to practice');
  assert.equal(practicePillLabel(inPractice), 'Stop practicing “braise”: marks it as one you can say');
  // The name holds the words the pill shows, so a voice command that says them presses it (WCAG 2.5.3).
  assert.ok(practicePillLabel(out).toLowerCase().includes('practice'));
  assert.ok(practicePillLabel(inPractice).toLowerCase().includes('practicing'));
});

test('the same item\'s second press within 0.7 s is ignored; another item\'s, or one after that, counts', () => {
  assert.equal(PRACTICE_PRESS_WINDOW_MS, 700, 'acceptDestructive\'s window, as for Delete, Archive and Reset');
  assert.equal(acceptPracticePress(null, 'a', 0), true);
  const last = { id: 'a', at: 10_000 };
  assert.equal(acceptPracticePress(last, 'a', 10_699), false);
  assert.equal(acceptPracticePress(last, 'a', 10_700), true);
  assert.equal(acceptPracticePress(last, 'b', 10_001), true);
});

const conflict = () => ({ error: new HttpError('Undo review failed (409): superseded', 409, 'Review is no longer the latest change for this item') });

test('a failed undo says why, as Study does, but never to try again: the undo offer has closed by then', () => {
  assert.equal(practiceUndoFailureText(conflict(), true, 'card'), 'This card has changed since, so the change can’t be undone.');
  assert.equal(practiceUndoFailureText(conflict(), false, 'sentence'), 'This sentence has changed since, so the change can’t be undone.');
  assert.equal(practiceUndoFailureText('waiting', true, 'card'), 'The change is still syncing, so it can’t be undone.');
  assert.equal(practiceUndoFailureText('waiting', false, 'card'), 'You’re offline, so the change can’t be undone.');
  assert.equal(practiceUndoFailureText({ error: new TypeError('Failed to fetch') }, false, 'card'), 'You’re offline, so the change can’t be undone.');
  assert.equal(practiceUndoFailureText({ error: new TypeError('Failed to fetch') }, true, 'card'), 'The change could not be undone.');
  assert.equal(practiceUndoFailureText({ error: new HttpError('Undo review failed (404)', 404, 'Review event not found') }, true, 'card'), 'The change could not be undone.');
});

test('taking a press back resolves to nothing once undone, or to the reason it wasn\'t, and never rejects', async () => {
  const asked: string[] = [];
  const undo = (result: boolean | Error) => async (eventId: string) => {
    asked.push(eventId);
    if (result instanceof Error) throw result;
    return result;
  };
  assert.equal(await undoPracticeChange(undo(true), 'event-1', 'card', () => true), null);
  assert.equal(await undoPracticeChange(undo(false), 'event-2', 'card', () => true), 'The change is still syncing, so it can’t be undone.');
  assert.equal(await undoPracticeChange(undo(false), 'event-3', 'card', () => false), 'You’re offline, so the change can’t be undone.');
  assert.equal(await undoPracticeChange(undo(conflict().error), 'event-4', 'sentence', () => true), 'This sentence has changed since, so the change can’t be undone.');
  assert.deepEqual(asked, ['event-1', 'event-2', 'event-3', 'event-4']);
});

/** A press over fakes that note what it does, with a clock, ids, the connection and the undo's answer to set. */
function pressHarness(initial: PracticeToggle | null) {
  const done: string[] = [];
  const undos: (() => void)[] = [];
  const failures: string[] = [];
  const state = { toggle: initial, clock: 50_000, online: true, answer: (): Promise<boolean> => Promise.resolve(true) };
  let ids = 0;
  const press = createPracticePress({
    toggle: () => state.toggle,
    record: (itemId, rating, context) => { done.push(`record ${itemId} ${rating} ${JSON.stringify(context)}`); },
    undoReview: eventId => { done.push(`undo ${eventId}`); return state.answer(); },
    offerUndo: (message, onUndo) => { done.push(`offer ${message}`); undos.push(onUndo); },
    showUndoFailure: message => { failures.push(message); },
    now: () => state.clock,
    createId: () => `event-${++ids}`,
    isOnline: () => state.online,
  });
  return { press, done, undos, failures, state };
}

test('a press records a triage review under a new event id, with no session id, and offers to take it back', () => {
  const { press, done, state } = pressHarness(out);
  press();
  press(); // the second tap of a double tap
  assert.deepEqual(done, [
    'record braise-1 again {"taskType":"triage","eventId":"event-1"}',
    'offer Practicing “braise”',
  ], 'a set: session id would count it toward the day\'s goal');

  // The review landed: the pill shows the card in practice, and a press after the window takes it out.
  state.toggle = inPractice;
  state.clock += PRACTICE_PRESS_WINDOW_MS;
  press();
  assert.deepEqual(done.slice(2), ['record braise-1 easy {"taskType":"triage","eventId":"event-2"}', 'offer Can say “braise”']);
});

test('another item\'s press counts at once, and a hidden pill\'s press does nothing', () => {
  const { press, done, state } = pressHarness(out);
  press();
  state.toggle = { itemId: 'gauche-1', practicing: false, name: 'gauche', noun: 'card' };
  press();
  assert.deepEqual(done.filter(line => line.startsWith('record')).map(line => line.split(' ')[1]), ['braise-1', 'gauche-1']);

  const hidden = pressHarness(null);
  hidden.press();
  assert.deepEqual(hidden.done, []);
});

test('Undo takes back the press\'s own review by its event id, and a failure says why in words', async () => {
  const { press, done, undos, failures, state } = pressHarness(out);
  press();
  undos[0]();
  await settle();
  assert.deepEqual(done.slice(-1), ['undo event-1']);
  assert.deepEqual(failures, [], 'undone: nothing to say');

  state.clock += PRACTICE_PRESS_WINDOW_MS;
  press();
  state.answer = () => Promise.resolve(false);
  undos[1]();
  await settle();
  state.online = false;
  undos[1]();
  await settle();
  state.answer = () => Promise.reject(conflict().error);
  undos[1]();
  await settle();
  assert.deepEqual(failures, [
    'The change is still syncing, so it can’t be undone.',
    'You’re offline, so the change can’t be undone.',
    'This card has changed since, so the change can’t be undone.',
  ]);
});

test('while an item\'s undo is on its way a press on it waits, since it would make the server refuse that undo', async () => {
  const { press, done, undos, state } = pressHarness(out);
  let answer: (undone: boolean) => void = () => {};
  state.answer = () => new Promise<boolean>(resolve => { answer = resolve; });
  press();
  undos[0]();
  state.clock += PRACTICE_PRESS_WINDOW_MS;
  press();
  assert.equal(done.filter(line => line.startsWith('record')).length, 1, 'no review while the undo is on its way');
  answer(true);
  await settle();
  press();
  assert.equal(done.filter(line => line.startsWith('record')).length, 2, 'and the next press counts once it settles');
});

test('a review that fails to record is noted, not thrown, and the undo is still offered', async t => {
  const warned = t.mock.method(console, 'warn', () => {});
  const rejections: unknown[] = [];
  const onRejection = (reason: unknown) => { rejections.push(reason); };
  process.on('unhandledRejection', onRejection);
  try {
    const offered: string[] = [];
    const press = createPracticePress({
      toggle: () => out, record: () => Promise.reject(new Error('the scheduler failed to load')),
      undoReview: async () => true, offerUndo: message => { offered.push(message); }, showUndoFailure: () => {},
      now: () => 0, createId: () => 'event-1', isOnline: () => true,
    });
    press();
    await settle();
    assert.deepEqual(offered, ['Practicing “braise”']);
    assert.deepEqual(rejections, []);
    assert.deepEqual(warned.mock.calls.map(call => call.arguments[0]), ['Practice change failed:']);
  } finally {
    process.off('unhandledRejection', onRejection);
  }
});

test('the hook shows no pill without the card view\'s three callbacks, and with them its press calls them', async () => {
  const calls: unknown[][] = [];
  const onUpdateSRS = (...args: unknown[]) => { calls.push(['review', ...args]); return Promise.resolve(true); };
  const onUndoReview = (eventId: string) => { calls.push(['undo', eventId]); return Promise.resolve(true); };
  const offers: (() => void)[] = [];
  const onOfferUndo = (message: string, undo: () => void) => { calls.push(['offer', message]); offers.push(undo); };

  assert.equal(capture(() => usePracticeToggle({ item: braise, onUpdateSRS, onUndoReview: undefined, onOfferUndo })).toggle, null);
  assert.equal(capture(() => usePracticeToggle({ item: undefined, onUpdateSRS, onUndoReview, onOfferUndo })).toggle, null);

  const practice = capture(() => usePracticeToggle({ item: braise, onUpdateSRS, onUndoReview, onOfferUndo }));
  assert.deepEqual(practice.toggle, out);
  assert.equal(practice.undoFailure, null);
  practice.press();
  offers[0]();
  await settle();
  const [review, offer, undo] = calls;
  assert.equal(review[1], 'braise-1');
  assert.equal(review[2], 'again');
  const context = review[3] as { taskType: string; eventId: string };
  assert.deepEqual(Object.keys(context), ['taskType', 'eventId']);
  assert.equal(context.taskType, 'triage');
  assert.match(context.eventId, /^[0-9a-f-]{36}$/);
  assert.deepEqual(offer, ['offer', 'Practicing “braise”']);
  assert.deepEqual(undo, ['undo', context.eventId], 'the undo names the review the press recorded');
});

// The pill's look: one size and shape in both states, outlined out of practice and filled orange in it.

const pill = (toggle: PracticeToggle) => renderToStaticMarkup(createElement(PracticePill, { toggle, onPress: () => {} }));
const classesOf = (markup: string) => markup.match(/^<button[^>]*class="([^"]*)"/)![1].split(/\s+/);
const COLOURS = /^(hover:)?(bg|text|border)-(white|slate|orange)/;

test('"+ Practice" is an outlined toggle, not pressed, with the Target icon, never the Bookmark that means Save', () => {
  const markup = pill(out);
  assert.match(markup, /^<button type="button" aria-pressed="false" aria-label="Add “braise” to practice" title="Add “braise” to practice \(B\)" class="/);
  assert.match(markup, /<svg[^>]*class="lucide lucide-target text-orange-500" aria-hidden="true">/);
  assert.match(markup, /<\/svg>\+ Practice<\/button>$/);
  assert.doesNotMatch(markup, /lucide-bookmark/);
  assert.deepEqual(classesOf(markup).filter(name => COLOURS.test(name)), [
    'border-slate-200', 'bg-white', 'text-slate-600', 'hover:border-orange-300', 'hover:bg-orange-50', 'hover:text-orange-700',
  ]);
});

test('"Practicing" is the same toggle pressed and filled orange, whose name says a press marks it as one you can say', () => {
  const markup = pill(inPractice);
  assert.match(markup, /^<button type="button" aria-pressed="true" aria-label="Stop practicing “braise”: marks it as one you can say" title="Stop practicing “braise”: marks it as one you can say \(B\)"/);
  assert.match(markup, /<svg[^>]*class="lucide lucide-target" aria-hidden="true">/);
  assert.match(markup, /<\/svg>Practicing<\/button>$/);
  assert.deepEqual(classesOf(markup).filter(name => COLOURS.test(name)), [
    'border-orange-500', 'bg-orange-500', 'text-white', 'hover:border-orange-600', 'hover:bg-orange-600',
  ]);
});

test('a press changes only the pill\'s colours, so nothing beside it moves; it\'s as tall as the lesson row allows', () => {
  const shape = (toggle: PracticeToggle) => classesOf(pill(toggle)).filter(name => !COLOURS.test(name));
  assert.deepEqual(shape(out), shape(inPractice));
  // A fixed minimum width holds either text, and -my-1 pulls the 32 px pill to 24 px in the row's layout (the row is 28).
  for (const name of ['min-w-[6.75rem]', 'h-8', '-my-1', 'rounded-full', 'shrink-0']) assert.ok(shape(out).includes(name), name);
});

test('a failed undo shows as a rose alert in the notice stack, which may wrap', () => {
  const markup = renderToStaticMarkup(createElement(PracticeUndoFailure, { message: 'You’re offline, so the change can’t be undone.' }));
  assert.match(markup, /^<div role="alert" class="[^"]*rounded-2xl bg-rose-600 [^"]*">.*You’re offline, so the change can’t be undone\.<\/span><\/div>$/);
});
