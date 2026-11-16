import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  MAX_SELECTION_WORDS, isSentenceSelection, pointInRects, selectionLookupTerm, type RectEdges,
} from '../../services/selectionLookup.ts';
import { useSelectionLookup } from '../../views/detail/useSelectionLookup.ts';
import type { StoredItem } from '../../types.ts';

// Looking up a phrase selected in a sentence, on a laptop: select it, then Cmd/Ctrl-click inside the selection.
// services/selectionLookup.ts decides what a selection looks up; views/detail/useSelectionLookup.ts reads it at
// pointerdown and hands it to the click.

test('a selection looks up its text with punctuation and quotes trimmed from its ends and its spaces collapsed', () => {
  assert.equal(selectionLookupTerm('ran the gamut', true), 'ran the gamut');
  assert.equal(selectionLookupTerm('“ran the gamut,”', true), 'ran the gamut');
  assert.equal(selectionLookupTerm(' ‘carry on’ ', true), 'carry on');
  assert.equal(selectionLookupTerm('—carry on…', true), 'carry on');
  assert.equal(selectionLookupTerm('ran\n  the\tgamut', true), 'ran the gamut');
  // Letters stay, accented ones too, and so do digits and straight apostrophes; inner punctuation is the phrase's.
  assert.equal(selectionLookupTerm('(touché!)', true), 'touché');
  assert.equal(selectionLookupTerm("rock 'n'", true), "rock 'n'");
  assert.equal(selectionLookupTerm('24/7.', true), '24/7');
  assert.equal(selectionLookupTerm('well, well', true), 'well, well');
});

test('a selection looks something up only with 1 to 6 words; a dash between words is no word', () => {
  const words = (n: number) => Array.from({ length: n }, (_, i) => `w${i + 1}`).join(' ');
  assert.equal(MAX_SELECTION_WORDS, 6);
  assert.equal(selectionLookupTerm(words(1), true), 'w1');
  assert.equal(selectionLookupTerm(words(6), true), words(6));
  assert.equal(selectionLookupTerm(words(7), true), null, 'seven words: the click looks up the word under it');
  assert.equal(selectionLookupTerm('w1 w2 — w3 w4 w5 w6', true), 'w1 w2 — w3 w4 w5 w6');
  for (const empty of ['', '   ', '—', '“ ”', '…!']) assert.equal(selectionLookupTerm(empty, true), null, JSON.stringify(empty));
});

test('a selection that isn\'t the sentence\'s looks nothing up', () => {
  assert.equal(selectionLookupTerm('ran the gamut', false), null);
});

/** A stand-in DOM node: contains() as Node.contains, which counts a node as containing itself. */
class FakeNode {
  readonly started: number[] = [];
  constructor(readonly name: string, readonly parent: FakeNode | null = null, readonly attributes: Record<string, string> = {}) {}
  contains(other: unknown): boolean {
    for (let node = other as FakeNode | null; node; node = node.parent) if (node === this) return true;
    return false;
  }
  animate(_keyframes: Keyframe[], options: KeyframeAnimationOptions) {
    this.started.push(Number(options.duration));
    return { cancel() {} };
  }
}

// The sentence page as SentenceHero renders it: the sentence's <p> with its words, the IPA line under it, then the row
// with the speaker. Text nodes are children of the words they're in.
const page = new FakeNode('banner');
const sentence = new FakeNode('p[data-sentence-hero]', page);
const ran = new FakeNode('ran', sentence, { 'data-word-offset': '10' });
const the = new FakeNode('the', sentence, { 'data-word-offset': '14' });
const gamut = new FakeNode('gamut', sentence, { 'data-word-offset': '18' });
const ranText = new FakeNode('#text ran', ran);
const gamutText = new FakeNode('#text gamut', gamut);
const ipaLine = new FakeNode('p[data-no-lookup]', page, { 'data-no-lookup': '' });
const ipaText = new FakeNode('#text ipa', ipaLine);
const speakerRow = new FakeNode('div', page);
const asNode = (node: FakeNode) => node as unknown as Node;

test('only a selection with both ends inside the sentence is the sentence\'s; one reaching the IPA line or beyond isn\'t', () => {
  const inSentence = (anchor: FakeNode | null, focus: FakeNode | null, root: FakeNode | null = sentence) =>
    isSentenceSelection(anchor && asNode(anchor), focus && asNode(focus), root);
  assert.equal(inSentence(ranText, gamutText), true);
  assert.equal(inSentence(gamutText, ranText), true, 'selected backwards');
  assert.equal(inSentence(sentence, gamutText), true, 'an end on the sentence element itself');
  assert.equal(inSentence(ranText, ipaText), false, 'dragged on into the IPA line');
  assert.equal(inSentence(ipaText, gamutText), false, 'started in the IPA line');
  assert.equal(inSentence(ipaText, ipaText), false, 'inside the IPA line');
  assert.equal(inSentence(ranText, speakerRow), false);
  assert.equal(inSentence(null, gamutText), false);
  assert.equal(inSentence(ranText, gamutText, null), false);
});

test('the pointer is on the selection when it lies on one of its line rects, give or take two pixels', () => {
  const lines: RectEdges[] = [{ left: 100, right: 300, top: 50, bottom: 80 }, { left: 0, right: 120, top: 80, bottom: 110 }];
  assert.equal(pointInRects(200, 60, lines), true);
  assert.equal(pointInRects(50, 100, lines), true, 'on its second line');
  assert.equal(pointInRects(302, 60, lines), true, 'a word\'s padding at the edge');
  assert.equal(pointInRects(303, 60, lines), false);
  assert.equal(pointInRects(50, 60, lines), false, 'beside the first line, before the selection starts');
  assert.equal(pointInRects(200, 60, []), false);
});

// The hook, in a server render, with the page's selection standing in for window.getSelection().

interface FakeSelection {
  text: string;
  anchor: FakeNode;
  focus: FakeNode;
  covers: FakeNode[];
  rects?: RectEdges[];
  collapsed?: boolean;
}
let current: FakeSelection | null = null;
const SELECTED_RECTS: RectEdges[] = [{ left: 100, right: 300, top: 50, bottom: 80 }];

const globals = globalThis as Record<string, unknown>;
const hadWindow = 'window' in globals;
before(() => {
  globals.window = {
    getSelection: () => current && {
      isCollapsed: !!current.collapsed,
      rangeCount: current.collapsed ? 0 : 1,
      anchorNode: current.anchor,
      focusNode: current.focus,
      toString: () => current!.text,
      getRangeAt: () => ({
        getClientRects: () => current!.rects ?? SELECTED_RECTS,
        intersectsNode: (node: FakeNode) => current!.covers.includes(node),
      }),
    },
  };
});
after(() => {
  if (!hadWindow) delete globals.window;
});

const sentenceElement = Object.assign(sentence, {
  querySelectorAll: (selector: string) => {
    assert.equal(selector, '[data-word-offset]');
    return [ran, the, gamut];
  },
});

/** The hook as sentence review wires it, recording what it opened and looked up. */
function phraseLookUp({ saved = null as StoredItem | null } = {}) {
  const asked: string[] = [];
  let hook: ReturnType<typeof useSelectionLookup> | undefined;
  const Probe = () => {
    hook = useSelectionLookup({
      findSaved: term => (saved && term === 'ran the gamut' ? saved : null),
      onOpenCard: item => { asked.push(`open ${item.data.id}`); },
      onSearch: term => { asked.push(`search ${term}`); },
    });
    return null;
  };
  renderToStaticMarkup(createElement(Probe));
  const pointerDown = (modifiers: { metaKey?: boolean; ctrlKey?: boolean }, at = { x: 200, y: 60 }) =>
    hook!.onPointerDownCapture({
      metaKey: false, ctrlKey: false, ...modifiers, clientX: at.x, clientY: at.y, currentTarget: sentenceElement,
    } as never);
  return { asked, pointerDown, lookUpSelection: () => hook!.lookUpSelection() };
}

const ranTheGamut: FakeSelection = { text: 'ran the gamut,', anchor: ranText, focus: gamutText, covers: [ran, the, gamut] };

test('Cmd or Ctrl-clicking inside a phrase selected in the sentence looks the phrase up once, flashing its words', (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 50_000 });
  for (const modifier of [{ metaKey: true }, { ctrlKey: true }]) {
    for (const word of [ran, the, gamut]) word.started.length = 0;
    current = ranTheGamut;
    const lookUp = phraseLookUp();
    lookUp.pointerDown(modifier);
    t.mock.timers.tick(150);
    assert.equal(lookUp.lookUpSelection(), true);
    assert.deepEqual(lookUp.asked, ['search ran the gamut']);
    assert.deepEqual([ran, the, gamut].map(word => word.started), [[450], [450], [450]]);
    // The click took it: a second click looks up the word under the pointer.
    assert.equal(lookUp.lookUpSelection(), false);
  }
  current = null;
});

test('a saved phrase opens its card instead of being looked up', (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 50_000 });
  current = ranTheGamut;
  const lookUp = phraseLookUp({ saved: { type: 'phrase', data: { id: 'gamut-card' }, savedAt: 1 } as unknown as StoredItem });
  lookUp.pointerDown({ metaKey: true });
  assert.equal(lookUp.lookUpSelection(), true);
  assert.deepEqual(lookUp.asked, ['open gamut-card']);
  current = null;
});

test('the click looks up the word as before without Cmd or Ctrl, a selection, a sentence\'s selection of 1–6 words, or the pointer on it', (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 50_000 });
  const cases: [string, FakeSelection | null, { metaKey?: boolean }, { x: number; y: number }?][] = [
    ['a plain click', ranTheGamut, {}],
    ['nothing selected', null, { metaKey: true }],
    ['a collapsed selection', { ...ranTheGamut, collapsed: true }, { metaKey: true }],
    ['a selection reaching the IPA line', { ...ranTheGamut, focus: ipaText }, { metaKey: true }],
    ['seven words', { ...ranTheGamut, text: 'her moods ran the gamut of emotions' }, { metaKey: true }],
    ['the pointer off the selection', ranTheGamut, { metaKey: true }, { x: 20, y: 60 }],
  ];
  for (const [name, selection, modifier, at] of cases) {
    current = selection;
    const lookUp = phraseLookUp();
    lookUp.pointerDown(modifier, at);
    assert.equal(lookUp.lookUpSelection(), false, name);
    assert.deepEqual(lookUp.asked, [], name);
  }
  current = null;
});

test('a click more than a second after its pointerdown, or after another pointerdown, looks up the word', (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 50_000 });
  current = ranTheGamut;
  const slow = phraseLookUp();
  slow.pointerDown({ metaKey: true });
  t.mock.timers.tick(1_001);
  assert.equal(slow.lookUpSelection(), false, 'held down too long');

  const again = phraseLookUp();
  again.pointerDown({ metaKey: true });
  again.pointerDown({});
  assert.equal(again.lookUpSelection(), false, 'the plain pointerdown dropped what the first one found');
  assert.deepEqual([...slow.asked, ...again.asked], []);
  current = null;
});
