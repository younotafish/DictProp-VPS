import assert from 'node:assert/strict';
import test from 'node:test';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { sentenceSourceResolver, syntheticSourceItem } from '../../services/sentenceSource.ts';
import type { StoredItem, VocabCard } from '../../types.ts';
import { useExampleSentencePreview } from '../../views/detail/useExampleSentencePreview.ts';
import { indexSavedSentences } from '../../views/detail/useSavedSentenceIndex.ts';

const card = (id: string, word: string, sense: string, forms: string[] = [], extra: { isDeleted?: boolean } = {}): StoredItem =>
  ({ type: 'vocab', savedAt: 1, data: { id, word, sense, forms } as Partial<VocabCard>, ...extra }) as unknown as StoredItem;

test('a sentence opens the card with its word and sense, else the first card with its word', () => {
  const find = sentenceSourceResolver([
    card('fast', 'making time', 'idiom: progressing at a good speed'),
    card('busy', 'Making Time', 'idiom: finding time despite a busy schedule'),
  ]);
  assert.equal(find('making time', 'idiom: finding time despite a busy schedule')?.data.id, 'busy');
  assert.equal(find(' Making time ', 'a sense no card has')?.data.id, 'fast');
  assert.equal(find('making time')?.data.id, 'fast');
});

test('a word saved in an inflected form reaches the card renamed to its base form through its forms', () => {
  const find = sentenceSourceResolver([
    card('speed', 'make time', 'idiom: progress quickly', ['makes time', 'made time, making time']),
    card('busy', 'make time', 'idiom: find time despite a busy schedule', ['makes time', 'made time', 'making time']),
    card('work', 'work with', 'phrasal verb: collaborate', ['works with', 'worked with', 'working with']),
  ]);
  assert.equal(find('making time', 'idiom: find time despite a busy schedule')?.data.id, 'busy');
  assert.equal(find('Making time', 'idiom: finding time for something')?.data.id, 'speed', 'without its sense, the first card that lists the form');
  assert.equal(find('working with', 'phrasal verb: collaborating or cooperating')?.data.id, 'work');
});

test('a card spelled as the word wins over one that lists it as a form', () => {
  const find = sentenceSourceResolver([
    card('leave', 'leave', 'verb: go away', ['leaves', 'left', 'leaving']),
    card('left', 'left', 'adjective: on the west side'),
  ]);
  assert.equal(find('left')?.data.id, 'left');
});

test('deleted cards, other item types and unknown words find nothing', () => {
  const find = sentenceSourceResolver([
    card('gone', 'make time', 'idiom', ['making time'], { isDeleted: true }),
    { type: 'phrase', savedAt: 1, data: { id: 'p', query: 'making time' } } as unknown as StoredItem,
  ]);
  assert.equal(find('making time'), undefined);
  assert.equal(find('make time'), undefined);
  assert.equal(find(''), undefined);
  assert.equal(find(undefined), undefined);
});

test('a sentence whose word is gone opens on a stand-in card with the word, the sense and the sentence as its example', () => {
  const stand = syntheticSourceItem('s9', 'ephemeral', 'adjective: brief', 'An ephemeral fame.');
  assert.equal(stand.type, 'vocab');
  assert.equal(stand.data.id, 'sentence-src:s9');
  assert.equal(stand.srs.id, 'sentence-src:s9');
  const vocab = stand.data as { word: string; sense?: string; examples: string[] };
  assert.deepEqual([vocab.word, vocab.sense, vocab.examples], ['ephemeral', 'adjective: brief', ['An ephemeral fame.']]);
  assert.equal((syntheticSourceItem('s9', '', undefined, 'x').data as { word: string }).word, '(unknown word)');
});

test("an example opened from a word card finds its source card as a saved sentence's lesson does, else opens on a stand-in", async () => {
  const items = [
    card('speed', 'make time', 'idiom: progress quickly', ['makes time', 'made time, making time']),
    card('busy', 'make time', 'idiom: find time despite a busy schedule', ['makes time', 'made time', 'making time']),
  ];
  let preview: ReturnType<typeof useExampleSentencePreview> | undefined;
  const Preview = () => {
    preview = useExampleSentencePreview({
      onOpenExampleSentence: () => null,
      savedItemsRef: { current: items },
      savedSentenceIndex: indexSavedSentences([]),
      stopAutoPlay: () => {},
    });
    return null;
  };
  // Just enough of a browser for React to render a component that draws nothing (as in use-now.test.ts).
  const page = Object.assign(new EventTarget(), { nodeType: 9, activeElement: null, defaultView: null as unknown });
  const browser = { document: page, event: undefined, HTMLIFrameElement: class {} };
  page.defaultView = browser;
  const globals = globalThis as Record<string, unknown>;
  Object.assign(globals, { window: browser, document: page, IS_REACT_ACT_ENVIRONMENT: true });
  try {
    const container = Object.assign(new EventTarget(), {
      nodeType: 1, nodeName: 'DIV', tagName: 'DIV', namespaceURI: 'http://www.w3.org/1999/xhtml', ownerDocument: page, textContent: '',
    });
    const root = createRoot(container as unknown as Element);
    await act(() => root.render(createElement(Preview)));
    const sourceOf = async (text: string, word: string, sense?: string) => {
      await act(() => preview!.openExampleSentencePreview(text, word, sense));
      const opened = preview!.exampleSentencePreview!;
      return { source: opened.sourceGroup.items[0], sentenceId: opened.sentence.data.id };
    };

    // A word no card is spelled as reaches the card that lists it among its forms, matching the sense first.
    assert.equal((await sourceOf('Making time for friends matters.', 'making time', 'idiom: find time despite a busy schedule')).source.data.id, 'busy');
    assert.equal((await sourceOf('We are making time.', 'making time')).source.data.id, 'speed');
    // A word no card has opens on the stand-in, with the sentence as its example.
    const stand = await sourceOf('A fleeting fame.', 'fleeting', 'adjective: brief');
    assert.equal(stand.source.data.id, `sentence-src:${stand.sentenceId}`);
    assert.deepEqual((stand.source.data as VocabCard).examples, ['A fleeting fame.']);
    await act(() => root.unmount());
  } finally {
    delete globals.window;
    delete globals.document;
    delete globals.IS_REACT_ACT_ENVIRONMENT;
  }
});
