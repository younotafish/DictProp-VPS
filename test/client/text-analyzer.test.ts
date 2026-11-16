import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { TextAnalyzer, analyzerHeaderButton, type AnalyzerStep } from '../../components/TextAnalyzer.tsx';

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
