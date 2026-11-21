import assert from 'node:assert/strict';
import test from 'node:test';
import { THEME_TAXONOMY_VERSION, THEMES, type ThemesResponse } from '../src/shared/item-themes.js';
import type { ThemeSweep, ThemeSweepReport } from '../src/themes/sweep.js';
import { srs } from './support/fixtures.js';

process.env.DEV_AUTH_BYPASS = '1';

const { createApp } = await import('../src/app.js');
const { recordThemeResults } = await import('../src/db.js');
const { DEV_AUTH_USER } = await import('../src/middleware/auth.js');
const { createThemeSweep } = await import('../src/themes/sweep.js');
const { answering, manualClock, provider } = await import('./support/theme-sweep.js');
const USER = DEV_AUTH_USER.id;
const [A, B] = THEMES.map(theme => theme.id);

/** A sweep that reports what it is told and records the writes it hears of. */
function fakeSweep(report: ThemeSweepReport = { pending: 0, status: 'idle' }) {
  const writes: string[] = [];
  const reported: string[] = [];
  const sweep: ThemeSweep = {
    report: async (userId) => {
      reported.push(userId);
      return report;
    },
    trigger: () => {},
    noteItemWrite: (userId) => { writes.push(userId); },
    startAfterDelay: () => {},
    stop: () => {},
    idle: async () => {},
  };
  return { sweep, writes, reported };
}

const record = (itemId: string, themeId: string | null) =>
  recordThemeResults(USER, [{ itemId, inputHash: itemId.padEnd(64, '0'), themeId }], { model: 'test-model', taxonomyVersion: 1, now: 1 });

test('GET /api/themes sends the rows changed after the asked seq and how the sorting stands, never cached', async () => {
  const fake = fakeSweep({ pending: 34, status: 'paused', lastError: 'The AI provider\'s balance is used up.' });
  const app = createApp({ logging: false, serveStaticFiles: false, themeSweep: fake.sweep });
  record('route-a', A);
  record('route-b', B);
  record('route-c', null);

  const get = async (query: string) => {
    const response = await app.request(`/api/themes${query}`);
    assert.equal(response.status, 200, query);
    assert.equal(response.headers.get('cache-control'), 'private, no-store');
    return await response.json() as ThemesResponse;
  };
  const all = await get('');
  assert.deepEqual(all, {
    taxonomyVersion: THEME_TAXONOMY_VERSION, rows: [['route-a', A], ['route-b', B]], latestSeq: all.latestSeq,
    pending: 34, status: 'paused', lastError: 'The AI provider\'s balance is used up.',
  });
  assert.deepEqual(await get('?after=0'), all);
  assert.deepEqual(await get('?after='), all);

  record('route-a', B);
  record('route-b', null);
  const changed = await get(`?after=${all.latestSeq}`);
  assert.deepEqual(changed.rows, [['route-a', B], ['route-b', null]]);
  assert.equal(changed.latestSeq, all.latestSeq + 2);
  assert.deepEqual((await get(`?after=${changed.latestSeq}`)).rows, []);
  assert.deepEqual(fake.reported, Array(5).fill(USER));
});

test('an after that is no seq is refused', async () => {
  const app = createApp({ logging: false, serveStaticFiles: false, themeSweep: fakeSweep().sweep });
  for (const after of ['-1', '1.5', 'abc', '1e400']) {
    const response = await app.request(`/api/themes?after=${after}`);
    assert.equal(response.status, 400, after);
    assert.deepEqual(await response.json(), { error: 'Invalid after parameter' });
  }
});

/** An item's first review, with the device's copy of the item as its seed when one is given. */
const reviewBody = (itemId: string, seedItem?: unknown, itemType = 'sentence') => ({
  event: { id: `${itemId}-review`, itemId, itemType, reviewedAt: 1, previousStep: 0, nextStep: 1 },
  itemIds: [itemId],
  ...(seedItem ? { seedItem } : {}),
});

test("a save, an import or a review that brings its sentence tells the sweep when it succeeds; a refused one, a read, a seedless or retried review, or a word's, does not", async () => {
  const fake = fakeSweep();
  const app = createApp({ logging: false, serveStaticFiles: false, themeSweep: fake.sweep });
  const item = {
    type: 'sentence',
    data: { id: 'route-write', text: 'Write it down.', sourceWord: 'write' },
    srs: srs('route-write', 'sentence'),
    savedAt: 1,
  };
  const send = (method: string, path: string, body: unknown) => app.request(path, {
    method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });

  assert.equal((await send('PUT', '/api/items', [item])).status, 200);
  assert.deepEqual(fake.writes, [USER]);
  assert.equal((await send('PUT', '/api/items', [{ ...item, type: 'card' }])).status, 400);
  assert.equal((await app.request('/api/items')).status, 200);
  assert.equal((await send('POST', '/api/reviews/apply', reviewBody('route-write'))).status, 201);
  assert.deepEqual(fake.writes, [USER]);

  // A sentence saved and reviewed before its first push reaches the server as its review's seed, and no push follows.
  const seeded = { ...item, data: { id: 'route-seeded', text: 'Bring it along.', sourceWord: 'bring' }, srs: srs('route-seeded', 'sentence') };
  assert.equal((await send('POST', '/api/reviews/apply', reviewBody('route-seeded', seeded))).status, 201);
  assert.deepEqual(fake.writes, [USER, USER]);
  // Its retry is answered from the stored review, and a seed that isn't the reviewed item's is refused.
  assert.equal((await send('POST', '/api/reviews/apply', reviewBody('route-seeded', seeded))).status, 200);
  assert.equal((await send('POST', '/api/reviews/apply', reviewBody('route-other', seeded))).status, 400);
  // A word's seed brings nothing the sweep sorts.
  const word = { type: 'vocab', data: { id: 'route-seeded-word', word: 'along' }, srs: srs('route-seeded-word', 'vocab'), savedAt: 1 };
  assert.equal((await send('POST', '/api/reviews/apply', reviewBody('route-seeded-word', word, 'vocab'))).status, 201);
  assert.deepEqual(fake.writes, [USER, USER]);

  const imported = { ...item, data: { id: 'route-import', text: 'Import it all.', sourceWord: 'import' }, srs: srs('route-import', 'sentence') };
  assert.equal((await send('POST', '/api/import', [imported])).status, 200);
  assert.deepEqual(fake.writes, [USER, USER, USER]);
});

test('a review that brings a new sentence gets it sorted half a minute later, after a sweep that had finished, with no save', async () => {
  const clock = manualClock();
  const fake = provider(answering());
  const sweep = createThemeSweep({ chat: fake.chat, model: 'test-model', now: clock.now, setTimer: clock.setTimer });
  const app = createApp({ logging: false, serveStaticFiles: false, themeSweep: sweep });
  const themes = async () => {
    const response = await app.request('/api/themes');
    assert.equal(response.status, 200);
    return await response.json() as ThemesResponse;
  };

  // The sweep sorts what the library holds and finishes, so nothing waits and no later report starts it again.
  await themes();
  await sweep.idle(USER);
  const { pending, status } = await themes();
  assert.deepEqual({ pending, status }, { pending: 0, status: 'idle' });
  const asked = fake.asked.length;

  const id = 'route-sweep-seeded';
  const seed = { type: 'sentence', data: { id, text: 'Sort this one out.', sourceWord: 'sort' }, srs: srs(id, 'sentence'), savedAt: 1 };
  const response = await app.request('/api/reviews/apply', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(reviewBody(id, seed)),
  });
  assert.equal(response.status, 201);
  clock.advance(30_000 - 1);
  await sweep.idle(USER);
  assert.equal(fake.asked.length, asked, 'the sweep waits half a minute after the write');
  clock.advance(1);
  await sweep.idle(USER);
  assert.deepEqual(fake.asked.slice(asked), [['Sort this one out.']]);
  assert.deepEqual((await themes()).rows.filter(([itemId]) => itemId === id), [[id, A]]);
  sweep.stop();
});
