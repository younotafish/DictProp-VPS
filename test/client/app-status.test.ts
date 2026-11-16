import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement, type ComponentProps } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import * as AppStatus from '../../components/AppStatus.tsx';
import { AppStatusPills } from '../../components/AppStatus.tsx';
import { JobPills } from '../../components/JobPills.tsx';
import { NoticePill, type NoticeTone } from '../../components/NoticePill.tsx';
import { announceUpdate, dismissUpdate } from '../../services/appUpdate.ts';
import type { JobNotice } from '../../services/jobNotices.ts';
import { clearRefusedReviews, recordRefusedReview } from '../../services/refusedReviews.ts';
import { MemoryStorage } from '../support/memory-storage.ts';

// components/AppStatus.tsx's notice stack, the job pills App renders into it (components/JobPills.tsx), and
// components/NoticePill.tsx, rendered on the server. The refused-reviews notice reads this device's log from
// localStorage, and the update notice reads services/appUpdate.
(globalThis as unknown as { localStorage: MemoryStorage }).localStorage = new MemoryStorage();

type StackProps = ComponentProps<typeof AppStatusPills>;
const quiet: StackProps = {
  userId: 'u1',
  onViewRefusedReviews: () => {},
  imagePrefetchProgress: null,
  onStopImageDownload: () => {},
  imageRestoreProgress: null,
  jobPills: null,
  undoMessage: null,
  onUndo: () => {},
  writeFailed: false,
  offline: false,
  offlineChip: false,
  aboveTabBar: true,
  holdUpdate: false,
  liftAbovePopup: false,
};
const renderStack = (props: Partial<StackProps> = {}) => renderToStaticMarkup(createElement(AppStatusPills, { ...quiet, ...props }));

type JobProps = ComponentProps<typeof JobPills>;
const noJobs: JobProps = {
  speechProgress: null,
  onHideSpeechProgress: () => {},
  batchImportProgress: null,
  onStopBatchImport: () => {},
  jobNotice: null,
  onRetryJob: () => {},
  onDismissJobNotice: () => {},
};
/** The job pills as App renders them into the stack. */
const jobPills = (props: Partial<JobProps>) => createElement(JobPills, { ...noJobs, ...props });
const renderJobs = (props: Partial<JobProps>) => renderStack({ jobPills: jobPills(props) });
/** The class list of the stack's own element, the first in the markup. */
const stackClasses = (html: string) => html.match(/^<div class="([^"]*)"/)![1].split(/\s+/);
const refuseOneReview = () => recordRefusedReview('u1', { itemId: 'i1', word: 'gamut', reviewedAt: 1, reason: 'The card isn’t on the server' });

test('the stack is a fixed, centred column that lets taps through between its pills', () => {
  const classes = stackClasses(renderStack());
  for (const name of ['fixed', 'left-1/2', '-translate-x-1/2', 'flex', 'flex-col', 'items-center', 'gap-2', 'pointer-events-none']) {
    assert.ok(classes.includes(name), name);
  }
});

test('the stack rises above the card popup only when told to, and otherwise stays beneath every dialog', () => {
  assert.ok(stackClasses(renderStack({ liftAbovePopup: true, undoMessage: 'Deleted “gamut”' })).includes('z-[110]'));
  const beneath = stackClasses(renderStack({ undoMessage: 'Deleted “gamut”' }));
  assert.ok(beneath.includes('z-[80]'), 'an undo offer alone no longer lifts it over open dialogs');
  assert.ok(!beneath.includes('z-[110]'));
});

test('on the tabs the stack floats above the tab bar and a tab\'s footer; over a card it starts at --card-float-bottom', () => {
  assert.ok(stackClasses(renderStack({ aboveTabBar: true })).includes('bottom-[calc(var(--nav-h)+var(--tab-footer-h,0px)+0.5rem)]'));
  const overCard = stackClasses(renderStack({ aboveTabBar: false }));
  assert.ok(overCard.includes('bottom-[var(--card-float-bottom)]'));
  assert.equal(overCard.filter(name => name.startsWith('bottom-')).length, 1);
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
    jobPills: jobPills({ speechProgress: { current: 10, total: 100 } }),
  });
  const order = ['Deleted “gamut”', 'data-notice-slot="search"', 'data-notice-slot="progress"', 'Offline images · 3/40',
    'Sentence audio · 10/100', '1 review wasn’t accepted', 'Update ready'].map(text => html.indexOf(text));
  assert.ok(order.every(index => index >= 0), `every notice renders: ${order}`);
  assert.deepEqual([...order].sort((a, b) => a - b), order);
});

test('a failed save on this device is an alert in the long-lived group, whose advice follows the connection', t => {
  refuseOneReview();
  t.after(() => clearRefusedReviews('u1'));
  const online = renderStack({ writeFailed: true, imagePrefetchProgress: { done: 3, total: 40 } });
  const alert = online.match(/<div role="alert" class="([^"]*)"><span class="min-w-0 line-clamp-2">Couldn’t save on this device\. Your changes still sync\.<\/span><\/div>/);
  assert.ok(alert, 'a rose alert of up to two lines');
  for (const name of ['bg-rose-600', 'rounded-2xl']) assert.ok(alert[1].split(/\s+/).includes(name), name);
  const order = ['Offline images · 3/40', 'role="alert"', '1 review wasn’t accepted'].map(text => online.indexOf(text));
  assert.deepEqual([...order].sort((a, b) => a - b), order, 'below the progress pills, above refused reviews');
  assert.match(renderStack({ writeFailed: true, offline: true }), />Couldn’t save on this device\. Keep this tab open until you’re back online\.</);
  assert.doesNotMatch(renderStack({ offline: true }), /role="alert"/);
});

test('the Offline chip shows only when told, below the couldn\'t-save alert and above refused reviews', t => {
  refuseOneReview();
  t.after(() => clearRefusedReviews('u1'));
  assert.doesNotMatch(renderStack({ offline: true }), />Offline</, 'App decides where the chip shows (connectivityNotice)');
  const html = renderStack({ offlineChip: true, offline: true, writeFailed: true });
  assert.match(html, /<div role="status" class="[^"]*bg-amber-600[^"]*"><svg[^>]*lucide-wifi-off[^>]*>.*?<\/svg><span class="min-w-0 truncate">Offline<\/span><\/div>/);
  const order = ['role="alert"', '>Offline<', '1 review wasn’t accepted'].map(text => html.indexOf(text));
  assert.deepEqual([...order].sort((a, b) => a - b), order);
});

test('the offline and couldn\'t-save banners above the page are gone, so nothing moves the page', () => {
  assert.deepEqual(Object.keys(AppStatus), ['AppStatusPills']);
});

test('every pill is capped short of the search button\'s column and truncates its text', t => {
  refuseOneReview();
  announceUpdate('chunk-load');
  t.after(() => { clearRefusedReviews('u1'); dismissUpdate(); });
  const html = renderStack({
    undoMessage: 'Deleted “gamut”',
    imagePrefetchProgress: { done: 3, total: 40 },
    imageRestoreProgress: { phase: 'uploading', done: 1, total: 4, failed: 0 },
    jobPills: jobPills({ speechProgress: { current: 10, total: 100 } }),
  });
  const pills = [...html.matchAll(/<div role="status"[^>]*class="([^"]*)"/g)].map(match => match[1]);
  assert.equal(pills.length, 6);
  for (const pill of pills) {
    assert.ok(pill.includes('max-w-[calc(100vw-9rem)]'), pill);
    assert.ok(!pill.includes('whitespace-nowrap'), 'the text truncates instead');
  }
  assert.equal([...html.matchAll(/<span class="min-w-0 truncate">/g)].length, 6);
});

test('the undo pill names its shortcut to assistive technology, with no hint on screen', () => {
  const html = renderStack({ undoMessage: 'Deleted “gamut”' });
  assert.match(html, /<span class="min-w-0 truncate">Deleted “gamut”<\/span><button type="button" aria-keyshortcuts="Meta\+Z Control\+Z" class="[^"]*">Undo<\/button>/);
  assert.doesNotMatch(html, /⌘|Ctrl/);
});

test('the update notice says it in two words, with the sentence as its title and name, and a new version waits while covered', t => {
  t.after(dismissUpdate);
  announceUpdate('service-worker');
  const ready = renderStack();
  assert.match(ready, /<div role="status" title="A new version is available" aria-label="A new version is available" class="[^"]*"><span class="min-w-0 truncate">Update ready<\/span>/);
  assert.match(ready, />Reload<\/button>/);
  assert.match(ready, /title="Not now" aria-label="Dismiss the update notice"/);
  assert.doesNotMatch(renderStack({ holdUpdate: true }), /Update ready/, 'held while a card or popup is open');

  announceUpdate('chunk-load');
  for (const holdUpdate of [false, true]) {
    assert.match(renderStack({ holdUpdate }), /title="Part of the app couldn’t load" aria-label="Part of the app couldn’t load" class="[^"]*"><span class="min-w-0 truncate">Reload needed</);
  }
});

test('the image jobs keep their texts and their stop button', () => {
  const html = renderStack({ imagePrefetchProgress: { done: 40, total: 40 } });
  assert.match(html, /aria-label="Stop downloading offline images"/);
  assert.match(html, /title="Stop downloading"/);
  assert.doesNotMatch(html, /animate-spin/, 'a finished download stops spinning');
  assert.match(renderStack({ imageRestoreProgress: { phase: 'failed', done: 0, total: 0, failed: 0 } }), /bg-rose-600/);
  assert.match(renderStack({ imageRestoreProgress: { phase: 'done', done: 4, total: 4, failed: 0 } }), /bg-emerald-600[^>]*><span class="min-w-0 truncate">Restored 4 images to the server ✓/);
});

test('the speech sweep shows its progress, with no time estimate, and a × that only hides it: the server carries on', () => {
  const html = renderJobs({ speechProgress: { current: 1_200, total: 7_000 } });
  assert.match(html, /<span class="min-w-0 truncate">Sentence audio · 1,200\/7,000<\/span>/);
  assert.match(html, /style="width:17%"/, 'the bar');
  assert.match(html, /animate-spin/, 'it spins until the server is done');
  assert.match(html, /<button type="button" title="Hide" aria-label="Hide sentence audio progress; generation continues on the server"/);
  assert.doesNotMatch(html, /left<|Stop generating|Generating/);
});

const importing = (current: number, total: number, stopping = false) =>
  ({ current, total, skipped: 0, failed: 0, saved: current, stopping });

test('a batch import shows how far it has got, on every tab, with a × that stops it', () => {
  const html = renderJobs({ batchImportProgress: importing(12, 40) });
  assert.match(html, /<span class="min-w-0 truncate">Adding words · 12\/40<\/span>/);
  assert.match(html, /style="width:30%"/, 'the bar');
  assert.match(html, /animate-spin/);
  assert.match(html, /<button type="button" title="Stop adding" aria-label="Stop adding words" class="shrink-0 w-8 h-8 rounded-full/);
  assert.match(renderJobs({ batchImportProgress: importing(1_200, 7_000) }), />Adding words · 1,200\/7,000</);
});

test('once Stop is pressed the pill says so, with nothing left to press, until the words under way are done', () => {
  const html = renderJobs({ batchImportProgress: importing(12, 40, true) });
  assert.match(html, />Stopping · 12\/40</);
  assert.doesNotMatch(html, /Stop adding words|<button/);
});

test('a job\'s result is a pill with a × that dismisses it, and Retry only when it offers one', () => {
  const done = renderJobs({ jobNotice: { text: 'Added 18 words · 2 already saved', tone: 'emerald', timeoutMs: 4_000 } });
  assert.match(done, /<div role="status" class="[^"]*bg-emerald-600[^"]*"><span class="min-w-0 truncate">Added 18 words · 2 already saved<\/span>/);
  assert.match(done, /<button type="button" title="Dismiss" aria-label="Dismiss this notice"/);
  assert.doesNotMatch(done, />Retry</);

  const failed: JobNotice = { text: 'Couldn’t add 3 words', tone: 'rose', timeoutMs: null, retryWords: ['qwxz', 'zzyzx', 'blorp'] };
  const alert = renderJobs({ jobNotice: failed });
  assert.match(alert, /<div role="alert" class="[^"]*bg-rose-600[^"]*"><span class="min-w-0 truncate">Couldn’t add 3 words<\/span><button type="button" class="[^"]*">Retry<\/button><button type="button" title="Dismiss"/);
  const whileImporting = renderJobs({ jobNotice: failed, batchImportProgress: importing(1, 5) });
  assert.match(whileImporting, /<button type="button" disabled="" class="[^"]*">Retry<\/button>/, 'Retry waits for the import under way');
});

test('the jobs come after the progress slot, and the last result just above the long-lived notices', t => {
  refuseOneReview();
  t.after(() => clearRefusedReviews('u1'));
  const html = renderStack({
    imagePrefetchProgress: { done: 3, total: 40 },
    jobPills: jobPills({
      speechProgress: { current: 10, total: 100 },
      batchImportProgress: importing(12, 40),
      jobNotice: { text: 'No duplicates found', tone: 'emerald', timeoutMs: 3_000 },
    }),
  });
  const order = ['data-notice-slot="progress"', 'Offline images · 3/40', 'Sentence audio · 10/100', 'Adding words · 12/40',
    'No duplicates found', '1 review wasn’t accepted'].map(text => html.indexOf(text));
  assert.ok(order.every(index => index >= 0), `every notice renders: ${order}`);
  assert.deepEqual([...order].sort((a, b) => a - b), order);
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
