import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ts from 'typescript';
import type { StoredItem } from '../../types.ts';
import { THEME_DOMAINS } from '../../server/src/shared/item-themes.ts';
import { startPracticeSession, startSetSession } from '../../services/learningLoop/session.ts';
import { loopSessionKey, writeLoopSession } from '../../services/learningLoop/sessionStore.ts';
import { encodeStudySession } from '../../services/studySessionRecord.ts';
import { STUDY_SESSION_KEY } from '../../services/studySessionStore.ts';
import { installFakeMedia } from '../support/audio/fakeMedia.ts';
import { DAY, HOUR, practicing, reviewed, vocabItem } from '../support/loop-fixtures.ts';
import { MemoryStorage } from '../support/memory-storage.ts';
import { readRepoFile } from '../support/paths.ts';

// Today as the Study tab: what it opens on (its own kept session, classic Study's, or the plan), and its wiring into
// App and the tab bar, which no rendered test reaches, read from the source.

installFakeMedia();
const { TodayView } = await import('../../views/today/TodayView.tsx');
type TodayViewProps = Parameters<typeof TodayView>[0];

const NOW = new Date(2026, 10, 18, 15, 0).getTime();
const USER = 'user-1';
const THEME = THEME_DOMAINS[0].themes[0];
const noop = () => {};
const textOf = (markup: string) => markup.replace(/<[^>]+>/g, ' ').replace(/&#x27;/g, '\'').replace(/\s+/g, ' ').trim();

const NEW_WORDS = ['a', 'b', 'c'].map(id => vocabItem(id, `word-${id}`, { chinese: `词${id}`, definition: `Meaning of ${id}.` }));
const DUE = ['p1', 'p2'].map(id => vocabItem(id, `practice-${id}`, { srs: practicing(NOW - 3 * DAY, { lastReviewDate: NOW - 2 * DAY, nextReview: NOW - HOUR }) }));
const CARDS = ['r1', 'r2'].map(id => vocabItem(id, `card-${id}`, { srs: reviewed(NOW - 3 * DAY, { nextReview: NOW - HOUR, memoryStrength: 20 }) }));
const ITEMS: StoredItem[] = [...NEW_WORDS, ...DUE, ...CARDS];

/** A fresh device for the test, at NOW. */
function device(t: TestContext): MemoryStorage {
  const storage = new MemoryStorage();
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: storage });
  t.after(() => { Reflect.deleteProperty(globalThis, 'localStorage'); });
  t.mock.method(Date, 'now', () => NOW);
  return storage;
}

const render = (props: Partial<TodayViewProps> = {}) => renderToStaticMarkup(createElement(TodayView, {
  userId: USER, items: ITEMS, studyItems: CARDS, reviewHistory: { recent: [], olderTimes: [], olderCount: 0 },
  onReview: async () => true, onUndoReview: async () => true, onOpenExampleSentence: noop, onViewCards: noop, onOpenSentence: noop,
  onLazyLoadImage: async () => null, undoOffered: false, ...props,
}));

/** Classic Study's kept session over the two cards, at its first, written at `savedAt`. */
const keepClassic = (storage: MemoryStorage, savedAt: number, userId = USER) => storage.setItem(STUDY_SESSION_KEY, encodeStudySession({
  id: 'classic-1', itemIds: ['r1', 'r2'], index: 0, grades: [], startedAt: savedAt - 60_000,
}, userId, savedAt));

const keepSet = (savedAt: number, userId = USER) =>
  writeLoopSession(startSetSession('set-1', { themeId: THEME.id, itemIds: ['a', 'b', 'c'] }, savedAt), userId, savedAt);

test('with nothing kept Today opens on its plan, which offers the practice due first', t => {
  device(t);
  const markup = render();
  assert.match(markup, /^<div class="h-full" data-today-mode="plan">/);
  const text = textOf(markup);
  assert.match(text, /^Today Wednesday, November 18 /);
  assert.match(text, /Practice · 2 due Loading themes… Practice 2 /, 'no theme map on this device yet');
  assert.match(text, /Card review 2 due ›$/);
});

test('Today takes up its own kept session at its card when it is newer than classic Study\'s', t => {
  const storage = device(t);
  keepClassic(storage, NOW - 2 * HOUR);
  keepSet(NOW - HOUR);
  const markup = render();
  assert.match(markup, /^<div class="h-full" data-today-mode="set">/);
  assert.match(textOf(markup), new RegExp(`^${THEME.emoji} ${THEME.title} 1 / 3 Speak Card 1 of 3 Say the word 词a Meaning of a\\. Hint Reveal`));
});

test('Today opens Card review on classic Study\'s kept session when that is the newer one', t => {
  const storage = device(t);
  keepSet(NOW - 2 * HOUR);
  keepClassic(storage, NOW - HOUR);
  const markup = render();
  assert.match(markup, /^<div class="h-full" data-today-mode="classic">/);
  assert.match(markup, /<span class="text-sm font-semibold text-slate-600">1 \/ 2<\/span>/);
  assert.match(markup, />card-r1</);
  assert.ok(storage.getItem(loopSessionKey(USER)), 'Today\'s own session waits on the plan');
});

test('a kept practice session opens at its card in the mode it runs in', t => {
  device(t);
  writeLoopSession(startPracticeSession('practice-1', ['p1', 'p2'], 'quiet', NOW - HOUR, (() => {
    let id = 0;
    return () => `event-${id++}`;
  })()), USER, NOW - HOUR);
  const markup = render();
  assert.match(markup, /^<div class="h-full" data-today-mode="practice">/);
  assert.match(textOf(markup), /^Practice 1 \/ 2 Quiet Card 1 of 2 Think of the word/);
});

test('a kept session Today or Card review couldn\'t take up opens the plan instead', t => {
  const storage = device(t);
  keepSet(NOW - HOUR, 'someone-else');
  keepClassic(storage, NOW - HOUR, 'someone-else');
  assert.match(render(), /data-today-mode="plan"/, 'another user\'s');

  // Every card of classic Study's session was reviewed since it was kept: Card review would have nothing to show.
  keepClassic(storage, NOW - HOUR);
  const reviewedSince = CARDS.map(card => ({ ...card, srs: { ...card.srs, lastReviewDate: NOW - 30 * 60_000 } }));
  assert.match(render({ studyItems: reviewedSince, items: [...NEW_WORDS, ...DUE, ...reviewedSince] }), /data-today-mode="plan"/);
  assert.match(render({ studyItems: [] }), /data-today-mode="plan"/, 'no cards at all');
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
  const props: Record<string, string> = {};
  for (const attribute of found[0].attributes.properties) {
    if (ts.isJsxAttribute(attribute)) props[attribute.name.getText()] = attribute.initializer?.getText() ?? 'true';
  }
  return { element: found[0], props };
}

test('the Study tab shows Today, which gets the whole library, classic Study\'s cards and the app\'s undo pill', () => {
  const source = app.getFullText();
  assert.match(source, /^const TodayView = lazyScreen\('study', \(\) => import\('\.\/views\/today\/TodayView'\)\.then\(module => \(\{ default: React\.memo\(module\.TodayView\) \}\)\)\);$/m);
  assert.match(source, /^ {2}study: TodayView,$/m, 'the tab\'s screen, which the tab bar preloads');
  assert.doesNotMatch(source, /StudyEnhanced/, 'classic Study is Card review, inside Today');

  const { element, props } = attributesOf('TodayView');
  const tab = element.parent;
  assert.ok(ts.isJsxElement(tab) && tab.openingElement.tagName.getText() === 'TabScreen');
  assert.equal(tab.openingElement.attributes.properties[0]?.getText(), 'shown={currentView === \'study\'}');
  assert.deepEqual(props, {
    userId: '{user.id}',
    items: '{library.savedItems}',
    studyItems: '{studyItems}',
    reviewHistory: '{reviewHistory}',
    onReview: '{updateSRS}',
    onUndoReview: '{undoSRSReview}',
    onOpenExampleSentence: '{handleOpenStudyExample}',
    onViewCards: '{handleViewStoredItem}',
    onOpenSentence: '{handleViewSentence}',
    onLazyLoadImage: '{lazyLoadImage}',
    undoOffered: '{!!undoMessage}',
    interactionLocked: '{!!detailContext}',
    onScroll: '{handleScroll}',
  });
});

test('the tab bar counts Today\'s badge from the whole library', () => {
  assert.equal(attributesOf('AppNavigation').props.items, '{library.savedItems}');
});

test('Today\'s Esc and keys follow todayHandlers, so they never listen over Card review, which keeps classic Study\'s', () => {
  const source = readRepoFile('views/today/TodayView.tsx');
  assert.match(source, /^ {2}const listening = todayHandlers\(screen, playing, interactionLocked\);$/m);
  assert.match(source, /^ {2}\}, 0, listening\.escape\);$/m, 'the escape layer');
  assert.match(source, /^ {2}const keysActive = listening\.keys;$/m);
  assert.match(source, /^ {4}if \(!keysActive\) return;$/m, 'the key listener');
  assert.match(source, /window\.addEventListener\('keydown', handleTodayKey, true\);/, 'in the capture phase, ahead of the tab keys');
});
