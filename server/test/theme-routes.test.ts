import assert from 'node:assert/strict';
import test from 'node:test';
import { THEME_TAXONOMY_VERSION, THEMES, type ThemesResponse } from '../src/shared/item-themes.js';
import type { ThemeSweep, ThemeSweepReport } from '../src/themes/sweep.js';
import { srs } from './support/fixtures.js';

process.env.DEV_AUTH_BYPASS = '1';

const { createApp } = await import('../src/app.js');
const { recordThemeResults } = await import('../src/db.js');
const { DEV_AUTH_USER } = await import('../src/middleware/auth.js');
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

test('a save or an import that succeeds tells the sweep; a refused one, a read or a review does not', async () => {
  const fake = fakeSweep();
  const app = createApp({ logging: false, serveStaticFiles: false, themeSweep: fake.sweep });
  const item = { type: 'vocab', data: { id: 'route-write', word: 'write' }, srs: srs('route-write', 'vocab'), savedAt: 1 };
  const send = (method: string, path: string, body: unknown) => app.request(path, {
    method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });

  assert.equal((await send('PUT', '/api/items', [item])).status, 200);
  assert.deepEqual(fake.writes, [USER]);
  assert.equal((await send('PUT', '/api/items', [{ ...item, type: 'card' }])).status, 400);
  assert.equal((await app.request('/api/items')).status, 200);
  assert.equal((await send('POST', '/api/reviews/apply', {
    event: { id: 'route-write-review', itemId: 'route-write', itemType: 'vocab', reviewedAt: 1, previousStep: 0, nextStep: 1 },
    itemIds: ['route-write'],
  })).status, 201);
  assert.deepEqual(fake.writes, [USER]);
  assert.equal((await send('POST', '/api/import', [{ ...item, data: { id: 'route-import', word: 'import' }, srs: srs('route-import', 'vocab') }])).status, 200);
  assert.deepEqual(fake.writes, [USER, USER]);
});
