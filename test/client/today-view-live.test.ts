import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { Activity, act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import type { ReviewEvent, StoredItem } from '../../types.ts';
import { THEME_DOMAINS, THEME_TAXONOMY_VERSION } from '../../server/src/shared/item-themes.ts';
import { readTodayPin, writeActiveUnit, writeTodayPin } from '../../services/learningLoop/sessionStore.ts';
import { localDayKey, localDayStart } from '../../services/learningLoop/standing.ts';
import { installFakeMedia } from '../support/audio/fakeMedia.ts';
import { HOUR, reviewed, sentenceItem, vocabItem } from '../support/loop-fixtures.ts';
import { MemoryStorage } from '../support/memory-storage.ts';

// Today mounted as App mounts it, in its tab's <Activity>, for what a static render never reaches: the snapshot taken
// again when a new device's library first arrives or when a page comes back into view with a unit another window
// started, and the review history asked for as Today shows and while it stays on screen. The browser is just enough
// for React (a page whose visibility changes, a window whose timers the test runs by hand), and the server is faked
// behind fetch: a theme map with nothing left to sort, and no set days yet.

installFakeMedia();
const page = Object.assign(new EventTarget(), {
  nodeType: 9, visibilityState: 'visible' as DocumentVisibilityState, activeElement: null, defaultView: null as unknown,
});
/** The window's own timers (the plan's midnight replan, the history's refreshes), which only the test runs. */
const windowTimers = new Map<number, { run: () => void; ms: number; repeats: boolean }>();
let lastTimer = 0;
const addTimer = (repeats: boolean) => (run: () => void, ms = 0) => {
  windowTimers.set(++lastTimer, { run, ms, repeats });
  return lastTimer;
};
const browser = Object.assign(new EventTarget(), (globalThis as unknown as { window: object }).window, {
  document: page, event: undefined, HTMLIFrameElement: class {},
  setTimeout: addTimer(false), setInterval: addTimer(true),
  clearTimeout: (id: number) => { windowTimers.delete(id); }, clearInterval: (id: number) => { windowTimers.delete(id); },
});
page.defaultView = browser;
Object.assign(globalThis, { window: browser, document: page, IS_REACT_ACT_ENVIRONMENT: true });

const { TodayView } = await import('../../views/today/TodayView.tsx');
const { TodayPlan } = await import('../../views/today/TodayPlan.tsx');
type TodayViewProps = Parameters<typeof TodayView>[0];
type TodayPlanProps = Parameters<typeof TodayPlan>[0];

const NOW = new Date(2026, 10, 18, 15, 0).getTime();
const USER = 'user-1';
/**
 * The clock every case reads (Date.now), from NOW on. It only moves forward, also from one case to the next: when the
 * page comes back into view useNow notes the time in one place for every screen, so a case resuming at the time an
 * earlier one did would take no new snapshot.
 */
let clock = NOW;
const [BIG, SMALL] = THEME_DOMAINS[0].themes;

// Fourteen new sentences in one theme, three in another that ranks lower, and two word cards due in Card review.
const BIG_SENTENCES = Array.from({ length: 14 }, (_, i) => sentenceItem(`big-${i}`, `A line about {{thing ${i}}}.`, { sourceWord: `thing ${i}` }));
const SMALL_SENTENCES = Array.from({ length: 3 }, (_, i) => sentenceItem(`small-${i}`, `A short line about {{item ${i}}}.`, { sourceWord: `item ${i}` }));
const CARDS = ['r1', 'r2'].map(id => vocabItem(id, `card-${id}`, { srs: reviewed(NOW - 3 * 24 * HOUR, { nextReview: NOW - HOUR, memoryStrength: 20 }) }));
const LIBRARY: StoredItem[] = [...BIG_SENTENCES, ...SMALL_SENTENCES, ...CARDS];
const THEME_ROWS: [string, string][] = [
  ...BIG_SENTENCES.map(item => [item.data.id, BIG.id] as [string, string]),
  ...SMALL_SENTENCES.map(item => [item.data.id, SMALL.id] as [string, string]),
];

/** How the fake server answers the set days' request: none yet, unless a case says otherwise. */
const NO_SET_DAYS = () => Response.json({ days: {} });
let answerSetDays: (url: URL) => Response | Promise<Response> = NO_SET_DAYS;

/** The server behind fetch: every theme row at once, nothing waiting to be sorted, and the set days as answerSetDays says. */
function fakeServer(t: TestContext) {
  const realFetch = globalThis.fetch;
  const themes = (rows: [string, string][]) =>
    Response.json({ taxonomyVersion: THEME_TAXONOMY_VERSION, rows, latestSeq: THEME_ROWS.length, pending: 0, status: 'idle' });
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input);
    if (url === '/api/themes?after=0') return themes(THEME_ROWS);
    if (url.startsWith('/api/themes?after=')) return themes([]);
    if (url.startsWith('/api/reviews/set-days?')) return answerSetDays(new URL(url, 'https://dictprop.online'));
    throw new Error(`unexpected request ${url}`);
  }) as typeof fetch;
  t.after(() => { globalThis.fetch = realFetch; });
}

/** The first element in a tree that `match` accepts. */
type ElementLike = { type?: unknown; props?: Record<string, unknown> & { children?: unknown } };
function findElement(node: unknown, match: (node: ElementLike) => boolean): ElementLike | null {
  if (!node || typeof node !== 'object') return null;
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = findElement(child, match);
      if (found) return found;
    }
    return null;
  }
  const element = node as ElementLike;
  if (element.props && match(element)) return element;
  return findElement(element.props?.children, match);
}

/** Runs `change` in act, and lets what it sets off (the set days' answer, the theme map's) land before act ends. */
const settled = (change: () => void) => act(async () => {
  change();
  await new Promise(resolve => setTimeout(resolve, 5));
});

/**
 * Today mounted on a fresh device a minute after the last case, once `setup` has put what the device keeps in its
 * storage, its hooks run by a probe that draws nothing (as today-view.test.ts's planOf does). `plan()` is the plan it
 * last rendered, with its handlers.
 */
async function mountToday(t: TestContext, initial: Partial<TodayViewProps>, setup: () => void = () => {}) {
  clock += 60_000;
  t.mock.method(Date, 'now', () => clock);
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: new MemoryStorage() });
  t.after(() => { Reflect.deleteProperty(globalThis, 'localStorage'); });
  setup();
  fakeServer(t);
  windowTimers.clear();
  page.visibilityState = 'visible';

  let props: TodayViewProps = {
    userId: USER, items: LIBRARY, studyItems: CARDS, reviewHistory: { recent: [], olderTimes: [], olderCount: 0 },
    onReview: async () => true, onUndoReview: async () => true, onOpenExampleSentence: () => {}, onViewCards: () => {},
    onOpenSentence: () => {}, ...initial,
  };
  let tree: unknown;
  const Probe = (probeProps: TodayViewProps) => {
    tree = TodayView(probeProps);
    return null;
  };
  const container = Object.assign(new EventTarget(), {
    nodeType: 1, nodeName: 'DIV', tagName: 'DIV', namespaceURI: 'http://www.w3.org/1999/xhtml', ownerDocument: page, textContent: '',
  });
  const root = createRoot(container as unknown as Element);
  const render = (change: Partial<TodayViewProps> = {}, shown = true) => {
    props = { ...props, ...change };
    return settled(() => root.render(createElement(Activity, { mode: shown ? 'visible' : 'hidden', children: createElement(Probe, props) })));
  };
  await render();
  t.after(() => act(() => root.unmount()));

  const plan = (): TodayPlanProps => {
    const found = findElement(tree, node => node.type === TodayPlan);
    assert.ok(found, 'Today shows its plan');
    return found.props as unknown as TodayPlanProps;
  };
  return {
    render,
    plan,
    /** Lets the theme map and the set days arrive until `check` holds. */
    async until(check: () => boolean, what: string) {
      for (let tries = 0; tries < 400; tries++) {
        if (check()) return;
        await settled(() => {});
      }
      assert.fail(`timed out waiting until ${what}`);
    },
    /** The page goes to the background and comes back into view `ms` later. */
    resumePage: (ms: number) => settled(() => {
      page.visibilityState = 'hidden';
      page.dispatchEvent(new Event('visibilitychange'));
      clock += ms;
      page.visibilityState = 'visible';
      page.dispatchEvent(new Event('visibilitychange'));
    }),
    /** Runs `change` in act, as a tap does. */
    tap: settled,
    /** The window's repeating timers of `ms`. */
    intervals: (ms: number) => [...windowTimers.values()].filter(timer => timer.repeats && timer.ms === ms),
  };
}

/** The unit card's size, when it offers a unit to start. */
const startSize = (plan: TodayPlanProps) => (plan.card.kind === 'start' ? plan.card.size : null);

test('a plan taken over a new device\'s empty library fills in when the library first arrives, with no tab switch', async t => {
  const today = await mountToday(t, { items: [], studyItems: [] });
  await today.until(() => today.plan().card.kind === 'empty', 'the theme map is in, over the empty library');
  assert.equal(today.plan().hasThemes, false);
  assert.equal(today.plan().classicDue, 0);

  // The first pull lands while Today is on screen.
  await today.render({ items: LIBRARY, studyItems: CARDS });
  const plan = today.plan();
  assert.equal(plan.card.kind, 'start');
  assert.equal(plan.card.kind === 'start' && plan.card.set.themeId, BIG.id);
  assert.equal(plan.hasThemes, true);
  assert.equal(plan.classicDue, 2);
});

test('a plan over a library holds still while the library grows under it', async t => {
  const today = await mountToday(t, { items: BIG_SENTENCES.slice(0, 6), studyItems: [] });
  await today.until(() => today.plan().card.kind === 'start', 'the plan offers a unit');
  assert.equal(startSize(today.plan()), 6);

  await today.render({ items: LIBRARY, studyItems: CARDS });
  assert.equal(startSize(today.plan()), 6, 'the unit offered stays as it was');
  assert.equal(today.plan().classicDue, 0);
});

test('today\'s pin survives a plan over an empty library, and the plan keeps to it once the library arrives', async t => {
  // The device kept today's theme, then lost its library (storage cleared, say) and opens with the server's on its way.
  let pin = { day: '', themeId: SMALL.id };
  const today = await mountToday(t, { items: [], studyItems: [] }, () => {
    pin = { day: localDayKey(Date.now()), themeId: SMALL.id };
    writeTodayPin(USER, pin);
  });
  await today.until(() => today.plan().card.kind === 'empty', 'the theme map is in, over the empty library');
  assert.deepEqual(readTodayPin(USER), pin, 'a plan with no unit says nothing about the day\'s theme');

  await today.render({ items: LIBRARY, studyItems: CARDS });
  const plan = today.plan();
  assert.equal(plan.card.kind === 'start' && plan.card.set.themeId, SMALL.id, 'the pinned theme, though another ranks higher');
  assert.deepEqual(readTodayPin(USER), pin);
});

test('a page that comes back into view takes up the unit another window started over the sentences it offers', async t => {
  const today = await mountToday(t, {});
  await today.until(() => today.plan().card.kind === 'start', 'the plan offers a unit');
  const offered = today.plan().card;
  assert.ok(offered.kind === 'start');

  // Another window of the app starts that unit; this one comes back into view a minute later.
  writeActiveUnit({ version: 1, userId: USER, id: 'other-window', themeId: offered.set.themeId, itemIds: offered.set.itemIds, startedAt: Date.now() });
  await today.resumePage(60_000);
  const plan = today.plan();
  assert.equal(plan.card.kind, 'continue', 'Continue, not a second unit over the same sentences');
  assert.equal(plan.card.kind === 'continue' && plan.card.size, offered.set.itemIds.length);
});

test('Today asks for a fresh history as it takes each snapshot, and every two minutes while its plan shows uncovered', async t => {
  let refreshes = 0;
  const onRefreshHistory = () => { refreshes++; };
  const today = await mountToday(t, { onRefreshHistory });
  await today.until(() => today.plan().card.kind === 'start', 'the plan offers a unit');
  assert.ok(refreshes >= 1, 'as Today showed');

  // The page comes back into view: a new snapshot, and the history asked for again.
  let before = refreshes;
  await today.resumePage(60_000);
  assert.equal(refreshes, before + 1);

  // Left on screen, it asks every two minutes, but not while the page is hidden.
  const [interval] = today.intervals(2 * 60_000);
  assert.ok(interval, 'the two-minute refresh runs');
  before = refreshes;
  interval.run();
  assert.equal(refreshes, before + 1);
  page.visibilityState = 'hidden';
  interval.run();
  page.visibilityState = 'visible';
  assert.equal(refreshes, before + 1);

  // Under the lesson it stops; as the lesson closes the plan is taken again, the history asked for, and it starts again.
  await today.render({ interactionLocked: true });
  assert.equal(today.intervals(2 * 60_000).length, 0);
  before = refreshes;
  clock += 60_000;
  await today.render({ interactionLocked: false });
  assert.equal(refreshes, before + 1);
  assert.equal(today.intervals(2 * 60_000).length, 1);

  // Hidden behind another tab, and in Card review, it doesn't run either.
  await today.render({}, false);
  assert.equal(today.intervals(2 * 60_000).length, 0);
  await today.render({}, true);
  assert.equal(today.intervals(2 * 60_000).length, 1);
  await today.tap(() => today.plan().onClassic());
  assert.equal(today.intervals(2 * 60_000).length, 0);
});

test('after a trip the streak waits for set days counted in the new zone, never the old zone\'s merged with the history', async t => {
  const savedZone = process.env.TZ;
  process.env.TZ = 'America/New_York';
  t.after(() => {
    answerSetDays = NO_SET_DAYS;
    if (savedZone === undefined) delete process.env.TZ;
    else process.env.TZ = savedZone;
  });
  // Yesterday's unit, Got it'd from 00:30 in New York: 23:30 the evening before in Chicago.
  const from = localDayStart(clock, -1) + 30 * 60_000;
  const unit: ReviewEvent[] = BIG_SENTENCES.slice(0, 12).map((item, index) => ({
    id: `trip-${index}`, itemId: item.data.id, itemType: 'sentence', reviewedAt: from + index * 60_000, previousStep: 0,
    nextStep: 1, rating: 'good', taskType: 'quick', sessionId: 'set:trip',
  }));
  // The server counts the calendar days of the zone the device names, which is the zone the test is in.
  let online = true;
  answerSetDays = url => {
    if (!online) throw new TypeError('Failed to fetch');
    return Response.json({ days: { [localDayKey(from)]: 12 }, timeZone: url.searchParams.get('tz') });
  };
  const today = await mountToday(t, { reviewHistory: { recent: unit, olderTimes: [], olderCount: 0 } });
  await today.until(() => today.plan().streak !== null, 'the set days are in');
  assert.equal(today.plan().streak, 1, 'yesterday, in New York');

  // The device lands in Chicago the same day, offline. New York's days, with the history bucketed by Chicago's offset,
  // would put the unit on yesterday and on the day before: a streak of two.
  online = false;
  process.env.TZ = 'America/Chicago';
  await today.resumePage(60_000);
  assert.equal(today.plan().streak, null);

  // Back online, with Today still on screen: the connection's return asks again, and Chicago's days come, where the
  // unit fell on the evening before yesterday.
  online = true;
  await today.tap(() => { browser.dispatchEvent(new Event('online')); });
  await today.until(() => today.plan().streak !== null, 'Chicago\'s set days are in');
  assert.equal(today.plan().streak, 0);
});

test('a zone the device moves to with Today on screen takes the snapshot again, and the streak counts in that zone', async t => {
  const savedZone = process.env.TZ;
  process.env.TZ = 'America/New_York';
  t.after(() => {
    answerSetDays = NO_SET_DAYS;
    if (savedZone === undefined) delete process.env.TZ;
    else process.env.TZ = savedZone;
  });
  // 00:31 in New York (mountToday adds the minute), when it is 23:31 the evening before in Chicago. The clock only
  // moves forward: to the next midnight.
  clock = localDayStart(clock, 1) + 30 * 60_000;
  // A unit Got it'd from 00:10 in New York two days before, which was 23:10 the day before that in Chicago.
  const from = localDayStart(clock + 60_000, -2) + 10 * 60_000;
  const unit: ReviewEvent[] = BIG_SENTENCES.slice(0, 12).map((item, index) => ({
    id: `move-${index}`, itemId: item.data.id, itemType: 'sentence', reviewedAt: from + index * 60_000, previousStep: 0,
    nextStep: 1, rating: 'good', taskType: 'quick', sessionId: 'set:move',
  }));
  answerSetDays = url => Response.json({ days: { [localDayKey(from)]: 12 }, timeZone: url.searchParams.get('tz') });
  const today = await mountToday(t, { reviewHistory: { recent: unit, olderTimes: [], olderCount: 0 } });
  await today.until(() => today.plan().streak !== null, 'the set days are in');
  assert.equal(today.plan().streak, 0, 'in New York the unit was two days ago');

  // The device's zone becomes Chicago with Today on screen, and nothing but a history refresh renders it again. New
  // York's days, with the history bucketed by Chicago's offset, would put the unit on the two days before today in
  // Chicago: a streak of two.
  process.env.TZ = 'America/Chicago';
  await today.render({ reviewHistory: { recent: [...unit], olderTimes: [], olderCount: 0 } });
  assert.notEqual(today.plan().streak, 2);
  await today.until(() => today.plan().streak !== null, 'Chicago\'s set days are in');
  assert.equal(today.plan().streak, 0, 'in Chicago the unit was three days ago');
});

test('a zone change with Today on screen takes the time again, so the plan keeps today\'s pin on a date the snapshot\'s time has left', async t => {
  const savedZone = process.env.TZ;
  process.env.TZ = 'America/New_York';
  t.after(() => {
    if (savedZone === undefined) delete process.env.TZ;
    else process.env.TZ = savedZone;
  });
  // 00:31 in New York (mountToday adds the minute), with today's theme the smaller one.
  clock = localDayStart(clock, 1) + 30 * 60_000;
  let pin = { day: '', themeId: SMALL.id };
  const today = await mountToday(t, {}, () => {
    pin = { day: localDayKey(Date.now()), themeId: SMALL.id };
    writeTodayPin(USER, pin);
  });
  await today.until(() => today.plan().card.kind === 'start', 'the plan offers a unit');
  const before = today.plan().card;
  assert.equal(before.kind === 'start' && before.set.themeId, SMALL.id);

  // An hour on, the device's zone becomes Chicago, where it is 00:30 the same day, and a history refresh renders Today.
  // The snapshot's time, 00:31 in New York, was the evening before in Chicago: a plan taken at it would make yesterday
  // today and its theme the day's.
  clock += 59 * 60_000;
  process.env.TZ = 'America/Chicago';
  await today.render({ reviewHistory: { recent: [], olderTimes: [], olderCount: 0 } });
  assert.equal(localDayKey(Date.now()), pin.day, 'the same date in Chicago');
  const after = today.plan().card;
  assert.equal(after.kind === 'start' && after.set.themeId, SMALL.id);
  assert.deepEqual(readTodayPin(USER), pin);
});

test('an answer for a zone the device left while it loaded leaves the answer for the zone it is in', async t => {
  const savedZone = process.env.TZ;
  process.env.TZ = 'America/New_York';
  t.after(() => {
    answerSetDays = NO_SET_DAYS;
    if (savedZone === undefined) delete process.env.TZ;
    else process.env.TZ = savedZone;
  });
  const chicago: { reply?: (response: Response) => void } = {};
  answerSetDays = url => (url.searchParams.get('tz') === 'America/Chicago'
    ? new Promise<Response>(resolve => { chicago.reply = resolve; })
    : Response.json({ days: {}, timeZone: url.searchParams.get('tz') }));
  const today = await mountToday(t, {});
  await today.until(() => today.plan().streak !== null, 'New York\'s set days are in');

  // The zone becomes Chicago and the connection returns before Today renders again; the zone is New York again before
  // Chicago's answer comes back.
  process.env.TZ = 'America/Chicago';
  browser.dispatchEvent(new Event('online'));
  process.env.TZ = 'America/New_York';
  assert.ok(chicago.reply, 'the connection\'s return asked for Chicago\'s days');
  await today.tap(() => chicago.reply?.(Response.json({ days: {}, timeZone: 'America/Chicago' })));
  assert.equal(today.plan().streak, 0, 'New York\'s answer still counts');
});
