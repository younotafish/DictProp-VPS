import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { StoredItem } from '../../types.ts';
import { THEME_DOMAINS } from '../../server/src/shared/item-themes.ts';
import { SENTENCE_GOT_IT_RULE, loopCard, type LoopMode } from '../../services/learningLoop/cues.ts';
import { GRADUATION_DOTS } from '../../services/learningLoop/standing.ts';
import { installFakeMedia } from '../support/audio/fakeMedia.ts';
import { DAY, practicing, sentenceItem, vocabItem } from '../support/loop-fixtures.ts';

// The player draws its card's speakers, which import the speech engine, which reads the browser's media when it loads.
installFakeMedia();
const { LoopPlayer } = await import('../../views/today/LoopPlayer.tsx');
type LoopPlayerProps = Parameters<typeof LoopPlayer>[0];

// A set or practice session's card as it renders: the header, the card at each step for a word and a sentence, and
// the footer's one slot in each of its states, with the receipt line above it.

const NOW = new Date(2026, 10, 18, 15, 0).getTime();
const THEME = THEME_DOMAINS[0].themes[0];
const noop = () => {};
const textOf = (markup: string) => markup
  .replace(/<[^>]+>/g, ' ')
  .replace(/&#x27;/g, '\'')
  .replace(/&quot;/g, '"')
  .replace(/\s+/g, ' ')
  .trim();

const WORD = vocabItem('w', 'crestfallen', {
  chinese: '垂头丧气的', definition: 'Sad because crestfallen hopes failed.', sense: 'adjective: disappointed', ipa: '/ˈkrɛstˌfɔːlən/',
  examples: ['She looked {{crestfallen}} after the loss.'],
});
const SENTENCE = sentenceItem('s', 'Could you keep {{an eye on}} my bag?', { sourceWord: 'keep an eye on', translation: '你能帮我看着包吗？', naturalSpeechIpa: 'kʊdʒə kiːp ən aɪ ɑn maɪ bæɡ' });

function renderCard(item: StoredItem, props: Partial<LoopPlayerProps> = {}, mode: LoopMode = 'speak') {
  return renderToStaticMarkup(createElement(LoopPlayer, {
    item, card: loopCard(item, mode), step: 'cue', hintShown: false, mode, attemptLabel: null, dots: null, onOpenItem: noop,
    onPlaybackStart: noop, onLazyLoadImage: async () => null, theme: { emoji: THEME.emoji, title: THEME.title }, position: 2, total: 5,
    phase: 'meet', onToggleMode: noop, footer: 'cue', canHint: true, sayOpen: true, captions: null, receipt: null, undoLabel: 'Undo',
    canUndo: false, undoing: false, waiting: false, undoError: '', onClose: noop, onReveal: noop, onHint: noop, onChoose: noop,
    onAnswer: noop, onNext: noop, onReplay: noop, onUndo: noop, ...props,
  }));
}

test('the header has × to end, the set\'s theme or Practice, i / n with its bar, and the Speak | Quiet chip', () => {
  const set = renderCard(WORD);
  assert.match(set, /aria-label="End the set"/);
  assert.match(textOf(set), new RegExp(`^${THEME.emoji} ${THEME.title} 2 / 5 Speak`));
  assert.match(set, /role="progressbar" aria-label="Session progress" aria-valuemin="0" aria-valuemax="5" aria-valuenow="1"/);
  assert.match(set, /style="width:20%"/);
  assert.match(set, /aria-label="Speak mode: switch to Quiet"/);
  assert.match(textOf(renderCard(WORD, { phase: 'round', position: 1, total: 4 })), /Round 1 \/ 4/);
  const practice = renderCard(WORD, { theme: null, phase: 'practice' }, 'quiet');
  assert.match(practice, /aria-label="End practice"/);
  assert.match(textOf(practice), /^Practice 2 \/ 5 Quiet/);
  assert.match(practice, /aria-label="Quiet mode: switch to Speak"/);
});

test('a word\'s cue asks for the word from its Chinese and its definition with the word blanked, and Reveal waits under Hint', () => {
  const card = loopCard(WORD, 'speak');
  assert.equal(card.cue.kind === 'word' && card.cue.level, 1);
  const markup = renderCard(WORD);
  const text = textOf(markup);
  assert.match(text, /Say the word 垂头丧气的 Sad because hopes failed\. adjective Hint Reveal$/);
  assert.match(markup, /<span role="img" aria-label="blank"/);
  assert.doesNotMatch(text, /crestfallen/, 'nothing gives the word away');
  assert.doesNotMatch(markup, /aria-label="Answer"/);
  assert.match(markup, /aria-keyshortcuts="H">Hint<\/button>/);
  assert.match(markup, /aria-keyshortcuts="Space Enter"><svg[^>]*>.*?<\/svg> Reveal<\/button>/);
  assert.match(textOf(renderCard(WORD, {}, 'quiet')), /Think of the word/);
});

test('a hint shows the first letters once taken, and the Hint button says so', () => {
  const markup = renderCard(WORD, { hintShown: true, canHint: false });
  assert.match(textOf(markup), /Hint c__________/);
  assert.match(markup, /disabled="" class="[^"]*" aria-keyshortcuts="H">Hint shown<\/button>/);
});

test('the revealed word shows under its cue: the word, ↗ to the card, IPA, sense, Chinese, definition and the example with its speaker', () => {
  const markup = renderCard(WORD, { step: 'answer', footer: 'meet' });
  const text = textOf(markup);
  assert.match(markup, /<section aria-live="polite" aria-label="Answer"/);
  assert.match(markup, /<h3 class="[^"]*">crestfallen<\/h3><button type="button" class="[^"]*" aria-label="Open the card" title="Open the card">/);
  assert.match(text, /crestfallen \/ˈkrɛstˌfɔːlən\/ adjective: disappointed 垂头丧气的 Sad because crestfallen hopes failed\. She looked crestfallen after the loss\./);
  assert.match(markup, /<mark class="bg-transparent font-semibold text-slate-800">crestfallen<\/mark>/);
  assert.match(markup, /aria-label="Listen to this sentence"/, 'the example\'s speaker');
});

test('the Meet\'s footer offers Practice, Passive and Can say it with their keys; after a hint Can say it is closed', () => {
  const open = renderCard(WORD, { step: 'answer', footer: 'meet' });
  assert.match(open, /aria-keyshortcuts="1 ArrowLeft" class="[^"]*amber[^"]*">Practice<\/button>/);
  assert.match(open, /aria-keyshortcuts="2 ArrowDown" class="[^"]*slate[^"]*">Passive<\/button>/);
  assert.match(open, /aria-keyshortcuts="3 ArrowRight" class="[^"]*emerald[^"]*">Can say it<\/button>/);
  const closed = renderCard(WORD, { step: 'answer', footer: 'meet', hintShown: true, sayOpen: false });
  assert.match(closed, /aria-disabled="true" aria-label="Can say it is closed after a hint" class="[^"]*cursor-not-allowed[^"]*">Can say it<\/button>/);
  assert.doesNotMatch(closed, /3 ArrowRight/);
});

test('after Practice the answer stays to be said twice, aloud or in your head, with Replay and Next', () => {
  const speak = renderCard(WORD, { step: 'encode', footer: 'encode' });
  assert.match(textOf(speak), /Say it twice, out loud crestfallen/);
  assert.match(speak, /aria-keyshortcuts="P"><svg[^>]*>.*?<\/svg> Replay<\/button>/);
  assert.match(speak, /aria-keyshortcuts="Space Enter">Next<\/button>/);
  assert.match(textOf(renderCard(WORD, { step: 'encode', footer: 'encode' }, 'quiet')), /Say it twice in your head/);
});

test('a run\'s card captions Not yet and Got it with where each leads, and shows the graduation dots once revealed', () => {
  const markup = renderCard(WORD, {
    step: 'answer', footer: 'run', phase: 'round', dots: 2, captions: { notYet: 'again soon', gotIt: 'in 4d' }, attemptLabel: 'Second try',
  });
  assert.match(markup, /aria-keyshortcuts="1"><span class="block">Not yet<\/span><span class="[^"]*">again soon<\/span><\/button>/);
  assert.match(markup, /aria-keyshortcuts="3 Enter"><span class="block">Got it<\/span><span class="[^"]*">in 4d<\/span><\/button>/);
  assert.match(markup, new RegExp(`role="img" aria-label="Toward Can say it: 2 of ${GRADUATION_DOTS}"`));
  assert.equal(markup.match(/h-2 w-2 rounded-full bg-orange-500/g)?.length, 2);
  assert.equal(markup.match(/h-2 w-2 rounded-full bg-slate-200/g)?.length, GRADUATION_DOTS - 2);
  assert.match(textOf(markup), /Second try · Say the word/);
});

test('the last look at an item missed twice has one Next', () => {
  const markup = renderCard(WORD, { step: 'answer', footer: 'look', phase: 'practice', theme: null, attemptLabel: 'One more look' });
  assert.match(textOf(markup), /One more look · Say the word/);
  assert.match(markup, /<div class="mt-1.5 grid"><button type="button" class="[^"]*" aria-keyshortcuts="Space Enter">Next<\/button><\/div>/);
  assert.doesNotMatch(markup, />Not yet<|>Got it</);
});

test('a sentence\'s cue gives its translation and the sentence with its expression blanked, and what counts as Got it', () => {
  const markup = renderCard(SENTENCE);
  const text = textOf(markup);
  assert.match(text, new RegExp(`Say the whole sentence 你能帮我看着包吗？ Could you keep my bag\\? ${SENTENCE_GOT_IT_RULE}`));
  assert.match(markup, /aria-label="blank"/);
  assert.doesNotMatch(text, /an eye on/);
});

test('a revealed sentence marks its expression, with its speaker, ↗ to its lesson, its connected speech and its translation', () => {
  const markup = renderCard(SENTENCE, { step: 'answer', footer: 'meet' });
  assert.match(markup, /Could you keep <mark class="rounded bg-violet-100 px-0.5 text-violet-950">an eye on<\/mark> my bag\?/);
  assert.match(markup, /aria-label="Open the sentence lesson"/);
  assert.match(textOf(markup), /kʊdʒə kiːp ən aɪ ɑn maɪ bæɡ 你能帮我看着包吗？/);
});

test('a strong item\'s sentence cue gives its translation alone, and the cloze is its hint', () => {
  const strong = sentenceItem('s2', 'Could you keep {{an eye on}} my bag?', {
    translation: '你能帮我看着包吗？', srs: practicing(NOW - 30 * DAY, { totalReviews: 6, stability: 9, lastReviewDate: NOW - 9 * DAY }),
  });
  const markup = renderCard(strong, { hintShown: true });
  const text = textOf(markup);
  assert.match(text, /Say it in English with the expression 你能帮我看着包吗？ Hint Could you keep my bag\?/);
  assert.doesNotMatch(text, /Got it =/);
});

test('the receipt line names the last review and what Undo takes back; a review still on the device says so', () => {
  const markup = renderCard(WORD, {
    receipt: { word: 'crestfallen', label: 'Got it', tone: 'emerald', detail: 'next in 4d' }, canUndo: true, waiting: true,
  });
  assert.match(textOf(markup), /↶ crestfallen · Got it · next in 4d · saved on this device Undo/);
  assert.match(markup, /<span class="text-emerald-700">Got it<\/span>/);
  assert.match(markup, /aria-label="Undo the last answer" aria-keyshortcuts="U">Undo<\/button>/);

  const back = renderCard(WORD, { receipt: { word: 'alpha', label: 'Practice', tone: 'amber' }, canUndo: true, undoLabel: 'Back' });
  assert.match(textOf(back), /↶ alpha · Practice Back/);
  assert.match(back, /aria-label="Back: take back the last choice" aria-keyshortcuts="U">Back<\/button>/);
});

test('while an undo is under way the footer waits, and a failed undo takes the receipt\'s place', () => {
  const undoing = renderCard(WORD, { receipt: { word: 'crestfallen', label: 'Got it', tone: 'emerald' }, canUndo: true, undoing: true });
  assert.match(textOf(undoing), /↶ crestfallen · Got it · Undoing…/);
  assert.equal(undoing.match(/<button type="button"[^>]*disabled=""/g)?.length, 3, 'Undo, Hint and Reveal');
  const failed = renderCard(WORD, { receipt: { word: 'crestfallen', label: 'Got it', tone: 'emerald' }, canUndo: true, undoError: 'Couldn’t undo: try again.' });
  assert.match(failed, /<span class="text-rose-700" role="alert">Couldn’t undo: try again\.<\/span>/);
  assert.doesNotMatch(textOf(failed), /↶/);
  assert.doesNotMatch(renderCard(WORD), /↶|Undo/, 'nothing to take back');
});
