import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement, type ComponentProps } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { SentenceHero } from '../../views/detail/SentenceHero.tsx';

// The sentence lesson's hero (views/detail/SentenceHero.tsx), rendered to markup: the sentence, the connected-speech IPA
// under it when the analysis has one, then the speaker row.

const IPA = 'ʃi ˈfaɪnli keɪm ˈklin';
const LABEL = 'Natural American IPA (connected speech)';

const render = (props: Partial<ComponentProps<typeof SentenceHero>> = {}) => renderToStaticMarkup(createElement(SentenceHero, {
  layout: 'centered', text: 'She finally {{came clean}}.', sourceWord: 'come clean', onSearchWord: () => {}, commandHeld: false,
  onWordClickCapture: () => {}, onListened: () => {}, copyState: null, onCopy: () => {}, ...props,
}));

/** The markup's parts, in order: the sentence's <p>, whatever comes before the speaker row, and the row. */
function parts(markup: string) {
  const sentenceEnd = markup.indexOf('</p>') + '</p>'.length;
  const rowStart = markup.indexOf('<div class="mt-5');
  assert.ok(markup.startsWith('<p data-sentence-hero'), 'the sentence comes first');
  assert.ok(sentenceEnd > 0 && rowStart >= sentenceEnd, 'then the speaker row');
  return { sentence: markup.slice(0, sentenceEnd), between: markup.slice(sentenceEnd, rowStart), row: markup.slice(rowStart) };
}

test('the connected-speech IPA shows between the sentence and its speaker row, labelled for hover and screen readers', () => {
  for (const layout of ['centered', 'split'] as const) {
    const { sentence, between } = parts(render({ layout, connectedIpa: IPA }));
    assert.ok(!sentence.includes(IPA), `${layout}: the line is outside the sentence's element, so it's no word to tap or select`);
    const line = between.match(/^<p ([^>]*)>([^<]*)<\/p>$/);
    assert.ok(line, `${layout}: one paragraph, ${between}`);
    const [, attributes, text] = line;
    assert.equal(text, IPA);
    assert.match(attributes, /role="note"/);
    assert.match(attributes, new RegExp(`title="${LABEL.replace(/[()]/g, '\\$&')}"`));
    assert.match(attributes, new RegExp(`aria-label="${LABEL.replace(/[()]/g, '\\$&')}"`));
  }
});

test('the IPA line takes the analysis page\'s IPA style, centred alone on the page and left-aligned beside a picture on md+', () => {
  const classOf = (layout: 'centered' | 'split') => parts(render({ layout, connectedIpa: IPA })).between.match(/class="([^"]*)"/)?.[1];
  assert.equal(classOf('centered'), 'mt-3 max-w-2xl mx-auto text-center font-mono text-sm sm:text-base leading-relaxed text-indigo-700 break-words');
  assert.equal(classOf('split'), 'mt-3 text-center md:text-left font-mono text-sm sm:text-base leading-relaxed text-indigo-700 break-words');
});

test('without the IPA nothing renders in its place, so the speaker row sits where it always has', () => {
  for (const layout of ['centered', 'split'] as const) {
    const without = render({ layout });
    assert.equal(parts(without).between, '', `${layout}: no element, empty or not`);
    assert.equal(render({ layout, connectedIpa: '' }), without);
    assert.equal(render({ layout, connectedIpa: undefined }), without);
    assert.ok(!without.includes(LABEL));
  }
});
