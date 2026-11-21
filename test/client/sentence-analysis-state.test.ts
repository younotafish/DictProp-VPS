import assert from 'node:assert/strict';
import test from 'node:test';
import { act, createElement, type ComponentProps } from 'react';
import { createRoot } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import type { SentenceData, StoredItem } from '../../types.ts';
import { SRSAlgorithm } from '../../services/srsAlgorithm.ts';
import { analysisPlaceholderState, type AnalysisPlaceholderState } from '../../services/sentenceAnalysisState.ts';
import { SentenceAnalysisView } from '../../components/SentenceAnalysisView.tsx';
import { SentenceHeaderRow } from '../../views/detail/SentenceHeaderRow.tsx';
import { useSentenceEnrichment } from '../../views/detail/useSentenceEnrichment.ts';

// What a sentence's analysis page shows (services/sentenceAnalysisState.ts) and where the lesson's loading and failures
// come from (views/detail/useSentenceEnrichment.ts), and the page and the lesson's top row rendered on the server: the
// header's Got it, the placeholder's three texts and the analysis button's spinner.

test('an analysis on screen wins; otherwise loading beats a failure, and a failure beats none in the pool', () => {
  const cases: [Parameters<typeof analysisPlaceholderState>[0], AnalysisPlaceholderState][] = [
    [{ hasAnalysis: true, loading: false, failed: false }, 'ready'],
    [{ hasAnalysis: true, loading: true, failed: true }, 'ready'],
    [{ hasAnalysis: false, loading: true, failed: false }, 'loading'],
    [{ hasAnalysis: false, loading: true, failed: true }, 'loading'],
    [{ hasAnalysis: false, loading: false, failed: true }, 'failed'],
    [{ hasAnalysis: false, loading: false, failed: false }, 'missing'],
  ];
  for (const [input, expected] of cases) assert.equal(analysisPlaceholderState(input), expected, JSON.stringify(input));
});

const sentence: SentenceData = { id: 'sentence-1', text: 'She finally came clean.', sourceWord: 'come clean' };

type PageProps = ComponentProps<typeof SentenceAnalysisView>;
const pageProps = (props: Partial<PageProps> = {}): PageProps => ({
  sentence, position: 2, total: 12, visible: true, analysisState: 'missing', onBack: () => {}, onSearch: () => {},
  onTouchStart: () => {}, onTouchEnd: () => {}, ...props,
});
const page = (props: Partial<PageProps> = {}) => renderToStaticMarkup(createElement(SentenceAnalysisView, pageProps(props)));

/** The header's markup, from its opening tag to its close. */
const headerOf = (html: string) => html.match(/<header[\s\S]*?<\/header>/)![0];
/** The placeholder block that stands where the analysis goes. */
const placeholderOf = (html: string) => html.match(/<div role="status"[\s\S]*?<\/p><\/div>/)?.[0] ?? null;

test('the analysis header has a compact Got it in its right slot, 76 px wide like the empty slot it fills', () => {
  const header = headerOf(page({ onRemember: () => {} }));
  const button = header.match(/<button[^>]*title="Remember \(R\)"[^>]*>[\s\S]*?<\/button>/)?.[0];
  assert.ok(button, 'a Got it button titled Remember (R)');
  assert.match(button, /<\/svg> Got it<\/button>$/);
  assert.match(button, /lucide-check/);
  const classes = button.match(/class="([^"]*)"/)![1].split(/\s+/);
  for (const name of ['h-9', 'w-[76px]', 'rounded-lg', 'bg-emerald-500', 'text-sm', 'font-bold', 'text-white']) {
    assert.ok(classes.includes(name), name);
  }
  assert.doesNotMatch(header, /aria-hidden="true"><\/div>/, 'the button takes the spacer\'s place');
});

test('a read-only preview keeps the empty 76 px slot, so the title stays where it was', () => {
  const header = headerOf(page());
  assert.doesNotMatch(header, /Got it/);
  assert.match(header, /<div class="w-\[76px\]" aria-hidden="true"><\/div><\/div><\/header>$/);
});

test('Got it stops its click there, so the page behind doesn\'t take it as a tap too', () => {
  let remembered = 0;
  let stopped = 0;
  // The page's element tree as its render returns it, its hooks run by a probe component.
  let tree: unknown;
  const Probe = () => {
    tree = SentenceAnalysisView(pageProps({ onRemember: () => { remembered += 1; } }));
    return null;
  };
  renderToStaticMarkup(createElement(Probe));
  const button = findElement(tree, node => node.props?.title === 'Remember (R)');
  assert.ok(button, 'the Got it element');
  (button.props.onClick as (event: { stopPropagation: () => void }) => void)({ stopPropagation: () => { stopped += 1; } });
  assert.deepEqual([remembered, stopped], [1, 1]);
});

test('without an analysis the page says whether it is loading, failed to load or not in the pool yet', () => {
  const loading = placeholderOf(page({ analysisState: 'loading' }));
  assert.ok(loading);
  assert.match(loading, /animate-spin/, 'a spinner');
  assert.match(loading, />Loading analysis…<\/p>/);

  const failed = placeholderOf(page({ analysisState: 'failed' }));
  assert.ok(failed);
  assert.match(failed, />Couldn’t load the analysis\. It will retry automatically\.<\/p>/);
  assert.doesNotMatch(failed, /animate-spin/);

  const missing = placeholderOf(page({ analysisState: 'missing' }));
  assert.ok(missing);
  assert.match(missing, />Not analyzed yet<\/p>/);
  assert.doesNotMatch(missing, /animate-spin/);

  assert.doesNotMatch(page({ analysisState: 'loading' }), /Analysis pending/);
});

test('an analysis on screen shows itself, never a placeholder', () => {
  const analysed: SentenceData = {
    ...sentence,
    analysis: {
      translation: '她终于坦白了。',
      americanEnglish: { status: 'shared', explanation: 'Common everywhere.' },
      terms: [],
    } as unknown as SentenceData['analysis'],
  };
  const html = page({ sentence: analysed, analysisState: 'ready' });
  assert.equal(placeholderOf(html), null);
  assert.match(html, /1\. Chinese Translation/);
});

type RowProps = ComponentProps<typeof SentenceHeaderRow>;
const headerRow = (props: Partial<RowProps> = {}) => renderToStaticMarkup(createElement(SentenceHeaderRow, {
  autoPlaying: false, exitLabel: 'Sentences', onExit: () => {}, onOpenAnalysis: () => {}, loadingLesson: false, position: 3,
  total: 12, reviewPill: { count: 4, label: '4 to review', tone: 'amber' }, ...props,
}));
/** The analysis button: its opening tag and what it holds. */
const analysisButton = (html: string) => html.match(/<button type="button"[^>]*>[\s\S]*?<\/button>/)![0];
const classesOf = (tag: string) => tag.match(/class="([^"]*)"/)![1];

test('while the analysis loads, a spinner takes the book\'s place in the same box, and no label pushes the row', () => {
  const idle = headerRow();
  const loading = headerRow({ loadingLesson: true });
  assert.doesNotMatch(loading, /Loading lesson/);
  assert.match(analysisButton(idle), /aria-label="Open sentence analysis"[\s\S]*lucide-book-open-text/);
  assert.match(analysisButton(loading), /title="Loading analysis…" aria-label="Loading analysis…"[\s\S]*animate-spin/);
  assert.doesNotMatch(analysisButton(loading), /lucide-book-open-text/);
  assert.equal(classesOf(analysisButton(loading)), classesOf(analysisButton(idle)), 'the same h-9 w-9 box');
  // Everything after the analysis button is the same, loading or not.
  const after = (html: string) => html.slice(html.indexOf(analysisButton(html)) + analysisButton(html).length);
  assert.equal(after(loading), after(idle));
});

interface ElementLike { type?: unknown; props?: Record<string, unknown> & { children?: unknown } }

/** The first element in a rendered tree that `match` accepts, walking props.children depth first. */
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

const lessonSentence = (id: string, text: string): StoredItem => ({
  type: 'sentence',
  data: { id, text, sourceWord: 'word' },
  savedAt: 1,
  srs: SRSAlgorithm.createNew(id, 'sentence', 0),
});

/** A promise and the handles that settle it. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

/**
 * Lets the fetches, the module load and the state updates they lead to run, until `done` holds. It waits up to ten
 * seconds, not a number of turns: the first lookup loads services/sentenceEnrichment, which tsx compiles as it's asked
 * for, and with the whole suite running at once that took longer than 2,000 turns (about a tenth of a second).
 */
async function settle(done: () => boolean = () => true) {
  const giveUpAt = performance.now() + 10_000;
  do {
    await act(() => new Promise<void>(resolve => setImmediate(resolve)));
    if (done()) return;
  } while (performance.now() < giveUpAt);
  assert.fail(`gave up waiting for ${done.toString()}`);
}

/**
 * Renders useSentenceEnrichment over `items` with a stand-in fetch: each lookup waits until the test answers it, by
 * the sentence's text. Just enough of a browser for React to render a component that draws nothing, as in
 * sentence-source.test.ts.
 */
async function enrichmentHarness(items: StoredItem[], library: {
  saved?: StoredItem[];
  onPatchItem?: (id: string, patch: (item: StoredItem) => StoredItem | null) => void;
} = {}) {
  const asked = new Map<string, ReturnType<typeof deferred<Response>>[]>();
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
    const { text } = JSON.parse(String(init?.body)) as { text: string };
    const reply = deferred<Response>();
    asked.set(text, [...(asked.get(text) ?? []), reply]);
    return reply.promise;
  }) as typeof fetch;
  const page = Object.assign(new EventTarget(), { nodeType: 9, activeElement: null, defaultView: null as unknown });
  const browser = Object.assign(new EventTarget(), { document: page, event: undefined, HTMLIFrameElement: class {} });
  page.defaultView = browser;
  const globals = globalThis as Record<string, unknown>;
  Object.assign(globals, { window: browser, document: page, IS_REACT_ACT_ENVIRONMENT: true });
  const container = Object.assign(new EventTarget(), {
    nodeType: 1, nodeName: 'DIV', tagName: 'DIV', namespaceURI: 'http://www.w3.org/1999/xhtml', ownerDocument: page, textContent: '',
  });
  const root = createRoot(container as unknown as Element);
  let state: ReturnType<typeof useSentenceEnrichment> | undefined;
  // Refs keep their identity across renders, as the view's useLatest refs do.
  const savedSentenceItemsRef = { current: library.saved ?? [] };
  const onPatchItemRef = { current: library.onPatchItem ?? (() => {}) };
  const Lesson = ({ index }: { index: number }) => {
    state = useSentenceEnrichment({ sentenceItems: items, sentenceIndex: index, savedSentenceItemsRef, onPatchItemRef });
    return null;
  };
  const show = (index: number) => act(() => root.render(createElement(Lesson, { index })));
  await show(0);
  return {
    get state() { return state!; },
    show,
    /** How many lookups the sentence `text` has made. */
    asks: (text: string) => asked.get(text)?.length ?? 0,
    /** Answers the sentence's latest lookup. */
    answer: async (text: string, reply: Response | Error) => {
      const pending = asked.get(text)?.at(-1);
      assert.ok(pending, `no lookup for ${text}`);
      await act(() => { if (reply instanceof Error) pending.reject(reply); else pending.resolve(reply); });
    },
    online: () => act(() => { browser.dispatchEvent(new Event('online')); }),
    close: async () => {
      await act(() => root.unmount());
      globalThis.fetch = realFetch;
      delete globals.window;
      delete globals.document;
      delete globals.IS_REACT_ACT_ENVIRONMENT;
    },
  };
}

const notFound = () => new Response(JSON.stringify({ found: false }), { status: 200, headers: { 'Content-Type': 'application/json' } });

test('a lookup that throws marks its sentence failed until it is asked again; one that finds nothing is not a failure', async () => {
  const lesson = await enrichmentHarness([lessonSentence('a', 'First line.'), lessonSentence('b', 'Second line.')]);
  try {
    await settle(() => lesson.asks('First line.') === 1 && lesson.asks('Second line.') === 1);
    assert.equal(lesson.state.preparingSentenceId, 'a', 'the sentence on screen shows its analysis loading');

    await lesson.answer('First line.', new TypeError('Failed to fetch'));
    await lesson.answer('Second line.', notFound());
    await settle(() => lesson.state.preparingSentenceId === null);
    assert.deepEqual([...lesson.state.failedSentenceIds], ['a']);

    // Coming back online asks again for the one that failed, not for the one the pool has no analysis for.
    await lesson.online();
    await settle(() => lesson.asks('First line.') === 2);
    assert.equal(lesson.asks('Second line.'), 1);
    assert.deepEqual([...lesson.state.failedSentenceIds], [], 'a new attempt clears the failure');
    assert.equal(lesson.state.preparingSentenceId, 'a');

    await lesson.answer('First line.', new Response('Server error', { status: 500 }));
    await settle(() => lesson.state.failedSentenceIds.has('a'));
    assert.equal(lesson.state.preparingSentenceId, null);
  } finally {
    await lesson.close();
  }
});

test('a sentence reached while a lookup ahead of it still runs shows its analysis loading until that lookup ends', async () => {
  const lesson = await enrichmentHarness([lessonSentence('a', 'First line.'), lessonSentence('b', 'Second line.')]);
  try {
    await settle(() => lesson.asks('Second line.') === 1);
    await lesson.answer('First line.', notFound());
    await settle(() => lesson.state.preparingSentenceId === null);

    await lesson.show(1);
    assert.equal(lesson.state.preparingSentenceId, 'b');
    assert.equal(lesson.asks('Second line.'), 1, 'it waits for the lookup already running');
    await lesson.answer('Second line.', notFound());
    await settle(() => lesson.state.preparingSentenceId === null);
    assert.deepEqual([...lesson.state.failedSentenceIds], []);
  } finally {
    await lesson.close();
  }
});

test('a failed lookup is tried again 15 s later on its own, as the failure message promises', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const lesson = await enrichmentHarness([lessonSentence('a', 'Only line.')]);
  try {
    await settle(() => lesson.asks('Only line.') === 1);
    await lesson.answer('Only line.', new TypeError('Failed to fetch'));
    await settle(() => lesson.state.failedSentenceIds.has('a'));

    await act(() => { t.mock.timers.tick(14_999); });
    await settle();
    assert.equal(lesson.asks('Only line.'), 1);
    await act(() => { t.mock.timers.tick(1); });
    await settle(() => lesson.asks('Only line.') === 2);
    assert.equal(lesson.state.preparingSentenceId, 'a');
  } finally {
    await lesson.close();
  }
});

// critic-01: an analysis that arrives for a saved sentence goes to the library's live copy, so it can't bring back a
// sentence deleted on another device while the lookup ran.
const analysisReply = () => new Response(JSON.stringify({
  found: true,
  analysis: { translation: '她终于坦白了。', americanEnglish: { status: 'shared', explanation: 'Common.' }, terms: [] },
  analysisGeneratedAt: 42,
  imageUrl: '/api/sentence-enrichments/abc/image',
}), { status: 200, headers: { 'Content-Type': 'application/json' } });

test('an analysis that arrives for a saved sentence patches its live copy instead of saving the copy the view holds', async () => {
  const saved = lessonSentence('s1', 'Saved line.');
  const patches: [string, (item: StoredItem) => StoredItem | null][] = [];
  const lesson = await enrichmentHarness([saved], {
    saved: [saved], onPatchItem: (id, patch) => { patches.push([id, patch]); },
  });
  try {
    await settle(() => lesson.asks('Saved line.') === 1);
    await lesson.answer('Saved line.', analysisReply());
    await settle(() => patches.length === 1);
    const [id, patch] = patches[0];
    assert.equal(id, 's1');
    // Applied to whatever copy the library holds then: it adds the analysis and the picture link, keeping the rest.
    const live = { ...saved, srs: { ...saved.srs, totalReviews: 3 } };
    const upgraded = patch(live)!;
    assert.equal(upgraded.srs.totalReviews, 3);
    assert.equal((upgraded.data as SentenceData).analysisGeneratedAt, 42);
    assert.equal((upgraded.data as SentenceData).imageUrl, '/api/sentence-enrichments/abc/image');
    // A copy that already has a detailed analysis and a picture link gets nothing written.
    const detailed = {
      translation: '她终于坦白了。',
      americanEnglish: { status: 'shared', explanation: 'Common.', evidence: ['Heard everywhere.'] },
      terms: [],
      grammar: { structure: 'Subject + adverb + verb + particle.', points: [] },
      pronunciation: { slowIpa: 'ʃi ˈfaɪnəli keɪm klin', fastIpa: 'ʃi ˈfaɪnli keɪm klin', fastSpeechFeatures: ['elision'] },
    } as unknown as SentenceData['analysis'];
    const complete = { ...live, data: { ...live.data, analysis: detailed, imageUrl: 'idb:stored' } as SentenceData };
    assert.equal(patch(complete), null);
  } finally {
    await lesson.close();
  }
});

