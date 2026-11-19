import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { StoredItem } from '../../types.ts';
import { THEME_DOMAINS } from '../../server/src/shared/item-themes.ts';
import { WHAT_COUNTS, loopCard, type LoopMode } from '../../services/learningLoop/cues.ts';
import { GRADUATION_DOTS } from '../../services/learningLoop/standing.ts';
import { installFakeMedia } from '../support/audio/fakeMedia.ts';
import { DAY, practicing, reviewed, sentenceItem } from '../support/loop-fixtures.ts';

// The player draws its card's speakers, which import the speech engine, which reads the browser's media when it loads.
installFakeMedia();
const { LoopPlayer } = await import('../../views/today/LoopPlayer.tsx');
type LoopPlayerProps = Parameters<typeof LoopPlayer>[0];

// A set or practice session's card as it renders: the header, the card at each step and level, and the footer's one
// slot in each of its states, with the receipt line above it.

const NOW = new Date(2026, 10, 18, 15, 0).getTime();
const THEME = THEME_DOMAINS[0].themes[0];
const noop = () => {};
const textOf = (markup: string) => markup
  .replace(/<[^>]+>/g, ' ')
  .replace(/&#x27;/g, '\'')
  .replace(/&quot;/g, '"')
  .replace(/\s+/g, ' ')
  .trim();

const SENTENCE = sentenceItem('s', 'Could you keep {{an eye on}} my bag?', {
  sourceWord: 'keep an eye on', translation: '你能帮我看着包吗？', naturalSpeechIpa: 'kʊdʒə kiːp ən aɪ ɑn maɪ bæɡ', imageUrl: 'server:has_image:3',
});
/** The same sentence Got it'd often enough for a level 2 cue in a run. */
const STRONG = { ...SENTENCE, srs: { ...SENTENCE.srs, ...reviewed(NOW - 9 * DAY, { totalReviews: 6, stability: 9 }) } };

function renderCard(item: StoredItem, props: Partial<LoopPlayerProps> = {}, mode: LoopMode = 'speak', level?: 1 | 2) {
  return renderToStaticMarkup(createElement(LoopPlayer, {
    item, card: loopCard(item, mode, undefined, level), step: 'cue', hintShown: false, mode, attemptLabel: null, dots: null, onOpenItem: noop,
    onPlaybackStart: noop, onLazyLoadImage: async () => null, theme: { emoji: THEME.emoji, title: THEME.title }, position: 2, total: 5,
    phase: 'meet', onToggleMode: noop, footer: 'cue', canHint: true, sayOpen: true, captions: null, receipt: null, undoLabel: 'Undo',
    canUndo: false, undoing: false, waiting: false, undoError: '', onClose: noop, onReveal: noop, onHint: noop, onChoose: noop,
    onAnswer: noop, onNext: noop, onReplay: noop, onUndo: noop, ...props,
  }));
}

test('the header has × to end, the set\'s theme or Practice, i / n with its bar, and the Speak | Quiet chip', () => {
  const set = renderCard(SENTENCE);
  assert.match(set, /aria-label="End the set"/);
  assert.match(textOf(set), new RegExp(`^${THEME.emoji} ${THEME.title} 2 / 5 Speak`));
  assert.match(set, /role="progressbar" aria-label="Session progress" aria-valuemin="0" aria-valuemax="5" aria-valuenow="1"/);
  assert.match(set, /style="width:20%"/);
  assert.match(set, /aria-label="Speak mode: switch to Quiet"/);
  assert.match(textOf(renderCard(SENTENCE, { phase: 'round', position: 1, total: 4 })), /Round 1 \/ 4/);
  assert.match(set, /<p class="sr-only" aria-live="polite">Card 2 of 5<\/p>/, 'a screen reader hears each new card');
  assert.match(renderCard(SENTENCE, { phase: 'round', position: 1, total: 4 }), /aria-live="polite">Round, card 1 of 4</);
  const practice = renderCard(SENTENCE, { theme: null, phase: 'practice' }, 'quiet');
  assert.match(practice, /aria-label="End practice"/);
  assert.match(textOf(practice), /^Practice 2 \/ 5 Quiet/);
  assert.match(practice, /aria-label="Quiet mode: switch to Speak"/);
});

test('a level 1 cue asks for the whole sentence from its translation, the expression to use in a chip, and Reveal waits under Hint', () => {
  const markup = renderCard(SENTENCE);
  const text = textOf(markup);
  assert.match(text, new RegExp(`Say the whole sentence 你能帮我看着包吗？ Use keep an eye on ${WHAT_COUNTS.expression} Hint Reveal$`));
  assert.match(markup, /<p class="mt-3 text-sm text-slate-600">Use <span class="rounded bg-violet-100 px-1.5 font-semibold text-violet-950">keep an eye on<\/span><\/p>/);
  assert.doesNotMatch(text, /Could you|my bag/, 'nothing of the sentence shows');
  assert.doesNotMatch(markup, /overflow-hidden rounded-xl/, 'the picture waits for level 2');
  assert.doesNotMatch(markup, /aria-label="Answer"/);
  assert.match(markup, /aria-keyshortcuts="H">Hint<\/button>/);
  assert.match(markup, /aria-keyshortcuts="Space Enter"><svg[^>]*>.*?<\/svg> Reveal<\/button>/);
  assert.match(textOf(renderCard(SENTENCE, {}, 'quiet')), /^.* Think of the whole sentence 你能帮我看着包吗？/);
});

test('a hint shows the first letter of each word of the sentence once taken, and the Hint button says so', () => {
  const markup = renderCard(SENTENCE, { hintShown: true, canHint: false });
  assert.match(textOf(markup), /Hint C____ y__ k___ a_ e__ o_ m_ b__\?/);
  assert.match(markup, /disabled="" class="[^"]*" aria-keyshortcuts="H">Hint shown<\/button>/);
});

test('the Meet\'s footer offers Practice, Passive and Can say it with their keys; after a hint Can say it is closed', () => {
  const open = renderCard(SENTENCE, { step: 'answer', footer: 'meet' });
  assert.match(open, /aria-keyshortcuts="1 ArrowLeft" class="[^"]*amber[^"]*">Practice<\/button>/);
  assert.match(open, /aria-keyshortcuts="2 ArrowDown" class="[^"]*slate[^"]*">Passive<\/button>/);
  assert.match(open, /aria-keyshortcuts="3 ArrowRight" class="[^"]*emerald[^"]*">Can say it<\/button>/);
  const closed = renderCard(SENTENCE, { step: 'answer', footer: 'meet', hintShown: true, sayOpen: false });
  assert.match(closed, /aria-disabled="true" aria-label="Can say it is closed after a hint" class="[^"]*cursor-not-allowed[^"]*">Can say it<\/button>/);
  assert.doesNotMatch(closed, /3 ArrowRight/);
});

test('after Practice the answer stays to be said twice, aloud or in your head, with Replay and Next', () => {
  const speak = renderCard(SENTENCE, { step: 'encode', footer: 'encode' });
  assert.match(textOf(speak), /Say it twice, out loud Could you keep an eye on my bag\?/);
  assert.match(speak, /aria-keyshortcuts="P"><svg[^>]*>.*?<\/svg> Replay<\/button>/);
  assert.match(speak, /aria-keyshortcuts="Space Enter">Next<\/button>/);
  assert.match(textOf(renderCard(SENTENCE, { step: 'encode', footer: 'encode' }, 'quiet')), /Say it twice in your head/);
});

test('a run\'s card captions Not yet and Got it with where each leads, and shows the graduation dots once revealed', () => {
  const markup = renderCard(SENTENCE, {
    step: 'answer', footer: 'run', phase: 'round', dots: 2, captions: { notYet: 'again soon', gotIt: 'in 4d' }, attemptLabel: 'Second try',
  });
  assert.match(markup, /aria-keyshortcuts="1"><span class="block">Not yet<\/span><span class="[^"]*">again soon<\/span><\/button>/);
  assert.match(markup, /aria-keyshortcuts="3 Enter"><span class="block">Got it<\/span><span class="[^"]*">in 4d<\/span><\/button>/);
  assert.match(markup, new RegExp(`role="img" aria-label="Toward Can say it: 2 of ${GRADUATION_DOTS}"`));
  assert.equal(markup.match(/h-2 w-2 rounded-full bg-orange-500/g)?.length, 2);
  assert.equal(markup.match(/h-2 w-2 rounded-full bg-slate-200/g)?.length, GRADUATION_DOTS - 2);
  assert.match(textOf(markup), /Second try · Say the whole sentence/);
});

test('the last look at an item missed twice has one Next', () => {
  const markup = renderCard(SENTENCE, { step: 'answer', footer: 'look', phase: 'practice', theme: null, attemptLabel: 'One more look' });
  assert.match(textOf(markup), /One more look · Say the whole sentence/);
  assert.match(markup, /<div class="mt-1.5 grid"><button type="button" class="[^"]*" aria-keyshortcuts="Space Enter">Next<\/button><\/div>/);
  assert.doesNotMatch(markup, />Not yet<|>Got it</);
});

test('a revealed sentence marks its expression, with its speaker, ↗ to its lesson, its connected speech and its translation', () => {
  const markup = renderCard(SENTENCE, { step: 'answer', footer: 'meet' });
  assert.match(markup, /Could you keep <mark class="rounded bg-violet-100 px-0.5 text-violet-950">an eye on<\/mark> my bag\?/);
  assert.match(markup, /aria-label="Open the sentence lesson"/);
  assert.match(textOf(markup), /kʊdʒə kiːp ən aɪ ɑn maɪ bæɡ 你能帮我看着包吗？/);
});

test('a level 2 cue gives the translation and the picture, with no anchor; the Meet asks the same sentence at level 1', () => {
  const markup = renderCard(STRONG, { hintShown: true, phase: 'round' });
  const text = textOf(markup);
  assert.match(text, new RegExp(`Say the whole sentence 你能帮我看着包吗？ ${WHAT_COUNTS.expression} Hint C____ y__ k___ a_ e__ o_ m_ b__\\?`));
  assert.match(markup, /<div class="mt-5 overflow-hidden rounded-xl">/, 'the picture');
  assert.doesNotMatch(text, /Use keep an eye on/);
  const meeting = renderCard(STRONG, {}, 'speak', 1);
  assert.match(textOf(meeting), /Say the whole sentence 你能帮我看着包吗？ Use keep an eye on/);
  assert.doesNotMatch(meeting, /overflow-hidden rounded-xl/);
  const practiceItem = sentenceItem('p', 'A {{line}} without a picture.', { srs: practicing(NOW - 30 * DAY, { totalReviews: 6, stability: 9 }) });
  assert.doesNotMatch(renderCard(practiceItem), /overflow-hidden rounded-xl/, 'no picture to show');
});

test('the receipt line names the last review and what Undo takes back; a review still on the device says so', () => {
  const markup = renderCard(SENTENCE, {
    receipt: { word: 'Could you keep an eye on my bag?', label: 'Got it', tone: 'emerald', detail: 'next in 4d' }, canUndo: true, waiting: true,
  });
  assert.match(textOf(markup), /↶ Could you keep an eye on my bag\? · Got it · next in 4d · saved on this device Undo/);
  assert.match(markup, /<span class="text-emerald-700">Got it<\/span>/);
  assert.match(markup, /aria-label="Undo the last answer" aria-keyshortcuts="U">Undo<\/button>/);

  const back = renderCard(SENTENCE, { receipt: { word: 'See you soon.', label: 'Practice', tone: 'amber' }, canUndo: true, undoLabel: 'Back' });
  assert.match(textOf(back), /↶ See you soon\. · Practice Back/);
  assert.match(back, /aria-label="Back: take back the last choice" aria-keyshortcuts="U">Back<\/button>/);
});

test('while an undo is under way the footer waits, and a failed undo takes the receipt\'s place', () => {
  const undoing = renderCard(SENTENCE, { receipt: { word: 'See you soon.', label: 'Got it', tone: 'emerald' }, canUndo: true, undoing: true });
  assert.match(textOf(undoing), /↶ See you soon\. · Got it · Undoing…/);
  assert.equal(undoing.match(/<button type="button"[^>]*disabled=""/g)?.length, 3, 'Undo, Hint and Reveal');
  const failed = renderCard(SENTENCE, { receipt: { word: 'See you soon.', label: 'Got it', tone: 'emerald' }, canUndo: true, undoError: 'Couldn’t undo: try again.' });
  assert.match(failed, /<span class="text-rose-700" role="alert">Couldn’t undo: try again\.<\/span>/);
  assert.doesNotMatch(textOf(failed), /↶/);
  assert.doesNotMatch(renderCard(SENTENCE), /↶|Undo/, 'nothing to take back');
});
