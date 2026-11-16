import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { SRSData, StoredItem, VocabCard } from '../../types.ts';
import type { StudySession } from '../../services/studySession.ts';
import { installFakeMedia } from '../support/audio/fakeMedia.ts';

// The card imports the speech engine, which reads the browser's media when it loads.
installFakeMedia();
const { StudyCard, TAB_FOOTER_HEIGHT } = await import('../../components/study/StudyCard.tsx');

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
/** Strong enough, on an odd review, with an example the word can be blanked from: a listening prompt. */
const LISTENING = { memoryStrength: 70, totalReviews: 5 };
const listening = (fields: Partial<VocabCard> = {}) =>
  card({ examples: ['She looked {{crestfallen}} after the loss.'], ...fields }, LISTENING);

const session = (overrides: Partial<StudySession> = {}): StudySession => ({
  id: 's', itemIds: ['a', 'b'], index: 0, revealed: false, typedAnswer: '', promptStartedAt: 0, startedAt: 0, grades: [],
  siblingCounts: {}, ...overrides,
});

const noop = () => {};
const render = (props: Partial<StudyCardProps> & Pick<StudyCardProps, 'item'>) => renderToStaticMarkup(createElement(StudyCard, {
  session: session(), canUndo: false, undoing: false, receipt: null, undoError: '', onUndo: noop, onClose: noop, onReveal: noop,
  onFooterReveal: noop, onFooterGrade: noop, onTypeAnswer: noop, onOpenExampleSentence: noop, ...props,
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

/** The card's three parts: the header, the scrolling body, and the footer above the tab bar. */
const partsOf = (markup: string) => ({
  header: markup.match(/<header[^]*?<\/header>/)?.[0] ?? '',
  body: markup.match(/<section[^]*?<\/section>/)?.[0] ?? '',
  footer: markup.match(/<footer[^]*?<\/footer>/)?.[0] ?? '',
});
const buttonsOf = (markup: string) => [...markup.matchAll(/<button[^>]*>/g)].map(match => match[0]);

test('before the reveal the footer holds one full-width Show answer and no grade, below the receipt line', () => {
  const markup = render({ item: card() });
  const { header, body, footer } = partsOf(markup);
  assert.ok(markup.indexOf(header) < markup.indexOf(body) && markup.indexOf(body) < markup.indexOf(footer), 'header, body, footer');
  assert.match(footer, /^<footer class="shrink-0 px-4 pb-\[calc\(var\(--nav-h,95px\)\+0\.5rem\)\]">/);
  // The receipt line is there, empty, from the first card on.
  assert.match(footer, /<div class="h-8 flex items-center gap-2 text-xs text-slate-500"><div class="min-w-0 flex-1 truncate" aria-live="polite"><\/div><\/div>/);
  const buttons = buttonsOf(footer);
  assert.equal(buttons.length, 1);
  assert.match(buttons[0], /class="mt-1\.5 w-full h-14 [^"]*"/);
  assert.match(buttons[0], /aria-keyshortcuts="Space Enter"/);
  assert.match(footer, /Show answer<\/button>/);
  assert.doesNotMatch(body, /<button/, 'nothing to press in the body of a meaning prompt without an IPA');
  assert.match(body, /^<section class="flex-1 min-h-0 overflow-y-auto px-4"><div class="max-w-2xl mx-auto pt-\[8vh\] pb-6 text-center">/);
});

test('once revealed the same slot holds the four grades in one row, in key order, with their intervals', () => {
  const { footer } = partsOf(render({ item: card(), session: session({ revealed: true }) }));
  assert.match(footer, /<div class="mt-1\.5 grid grid-cols-4 gap-2">/);
  const grades = buttonsOf(footer).map(button => button.match(/aria-keyshortcuts="(\d)"/)?.[1]);
  assert.deepEqual(grades, ['1', '2', '3', '4']);
  assert.deepEqual([...footer.matchAll(/<span class="block">([a-z]+)<\/span>/g)].map(match => match[1]), ['again', 'hard', 'good', 'easy']);
  assert.doesNotMatch(footer, /Show answer/);
});

test('a listening card\'s prompt is the 64 px dark speaker, which pauses, resumes or plays the sentence again', () => {
  const { header, body } = partsOf(render({ item: listening() }));
  assert.match(header, />Listen to the sentence</);
  const buttons = buttonsOf(body);
  assert.equal(buttons.length, 1);
  assert.match(buttons[0], /class=" transition-colors text-white mx-auto w-16 h-16 rounded-full grid place-items-center bg-slate-900 hover:bg-slate-800"/);
  assert.match(buttons[0], /aria-label="Listen to this sentence"/);
  assert.match(body, /<svg[^>]* width="26" height="26"[^>]*class="lucide lucide-volume2 /);
  assert.doesNotMatch(textOf(body), /crestfallen|loss/, 'the sentence is heard, not read');
});

const IPA = '/ˈkrestˌfɔːlən/';
/** The IPA chips (PronunciationBlock) in some markup: the IPA each shows. */
const ipaChipsOf = (markup: string) =>
  [...markup.matchAll(/<button type="button" class="[^"]*font-mono[^"]*" title="Click to listen">[^]*?<span[^>]*>([^<]*)<\/span><\/button>/g)].map(match => match[1]);

test('a listening card\'s answer shows the IPA under the word, the chip that says it, and never before the reveal', () => {
  const item = listening({ ipa: IPA });
  assert.deepEqual(ipaChipsOf(render({ item })), []);
  const { body } = partsOf(render({ item, session: session({ revealed: true }) }));
  assert.match(body, /<div class="text-3xl font-bold text-slate-900 mb-2">crestfallen<\/div><div class="mb-3"><button type="button" class="[^"]*font-mono[^"]*" title="Click to listen">/);
  assert.deepEqual(ipaChipsOf(body), [IPA]);
  // The prompt's speaker is still there, above the answer.
  assert.match(buttonsOf(body)[0], /w-16 h-16 rounded-full/);
});

test('a meaning prompt shows the IPA under its word, where it gives nothing away; a production prompt doesn\'t', () => {
  const meaning = render({ item: card({ ipa: IPA, word: 'lead', sense: 'noun: emotion' }), session: session({ siblingCounts: { a: 2 } }) });
  assert.match(meaning, /<div class="text-4xl font-bold text-slate-900">lead<\/div><div class="mt-3"><button type="button" class="[^"]*font-mono/);
  assert.deepEqual(ipaChipsOf(partsOf(meaning).body), [IPA]);
  assert.match(meaning, /<\/button><\/div><div class="mt-2 text-sm text-slate-400">noun · one of 2 meanings<\/div>/, 'the sense hint follows it');
  const production = card({ ipa: IPA }, PRODUCTION);
  assert.deepEqual(ipaChipsOf(render({ item: production })), []);
  assert.deepEqual(ipaChipsOf(render({ item: production, session: session({ revealed: true }) })), [IPA], 'it shows with the answer');
  // Without an IPA there's no chip, before the reveal or after.
  assert.deepEqual(ipaChipsOf(render({ item: card(), session: session({ revealed: true }) })), []);
});

test('the revealed example has its speaker beside Open sentence review', () => {
  const { body } = partsOf(render({ item: card({ examples: ['She looked {{crestfallen}}.'] }), session: session({ revealed: true }) }));
  const row = body.match(/<div class="flex items-start gap-2 border-l-2[^]*?<\/div>/)?.[0] ?? '';
  assert.match(row, /<span class="min-w-0 flex-1 pt-1\.5">She looked crestfallen\.<\/span>/);
  const [speaker, open] = buttonsOf(row);
  assert.match(speaker, /class=" transition-colors text-indigo-300 hover:text-indigo-600 grid h-9 w-9 shrink-0 place-items-center rounded-md hover:bg-slate-200 /);
  assert.match(speaker, /aria-label="Listen to this sentence"/);
  assert.match(open, /aria-label="Open sentence review"/);
  assert.match(row, /<svg[^>]* width="17" height="17"[^>]*class="lucide lucide-volume2 /);
});

test('the header keeps the count, the instruction and End, and no longer holds Undo', () => {
  const { header } = partsOf(render({ item: card(), canUndo: true }));
  assert.match(header, /1 \/ 2/);
  assert.equal(buttonsOf(header).length, 1);
  assert.match(header, /aria-label="End study session"/);
  assert.doesNotMatch(header, /Undo/);
});

test('the receipt line names the last grade, with an Undo button that keeps the line 32 px tall', () => {
  const receipt = { word: 'walk', rating: 'good', ratingLabel: 'Good', detail: 'next in 2d' } as const;
  const { footer } = partsOf(render({ item: card(), receipt, canUndo: true }));
  assert.match(footer, /<div class="min-w-0 flex-1 truncate" aria-live="polite"><span aria-hidden="true">↶ <\/span>walk · <span class="text-emerald-700">Good<\/span> · next in 2d<\/div>/);
  assert.equal(textOf(footer.match(/<div class="h-8[^]*?<\/button><\/div>/)?.[0] ?? '').replace('Undo', '').trim(), '↶ walk · Good · next in 2d');
  const undo = buttonsOf(footer)[0];
  assert.match(undo, /class="h-11 -my-1\.5 shrink-0 [^"]*"/);
  assert.match(undo, /aria-keyshortcuts="U"/);
  assert.match(undo, /title="Undo last rating \(U\)"/);
  assert.doesNotMatch(undo, / disabled=""/);
  assert.match(buttonsOf(partsOf(render({ item: card(), receipt, canUndo: true, undoing: true })).footer)[0], /disabled=""/);
});

test('a failed undo is said in the receipt line itself, so the card never moves for it', () => {
  const receipt = { word: 'walk', rating: 'good', ratingLabel: 'Good', detail: 'next in 2d' } as const;
  const markup = render({ item: card(), receipt, canUndo: true, undoError: 'Reconnect to undo this review.' });
  const { footer, body } = partsOf(markup);
  assert.match(footer, /<div class="min-w-0 flex-1 truncate" aria-live="polite"><span class="text-rose-700" role="alert">Reconnect to undo this review\.<\/span><\/div>/);
  assert.doesNotMatch(footer, /next in 2d/);
  assert.doesNotMatch(body, /Reconnect/);
  assert.equal(markup.match(/role="alert"/g)?.length, 1);
});

test('the footer reaches no higher above the tab bar than the --tab-footer-h it gives the notices and the search button', () => {
  const REM = 16;
  const { footer } = partsOf(render({ item: card(), receipt: { word: 'walk', rating: 'good', ratingLabel: 'Good', detail: 'next in 2d' }, canUndo: true }));
  // The parts the height is made of, as TAB_FOOTER_HEIGHT's comment adds them up.
  assert.match(footer, /pb-\[calc\(var\(--nav-h,95px\)\+0\.5rem\)\]/);
  assert.match(footer, /<div class="max-w-2xl mx-auto border-t border-slate-200"><div class="h-8 /);
  assert.match(footer, /<button[^>]*class="mt-1\.5 w-full h-14 /);
  const reach = 0.5 * REM + 1 + 2 * REM + 0.375 * REM + 3.5 * REM;
  assert.equal(reach, 103);
  assert.equal(TAB_FOOTER_HEIGHT, '6.5rem');
  assert.ok(reach <= 6.5 * REM);
});
