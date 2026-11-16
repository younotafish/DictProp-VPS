import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { SRSData, StoredItem, VocabCard } from '../../types.ts';
import type { StudySession } from '../../services/studySession.ts';
import { installFakeMedia } from '../support/audio/fakeMedia.ts';

// The card imports the speech engine, which reads the browser's media when it loads.
installFakeMedia();
const { StudyCard } = await import('../../components/study/StudyCard.tsx');

type StudyCardProps = Parameters<typeof StudyCard>[0];

/** A vocab card; memoryStrength and totalReviews pick its task (meaning under 30, production from 30 on even reviews). */
function card(fields: Partial<VocabCard> = {}, srs: Partial<SRSData> = {}): StoredItem {
  return {
    type: 'vocab',
    data: {
      id: 'a', word: 'crestfallen', chinese: '垂头丧气', ipa: '', definition: 'Sad and disappointed, as one crestfallen is.',
      synonyms: ['downcast'], antonyms: [], confusables: [], examples: [], history: '', register: '', mnemonic: '',
      ...fields,
    },
    srs: { id: 'a', type: 'vocab', nextReview: 0, interval: 0, memoryStrength: 0, lastReviewDate: 0, totalReviews: 0, correctStreak: 0, stability: 0.5, ...srs },
    savedAt: 0,
  };
}

const PRODUCTION = { memoryStrength: 40, totalReviews: 2 };

const session = (overrides: Partial<StudySession> = {}): StudySession => ({
  id: 's', itemIds: ['a', 'b'], index: 0, revealed: false, typedAnswer: '', promptStartedAt: 0, startedAt: 0, grades: [],
  siblingCounts: {}, ...overrides,
});

const noop = () => {};
const render = (props: Partial<StudyCardProps> & Pick<StudyCardProps, 'item'>) => renderToStaticMarkup(createElement(StudyCard, {
  session: session(), canUndo: false, undoing: false, undoError: '', onUndo: noop, onClose: noop, onReveal: noop,
  onTypeAnswer: noop, onGrade: noop, onOpenExampleSentence: noop, ...props,
}));

const textOf = (markup: string) => markup.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

test('the header says what the prompt asks', () => {
  assert.match(render({ item: card() }), />Recall the meaning</);
  assert.match(render({ item: card({}, PRODUCTION) }), />Type the English word</);
});

test('a meaning prompt for one of several senses names the sense count, and a single sense shows nothing extra', () => {
  const lead = card({ word: 'lead', sense: 'noun: emotion' });
  const several = render({ item: lead, session: session({ siblingCounts: { a: 3 } }) });
  assert.match(several, /<div class="text-4xl font-bold text-slate-900">lead<\/div><div class="mt-2 text-sm text-slate-400">noun · one of 3 meanings<\/div>/);
  assert.doesNotMatch(render({ item: lead }), /meanings/);
  // A phrase takes the smaller size.
  assert.match(render({ item: card({ word: 'give up' }) }), /<div class="text-2xl font-bold text-slate-900">give up<\/div>/);
});

test('a production prompt shows the Chinese and the definition beneath it, and never the word itself', () => {
  const markup = render({ item: card({ forms: ['crestfallener'] }, PRODUCTION) });
  assert.doesNotMatch(markup, /crestfallen/i);
  assert.match(markup, /<div class="text-xl leading-relaxed text-slate-800">垂头丧气<\/div><div class="mt-2 text-sm text-slate-500">Sad and disappointed, as one _____ is\.<\/div>/);
});

test('the answer box is left as typed: no capitals, no corrections, no spell check', () => {
  const input = render({ item: card({}, PRODUCTION) }).match(/<input[^>]*>/)?.[0] ?? '';
  assert.match(input, /autoComplete="off"|autocomplete="off"/i);
  assert.match(input, /autocapitalize="none"/i);
  assert.match(input, /autocorrect="off"/i);
  assert.match(input, /spellcheck="false"/i);
  assert.match(input, /aria-label="Type the recalled word"/);
});

test('once the answer shows, its full sense sits under the word, and a typed answer gets one verdict line', () => {
  const item = card({ sense: 'adjective: sad after a failure' }, PRODUCTION);
  const shown = (typedAnswer: string) => render({ item, session: session({ revealed: true, typedAnswer }) });
  const verdictOf = (markup: string) => markup.match(/<div class="text-sm font-medium mb-3 ([a-z0-9-]+)">([^<]*)<\/div>/)?.slice(1);

  assert.match(shown(''), /<div class="text-3xl font-bold text-slate-900 mb-2">crestfallen<\/div><div class="text-sm text-slate-500 mb-2">adjective: sad after a failure<\/div>/);
  assert.equal(verdictOf(shown('')), undefined, 'nothing typed, no line');
  assert.deepEqual(verdictOf(shown(' Crestfallen ')), ['text-emerald-700', '✓ Crestfallen']);
  assert.deepEqual(verdictOf(shown('crestfalen')), ['text-amber-700', '≈ crestfalen — one letter off']);
  assert.deepEqual(verdictOf(shown('downcast')), ['text-amber-700', '↔ downcast is a synonym — this card is crestfallen']);
  assert.deepEqual(verdictOf(shown('dejected')), ['text-rose-700', '✗ dejected']);
  assert.doesNotMatch(textOf(shown('dejected')), /Your answer/);
});

test('a meaning card shows no verdict, whatever the session holds', () => {
  assert.doesNotMatch(render({ item: card(), session: session({ revealed: true, typedAnswer: 'stale' }) }), /stale/);
});
