import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { createElement, type ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { HighlightedSentence } from '../../components/HighlightedSentence.tsx';
import { stripSentenceMarkers } from '../../services/sentenceMarkers.ts';
import type { StoredItem } from '../../types.ts';

type Props = Parameters<typeof HighlightedSentence>[0];

const saved = (word: string): StoredItem => ({ type: 'vocab', savedAt: 0, data: { id: word, word } }) as unknown as StoredItem;
const SAVED = new Map(['ice', 'break the ice'].map(word => [word, saved(word)]));
const findSaved = (term: string) => SAVED.get(term.toLowerCase().replace(/\s+/g, ' ').replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '')) ?? null;

let selection = '';
const hadWindow = 'window' in globalThis;
before(() => {
  (globalThis as { window?: unknown }).window = { getSelection: () => ({ toString: () => selection }) };
});
after(() => {
  if (!hadWindow) delete (globalThis as { window?: unknown }).window;
});

const render = (props: Props) => renderToStaticMarkup(createElement(HighlightedSentence, props));

// What the handlers read from an event, and what the tests read from a span.
interface FakeEvent { key?: string; preventDefault(): void; stopPropagation(): void }
type Span = ReactElement<{
  children?: unknown; role?: string; className?: string; onClick?: (event: FakeEvent) => void; onKeyDown?: (event: FakeEvent) => void;
}>;

// The memo's inner component has no hooks, so calling it returns the element tree to walk: the spans inside
// the selectable wrapper, in order.
function spans(props: Props): Span[] {
  const out: Span[] = [];
  const walk = (node: unknown) => {
    if (Array.isArray(node)) return node.forEach(walk);
    if (!node || typeof node !== 'object' || !('props' in node)) return;
    const element = node as Span;
    if (element.type === 'span') out.push(element);
    walk(element.props.children);
  };
  const wrapper = (HighlightedSentence as unknown as { type: (p: Props) => ReactElement<{ children: unknown }> }).type(props);
  walk(wrapper.props.children);
  return out;
}

const click = (element: Span) => {
  const calls: string[] = [];
  element.props.onClick!({ preventDefault: () => calls.push('preventDefault'), stopPropagation: () => calls.push('stopPropagation') });
  return calls;
};

test('in sentence review every word that can be looked up or opened carries its offset in the spoken text', () => {
  const text = 'Jokes {{break the ice}} — at [[parties]], ice-cold or not.';
  const html = render({ text, itemWord: 'break the ice', findSaved, onOpenCard: () => {}, onSearchWord: () => {}, searchAnyWord: true });
  const stripped = stripSentenceMarkers(text);
  const words = [...html.matchAll(/data-word-offset="(\d+)"[^>]*>([^<]*)</g)].map(([, offset, word]) => [Number(offset), word]);
  assert.deepEqual(words.map(([, word]) => word), ['Jokes', 'break the ice', 'at', 'parties', 'ice-cold', 'or', 'not.']);
  for (const [offset, word] of words) assert.equal(stripped.slice(Number(offset), Number(offset) + String(word).length), word);
  // Punctuation alone, the dash and the comma after the term, is plain text with nothing to look up.
  assert.match(html, /<\/span> — <span/);
  assert.match(html, /parties<\/span>, <span/);
});

test('word cards render the text whole: only [[terms]] look up, and nothing carries an offset', () => {
  const searched: string[] = [];
  const props: Props = { text: 'I {{need}} my [[espresso]], really need it.', itemWord: 'need', onSearchWord: term => searched.push(term) };
  const html = render(props);
  assert.doesNotMatch(html, /data-word-offset/);
  assert.equal(html.match(/role="button"/g)?.length, 1);
  const [item, term, legacy] = spans(props);
  assert.equal(item.props.onClick, undefined);
  assert.deepEqual(click(term), ['stopPropagation', 'preventDefault']);
  assert.deepEqual(searched, ['espresso']);
  // The unmarked 'need' later in the sentence is emphasized as the item too.
  assert.equal(legacy.props.children, 'need');
});

test('taps search the edge-trimmed word or open the saved card, and finishing a selection does neither', () => {
  const searched: string[] = [];
  const opened: string[] = [];
  const props: Props = {
    text: 'Thin ice, "please".',
    findSaved,
    onOpenCard: item => opened.push(item.data.id),
    onSearchWord: term => searched.push(term),
    searchAnyWord: true,
  };
  const [thin, ice, please] = spans(props);
  click(thin);
  click(ice);
  click(please);
  assert.deepEqual(searched, ['Thin', 'please']);
  assert.deepEqual(opened, ['ice']);

  selection = 'Thin ice';
  try {
    assert.deepEqual(click(thin), ['stopPropagation']);
    click(ice);
  } finally {
    selection = '';
  }
  assert.deepEqual(searched, ['Thin', 'please']);
  assert.deepEqual(opened, ['ice']);
});

test('without onSearchWord an unsaved [[term]] is emphasis only, and a saved one still opens on Enter', () => {
  const opened: string[] = [];
  const props: Props = { text: '[[gamut]] and [[ice]]', findSaved, onOpenCard: item => opened.push(item.data.id) };
  const [gamut, ice] = spans(props);
  assert.equal(gamut.props.role, undefined);
  assert.equal(gamut.props.onClick, undefined);
  assert.equal(ice.props.role, 'button');
  const calls: string[] = [];
  ice.props.onKeyDown!({ key: 'Enter', preventDefault: () => calls.push('preventDefault'), stopPropagation: () => calls.push('stopPropagation') });
  assert.deepEqual(calls, ['preventDefault', 'stopPropagation']);
  assert.deepEqual(opened, ['ice']);
});

test('an empty sentence renders nothing, and the wrapper keeps the text selectable', () => {
  assert.equal(render({ text: '' }), '');
  assert.equal(render({ text: 'Plain.' }), '<span class="sentence-selectable">Plain.</span>');
});

test('in a list row the studied item is emphasis only, saved or not, while dotted saved words still open their cards', () => {
  const opened: string[] = [];
  const row: Props = {
    text: 'Jokes {{break the ice}} at parties, on thin ice.',
    itemWord: 'break the ice',
    findSaved,
    onOpenCard: item => opened.push(item.data.id),
    onSearchWord: () => {},
    studiedItemInteractive: false,
  };
  const html = render(row);
  // The studied item keeps its emphasis and its offset, with no role or tab stop; the dotted 'ice' is still a button.
  assert.ok(html.includes('<span class="text-indigo-700 font-semibold bg-indigo-50 rounded px-0.5" data-word-offset="6">break the ice</span>'));
  assert.equal(html.match(/role="button"/g)?.length, 1);
  const [studied, ice] = spans(row).filter(span => span.props.children === 'break the ice' || span.props.children === 'ice.');
  assert.equal(studied.props.onClick, undefined);
  assert.equal(studied.props.onKeyDown, undefined);
  assert.equal(ice.props.role, 'button');
  click(ice);
  assert.deepEqual(opened, ['ice']);

  // Everywhere else (the sentence page) the saved studied item opens its card, as before.
  const page = spans({ ...row, studiedItemInteractive: undefined }).find(span => span.props.children === 'break the ice')!;
  assert.equal(page.props.role, 'button');
  click(page);
  assert.deepEqual(opened, ['ice', 'break the ice']);
});

test('an unsaved studied item that tap-any-word mode would look up stays plain when it is not interactive', () => {
  const searched: string[] = [];
  const props: Props = { text: 'I {{need}} it.', itemWord: 'need', onSearchWord: term => searched.push(term), searchAnyWord: true };
  const studied = (p: Props) => spans(p).find(span => span.props.children === 'need')!;
  const interactive = studied(props);
  assert.match(interactive.props.className!, /cursor-pointer/);
  click(interactive);
  assert.deepEqual(searched, ['need']);

  const plain = studied({ ...props, studiedItemInteractive: false });
  assert.equal(plain.props.onClick, undefined);
  assert.doesNotMatch(plain.props.className!, /cursor-pointer/);
});
