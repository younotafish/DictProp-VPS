import assert from 'node:assert/strict';
import test from 'node:test';
import { act, createElement, isValidElement, useLayoutEffect, type ReactElement, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import ts from 'typescript';
import type { ItemGroup, SentenceData, StoredItem, VocabCard } from '../../types.ts';
import { SRSAlgorithm } from '../../services/srsAlgorithm.ts';
import { followShownCard, useCardNavigation, type CardKeys } from '../../views/detail/useCardNavigation.ts';
import { ExampleSentencePreview } from '../../views/detail/ExampleSentencePreview.tsx';
import { SentenceReviewView } from '../../views/detail/SentenceReviewView.tsx';
import type { DetailViewBodyProps, SentenceReviewViewProps } from '../../views/detail/types.ts';
import { readRepoFile } from '../support/paths.ts';

// Where the card view is in its cards (views/detail/useCardNavigation.ts) when a delete, an archive or an undo changes
// them under it, here or on another device: it stays on the card it shows, and only when that card itself leaves does
// another take its place.

const at = (groupIndex: number, itemIndex = 0) => ({ groupIndex, itemIndex });
const words = (...ids: string[]): CardKeys => ids.map(id => [id]);

test('a card that leaves before the one on screen moves it up, and the view goes with it', () => {
  // Word 5 of six, "e"; word "b" is deleted on another device.
  assert.deepEqual(followShownCard(words('a', 'b', 'c', 'd', 'e', 'f'), words('a', 'c', 'd', 'e', 'f'), at(4)), { ...at(3), replaced: false });
  // Meaning 2 of "bank"; meaning 1 goes.
  assert.deepEqual(followShownCard([['bank:1', 'bank:2', 'bank:3'], ['cat']], [['bank:2', 'bank:3'], ['cat']], at(0, 1)), { ...at(0, 0), replaced: false });
  // Two earlier words go at once.
  assert.deepEqual(followShownCard(words('a', 'b', 'c', 'd', 'e', 'f', 'g'), words('b', 'd', 'e', 'f', 'g'), at(4)), { ...at(2), replaced: false });
});

test('a card that leaves after the one on screen, or a sync of its contents, moves nothing', () => {
  assert.deepEqual(followShownCard(words('a', 'b', 'c'), words('a', 'b'), at(1)), { ...at(1), replaced: false });
  assert.deepEqual(followShownCard([['bank:1', 'bank:2', 'bank:3']], [['bank:1', 'bank:2']], at(0, 1)), { ...at(0, 1), replaced: false });
  assert.deepEqual(followShownCard(words('a', 'b'), words('a', 'b'), at(1)), { ...at(1), replaced: false });
});

test('a card put back before the one on screen, as an undo does, moves it down, and the view goes with it', () => {
  assert.deepEqual(followShownCard(words('a', 'c', 'd'), words('a', 'b', 'c', 'd'), at(1)), { ...at(2), replaced: false });
  assert.deepEqual(followShownCard([['bank:2', 'bank:3']], [['bank:1', 'bank:2', 'bank:3']], at(0, 0)), { ...at(0, 1), replaced: false });
});

test('when the card on screen leaves, the next meaning of its word takes its place, or the one before after the last', () => {
  const bank = [['bank:1', 'bank:2', 'bank:3'], ['cat']];
  assert.deepEqual(followShownCard(bank, [['bank:1', 'bank:3'], ['cat']], at(0, 1)), { ...at(0, 1), replaced: true });
  assert.deepEqual(followShownCard(bank, [['bank:1', 'bank:2'], ['cat']], at(0, 2)), { ...at(0, 1), replaced: true });
  // With a word before it gone too, the meaning still takes the place, one word up.
  assert.deepEqual(followShownCard([['ant'], ...bank], [['bank:1', 'bank:3'], ['cat']], at(1, 1)), { ...at(0, 1), replaced: true });
});

test('when its whole word leaves, the next word takes its place at its first meaning, or the word before after the last', () => {
  assert.deepEqual(followShownCard(words('a', 'b', 'c'), words('a', 'c'), at(1)), { ...at(1), replaced: true });
  assert.deepEqual(followShownCard([['a'], ['bank:1', 'bank:2'], ['cat:1', 'cat:2']], [['a'], ['cat:1', 'cat:2']], at(1, 1)), { ...at(1, 0), replaced: true });
  assert.deepEqual(followShownCard([['ant:1', 'ant:2'], ['b']], [['ant:1', 'ant:2']], at(1)), { ...at(0, 0), replaced: true });
  // The card on screen and two before it go at once: the card after it takes the place, three words up.
  assert.deepEqual(followShownCard(words('a', 'b', 'c', 'd', 'e', 'f'), words('a', 'b', 'f'), at(4)), { ...at(2), replaced: true });
  // A later word gone with it doesn't count: the first one left after it does.
  assert.deepEqual(followShownCard(words('a', 'b', 'c', 'd'), words('a', 'd'), at(1)), { ...at(1), replaced: true });
});

test('indices that outran the cards are read as the card they showed, the last one', () => {
  assert.deepEqual(followShownCard(words('a', 'b', 'c'), words('b', 'c'), at(7)), { ...at(1), replaced: false });
  assert.deepEqual(followShownCard([['bank:1', 'bank:2']], [['bank:2']], at(0, 5)), { ...at(0, 0), replaced: false });
});

const card = (id: string): StoredItem => ({
  type: 'vocab',
  data: { id, word: id.split(':')[0], examples: [] } as Partial<VocabCard> as VocabCard,
  savedAt: 1,
  srs: SRSAlgorithm.createNew(id, 'vocab', 0),
});
const group = (...items: StoredItem[]): ItemGroup => ({ title: items[0].data.id.split(':')[0], items });

interface ViewProps {
  groups: ItemGroup[];
  /** Sentence review's sentence ids, one per group; none for the word card. */
  sentenceIds?: readonly string[];
  initialGroupIndex: number;
  initialItemIndex?: number;
  navigationKey?: number;
}

/**
 * Renders useCardNavigation in a component that draws nothing, with just enough of a browser for React, as in
 * detail-gone-items.test.ts. Every commit notes what it showed: the card's id, or in sentence review the sentence's.
 * `scroller` stands for the card's scroller.
 */
async function navigationHarness() {
  const page = Object.assign(new EventTarget(), { nodeType: 9, activeElement: null, defaultView: null as unknown, querySelector: () => null });
  const browser = Object.assign(new EventTarget(), { document: page, event: undefined, HTMLIFrameElement: class {} });
  page.defaultView = browser;
  const globals = globalThis as Record<string, unknown>;
  Object.assign(globals, { window: browser, document: page, IS_REACT_ACT_ENVIRONMENT: true });
  const container = Object.assign(new EventTarget(), {
    nodeType: 1, nodeName: 'DIV', tagName: 'DIV', namespaceURI: 'http://www.w3.org/1999/xhtml', ownerDocument: page, textContent: '',
  });
  const root = createRoot(container as unknown as Element);
  const scroller = { scrollTop: 0 };
  const scrollContainerRef = { current: scroller as unknown as HTMLElement };
  const shown: string[] = [];
  let navigation: ReturnType<typeof useCardNavigation> | undefined;
  const View = ({ groups, sentenceIds, initialGroupIndex, initialItemIndex = 0, navigationKey }: ViewProps) => {
    const nav = useCardNavigation(groups, {
      initialGroupIndex, initialItemIndex, navigationKey, scrollContainerRef,
      ...(sentenceIds ? { sentenceReview: true as const, sentenceIds } : { sentenceReview: false as const }),
    });
    navigation = nav;
    useLayoutEffect(() => {
      shown.push(sentenceIds ? sentenceIds[Math.min(nav.currentGroupIndex, sentenceIds.length - 1)] : nav.currentItem.data.id);
    });
    return null;
  };
  return {
    scroller,
    navigation: () => navigation!,
    show: (props: ViewProps) => act(() => root.render(createElement(View, props))),
    /** What the commits since the last call showed. */
    takeShown: () => shown.splice(0),
    close: async () => {
      await act(() => root.unmount());
      delete globals.window;
      delete globals.document;
      delete globals.IS_REACT_ACT_ENVIRONMENT;
    },
  };
}

test('a word deleted before the one on screen leaves that card on screen, unscrolled, and every commit shows it', async () => {
  const view = await navigationHarness();
  try {
    const [a, b, c, d, e, f] = ['a', 'b', 'c', 'd', 'e', 'f'].map(id => group(card(id)));
    await view.show({ groups: [a, b, c, d, e, f], initialGroupIndex: 4 });
    view.scroller.scrollTop = 120;
    view.takeShown();
    // Another device deleted "b": App takes it out of the view.
    await view.show({ groups: [a, c, d, e, f], initialGroupIndex: 4 });
    assert.deepEqual([...new Set(view.takeShown())], ['e'], 'no commit shows another card');
    assert.equal(view.navigation().currentGroupIndex, 3);
    assert.equal(view.scroller.scrollTop, 120, 'the reader keeps their place');

    // Now "e" itself goes: "f" takes its place, from its top.
    await view.show({ groups: [a, c, d, f], initialGroupIndex: 3 });
    assert.deepEqual([...new Set(view.takeShown())], ['f']);
    assert.equal(view.scroller.scrollTop, 0);
  } finally {
    await view.close();
  }
});

test('the card on screen deleted with two before it, as one pull brings them, gives its place to the card after it', async () => {
  const view = await navigationHarness();
  try {
    const [a, b, c, d, e, f, g, h] = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'].map(id => group(card(id)));
    await view.show({ groups: [a, b, c, d, e, f, g, h], initialGroupIndex: 4 });
    view.scroller.scrollTop = 80;
    view.takeShown();
    await view.show({ groups: [a, d, f, g, h], initialGroupIndex: 2 });
    assert.deepEqual([...new Set(view.takeShown())], ['f']);
    assert.equal(view.navigation().currentGroupIndex, 2);
    assert.equal(view.scroller.scrollTop, 0);
  } finally {
    await view.close();
  }
});

test('an earlier meaning deleted keeps the meaning on screen and its place; a later one changes nothing', async () => {
  const view = await navigationHarness();
  try {
    const [one, two, three] = ['bank:1', 'bank:2', 'bank:3'].map(card);
    const cat = group(card('cat'));
    await view.show({ groups: [group(one, two, three), cat], initialGroupIndex: 0, initialItemIndex: 1 });
    view.scroller.scrollTop = 60;
    view.takeShown();
    await view.show({ groups: [group(two, three), cat], initialGroupIndex: 0, initialItemIndex: 1 });
    await view.show({ groups: [group(two), cat], initialGroupIndex: 0, initialItemIndex: 0 });
    assert.deepEqual([...new Set(view.takeShown())], ['bank:2']);
    assert.equal(view.navigation().currentItemIndex, 0);
    assert.equal(view.scroller.scrollTop, 60);
  } finally {
    await view.close();
  }
});

test('in sentence review an earlier sentence of the same word leaving keeps the sentence on screen', async () => {
  const view = await navigationHarness();
  try {
    // Three sentences of "river" share its source card; the fourth is "apple"'s.
    const river = group(card('river'));
    const apple = group(card('apple'));
    await view.show({ groups: [river, river, river, apple], sentenceIds: ['s1', 's2', 's3', 's4'], initialGroupIndex: 2 });
    view.scroller.scrollTop = 40;
    view.takeShown();
    await view.show({ groups: [river, river, apple], sentenceIds: ['s2', 's3', 's4'], initialGroupIndex: 2 });
    assert.deepEqual([...new Set(view.takeShown())], ['s3']);
    assert.equal(view.navigation().currentGroupIndex, 1);
    assert.equal(view.scroller.scrollTop, 40);

    // The sentence on screen goes: the next one takes its place.
    await view.show({ groups: [river, apple], sentenceIds: ['s2', 's4'], initialGroupIndex: 1 });
    assert.deepEqual([...new Set(view.takeShown())], ['s4']);
  } finally {
    await view.close();
  }
});

test('an undo that puts the deleted card back moves the view to it, and a move still opens a word at its top', async () => {
  const view = await navigationHarness();
  try {
    const [a, b, c, d] = ['a', 'b', 'c', 'd'].map(id => group(card(id)));
    await view.show({ groups: [a, b, c, d], initialGroupIndex: 1 });
    // "b" is deleted here: "c" takes its place.
    await view.show({ groups: [a, c, d], initialGroupIndex: 1 });
    assert.deepEqual([...new Set(view.takeShown())], ['b', 'c']);
    view.scroller.scrollTop = 50;
    // Undo puts it back and moves the view to it (useUndoOffer).
    await view.show({ groups: [a, b, c, d], initialGroupIndex: 1, navigationKey: 1 });
    const commits = view.takeShown();
    assert.equal(commits.at(-1), 'b');
    assert.ok(commits.every(id => id === 'b' || id === 'c'), `only "c", then "b": ${commits.join(', ')}`);
    assert.equal(view.navigation().currentGroupIndex, 1);
    assert.equal(view.scroller.scrollTop, 0);

    view.scroller.scrollTop = 30;
    await act(() => view.navigation().setCurrentGroupIndex(index => index + 1));
    assert.deepEqual(view.takeShown(), ['c']);
    assert.equal(view.scroller.scrollTop, 0);
  } finally {
    await view.close();
  }
});

test('the key of the card on screen stays while the card only moves, and changes when another takes its place', async () => {
  const words = await navigationHarness();
  try {
    const [a, b, c, d] = ['a', 'b', 'c', 'd'].map(id => group(card(id)));
    await words.show({ groups: [a, b, c, d], initialGroupIndex: 2 });
    assert.equal(words.navigation().shownKey, 'c');
    await words.show({ groups: [b, c, d], initialGroupIndex: 2 });
    assert.equal(words.navigation().shownKey, 'c', 'a word before it left');
    await words.show({ groups: [b, d], initialGroupIndex: 1 });
    assert.equal(words.navigation().shownKey, 'd', 'it left, and the next word took its place');
  } finally {
    await words.close();
  }
  // In sentence review it's the sentence's key, though sentences of one word share its source card.
  const sentences = await navigationHarness();
  try {
    const river = group(card('river'));
    await sentences.show({ groups: [river, river, river], sentenceIds: ['s1', 's2', 's3'], initialGroupIndex: 1 });
    assert.equal(sentences.navigation().shownKey, 's2');
    await sentences.show({ groups: [river, river], sentenceIds: ['s2', 's3'], initialGroupIndex: 1 });
    assert.equal(sentences.navigation().shownKey, 's2');
  } finally {
    await sentences.close();
  }
});

/** The SentenceReviewView element in `node`, found through each element's children. */
function sentenceReviewIn(node: ReactNode): ReactElement<SentenceReviewViewProps> | undefined {
  if (Array.isArray(node)) return node.map(sentenceReviewIn).find(Boolean);
  if (!isValidElement<{ children?: ReactNode }>(node)) return undefined;
  if (node.type === SentenceReviewView) return node as ReactElement<SentenceReviewViewProps>;
  return sentenceReviewIn(node.props.children);
}

test('Save sentence in a word card\'s example keeps the sentence page where it was scrolled, as does the save going away', async () => {
  const source = group(card('come clean'));
  const preview: StoredItem = {
    type: 'sentence',
    data: { id: 'sentence-preview:7f3a', text: 'He finally came clean.', sourceWord: 'come clean' },
    savedAt: 1,
    srs: SRSAlgorithm.createNew('sentence-preview:7f3a', 'sentence', 0),
  };
  // After Save sentence the preview shows the saved copy merged over it (useExampleSentencePreview), under the saved
  // copy's new id.
  const savedCopy: StoredItem = { ...preview, data: { ...(preview.data as SentenceData), id: 'b1e4c9d2' }, srs: SRSAlgorithm.createNew('b1e4c9d2', 'sentence', 0) };
  // ExampleSentencePreview uses no hooks, so it's called as a function and the review it renders is read from it.
  const review = (sentence: StoredItem, saved: boolean) => {
    const element = sentenceReviewIn(ExampleSentencePreview({
      viewProps: {} as DetailViewBodyProps, requestId: 3, sourceGroup: source, sentence, saved, onClose: () => {},
    }));
    assert.ok(element, 'the preview renders a sentence review');
    return element.props;
  };
  const before = review(preview, false);
  const after = review(savedCopy, true);
  assert.notEqual(after.sentenceItems[0].data.id, before.sentenceItems[0].data.id, 'the sentence takes the saved copy\'s id');
  assert.ok(before.followIds, 'the review follows the example by a key of its own');
  assert.deepEqual(after.followIds, before.followIds, 'which the save keeps');

  // The view follows the run by those keys, as sentence review does (pinned below).
  const view = await navigationHarness();
  try {
    await view.show({ groups: [source], sentenceIds: before.followIds, initialGroupIndex: 0 });
    view.scroller.scrollTop = 200;
    view.takeShown();
    const shownKey = view.navigation().shownKey;
    await view.show({ groups: [source], sentenceIds: after.followIds, initialGroupIndex: 0 });
    assert.equal(view.scroller.scrollTop, 200, 'Save sentence leaves the page where it was');
    assert.equal(view.navigation().shownKey, shownKey, 'and auto-play\'s read, which starts again only for another key');
    // The saved copy deleted on another device turns back into the preview, which stays open.
    await view.show({ groups: [source], sentenceIds: before.followIds, initialGroupIndex: 0 });
    assert.equal(view.scroller.scrollTop, 200);
    assert.deepEqual([...new Set(view.takeShown())], before.followIds);
  } finally {
    await view.close();
  }
});

test('sentence review follows its run by the caller\'s followIds when given, and by the sentences\' ids otherwise', () => {
  const file = ts.createSourceFile(
    'SentenceReviewView.tsx', readRepoFile('views/detail/SentenceReviewView.tsx'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX,
  );
  const declared = new Map<string, ts.Expression>();
  const navigationOptions: ts.ObjectLiteralExpression[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) declared.set(node.name.text, node.initializer);
    if (ts.isCallExpression(node) && node.expression.getText() === 'useCardNavigation') {
      const options = node.arguments[1];
      if (options && ts.isObjectLiteralExpression(options)) navigationOptions.push(options);
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  assert.equal(navigationOptions.length, 1, 'the view moves through its run with useCardNavigation');
  const followed = navigationOptions[0].properties.find(property => property.name?.getText() === 'sentenceIds');
  assert.ok(followed && ts.isShorthandPropertyAssignment(followed), 'and hands it the view\'s sentenceIds');
  const memo = declared.get('sentenceIds');
  assert.ok(memo && ts.isCallExpression(memo) && memo.expression.getText() === 'useMemo');
  const compute = memo.arguments[0];
  assert.ok(compute && ts.isArrowFunction(compute));
  assert.equal(compute.body.getText().replace(/\s+/g, ' '), 'followIds ?? sentenceItems.map(item => item.data.id)');
});
