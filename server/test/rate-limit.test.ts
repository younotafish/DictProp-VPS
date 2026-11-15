import assert from 'node:assert/strict';
import test from 'node:test';
import { Hono } from 'hono';
import type { AppEnv } from '../src/middleware/auth.js';
import { createConcurrencyLimit, createRateLimit } from '../src/middleware/rate-limit.js';

/** An app whose requests are signed in as the user their x-user header names. */
function appWith(register: (app: Hono<AppEnv>) => void) {
  const app = new Hono<AppEnv>();
  app.onError((_error, c) => c.text('failed', 500));
  app.use('*', async (c, next) => {
    c.set('user', { id: c.req.header('x-user') ?? 'owner', email: '', displayName: null, photoUrl: null, isAdmin: true });
    await next();
  });
  register(app);
  return app;
}

test('a rate limit counts each user and path on its own, answers 429 with Retry-After, and resets after its window', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: 1_000_000 });
  const app = appWith(app => {
    app.use('/limited/*', createRateLimit(2, 10_000));
    app.get('/limited/:name', c => c.text('ok'));
  });
  const get = (path: string, user = 'owner') => app.request(path, { headers: { 'x-user': user } });

  assert.equal((await get('/limited/a')).headers.get('X-RateLimit-Remaining'), '1');
  assert.equal((await get('/limited/a')).status, 200);
  const limited = await get('/limited/a');
  assert.equal(limited.status, 429);
  assert.equal(limited.headers.get('Retry-After'), '10');
  assert.deepEqual(await limited.json(), { error: 'Too many requests. Try again shortly.' });

  assert.equal((await get('/limited/b')).status, 200);
  assert.equal((await get('/limited/a', 'someone-else')).status, 200);

  t.mock.timers.tick(4_000);
  assert.equal((await get('/limited/a')).headers.get('Retry-After'), '6');
  t.mock.timers.tick(6_000);
  assert.equal((await get('/limited/a')).status, 200);
});

test('a concurrency limit answers 503 while its slots are held, and frees a slot when a request throws', async () => {
  let release: () => void = () => {};
  const app = appWith(app => {
    app.use('/busy', createConcurrencyLimit(1, 'Busy right now.'));
    app.get('/busy', async c => {
      if (c.req.query('fail')) throw new Error('handler failed');
      await new Promise<void>(resolve => { release = resolve; });
      return c.text('done');
    });
  });

  const held = app.request('/busy');
  await new Promise(resolve => setImmediate(resolve));
  const busy = await app.request('/busy');
  assert.equal(busy.status, 503);
  assert.equal(busy.headers.get('Retry-After'), '5');
  assert.deepEqual(await busy.json(), { error: 'Busy right now.' });
  release();
  assert.equal(await (await held).text(), 'done');

  assert.equal((await app.request('/busy?fail=1')).status, 500);
  const next = app.request('/busy');
  await new Promise(resolve => setImmediate(resolve));
  release();
  assert.equal((await next).status, 200);
});
