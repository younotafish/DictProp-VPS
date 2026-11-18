import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { installFakeMedia } from '../support/audio/fakeMedia.ts';
import { DAY, HOUR, reviewed, vocabItem } from '../support/loop-fixtures.ts';
import { MemoryStorage } from '../support/memory-storage.ts';
import { readRepoFile } from '../support/paths.ts';

// Classic Study as Card review, a sub-screen of Today: its heading, and its way back to Today's plan.

// The study screen imports the speech engine, which reads the browser's media when it loads.
installFakeMedia();
const { StudyEnhanced } = await import('../../views/StudyEnhanced.tsx');

const NOW = new Date(2026, 10, 18, 15, 0).getTime();
const CARDS = ['r1', 'r2'].map(id => vocabItem(id, `card-${id}`, { srs: reviewed(NOW - 3 * DAY, { nextReview: NOW - HOUR, memoryStrength: 20 }) }));
const noop = () => {};
const PROPS = {
  userId: 'user-1', items: CARDS, reviewHistory: { recent: [], olderTimes: [], olderCount: 0 }, onReview: async () => true,
  onUndoReview: async () => true, onOpenExampleSentence: noop, onViewCards: noop,
};

test('Card review goes back to Today: a Back button beside its heading, and on its empty screen', t => {
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: new MemoryStorage() });
  t.after(() => { Reflect.deleteProperty(globalThis, 'localStorage'); });
  t.mock.method(Date, 'now', () => NOW);
  const dashboard = renderToStaticMarkup(createElement(StudyEnhanced, { ...PROPS, onBack: noop }));
  assert.match(dashboard, /aria-label="Back to Today"><svg[^>]*>.*?<\/svg><\/button><h2 class="text-3xl font-bold text-slate-800">Card review<\/h2>/);
  const empty = renderToStaticMarkup(createElement(StudyEnhanced, { ...PROPS, items: [], onBack: noop }));
  assert.match(empty, /aria-label="Back to Today"/);
  const alone = renderToStaticMarkup(createElement(StudyEnhanced, PROPS));
  assert.match(alone, /<h2 class="text-3xl font-bold text-slate-800">Card review<\/h2>/);
  assert.doesNotMatch(alone, /Back to Today/, 'only inside Today');
});

test('Esc in Card review between sessions goes back to Today; in a session it does what it did', () => {
  // The escape layer registers in an effect, which a markup render doesn't run, so its wiring is read from the source.
  const source = readRepoFile('views/StudyEnhanced.tsx');
  assert.match(source, /^ {4}if \(!session\) onBack\?\.\(\);$/m, 'between sessions: back');
  assert.match(source, /^ {4}else if \(showingCard\) endSession\(\);$/m, 'on a card: the summary');
  assert.match(source, /^ {2}\}, 0, \(!!session \|\| !!onBack\) && !interactionLocked\);$/m, 'listening while it can go back');
});
