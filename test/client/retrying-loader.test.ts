import assert from 'node:assert/strict';
import test from 'node:test';
import { retryingLoader } from '../../services/audio/retryingLoader.ts';

test('callers share one load, and a successful load is kept', async () => {
  let imports = 0;
  const loaded: string[] = [];
  const loader = retryingLoader(async () => { imports++; return 'engine'; }, value => loaded.push(value));
  assert.equal(loader.current, null);
  const [first, second] = await Promise.all([loader.load(), loader.load()]);
  assert.equal(first, 'engine');
  assert.equal(second, 'engine');
  assert.equal(await loader.load(), 'engine');
  assert.equal(imports, 1);
  assert.deepEqual(loaded, ['engine'], 'onLoaded runs once');
  assert.equal(loader.current, 'engine');
});

test('a failed load is forgotten, so the next call tries again', async () => {
  let attempts = 0;
  const loader = retryingLoader(async () => {
    attempts++;
    if (attempts === 1) throw new TypeError('Failed to fetch dynamically imported module');
    return 'engine';
  });
  await assert.rejects(loader.load(), TypeError);
  assert.equal(loader.current, null);
  assert.equal(await loader.load(), 'engine');
  assert.equal(attempts, 2);
});

test('onLoaded runs before the callers waiting on the load continue', async () => {
  const order: string[] = [];
  const loader = retryingLoader(async () => 'engine', () => order.push('loaded'));
  await loader.load().then(() => order.push('caller'));
  assert.deepEqual(order, ['loaded', 'caller']);
});
