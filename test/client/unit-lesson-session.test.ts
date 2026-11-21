import assert from 'node:assert/strict';
import test from 'node:test';
import { act, createElement, isValidElement, type ReactElement } from 'react';
import { createRoot } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import type { StoredItem } from '../../types.ts';
import type { DetailViewProps, SentenceReviewViewProps } from '../../views/detail/types.ts';
import { installFakeMedia } from '../support/audio/fakeMedia.ts';
import { sentenceItem, vocabItem } from '../support/loop-fixtures.ts';

// A Today unit's session from the plan to the review: App's handleViewSentence keeps the unit's options on the detail
// context (hooks/useDetailView.ts), App hands them to DetailView (test/client/today-view.test.ts reads that from its
// source), DetailView to the sentence lesson, and the lesson's Got it, on the sentence page and on the analysis page
// alike, records its review with the session, which useReviewOutbox puts on the event the outbox sends. Without it a
// unit's Got its would count toward neither the day's goal nor the streak, here or on the server, for good.
//
// The window here carries just enough of a browser for the lesson's modules and React, as in
// detail-auto-play-reader.test.ts: its auto-play settings listen on the window as they load.

installFakeMedia();
const page = Object.assign(new EventTarget(), { nodeType: 9, activeElement: null, defaultView: null as unknown, querySelector: () => null });
const browser = Object.assign(new EventTarget(), (globalThis as unknown as { window: object }).window, {
  document: page, event: undefined, HTMLIFrameElement: class {},
});
page.defaultView = browser;
Object.assign(globalThis, { window: browser, document: page, IS_REACT_ACT_ENVIRONMENT: true });

const { DetailView } = await import('../../views/DetailView.tsx');
const { SentenceReviewView } = await import('../../views/detail/SentenceReviewView.tsx');
const { SentenceActionsRow } = await import('../../views/detail/SentenceActionsRow.tsx');
const { SentenceAnalysisView } = await import('../../components/SentenceAnalysisView.tsx');
const { useDetailView } = await import('../../hooks/useDetailView.ts');
type DetailViewState = ReturnType<typeof useDetailView>;

const CARD = vocabItem('w1', 'come clean');
const SENTENCE = sentenceItem('s1', 'He finally {{came clean}}.', { sourceWord: 'come clean' });

/** The first element in a render's tree that `match` accepts. */
type ElementLike = { type?: unknown; props?: Record<string, unknown> & { children?: unknown } };
function findElement(node: unknown, match: (node: ElementLike) => boolean): (ElementLike & { props: Record<string, unknown> }) | null {
  if (!node || typeof node !== 'object') return null;
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = findElement(child, match);
      if (found) return found;
    }
    return null;
  }
  const element = node as ElementLike;
  if (element.props && match(element)) return element as ElementLike & { props: Record<string, unknown> };
  return findElement(element.props?.children, match);
}

/**
 * The Got its the lesson DetailView opens with `options` offers, on the sentence page's row and on the analysis page,
 * its hooks run by a probe, and the calls they make to onUpdateSRS.
 */
function lessonGotIts(options: Pick<DetailViewProps, 'reviewSessionId' | 'sentenceExitLabel'>) {
  const calls: unknown[][] = [];
  const props: DetailViewProps = {
    groups: [{ title: 'come clean', items: [CARD] }], initialGroupIndex: 0, sentenceItems: [SENTENCE], ...options,
    onClose: () => {}, onSave: () => {}, onPatchItem: () => {}, onRemoveFromView: () => {}, onDelete: () => {},
    savedItems: [CARD], savedSentenceItems: [SENTENCE], onSearch: () => {}, isVocabSaved: () => true,
    onUpdateSRS: (...args) => { calls.push(args); },
  };
  const element = DetailView(props);
  assert.ok(isValidElement(element) && element.type === SentenceReviewView, 'DetailView opens the sentence lesson');
  let tree: unknown;
  const Probe = () => {
    tree = SentenceReviewView((element as ReactElement<SentenceReviewViewProps>).props);
    return null;
  };
  renderToStaticMarkup(createElement(Probe));
  const row = findElement(tree, node => node.type === SentenceActionsRow);
  const analysis = findElement(tree, node => node.type === SentenceAnalysisView);
  assert.ok(row && analysis, 'the sentence page\'s row and the analysis page');
  return { row: row.props.onRemember as () => void, analysis: analysis.props.onRemember as () => void, calls };
}

test('Got it in a unit\'s lesson, on the sentence page and on the analysis page, records its review in the unit\'s session', () => {
  const unit = lessonGotIts({ reviewSessionId: 'set:unit-1', sentenceExitLabel: 'Today' });
  assert.equal(unit.analysis, unit.row, 'both pages press the one Got it, which R and a double tap press too');
  unit.row();
  assert.deepEqual(unit.calls, [['s1', 'good', { sessionId: 'set:unit-1' }]]);

  // The Sentences tab's lesson records a plain Got it.
  const plain = lessonGotIts({});
  plain.analysis();
  assert.deepEqual(plain.calls, [['s1', 'good', undefined]]);
});

test('opening sentences with a unit\'s options keeps them on the detail context; any other opening carries none', async () => {
  const container = Object.assign(new EventTarget(), {
    nodeType: 1, nodeName: 'DIV', tagName: 'DIV', namespaceURI: 'http://www.w3.org/1999/xhtml', ownerDocument: page, textContent: '',
  });
  const items: StoredItem[] = [CARD, SENTENCE];
  let detail: DetailViewState | undefined;
  const Probe = () => {
    detail = useDetailView({ libraryWords: [CARD], sentenceItemsById: new Map([[SENTENCE.data.id, SENTENCE]]) }, { latestItemsRef: { current: items } });
    return null;
  };
  const root = createRoot(container as unknown as Element);
  try {
    await act(() => root.render(createElement(Probe)));
    await act(() => detail!.handleViewSentence([SENTENCE], 0, { reviewSessionId: 'set:unit-1', exitLabel: 'Today' }));
    assert.equal(detail!.detailContext?.reviewSessionId, 'set:unit-1');
    assert.equal(detail!.detailContext?.exitLabel, 'Today');
    assert.deepEqual(detail!.detailContext?.sentenceItems, [SENTENCE]);

    await act(() => detail!.handleViewSentence([SENTENCE], 0));
    assert.equal(detail!.detailContext?.reviewSessionId, undefined);
    assert.equal(detail!.detailContext?.exitLabel, undefined);
  } finally {
    await act(() => root.unmount());
  }
});
