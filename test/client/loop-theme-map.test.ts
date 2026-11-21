import assert from 'node:assert/strict';
import test from 'node:test';
import { IDBKeyRange, indexedDB } from 'fake-indexeddb';
import { THEMES, type ThemesResponse } from '../../server/src/shared/item-themes.ts';
import { memorized, sentenceItem, vocabItem } from '../support/loop-fixtures.ts';

Object.assign(globalThis, { indexedDB, IDBKeyRange });

const {
  applyThemeRows, createThemeSync, idbThemeStore, loadCachedThemes, refreshThemes, sortingPercent, sortingProgress, THEME_IDLE_POLL_MS,
  THEME_POLL_MS,
} = await import('../../services/learningLoop/themeMap.ts');
const { planLoop } = await import('../../services/learningLoop/planner.ts');
type ThemeStore = import('../../services/learningLoop/themeMap.ts').ThemeStore;
type ThemeState = import('../../services/learningLoop/themeMap.ts').ThemeState;
const { META_STORE } = await import('../../services/idb.ts');

/** A store in memory that counts its writes. */
function memoryStore(initial: Record<string, unknown> = {}) {
  const values = new Map(Object.entries(initial));
  const store: ThemeStore & { writes: number } = {
    writes: 0,
    read: async userId => values.get(userId),
    write: async (userId, value) => { store.writes++; values.set(userId, structuredClone(value)); },
  };
  return { store, values };
}

const response = (rows: ThemesResponse['rows'], latestSeq: number, extra: Partial<ThemesResponse> = {}): ThemesResponse => ({
  taxonomyVersion: 1, rows, latestSeq, pending: 0, status: 'idle', ...extra,
});

/** A server answering each `after` from a list of responses, and noting what it was asked. */
function server(answers: Record<number, ThemesResponse | Error>) {
  const asked: number[] = [];
  return {
    asked,
    fetch: async (after: number) => {
      asked.push(after);
      const answer = answers[after];
      if (!answer) throw new Error(`unexpected after=${after}`);
      if (answer instanceof Error) throw answer;
      return answer;
    },
  };
}

const state = (latestSeq: number, entries: [string, string][], taxonomyVersion = 1): ThemeState =>
  ({ taxonomyVersion, latestSeq, themes: new Map(entries) });

test('rows apply in order: a theme id sets the item\'s theme, null takes it away', () => {
  const themes = new Map([['a', 'cooking'], ['b', 'eating-out']]);
  const next = applyThemeRows(themes, [['a', 'chores'], ['c', 'cooking'], ['b', null], ['c', 'eating-out'], ['zz', null]]);
  assert.deepEqual([...next], [['a', 'chores'], ['c', 'eating-out']]);
  assert.deepEqual([...themes], [['a', 'cooking'], ['b', 'eating-out']], 'the map given is left as it was');
});

test('the kept map is read back when well formed, and as none when damaged or unreadable', async () => {
  const { store } = memoryStore({
    good: { taxonomyVersion: 1, latestSeq: 7, map: { a: 'cooking', b: 'a-theme-this-build-doesnt-know' } },
    badSeq: { taxonomyVersion: 1, latestSeq: -1, map: {} },
    badTheme: { taxonomyVersion: 1, latestSeq: 1, map: { a: 3 } },
    badMap: { taxonomyVersion: 1, latestSeq: 1, map: [] },
  });
  assert.deepEqual(await loadCachedThemes('good', store), state(7, [['a', 'cooking'], ['b', 'a-theme-this-build-doesnt-know']]));
  for (const user of ['badSeq', 'badTheme', 'badMap', 'nobody']) assert.equal(await loadCachedThemes(user, store), null, user);
  const broken: ThemeStore = { read: async () => { throw new Error('no IndexedDB'); }, write: async () => {} };
  assert.equal(await loadCachedThemes('good', broken), null);
});

test('a refresh asks for the rows after the kept sequence and keeps the result only when it changed', async () => {
  const { store, values } = memoryStore();
  const first = server({ 0: response([['a', 'cooking'], ['b', 'chores']], 2, { pending: 40, status: 'running' }) });
  const fresh = await refreshThemes('u', null, first.fetch, store);
  assert.deepEqual(first.asked, [0], 'no map yet: every row');
  assert.deepEqual(fresh.state, state(2, [['a', 'cooking'], ['b', 'chores']]));
  assert.deepEqual(fresh.sorting, { pending: 40, status: 'running' });
  assert.deepEqual(values.get('u'), { taxonomyVersion: 1, latestSeq: 2, map: { a: 'cooking', b: 'chores' } });

  const next = server({ 2: response([['b', null], ['c', 'cooking']], 4, { lastError: 'quota' }) });
  const updated = await refreshThemes('u', fresh.state, next.fetch, store);
  assert.deepEqual(next.asked, [2]);
  assert.deepEqual(updated.state, state(4, [['a', 'cooking'], ['c', 'cooking']]));
  assert.deepEqual(updated.sorting, { pending: 0, status: 'idle', lastError: 'quota' });
  assert.equal(store.writes, 2);

  const quiet = server({ 4: response([], 4, { pending: 3 }) });
  const unchanged = await refreshThemes('u', updated.state, quiet.fetch, store);
  assert.equal(unchanged.state, updated.state, 'the same state, so a plan built on it stays');
  assert.equal(unchanged.sorting.pending, 3);
  assert.equal(store.writes, 2, 'nothing new to keep');
});

test('a new taxonomy or a sequence that went back fetches every row again and replaces the map', async () => {
  const kept = state(9, [['old', 'retired-theme'], ['a', 'cooking']]);
  const retaxed = server({ 9: response([], 9, { taxonomyVersion: 2 }), 0: response([['a', 'eating-out']], 3, { taxonomyVersion: 2 }) });
  const result = await refreshThemes('u', kept, retaxed.fetch, memoryStore().store);
  assert.deepEqual(retaxed.asked, [9, 0]);
  assert.deepEqual(result.state, state(3, [['a', 'eating-out']], 2));

  const restored = server({ 9: response([], 5), 0: response([['a', 'cooking']], 5) });
  const after = await refreshThemes('u', kept, restored.fetch, memoryStore().store);
  assert.deepEqual(restored.asked, [9, 0], 'a server restored from a backup');
  assert.deepEqual(after.state, state(5, [['a', 'cooking']]));
});

test('a refresh whose keeping fails still returns the map, and one whose request fails rejects', async () => {
  const failing: ThemeStore = { read: async () => undefined, write: async () => { throw new Error('quota'); } };
  const result = await refreshThemes('u', null, server({ 0: response([['a', 'cooking']], 1) }).fetch, failing);
  assert.deepEqual(result.state, state(1, [['a', 'cooking']]));
  await assert.rejects(refreshThemes('u', null, server({ 0: new Error('offline') }).fetch, failing), /offline/);
});

test('sorting progress is the share of sentences sorted among those sorted or pending', () => {
  assert.equal(sortingPercent(2, 6), 25);
  assert.equal(sortingPercent(0, 10), 0);
  assert.equal(sortingPercent(1, 0), 100);
  assert.equal(sortingPercent(0, 0), 100);
});

test('sorting progress counts Today\'s sentences in a known theme, never the rows a kept map holds for words', () => {
  const [first, second] = THEMES.map(theme => theme.id);
  const words = Array.from({ length: 60 }, (_, i) => vocabItem(`w${i}`, `word${i}`));
  const items = [
    sentenceItem('sorted-1', 'One.'), sentenceItem('sorted-2', 'Two.', { srs: memorized(Date.UTC(2026, 10, 17)) }),
    sentenceItem('waiting', 'Not sorted yet.'), sentenceItem('retired', 'In a theme this build doesn\'t know.'),
    sentenceItem('untranslated', 'No translation, which Today doesn\'t need.', { translation: null }),
    sentenceItem('archived', 'Archived.', { isArchived: true }),
    ...words,
  ];
  // The map an older build kept: the words its sweep sorted beside the sentences sorted so far.
  const themeOf = new Map<string, string>([
    ['sorted-1', first], ['sorted-2', second], ['retired', 'a-retired-theme'], ['untranslated', first], ['archived', second],
    ...words.map(word => [word.data.id, first] as [string, string]),
  ]);
  const plan = planLoop({ items, themeOf, now: Date.UTC(2026, 10, 18), recentStarts: {}, pin: null });
  // Three sentences sorted, a memorized one among them, and two waiting; the map's size would say 97%.
  assert.equal(sortingProgress(plan, { pending: 2 }), 60);
  assert.equal(sortingProgress(plan, { pending: 6 }), 33);
  assert.equal(sortingProgress(plan, { pending: 0 }), null, 'nothing left to sort');
  assert.equal(sortingProgress(plan, null), null, 'no refresh yet');
});

/** Timers run by hand. */
function manualTimers() {
  const timers = new Map<number, { run: () => void; ms: number }>();
  let next = 0;
  return {
    timers,
    setTimer: (run: () => void, ms: number) => { timers.set(++next, { run, ms }); return next; },
    clearTimer: (timer: unknown) => { timers.delete(timer as number); },
    fire() {
      const entries = [...timers];
      timers.clear();
      for (const [, timer] of entries) timer.run();
    },
  };
}

const settle = () => new Promise(resolve => setTimeout(resolve, 0));

test('the sync reports the kept map, refreshes, and polls every minute while items are pending, then every five minutes', async () => {
  const { store } = memoryStore({ u: { taxonomyVersion: 1, latestSeq: 1, map: { a: 'cooking' } } });
  const remote = server({
    1: response([['b', 'chores']], 2, { pending: 5, status: 'running' }),
    2: response([['c', 'chores']], 3, { pending: 0 }),
  });
  const timers = manualTimers();
  const updates: [number | null, number | null][] = [];
  const sync = createThemeSync({
    userId: 'u', fetchThemes: remote.fetch, store, ...timers,
    onUpdate: (current, sorting) => updates.push([current?.themes.size ?? null, sorting?.pending ?? null]),
  });
  sync.start();
  await settle();
  assert.deepEqual(updates, [[1, null], [2, 5]]);
  assert.deepEqual([...timers.timers.values()].map(timer => timer.ms), [THEME_POLL_MS]);
  timers.fire();
  await settle();
  assert.deepEqual(remote.asked, [1, 2]);
  assert.deepEqual(updates.at(-1), [3, 0]);
  assert.equal(THEME_IDLE_POLL_MS, 5 * 60_000);
  assert.deepEqual([...timers.timers.values()].map(timer => timer.ms), [THEME_IDLE_POLL_MS], 'nothing pending: the idle poll');
  sync.stop();
});

test('the idle poll brings a sentence sorted since, reports an unchanged map as the same state, and stops with the sync', async () => {
  const { store } = memoryStore({ u: { taxonomyVersion: 1, latestSeq: 3, map: { a: 'cooking' } } });
  const answers: Record<number, ThemesResponse> = { 3: response([], 3) };
  const remote = server(answers);
  const timers = manualTimers();
  const updates: (ThemeState | null)[] = [];
  const sync = createThemeSync({ userId: 'u', fetchThemes: remote.fetch, store, ...timers, onUpdate: current => updates.push(current) });
  sync.start();
  await settle();
  const quiet = updates.at(-1);
  assert.equal(quiet, updates.at(-2), 'the kept map, unchanged by the refresh');
  assert.deepEqual([...timers.timers.values()].map(timer => timer.ms), [THEME_IDLE_POLL_MS]);

  // A sentence saved since, here or on another device, is sorted on the server.
  answers[3] = response([['b', 'chores']], 4);
  answers[4] = response([], 4);
  timers.fire();
  await settle();
  const sorted = updates.at(-1);
  assert.equal(sorted?.themes.get('b'), 'chores');
  assert.deepEqual([...timers.timers.values()].map(timer => timer.ms), [THEME_IDLE_POLL_MS]);

  // Nothing new: the same state object, so Today doesn't take its plan again.
  timers.fire();
  await settle();
  assert.equal(updates.at(-1), sorted);
  assert.deepEqual(remote.asked, [3, 3, 4]);

  // Sentences waiting again (a burst of saves): back to polling every minute; stopping clears the poll.
  answers[4] = response([], 4, { pending: 6, status: 'running' });
  timers.fire();
  await settle();
  assert.deepEqual([...timers.timers.values()].map(timer => timer.ms), [THEME_POLL_MS]);
  sync.stop();
  assert.equal(timers.timers.size, 0);
});

test('a failed refresh is heard and tried again in a minute; once stopped nothing more is heard, and a new start reports the map held', async () => {
  const { store } = memoryStore();
  let offline = true;
  const asked: number[] = [];
  const fetchThemes = async (after: number) => {
    asked.push(after);
    if (offline) throw new Error('offline');
    return response([['a', 'cooking']], 1, { pending: 2 });
  };
  const timers = manualTimers();
  const errors: unknown[] = [];
  const updates: (ThemeState | null)[] = [];
  const sync = createThemeSync({ userId: 'u', fetchThemes, store, ...timers, onUpdate: current => updates.push(current), onError: error => errors.push(error) });
  sync.start();
  await settle();
  assert.equal(errors.length, 1);
  assert.deepEqual([...updates], [null], 'only the (missing) kept map');
  assert.equal(timers.timers.size, 1);
  offline = false;
  timers.fire();
  await settle();
  assert.equal(updates.at(-1)?.themes.get('a'), 'cooking');

  sync.stop();
  assert.equal(timers.timers.size, 0, 'stopping clears the poll');
  const heard = updates.length;
  sync.start();
  sync.stop(); // hidden again before the refresh came back
  await settle();
  assert.equal(updates.length, heard + 1, 'the start reported the map it holds, and the refresh after the stop wasn\'t heard');
  assert.equal(timers.timers.size, 0);
  assert.deepEqual(asked, [0, 0, 1]);
});

test('the map is kept in the library database\'s META store, per user', async () => {
  const userId = 'theme-user';
  await idbThemeStore.write(userId, { taxonomyVersion: 1, latestSeq: 4, map: { a: 'cooking' } });
  assert.deepEqual(await loadCachedThemes(userId, idbThemeStore), state(4, [['a', 'cooking']]));
  assert.equal(await loadCachedThemes('another-user', idbThemeStore), null);
  // Under its own key beside the library's cursor.
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open('PopDictDB');
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  const keys = await new Promise<IDBValidKey[]>((resolve, reject) => {
    const request = db.transaction(META_STORE, 'readonly').objectStore(META_STORE).getAllKeys();
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  db.close();
  assert.deepEqual(keys, ['themes_v1_theme-user']);
  const refreshed = await refreshThemes(userId, await loadCachedThemes(userId), server({ 4: response([['b', 'chores']], 5) }).fetch);
  assert.deepEqual(await loadCachedThemes(userId), refreshed.state);
});
