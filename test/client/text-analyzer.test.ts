import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { AnalyzeBar, TextAnalyzer, WordCheckItem, analyzerHeaderButton, type AnalyzerStep } from '../../components/TextAnalyzer.tsx';
import { foundHeader, markSavedWords } from '../../components/textAnalyzerMarks.ts';
import { makeVocabStoredItem } from '../../services/items.ts';
import { buildVariantIndex } from '../../services/wordMatch.ts';
import type { DetectedWord } from '../../services/api/ai.ts';
import type { StoredItem, VocabCard } from '../../types.ts';

const noop = () => {};

const card = (word: string, forms?: string[]): StoredItem => makeVocabStoredItem({
  id: word, word, forms, chinese: '', ipa: '', definition: word, synonyms: [], antonyms: [], confusables: [], examples: [],
  history: '', register: '', mnemonic: '',
} satisfies VocabCard);
const found = (...words: string[]): DetectedWord[] => words.map(word => ({ word, context: `a text with ${word} in it`, level: 'C1', reason: '' }));

test('a word the notebook has in another form is marked, and a word it lacks is not', () => {
  const notebook = buildVariantIndex([card('run'), card('gamut'), card('see', ['sees', 'saw', 'seen', 'seeing'])]);
  const marks = markSavedWords(found('running', 'ubiquitous', 'saw', 'Gamut', 'serendipity'), notebook);
  assert.deepEqual([...marks.saved], ['running', 'saw', 'Gamut'], 'an inflection, a listed form, another case');
  assert.deepEqual([marks.found, marks.alreadySaved], [5, 3]);
});

test('a deleted card leaves its word unmarked, and an empty notebook marks nothing', () => {
  const marks = markSavedWords(found('running'), buildVariantIndex([{ ...card('run'), isDeleted: true }]));
  assert.deepEqual([[...marks.saved], marks.alreadySaved], [[], 0]);
  assert.deepEqual(markSavedWords(found('running', 'gamut'), buildVariantIndex([])), { saved: new Set(), found: 2, alreadySaved: 0 });
});

test('the list heads with what was found, and how many of those the notebook has when it has any', () => {
  assert.equal(foundHeader(8, 3), '8 found · 3 already saved');
  assert.equal(foundHeader(8, 0), '8 found');
  assert.equal(foundHeader(1, 1), '1 found · 1 already saved');
});

/** A row of the list, rendered: its classes, whether it says the notebook has the word, and what it says. */
const rowOf = (props: { isSelected: boolean; saved: boolean }) => {
  const markup = renderToStaticMarkup(createElement(WordCheckItem, { ...props, word: found('ubiquitous')[0], onToggle: noop }));
  return {
    classes: /^<button class="([^"]*)"/.exec(markup)?.[1],
    tag: /<span class="([^"]*)"><svg[^>]*lucide-check[^>]*>.*?<\/svg>In notebook<\/span>/.exec(markup)?.[1] ?? null,
    text: markup.replace(/<[^>]+>/g, ''),
  };
};

test('a word the notebook has says In notebook, and can still be chosen', () => {
  const saved = rowOf({ isSelected: false, saved: true });
  assert.equal(saved.tag, 'inline-flex items-center gap-0.5 text-[10px] font-semibold px-1.5 py-0.5 rounded-full border bg-emerald-50 text-emerald-600 border-emerald-200');
  assert.equal(saved.text, 'ubiquitousC1In notebook&quot;...a text with ubiquitous in it...&quot;');
  const chosen = rowOf({ isSelected: true, saved: true });
  assert.ok(chosen.tag, 'chosen, it keeps saying so');
  assert.equal(chosen.classes, rowOf({ isSelected: true, saved: false }).classes, 'and looks like any chosen word');

  const unsaved = rowOf({ isSelected: true, saved: false });
  assert.equal(unsaved.tag, null);
  assert.doesNotMatch(unsaved.text, /In notebook/);
});

test('the header button, which Escape presses too: Close on the text and the summary, Back while choosing, none mid-analysis', () => {
  const pressed: string[] = [];
  const buttonOn = (step: AnalyzerStep) => analyzerHeaderButton(step, () => pressed.push('close'), () => pressed.push('back'));
  for (const step of ['input', 'done'] as const) {
    const button = buttonOn(step);
    assert.deepEqual([button?.kind, button?.label], ['close', 'Close the text analyzer'], step);
    button?.onClick();
  }
  const back = buttonOn('selecting');
  assert.deepEqual([back?.kind, back?.label], ['back', 'Back to the text']);
  back?.onClick();
  assert.equal(buttonOn('analyzing'), null, '"Stop after current word" is the way out');
  assert.deepEqual(pressed, ['close', 'close', 'back']);
});

test('a closed analyzer renders nothing', () => {
  assert.equal(renderToStaticMarkup(createElement(TextAnalyzer, { isOpen: false, onClose: noop, onSave: noop, savedItems: [], isOnline: true })), '');
});

/** The bar's button as whether it's disabled, its classes and its text, and the line under it. */
const barOf = (props: { count: number; isOnline: boolean }) => {
  const markup = renderToStaticMarkup(createElement(AnalyzeBar, { ...props, onAnalyze: noop }));
  const button = /<button([^>]*)>(.*?)<\/button>/.exec(markup);
  assert.ok(button);
  return {
    disabled: /\sdisabled=""/.test(button[1]),
    look: /class="([^"]*)"/.exec(button[1])?.[1].includes('bg-indigo-600') ? 'ready' : 'greyed',
    text: button[2].replace(/<svg.*?<\/svg>/, ''),
    note: /<\/button><p class="([^"]*)">(.*?)<\/p>/.exec(markup)?.slice(1),
  };
};

test('offline, Analyze & Save is disabled with Scan\'s notice instead of failing every word', () => {
  assert.deepEqual(barOf({ count: 3, isOnline: true }), {
    disabled: false, look: 'ready', text: 'Analyze &amp; Save (3)',
    note: ['text-[10px] text-slate-400 text-center mt-2', 'Each word will be fully analyzed with all meanings and saved to your notebook'],
  });
  assert.deepEqual(barOf({ count: 3, isOnline: false }), {
    disabled: true, look: 'greyed', text: 'Analyze &amp; Save (3)',
    note: ['text-xs text-amber-600 bg-amber-50 rounded-lg p-2 mt-2 text-center', 'Offline. Text analysis requires an internet connection.'],
  });
  const nothingChosen = barOf({ count: 0, isOnline: true });
  assert.deepEqual([nothingChosen.disabled, nothingChosen.look, nothingChosen.text], [true, 'greyed', 'Analyze &amp; Save ']);
});
