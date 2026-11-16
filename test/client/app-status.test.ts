import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement, type ComponentProps } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import * as AppStatus from '../../components/AppStatus.tsx';
import { AppStatusPills } from '../../components/AppStatus.tsx';
import { JobPills, StuckSyncPill } from '../../components/JobPills.tsx';
import { NoticePill, type NoticeTone } from '../../components/NoticePill.tsx';
import { RefusedChangesNotice } from '../../components/RefusedChanges.tsx';
import { fetchImageBatch, type ImagePrefetchProgress } from '../../hooks/useOfflineImages.ts';
import { announceUpdate, dismissUpdate } from '../../services/appUpdate.ts';
import type { ImageToStore } from '../../services/imageStore.ts';
import type { JobNotice } from '../../services/jobNotices.ts';
import { clearRefusedReviews, recordRefusedReview } from '../../services/refusedReviews.ts';
import type { StoredItem } from '../../types.ts';
import { MemoryStorage } from '../support/memory-storage.ts';

// components/AppStatus.tsx's notice stack, the job and stuck-sync pills App renders into it (components/JobPills.tsx),
// where the refused-changes notice sits among them (components/RefusedChanges.tsx, tested in refused-changes.test.ts),
// and components/NoticePill.tsx, rendered on the server; and the counts the offline-image download's pill reports
// (hooks/useOfflineImages.ts). The refused-reviews notice reads this device's log from localStorage, and the update
// notice reads services/appUpdate.
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
  stuckSyncPill: null,
  writeFailed: false,
  offline: false,
  offlineChip: false,
  refusedChangesNotice: null,
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
  forceSync: null,
  onForceSync: () => {},
  jobNotice: null,
  onRetryJob: () => {},
  onDismissJobNotice: () => {},
};
/** The job pills as App renders them into the stack. */
const jobPills = (props: Partial<JobProps>) => createElement(JobPills, { ...noJobs, ...props });
const renderJobs = (props: Partial<JobProps>) => renderStack({ jobPills: jobPills(props) });
/** The offline-image download `done` of `total` pictures in, as its pill shows it. */
const downloading = (done: number, total: number): ImagePrefetchProgress => ({ phase: 'downloading', done, total, saved: done, failed: 0 });
/** The class list of the stack's own element, the first in the markup. */
const stackClasses = (html: string) => html.match(/^<div class="([^"]*)"/)![1].split(/\s+/);
const refuseOneReview = () => recordRefusedReview('u1', { itemId: 'i1', word: 'gamut', reviewedAt: 1, reason: 'The card isn’t on the server' });

test('the stack is a fixed, centred column that lets taps through between its pills', () => {
  const classes = stackClasses(renderStack());
  for (const name of ['fixed', 'left-1/2', '-translate-x-1/2', 'flex', 'flex-col', 'items-center', 'gap-2', 'pointer-events-none']) {
    assert.ok(classes.includes(name), name);
  }
  // As wide as its widest pill, up to the pill's own cap: centred by its left edge alone, the column would shrink to the
  // 50vw right of that edge, and on a phone a pill that wraps would get half the screen.
  assert.ok(classes.includes('w-max'), 'w-max');
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
    imagePrefetchProgress: downloading(3, 40),
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
  const online = renderStack({ writeFailed: true, imagePrefetchProgress: downloading(3, 40) });
  const alert = online.match(/<div role="alert" class="([^"]*)"><span class="min-w-0 line-clamp-3">Couldn’t save on this device\. Your changes still sync\.<\/span><\/div>/);
  assert.ok(alert, 'a rose alert of up to three lines, which the offline advice takes on a phone');
  for (const name of ['bg-rose-600', 'rounded-2xl']) assert.ok(alert[1].split(/\s+/).includes(name), name);
  const order = ['Offline images · 3/40', 'role="alert"', '1 review wasn’t accepted'].map(text => online.indexOf(text));
  assert.deepEqual([...order].sort((a, b) => a - b), order, 'below the progress pills, above refused reviews');
  assert.match(renderStack({ writeFailed: true, offline: true }), />Couldn’t save on this device\. Keep this tab open until you’re back online\.</);
  assert.doesNotMatch(renderStack({ offline: true }), /role="alert"/);
});

type StuckProps = ComponentProps<typeof StuckSyncPill>;
/** The stuck-sync pill with `unsent` changes unsent, two pushes having failed a minute ago or more. */
const stuckPill = (unsent: number, props: Partial<StuckProps> = {}) => createElement(StuckSyncPill, {
  library: {
    savedItems: [],
    pushTrouble: { failures: 2, firstFailureAt: Date.now() - 61_000, nextRetryAt: Date.now() + 1_000 },
    countUnsentChanges: () => unsent,
  },
  online: true,
  onRetry: () => {},
  ...props,
});
/** Renders with a page whose visibility the stuck-sync pill reads. */
const onPage = (visibilityState: DocumentVisibilityState, render: () => string): string => {
  const globals = globalThis as Record<string, unknown>;
  globals.document = { visibilityState };
  try {
    return render();
  } finally {
    delete globals.document;
  }
};

test('changes that won\'t sync get an amber pill with Retry, below the couldn\'t-save alert and above refused reviews', t => {
  refuseOneReview();
  t.after(() => clearRefusedReviews('u1'));
  const html = onPage('visible', () => renderStack({ stuckSyncPill: stuckPill(3), writeFailed: true }));
  assert.match(html, /<div role="status" class="[^"]*bg-amber-600[^"]*"><span class="min-w-0 truncate">3 changes not synced<\/span><button type="button" class="[^"]*">Retry<\/button><\/div>/);
  assert.match(onPage('visible', () => renderToStaticMarkup(stuckPill(1))), />1 change not synced</);
  const order = ['role="alert"', '3 changes not synced', '1 review wasn’t accepted'].map(text => html.indexOf(text));
  assert.deepEqual([...order].sort((a, b) => a - b), order);
});

test('the stuck-sync pill waits for its minute, and stays away offline, on a hidden page or with nothing unsent', () => {
  const visible = (pill: ReturnType<typeof stuckPill>) => onPage('visible', () => renderToStaticMarkup(pill));
  const recent = { failures: 2, firstFailureAt: Date.now() - 30_000, nextRetryAt: Date.now() + 1_000 };
  assert.equal(visible(stuckPill(3, { library: { savedItems: [], pushTrouble: recent, countUnsentChanges: () => 3 } })), '');
  assert.equal(visible(stuckPill(3, { online: false })), '', 'offline is the Offline chip\'s to say');
  assert.equal(visible(stuckPill(0)), '');
  assert.equal(onPage('hidden', () => renderToStaticMarkup(stuckPill(3))), '');
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

/** A word the server refused. */
const refusedWord = (word: string) => ({ type: 'vocab', data: { id: word, word }, savedAt: 1 }) as unknown as StoredItem;
/** The refused-changes notice for `words`, as App renders it into the stack. */
const refusedNotice = (...words: string[]) => createElement(RefusedChangesNotice, { items: words.map(refusedWord) });

test('changes the server refused get one amber pill, with a × and no View, after the Offline chip and before refused reviews', t => {
  refuseOneReview();
  t.after(() => clearRefusedReviews('u1'));
  assert.doesNotMatch(renderStack(), /on this device: the server refused/, 'none by default');
  // The notice's words and its × are components/RefusedChanges' (refused-changes.test.ts).
  const one = renderStack({ refusedChangesNotice: refusedNotice('gamut') });
  assert.match(one, /<div role="status" class="[^"]*rounded-2xl bg-amber-600[^"]*"><span class="min-w-0 line-clamp-3">“gamut” stays on this device: the server refused it<\/span><button type="button" title="Dismiss" aria-label="Dismiss the refused changes notice"/);
  assert.equal(one.match(/<button/g)?.length, 3, 'its ×, and the refused reviews\' View and ×');
  const html = renderStack({ refusedChangesNotice: refusedNotice('gamut', 'atlas'), offlineChip: true, offline: true, writeFailed: true });
  const order = ['role="alert"', '>Offline<', '>2 changes stay on this device', '1 review wasn’t accepted'].map(text => html.indexOf(text));
  assert.ok(order.every(index => index >= 0), `every notice renders: ${order}`);
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
    imagePrefetchProgress: downloading(3, 40),
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

test('the offline-image download spins with its stop button while it runs', () => {
  const html = renderStack({ imagePrefetchProgress: downloading(120, 340) });
  assert.match(html, /<div role="status" class="[^"]*bg-indigo-600[^"]*"><svg[^>]*animate-spin[^>]*>.*?<\/svg><span class="min-w-0 truncate">Offline images · 120\/340<\/span>/);
  assert.match(html, /aria-label="Stop downloading offline images"/);
  assert.match(html, /title="Stop downloading"/);
});

test('the offline-image download then says what it saved, what failed, or that there was nothing to do', () => {
  const ended = (progress: Partial<ImagePrefetchProgress>) =>
    renderStack({ imagePrefetchProgress: { phase: 'done', done: 0, total: 0, saved: 0, failed: 0, ...progress } });
  // On a phone the text takes more lines rather than lose the count that failed.
  const pill = (tone: string, text: string) =>
    new RegExp(`<div role="status" class="[^"]*rounded-2xl bg-${tone}-600[^"]*"><span class="min-w-0 line-clamp-3">${text}</span></div>`);
  assert.match(ended({ done: 340, total: 340, saved: 340 }), pill('emerald', 'Saved 340 images for offline use'));
  assert.match(ended({ done: 1, total: 1, saved: 1 }), pill('emerald', 'Saved 1 image for offline use'));
  assert.match(ended({ done: 340, total: 340, saved: 300, failed: 40 }), pill('rose', 'Saved 300 of 340 images · 40 couldn’t download'));
  assert.match(ended({ phase: 'nothing' }), pill('emerald', 'All images are already offline'));
  assert.match(ended({ phase: 'empty' }), pill('emerald', 'No images to download'));
  for (const phase of ['done', 'nothing', 'empty'] as const) {
    assert.doesNotMatch(ended({ phase }), /animate-spin|<button/, `${phase}: nothing left to stop`);
  }
});

test('a batch of the offline download counts what it stored and what failed, and a picture the server lacks as neither', async () => {
  const versions = new Map([['a', 'v1']]);
  const stored: ImageToStore[][] = [];
  const blob = new Blob(['x']);
  // a and b arrive, c's download throws, and the server has no picture for d.
  const load = async (ids: string[], given?: ReadonlyMap<string, string>) => {
    assert.equal(given, versions);
    return { images: new Map(ids.filter(id => id === 'a' || id === 'b').map(id => [id, blob])), failed: ids.filter(id => id === 'c') };
  };
  const store = (ok: boolean) => async (images: ImageToStore[], options?: { remember?: boolean }) => {
    assert.deepEqual(options, { remember: false }, 'a bulk download leaves the memory cache to the cards just viewed');
    stored.push(images);
    return ok;
  };
  assert.deepEqual(await fetchImageBatch(['a', 'b', 'c', 'd'], versions, load, store(true)), { saved: 2, failed: 1 });
  assert.deepEqual(stored[0], [{ id: 'a', image: blob, version: 'v1' }, { id: 'b', image: blob, version: undefined }]);
  assert.deepEqual(await fetchImageBatch(['a', 'b', 'c', 'd'], versions, load, store(false)), { saved: 0, failed: 3 }, 'storing failed');
  const offline = async () => { throw new Error('offline'); };
  assert.deepEqual(await fetchImageBatch(['a', 'b', 'c', 'd'], versions, offline, store(true)), { saved: 0, failed: 4 }, 'the batch threw');
});

test('the image restore spins on indigo while it checks and uploads, a failed batch included, as the download does', () => {
  const running = (html: string, text: string) => assert.match(html, new RegExp(
    `<div role="status" class="[^"]*bg-indigo-600[^"]*"><svg[^>]*animate-spin[^>]*>.*?</svg><span class="min-w-0 truncate">${text}</span></div>`,
  ));
  running(renderStack({ imageRestoreProgress: { phase: 'checking', done: 0, total: 0, failed: 0 } }), 'Checking which images the server is missing…');
  running(renderStack({ imageRestoreProgress: { phase: 'uploading', done: 12, total: 40, failed: 0 } }), 'Restoring images to server: 12/40');
  // A batch that failed doesn't end the run: it stays work in progress until the result.
  running(renderStack({ imageRestoreProgress: { phase: 'uploading', done: 30, total: 40, failed: 10 } }), 'Restoring images to server: 30/40');
  for (const phase of ['done', 'failed'] as const) {
    const ended = renderStack({ imageRestoreProgress: { phase, done: 4, total: 4, failed: 0 } });
    assert.doesNotMatch(ended, /animate-spin|bg-indigo-600/, `${phase}: a result, no longer work in progress`);
  }
});

test('the image restore says how it went, with no check marks, as no other pill has', () => {
  assert.match(renderStack({ imageRestoreProgress: { phase: 'failed', done: 0, total: 0, failed: 0 } }), /bg-rose-600/);
  const restored = renderStack({ imageRestoreProgress: { phase: 'done', done: 4, total: 4, failed: 0 } });
  assert.match(restored, /bg-emerald-600[^>]*><span class="min-w-0 truncate">Restored 4 images to the server<\/span>/);
  const nothingToRestore = renderStack({ imageRestoreProgress: { phase: 'done', done: 0, total: 0, failed: 0 } });
  assert.match(nothingToRestore, /<span class="min-w-0 truncate">All images already on the server<\/span>/);
  for (const html of [restored, nothingToRestore]) assert.doesNotMatch(html, /✓/);
});

test('the speech sweep shows its progress, with no time estimate, and a × that only hides it: the server carries on', () => {
  const html = renderJobs({ speechProgress: { current: 1_200, total: 7_000 } });
  assert.match(html, /<span class="min-w-0 truncate">Sentence audio · 1,200\/7,000<\/span>/);
  assert.match(html, /style="width:17%"/, 'the bar');
  assert.match(html, /animate-spin/, 'it spins until the server is done');
  assert.match(html, /<button type="button" title="Hide" aria-label="Hide sentence audio progress; generation continues on the server"/);
  assert.doesNotMatch(html, /left<|Stop generating|Generating/);
});

test('Sync now shows that it is syncing, then that everything is up to date, or that it failed, with Retry', () => {
  const syncing = renderJobs({ forceSync: 'syncing' });
  assert.match(syncing, /<div role="status" class="[^"]*bg-indigo-600[^"]*"><svg[^>]*animate-spin[^>]*>.*?<\/svg><span class="min-w-0 truncate">Syncing…<\/span><\/div>/);
  assert.match(renderJobs({ forceSync: 'done' }), /<div role="status" class="[^"]*bg-emerald-600[^"]*"><span class="min-w-0 truncate">Up to date<\/span><\/div>/);
  assert.match(renderJobs({ forceSync: 'failed' }), /<div role="alert" class="[^"]*bg-rose-600[^"]*"><span class="min-w-0 truncate">Couldn’t sync<\/span><button type="button" class="[^"]*">Retry<\/button><\/div>/);
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
    imagePrefetchProgress: downloading(3, 40),
    jobPills: jobPills({
      speechProgress: { current: 10, total: 100 },
      batchImportProgress: importing(12, 40),
      forceSync: 'syncing',
      jobNotice: { text: 'No duplicates found', tone: 'emerald', timeoutMs: 3_000 },
    }),
  });
  const order = ['data-notice-slot="progress"', 'Offline images · 3/40', 'Sentence audio · 10/100', 'Adding words · 12/40',
    'Syncing…', 'No duplicates found', '1 review wasn’t accepted'].map(text => html.indexOf(text));
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
  assert.match(wrapped, /<span class="min-w-0 line-clamp-3">Saved<\/span>/);
});
