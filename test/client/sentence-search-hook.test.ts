import assert from 'node:assert/strict';
import { after, before, beforeEach, test, type TestContext } from 'node:test';
import Fuse from 'fuse.js';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { FUZZY_DELAY_MS, sentenceSearchResults, useSentenceSearch, type SentenceSearch } from '../../hooks/useSentenceSearch.ts';
import { buildSentenceIndex, searchSentencesLiteral } from '../../services/sentenceSearch.ts';
import { SRSAlgorithm } from '../../services/srsAlgorithm.ts';
import type { StoredItem } from '../../types.ts';

function sentence(id: string, text: string): StoredItem {
  return { type: 'sentence', savedAt: 0, data: { id, text, sourceWord: '' }, srs: SRSAlgorithm.createNew(id, 'sentence') };
}
const ids = (items: readonly StoredItem[]) => items.map(item => item.data.id).sort();

const APPLES = [
  sentence('a', 'An apple a day keeps the doctor away.'),
  sentence('b', 'Apples are sweet.'),
  sentence('c', 'He ate an apple pie.'),
];

test('the literal tiers answer at once; a literal miss is pending, with no list, until the fuzzy tier answers that very query', () => {
  const index = buildSentenceIndex(APPLES);
  const literal = searchSentencesLiteral('apple', index);
  assert.deepEqual(sentenceSearchResults({ literal, fuzzy: null, query: 'apple' }), { results: literal, pending: false });

  const miss = searchSentencesLiteral('appke', index);
  assert.equal(miss, null);
  assert.deepEqual(sentenceSearchResults({ literal: miss, fuzzy: null, query: 'appke' }), { results: [], pending: true });
  const answer = { query: 'appke', limit: undefined, results: [APPLES[1]] };
  assert.deepEqual(sentenceSearchResults({ literal: miss, fuzzy: answer, query: 'appke' }), { results: [APPLES[1]], pending: false });

  // An answer to another query, or to the same one under another limit, never shows.
  assert.deepEqual(sentenceSearchResults({ literal: null, fuzzy: answer, query: 'appkes' }), { results: [], pending: true });
  assert.deepEqual(sentenceSearchResults({ literal: null, fuzzy: answer, query: 'appke', limit: 6 }), { results: [], pending: true });
  // A blank query matches nothing, and isn't waiting for anything.
  assert.deepEqual(sentenceSearchResults({ literal: searchSentencesLiteral('  ', index), fuzzy: null, query: '  ' }), { results: [], pending: false });
});

// Just enough of a browser for React to render a component that draws nothing (as in use-now.test.ts).
const page = Object.assign(new EventTarget(), { nodeType: 9, activeElement: null, defaultView: null as unknown });
const browser = { document: page, event: undefined, HTMLIFrameElement: class {} };
page.defaultView = browser;
const globals = globalThis as Record<string, unknown>;

// The fuzzy tier's scans, counted at Fuse's search, which nothing else calls.
let scans = 0;
const fuseSearch = Fuse.prototype.search;
before(() => {
  Object.assign(globals, { window: browser, document: page, IS_REACT_ACT_ENVIRONMENT: true });
  Fuse.prototype.search = function (this: Fuse<unknown>, ...args: Parameters<typeof fuseSearch>) {
    scans++;
    return fuseSearch.apply(this, args);
  } as typeof fuseSearch;
});
after(() => {
  Fuse.prototype.search = fuseSearch;
  delete globals.window;
  delete globals.document;
  delete globals.IS_REACT_ACT_ENVIRONMENT;
});
beforeEach(() => {
  scans = 0;
});

interface SearchProps {
  items: readonly StoredItem[];
  query: string;
  limit?: number;
}

/** A component searching with useSentenceSearch, on a clock the test moves. */
async function mountSearch(t: TestContext, initial: SearchProps) {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const shown: SentenceSearch[] = [];
  const Search = ({ items, query, limit }: SearchProps) => {
    shown.push(useSentenceSearch(items, query, limit));
    return null;
  };
  const container = Object.assign(new EventTarget(), {
    nodeType: 1, nodeName: 'DIV', tagName: 'DIV', namespaceURI: 'http://www.w3.org/1999/xhtml', ownerDocument: page, textContent: '',
  });
  const root = createRoot(container as unknown as Element);
  let props = initial;
  const render = (next: Partial<SearchProps>) => act(() => {
    props = { ...props, ...next };
    root.render(createElement(Search, props));
  });
  await render({});
  return {
    render,
    type: (query: string) => render({ query }),
    /** Lets `ms` pass, running the timers that come due. */
    wait: (ms: number) => act(() => t.mock.timers.tick(ms)),
    /** What the screen shows now. */
    latest: () => shown[shown.length - 1],
    renders: () => shown.length,
    unmount: () => act(() => root.unmount()),
  };
}

test('a query with literal matches shows them on the keystroke, and the fuzzy tier never runs', async (t) => {
  const search = await mountSearch(t, { items: APPLES, query: '' });
  assert.deepEqual(search.latest(), { results: [], pending: false });
  await search.type('apple');
  assert.equal(search.latest().pending, false);
  assert.deepEqual(ids(search.latest().results), ['a', 'b', 'c']);
  const renders = search.renders();
  await search.wait(10 * FUZZY_DELAY_MS);
  assert.equal(scans, 0);
  assert.equal(search.renders(), renders, 'nothing comes later');
  await search.unmount();
});

test('a query with no literal match is pending, with no list, while typing, then one fuzzy scan answers it once typing pauses', async (t) => {
  const search = await mountSearch(t, { items: APPLES, query: '' });
  for (const query of ['a', 'ap', 'app']) {
    await search.type(query);
    assert.equal(search.latest().pending, false, query);
    assert.deepEqual(ids(search.latest().results), ['a', 'b', 'c'], query);
  }
  await search.type('appk');
  assert.deepEqual(search.latest(), { results: [], pending: true }, "not the list 'app' found");
  await search.wait(FUZZY_DELAY_MS - 1);
  await search.type('appke');
  assert.deepEqual(search.latest(), { results: [], pending: true });
  await search.wait(FUZZY_DELAY_MS - 1);
  assert.equal(scans, 0, 'no scan while the keystrokes come faster than the delay');
  assert.equal(search.latest().pending, true);

  await search.wait(1);
  assert.equal(scans, 1);
  assert.equal(search.latest().pending, false);
  assert.deepEqual(ids(search.latest().results), ['a', 'b', 'c']);
  await search.wait(10 * FUZZY_DELAY_MS);
  assert.equal(scans, 1, 'one scan per pause');
  await search.unmount();
});

test("the list never belongs to an earlier query or limit: each waits for the fuzzy tier's own answer", async (t) => {
  const search = await mountSearch(t, { items: APPLES, query: 'appke' });
  await search.wait(FUZZY_DELAY_MS);
  assert.deepEqual(ids(search.latest().results), ['a', 'b', 'c']);

  await search.type('appkes');
  assert.deepEqual(search.latest(), { results: [], pending: true });
  await search.wait(FUZZY_DELAY_MS);
  assert.equal(search.latest().pending, false);

  await search.render({ query: 'appke', limit: 1 });
  assert.deepEqual(search.latest(), { results: [], pending: true });
  await search.wait(FUZZY_DELAY_MS);
  assert.equal(search.latest().pending, false);
  assert.equal(search.latest().results.length, 1);
  assert.equal(scans, 3);
  await search.unmount();
});

test('a new sentence list keeps the answer on screen while one fuzzy scan refreshes it, and the same matches keep the same list', async (t) => {
  const search = await mountSearch(t, { items: APPLES, query: 'appke' });
  await search.wait(FUZZY_DELAY_MS);
  const answered = search.latest();
  assert.equal(scans, 1);

  // The same sentences in a new array, as a sync that changed none of them gives: nothing on screen changes.
  await search.render({ items: [...APPLES] });
  assert.equal(search.latest(), answered);
  await search.wait(FUZZY_DELAY_MS);
  assert.equal(scans, 2);
  assert.equal(search.latest(), answered);

  // A sentence that matches arrives: the earlier answer stays until the scan over the new list adds it.
  await search.render({ items: [...APPLES, sentence('d', 'Apple trees bloom in spring.')] });
  assert.deepEqual(search.latest(), answered);
  await search.wait(FUZZY_DELAY_MS);
  assert.equal(scans, 3);
  assert.equal(search.latest().pending, false);
  assert.deepEqual(ids(search.latest().results), ['a', 'b', 'c', 'd']);
  await search.unmount();
});

test('the answer on screen follows a new sentence list at once: a sentence it left out goes, and the rest show as they are now', async (t) => {
  const search = await mountSearch(t, { items: APPLES, query: 'appke' });
  await search.wait(FUZZY_DELAY_MS);
  const answered = search.latest().results;
  assert.deepEqual(ids(answered), ['a', 'b', 'c']);

  // 'a' is deleted (or archived on another device) and 'b' reviewed: the list shows both before any scan runs again,
  // in the answer's order.
  const reviewed: StoredItem = { ...APPLES[1], srs: { ...APPLES[1].srs, totalReviews: 1 } };
  await search.render({ items: [reviewed, APPLES[2]] });
  assert.equal(scans, 1, 'no scan over the new list yet');
  const following = answered.filter(item => item.data.id !== 'a').map(item => (item.data.id === 'b' ? reviewed : item));
  assert.deepEqual(search.latest(), { results: following, pending: false });
  assert.ok(search.latest().results.includes(reviewed), 'the reviewed sentence as it is now');

  await search.wait(FUZZY_DELAY_MS);
  assert.equal(scans, 2);
  assert.deepEqual(ids(search.latest().results), ['b', 'c']);
  assert.ok(search.latest().results.includes(reviewed));
  await search.unmount();
});

test('the search covers only the sentences it is given, so a list that leaves some out gets its typo-tolerant matches', async (t) => {
  // The Sentences tab leaves archived sentences out. Searching them too, an archived sentence in British spelling
  // matches 'colour' literally, so the fuzzy tier never runs, and the tab, leaving it out, would say "No sentences
  // match"; searching only what the tab shows finds 'color'.
  const archived: StoredItem = { ...sentence('archived', 'She described the colour of the evening sky.'), isArchived: true };
  const shown = sentence('shown', 'Money has no color.');
  const search = await mountSearch(t, { items: [archived, shown], query: 'colour' });
  assert.deepEqual(search.latest(), { results: [archived], pending: false });

  await search.render({ items: [shown] });
  assert.deepEqual(search.latest(), { results: [], pending: true });
  await search.wait(FUZZY_DELAY_MS);
  assert.deepEqual(search.latest(), { results: [shown], pending: false });
  await search.unmount();
});

test('a scan still waiting when the search goes away never runs', async (t) => {
  const search = await mountSearch(t, { items: APPLES, query: 'appke' });
  assert.equal(search.latest().pending, true);
  await search.unmount();
  await search.wait(10 * FUZZY_DELAY_MS);
  assert.equal(scans, 0);
});
