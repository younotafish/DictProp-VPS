import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ts from 'typescript';
import type { ReviewEvent, StoredItem } from '../../types.ts';
import AppNavigation from '../../components/AppNavigation.tsx';
import type { SentenceRunOptions } from '../../hooks/useDetailView.ts';
import { THEME_DOMAINS } from '../../server/src/shared/item-themes.ts';
import { activeUnitKey, readActiveUnit, readSetStarts, writeActiveUnit, type ActiveUnit } from '../../services/learningLoop/sessionStore.ts';
import { localDayStart } from '../../services/learningLoop/standing.ts';
import { DAILY_SET_GOAL } from '../../services/learningLoop/stats.ts';
import { encodeStudySession } from '../../services/studySessionRecord.ts';
import { STUDY_SESSION_KEY } from '../../services/studySessionStore.ts';
import { installFakeMedia } from '../support/audio/fakeMedia.ts';
import { HOUR, memorized, practicing, reviewed, sentenceItem, vocabItem } from '../support/loop-fixtures.ts';
import { MemoryStorage } from '../support/memory-storage.ts';
import { readRepoFile } from '../support/paths.ts';

// Today as the Study tab: what its plan offers for the active unit kept on the device, what Start unit and Continue
// open, and its wiring into App and the tab bar, which no rendered test reaches, read from the source.

installFakeMedia();
const { TodayView } = await import('../../views/today/TodayView.tsx');
const { TodayPlan } = await import('../../views/today/TodayPlan.tsx');
type TodayViewProps = Parameters<typeof TodayView>[0];
type TodayPlanProps = Parameters<typeof TodayPlan>[0];

const NOW = new Date(2026, 10, 18, 15, 0).getTime();
const USER = 'user-1';
const THEME = THEME_DOMAINS[0].themes[0];
const noop = () => {};
const textOf = (markup: string) => markup.replace(/<[^>]+>/g, ' ').replace(/&#x27;/g, '\'').replace(/\s+/g, ' ').trim();

// The learner's sentences: three never reviewed, two Got it'd an hour ago, one deleted, and one that v3 put in practice,
// whose membership Today no longer reads.
const SENTENCES = [
  sentenceItem('a', 'A line about {{the first}}.', { sourceWord: 'the first' }),
  sentenceItem('b', 'A line about {{the second}}.', { sourceWord: 'the second', translation: null }),
  sentenceItem('c', 'A line about {{the third}}.', { sourceWord: 'the third' }),
  sentenceItem('m1', 'A line Got it\'d an hour ago.', { srs: memorized(NOW - HOUR) }),
  sentenceItem('m2', 'Another line Got it\'d an hour ago.', { srs: memorized(NOW - HOUR) }),
  sentenceItem('gone', 'A deleted line.', { isDeleted: true }),
  sentenceItem('p', 'A line v3 put in practice.', { srs: practicing(NOW - 3 * 24 * HOUR, { nextReview: NOW + 24 * HOUR }) }),
];
// Card review's words, due the classic way.
const CARDS = ['r1', 'r2'].map(id => vocabItem(id, `card-${id}`, { srs: reviewed(NOW - 3 * 24 * HOUR, { nextReview: NOW - HOUR, memoryStrength: 20 }) }));
const ITEMS: StoredItem[] = [...SENTENCES, ...CARDS];

/** A fresh device for the test, at NOW. */
function device(t: TestContext): MemoryStorage {
  const storage = new MemoryStorage();
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: storage });
  t.after(() => { Reflect.deleteProperty(globalThis, 'localStorage'); });
  t.mock.method(Date, 'now', () => NOW);
  return storage;
}

const props = (extra: Partial<TodayViewProps> = {}): TodayViewProps => ({
  userId: USER, items: ITEMS, studyItems: CARDS, reviewHistory: { recent: [], olderTimes: [], olderCount: 0 },
  onReview: async () => true, onUndoReview: async () => true, onOpenExampleSentence: noop, onViewCards: noop, onOpenSentence: noop,
  ...extra,
});
const render = (extra: Partial<TodayViewProps> = {}) => renderToStaticMarkup(createElement(TodayView, props(extra)));

/** The unit 'unit-7' over `itemIds`, kept on the device as the active unit. */
const keepUnit = (itemIds: string[], startedAt = NOW - HOUR): ActiveUnit => {
  const unit: ActiveUnit = { version: 1, userId: USER, id: 'unit-7', themeId: THEME.id, itemIds, startedAt };
  writeActiveUnit(unit);
  return unit;
};

/** A Got it in the unit 'unit-7' today, as the lesson records it. */
const gotIt = (itemId: string, index: number): ReviewEvent => ({
  id: `e-${itemId}`, itemId, itemType: 'sentence', reviewedAt: localDayStart(NOW) + index * 60_000, previousStep: 0, nextStep: 1,
  rating: 'good', taskType: 'quick', sessionId: 'set:unit-7',
});
const metGoal = { recent: Array.from({ length: DAILY_SET_GOAL }, (_, i) => gotIt(`met-${i}`, i)), olderTimes: [], olderCount: 0 };

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

/** The plan TodayView renders, with the handlers it passes: its hooks run by a probe component, its tree kept. */
function planOf(extra: Partial<TodayViewProps> = {}): TodayPlanProps {
  let tree: unknown;
  const Probe = () => {
    tree = TodayView(props(extra));
    return null;
  };
  renderToStaticMarkup(createElement(Probe));
  const plan = findElement(tree, node => node.type === TodayPlan);
  assert.ok(plan, 'Today shows its plan');
  return plan.props as unknown as TodayPlanProps;
}

/** What onOpenSentence was asked to open: the sentences' ids, the index and the options. */
function opener() {
  const calls: { ids: string[]; index: number; options: SentenceRunOptions | undefined; items: StoredItem[] }[] = [];
  const onOpenSentence = (ordered: StoredItem[], index: number, options?: SentenceRunOptions) => {
    calls.push({ ids: ordered.map(item => item.data.id), index, options, items: ordered });
  };
  return { calls, onOpenSentence };
}

test('with nothing kept Today opens on its plan; until the theme map is in, the card says the themes are loading', t => {
  device(t);
  const markup = render();
  assert.match(markup, /^<div class="h-full" data-today-mode="plan">/);
  const text = textOf(markup);
  assert.match(text, /^Today Wednesday, November 18 /);
  assert.match(text, /Loading themes… /);
  assert.match(text, /Card review 2 due ›$/);
});

test('a kept session no longer opens Card review or v3\'s player: Today opens on the plan, and Card review offers Resume', t => {
  const storage = device(t);
  storage.setItem(STUDY_SESSION_KEY, encodeStudySession({
    id: 'classic-1', itemIds: ['r1', 'r2'], index: 0, grades: [], startedAt: NOW - 2 * HOUR,
  }, USER, NOW - HOUR));
  storage.setItem('today_session_v1:user-1', JSON.stringify({ version: 1, userId: USER, savedAt: NOW - 1_000, session: { kind: 'set' } }));
  const markup = render();
  assert.match(markup, /^<div class="h-full" data-today-mode="plan">/);
  assert.match(textOf(markup), /Card review Resume ›$/);
});

test('an unfinished unit kept on the device is offered as Continue, from yesterday too, with its live sentences\' progress', t => {
  device(t);
  keepUnit(['m1', 'a', 'gone', 'm2', 'missing', 'b'], localDayStart(NOW, -1) + 20 * HOUR);
  const text = textOf(render());
  assert.match(text, new RegExp(`Unit ${THEME.emoji} ${THEME.title} 4 sentences · 2 memorized Continue`));
  // Its sentences go to no other unit: none is offered while the theme map loads, but the plan excludes them.
  assert.doesNotMatch(text, /Start unit|Done for today/);
});

test('a unit done today, the goal met, reads Done for today with the unit; one done yesterday is passed over', t => {
  device(t);
  keepUnit(['m1', 'm2']);
  const today = textOf(render({ reviewHistory: metGoal }));
  assert.match(today, new RegExp(`Done for today ✓ ✓ ${THEME.emoji} ${THEME.title} · 2 memorized`));
  assert.match(today, new RegExp(`${DAILY_SET_GOAL}/${DAILY_SET_GOAL}`));
  assert.doesNotMatch(today, /Continue|Another unit/, 'no theme map yet, so no unit to offer');

  keepUnit(['m1', 'm2'], localDayStart(NOW, -1) + 23 * HOUR);
  const yesterday = textOf(render({ reviewHistory: metGoal }));
  assert.match(yesterday, /Done for today ✓/);
  assert.doesNotMatch(yesterday, /· 2 memorized/);
  // Before the history loads, the goal isn't met yet, whatever this device counts.
  assert.doesNotMatch(textOf(render({ reviewHistory: { ...metGoal, loaded: false } })), /Done for today/);
});

test('starting a unit keeps it as the active unit, notes its theme\'s start, and opens its live sentences in the lesson as the unit', t => {
  const storage = device(t);
  keepUnit(['m1', 'm2'], NOW - 2 * HOUR);
  const { calls, onOpenSentence } = opener();
  const plan = planOf({ onOpenSentence });
  plan.onStartUnit({ themeId: THEME.id, itemIds: ['c', 'gone', 'a', 'missing', 'p', 'b'] });

  const unit = readActiveUnit(USER);
  assert.ok(unit, 'the new unit is kept');
  assert.notEqual(unit.id, 'unit-7', 'in place of the one before');
  assert.deepEqual({ ...unit, id: 'x' }, { version: 1, userId: USER, id: 'x', themeId: THEME.id, itemIds: ['c', 'a', 'p', 'b'], startedAt: NOW });
  assert.deepEqual(readSetStarts(USER, NOW), { [THEME.id]: NOW }, 'its theme is held back for two days');
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].ids, ['c', 'a', 'p', 'b'], 'in the unit\'s order, without the deleted and the missing');
  assert.equal(calls[0].items[0], SENTENCES[2], 'the library\'s own copies');
  assert.equal(calls[0].index, 0, 'at its first sentence');
  assert.deepEqual(calls[0].options, { reviewSessionId: `set:${unit.id}`, exitLabel: 'Today' });
  assert.ok(storage.getItem(activeUnitKey(USER)));

  // A unit whose sentences have all gone since the plan was taken opens nothing.
  planOf({ onOpenSentence }).onStartUnit({ themeId: null, itemIds: ['gone', 'missing'] });
  assert.equal(calls.length, 1);
  assert.equal(readActiveUnit(USER)?.id, unit.id);
});

test('Continue opens the unit\'s live sentences in the lesson at the first still to review, as the same unit', t => {
  device(t);
  keepUnit(['m1', 'gone', 'm2', 'b', 'a']);
  const { calls, onOpenSentence } = opener();
  planOf({ onOpenSentence }).onContinue();
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].ids, ['m1', 'm2', 'b', 'a'], 'every live sentence of the unit, the memorized among them');
  assert.equal(calls[0].index, 2, 'at b, the first still to review');
  assert.deepEqual(calls[0].options, { reviewSessionId: 'set:unit-7', exitLabel: 'Today' });
  assert.equal(readActiveUnit(USER)?.startedAt, NOW - HOUR, 'the unit stays as it was');
});

/** App.tsx's source, parsed. */
const app = ts.createSourceFile('App.tsx', readRepoFile('App.tsx'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);

/** The attributes of the one JSX element named `tag` in App, as written. */
function attributesOf(tag: string): { element: ts.JsxSelfClosingElement; props: Record<string, string> } {
  const found: ts.JsxSelfClosingElement[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isJsxSelfClosingElement(node) && node.tagName.getText() === tag) found.push(node);
    ts.forEachChild(node, visit);
  };
  visit(app);
  assert.equal(found.length, 1, `App renders ${tag} once`);
  const attributes: Record<string, string> = {};
  for (const attribute of found[0].attributes.properties) {
    if (ts.isJsxAttribute(attribute)) attributes[attribute.name.getText()] = attribute.initializer?.getText() ?? 'true';
  }
  return { element: found[0], props: attributes };
}

test('the Study tab shows Today, which gets the whole library, classic Study\'s cards and the lesson\'s opener', () => {
  const source = app.getFullText();
  assert.match(source, /^const TodayView = lazyScreen\('study', \(\) => import\('\.\/views\/today\/TodayView'\)\.then\(module => \(\{ default: React\.memo\(module\.TodayView\) \}\)\)\);$/m);
  assert.match(source, /^ {2}study: TodayView,$/m, 'the tab\'s screen, which the tab bar preloads');
  assert.doesNotMatch(source, /StudyEnhanced/, 'classic Study is Card review, inside Today');

  const { element, props: attributes } = attributesOf('TodayView');
  const tab = element.parent;
  assert.ok(ts.isJsxElement(tab) && tab.openingElement.tagName.getText() === 'TabScreen');
  assert.equal(tab.openingElement.attributes.properties[0]?.getText(), 'shown={currentView === \'study\'}');
  assert.deepEqual(attributes, {
    userId: '{user.id}',
    items: '{library.savedItems}',
    studyItems: '{studyItems}',
    reviewHistory: '{reviewHistory}',
    onReview: '{updateSRS}',
    onUndoReview: '{undoSRSReview}',
    onOpenExampleSentence: '{handleOpenStudyExample}',
    onViewCards: '{handleViewStoredItem}',
    onOpenSentence: '{handleViewSentence}',
    interactionLocked: '{!!detailContext}',
    onScroll: '{handleScroll}',
  });
});

test('the tab bar badges only the Sentences tab, which keeps its violet count; Today counts nothing there', () => {
  assert.equal(attributesOf('AppNavigation').props.items, undefined, 'the tab bar gets no library');
  const markup = renderToStaticMarkup(createElement(AppNavigation, {
    currentView: 'study', onNavigate: noop, sentenceDueCount: 4, onKeyboardHelp: noop, covered: false, onFocus: noop,
  }));
  assert.match(markup, />Today<\/span>/);
  assert.match(markup, /aria-label="Sentences, 4 to review"/);
  assert.match(markup, /rounded-full bg-violet-500 px-1 text-\[9px\] font-bold leading-none text-white">4<\/span>/);
  assert.equal(markup.match(/rounded-full bg-/g)?.length, 1, 'one badge');
  assert.doesNotMatch(markup, /bg-orange-500|to practice/);
});

test('Today\'s Esc and Enter follow todayHandlers, so they never listen over Card review or under the lesson', () => {
  const source = readRepoFile('views/today/TodayView.tsx');
  assert.match(source, /^ {2}const listening = todayHandlers\(screen, interactionLocked\);$/m);
  assert.match(source, /^ {2}useEscapeLayer\(\(\) => setScreen\('plan'\), 0, listening\.escape\);$/m, 'the escape layer');
  assert.match(source, /^ {2}const keysActive = listening\.keys;$/m);
  assert.match(source, /^ {4}if \(!keysActive\) return;$/m, 'the key listener');
  assert.match(source, /window\.addEventListener\('keydown', handleTodayKey, true\);/, 'in the capture phase, ahead of the tab keys');
});

test('as Today mounts it forgets what v3 kept, and as the lesson closes it takes the plan again', () => {
  const source = readRepoFile('views/today/TodayView.tsx');
  assert.match(source, /^ {2}useEffect\(\(\) => \{ forgetV3State\(userId\); \}, \[userId\]\);$/m);
  assert.match(source, /^ {2}if \(covered !== interactionLocked\) \{\n {4}setCovered\(interactionLocked\);\n {4}if \(!interactionLocked\) setPlanTick\(tick => tick \+ 1\);\n {2}\}$/m);
});
