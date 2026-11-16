import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { AnalyzeBar, TextAnalyzer, analyzerHeaderButton, type AnalyzerStep } from '../../components/TextAnalyzer.tsx';

const noop = () => {};

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
