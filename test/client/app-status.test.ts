import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement, type ComponentProps } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { AppStatusPills } from '../../components/AppStatus.tsx';
import { NoticePill, type NoticeTone } from '../../components/NoticePill.tsx';
import { announceUpdate, dismissUpdate } from '../../services/appUpdate.ts';
import { clearRefusedReviews, recordRefusedReview } from '../../services/refusedReviews.ts';
import { MemoryStorage } from '../support/memory-storage.ts';

// components/AppStatus.tsx's notice stack and components/NoticePill.tsx, rendered on the server. The refused-reviews
// notice reads this device's log from localStorage, and the update notice reads services/appUpdate.
(globalThis as unknown as { localStorage: MemoryStorage }).localStorage = new MemoryStorage();

type StackProps = ComponentProps<typeof AppStatusPills>;
const quiet: StackProps = {
  userId: 'u1',
  onViewRefusedReviews: () => {},
  imagePrefetchProgress: null,
  onStopImageDownload: () => {},
  imageRestoreProgress: null,
  ttsGenProgress: null,
  onStopSpeechGeneration: () => {},
  undoMessage: null,
  onUndo: () => {},
};
const renderStack = (props: Partial<StackProps> = {}) => renderToStaticMarkup(createElement(AppStatusPills, { ...quiet, ...props }));
/** The class list of the stack's own element, the first in the markup. */
const stackClasses = (html: string) => html.match(/^<div class="([^"]*)"/)![1].split(/\s+/);
const refuseOneReview = () => recordRefusedReview('u1', { itemId: 'i1', word: 'gamut', reviewedAt: 1, reason: 'The card isn’t on the server' });

test('the stack is a fixed, centred column that lets taps through between its pills', () => {
  const classes = stackClasses(renderStack());
  for (const name of ['fixed', 'bottom-20', 'left-1/2', '-translate-x-1/2', 'z-[80]', 'flex', 'flex-col', 'items-center', 'gap-2', 'pointer-events-none']) {
    assert.ok(classes.includes(name), name);
  }
  assert.ok(stackClasses(renderStack({ undoMessage: 'Deleted “gamut”' })).includes('z-[110]'), 'an undo offer lifts it');
});

test('both slots render while empty, hidden, and nothing else shows with no notice', () => {
  const html = renderStack();
  assert.match(html, /<div data-notice-slot="search" class="flex flex-col items-center gap-2 empty:hidden"><\/div>/);
  assert.match(html, /<div data-notice-slot="progress" class="flex flex-col items-center gap-2 empty:hidden"><\/div>/);
  assert.doesNotMatch(html, /role="(status|alert)"/);
});

test('the stack keeps its notices in order of how long they stay: undo, search, progress, refused reviews, update', t => {
  refuseOneReview();
  announceUpdate('service-worker');
  t.after(() => { clearRefusedReviews('u1'); dismissUpdate(); });
  const html = renderStack({
    undoMessage: 'Deleted “gamut”',
    imagePrefetchProgress: { done: 3, total: 40 },
    ttsGenProgress: { isRunning: true, current: 10, total: 100 },
  });
  const order = ['Deleted “gamut”', 'data-notice-slot="search"', 'data-notice-slot="progress"', 'Offline images · 3/40',
    'Generating sentence audio · 10/100', '1 review wasn’t accepted', 'A new version is available'].map(text => html.indexOf(text));
  assert.ok(order.every(index => index >= 0), `every notice renders: ${order}`);
  assert.deepEqual([...order].sort((a, b) => a - b), order);
});

test('every pill is capped short of the search button\'s column and truncates its text', t => {
  refuseOneReview();
  announceUpdate('chunk-load');
  t.after(() => { clearRefusedReviews('u1'); dismissUpdate(); });
  const html = renderStack({
    undoMessage: 'Deleted “gamut”',
    imagePrefetchProgress: { done: 3, total: 40 },
    imageRestoreProgress: { phase: 'uploading', done: 1, total: 4, failed: 0 },
    ttsGenProgress: { isRunning: true, current: 10, total: 100 },
  });
  const pills = [...html.matchAll(/<div role="status"[^>]*class="([^"]*)"/g)].map(match => match[1]);
  assert.equal(pills.length, 6);
  for (const pill of pills) {
    assert.ok(pill.includes('max-w-[calc(100vw-9rem)]'), pill);
    assert.ok(!pill.includes('whitespace-nowrap'), 'the text truncates instead');
  }
  assert.equal([...html.matchAll(/<span class="min-w-0 truncate">/g)].length, 6);
});

test('the jobs keep their texts and their stop buttons', () => {
  const html = renderStack({
    imagePrefetchProgress: { done: 40, total: 40 },
    ttsGenProgress: { isRunning: true, current: 7_000, total: 7_000 },
  });
  assert.match(html, /aria-label="Stop downloading offline images"/);
  assert.match(html, /title="Stop downloading"/);
  assert.match(html, /aria-label="Stop generating sentence audio"/);
  assert.match(html, />Generating sentence audio · 7000\/7000</, 'no time left at the end');
  assert.equal([...html.matchAll(/animate-spin/g)].length, 1, 'a finished download stops spinning; the speech sweep spins until it ends');
  assert.match(renderStack({ ttsGenProgress: { isRunning: true, current: 0, total: 100 } }), / · ~2m left</);
  assert.match(renderStack({ imageRestoreProgress: { phase: 'failed', done: 0, total: 0, failed: 0 } }), /bg-rose-600/);
  assert.match(renderStack({ imageRestoreProgress: { phase: 'done', done: 4, total: 4, failed: 0 } }), /bg-emerald-600[^>]*><span class="min-w-0 truncate">Restored 4 images to the server ✓/);
});

const renderPill = (props: Partial<ComponentProps<typeof NoticePill>>) =>
  renderToStaticMarkup(createElement(NoticePill, { tone: 'dark', children: 'Saved', ...props }));

test('a notice pill takes its tone\'s colour, a status unless it is an alert', () => {
  const tones: Record<NoticeTone, string> = { dark: 'bg-slate-800', indigo: 'bg-indigo-600', emerald: 'bg-emerald-600', amber: 'bg-amber-600', rose: 'bg-rose-600' };
  for (const [tone, colour] of Object.entries(tones) as [NoticeTone, string][]) {
    const html = renderPill({ tone });
    assert.match(html, /^<div role="status"/);
    assert.ok(html.includes(colour), `${tone} is ${colour}`);
  }
  assert.match(renderPill({ tone: 'rose', role: 'alert' }), /^<div role="alert"/);
});

test('a notice pill draws its spinner, progress, actions and second line only when asked', () => {
  const plain = renderPill({});
  assert.doesNotMatch(plain, /animate-spin|<button|w-10/);
  assert.match(plain, /rounded-full/);
  assert.match(plain, /px-4 py-2/);

  const busy = renderPill({ tone: 'indigo', spinner: true, progress: 0.25, actions: [{ label: 'Stop it', dismiss: true, title: 'Stop', onClick: () => {} }] });
  assert.match(busy, /animate-spin/);
  assert.match(busy, /style="width:25%"/);
  assert.match(busy, /pl-4 pr-1.5 py-1.5/);
  assert.match(busy, /<button type="button" title="Stop" aria-label="Stop it" class="shrink-0 w-8 h-8 rounded-full/);

  const action = renderPill({ actions: [{ label: 'Undo', onClick: () => {}, keyShortcuts: 'Meta+Z Control+Z' }] });
  assert.match(action, /<button type="button" aria-keyshortcuts="Meta\+Z Control\+Z" class="shrink-0 rounded-full px-3 py-1 font-semibold disabled:opacity-70 text-indigo-300 hover:bg-white\/10">Undo<\/button>/);

  const wrapped = renderPill({ wrap: true, title: 'All of it', label: 'All of it, said in full' });
  assert.match(wrapped, /^<div role="status" title="All of it" aria-label="All of it, said in full" class="[^"]*rounded-2xl/);
  assert.match(wrapped, /<span class="min-w-0 line-clamp-2">Saved<\/span>/);
});
