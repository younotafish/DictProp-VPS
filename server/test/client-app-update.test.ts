import assert from 'node:assert/strict';
import test from 'node:test';
import { announceUpdate, dismissUpdate, hasUnsentChanges, isChunkLoadError, pendingUpdate, reloadApp, setReloadGuard } from '../../services/appUpdate.ts';

let reloads = 0;
(globalThis as { window?: unknown }).window = { location: { reload: () => { reloads++; } } };

test('a failed chunk outranks a plain update, and dismissing clears either', () => {
  assert.equal(pendingUpdate(), null);
  announceUpdate('service-worker');
  assert.equal(pendingUpdate(), 'service-worker');
  announceUpdate('chunk-load');
  assert.equal(pendingUpdate(), 'chunk-load');
  announceUpdate('service-worker');
  assert.equal(pendingUpdate(), 'chunk-load', 'a later update notice does not hide the failed chunk');
  dismissUpdate();
  assert.equal(pendingUpdate(), null);
});

test('only a module that could not be fetched counts as a chunk failure', () => {
  assert.equal(isChunkLoadError(new TypeError('Failed to fetch dynamically imported module: https://dictprop.online/assets/Notebook-abc.js')), true);
  assert.equal(isChunkLoadError(new TypeError('error loading dynamically imported module: /assets/x.js')), true);
  assert.equal(isChunkLoadError(new TypeError('Importing a module script failed.')), true);
  assert.equal(isChunkLoadError(new Error('Unable to preload CSS for /assets/index.css')), true);
  assert.equal(isChunkLoadError(new TypeError('Cannot read properties of undefined')), false);
  assert.equal(isChunkLoadError('Failed to fetch dynamically imported module'), false);
});

test('unsent changes hold back an automatic reload, and a broken probe errs on the side of waiting', () => {
  assert.equal(hasUnsentChanges(), false, 'nothing to protect before the app installs its guard');
  let unsent = true;
  const remove = setReloadGuard({ hasUnsentChanges: () => unsent, beforeReload: async () => {} });
  assert.equal(hasUnsentChanges(), true);
  unsent = false;
  assert.equal(hasUnsentChanges(), false);
  remove();

  const removeBroken = setReloadGuard({ hasUnsentChanges: () => { throw new Error('boom'); }, beforeReload: async () => {} });
  assert.equal(hasUnsentChanges(), true);
  removeBroken();
  assert.equal(hasUnsentChanges(), false);
});

test('reloading sends first, reloads even when sending fails, and reloads once however often it is pressed', async () => {
  const steps: string[] = [];
  setReloadGuard({
    hasUnsentChanges: () => true,
    beforeReload: async () => { steps.push('send'); throw new Error('offline'); },
  });
  const first = reloadApp();
  const second = reloadApp();
  assert.equal(first, second);
  await first;
  assert.deepEqual(steps, ['send']);
  assert.equal(reloads, 1);
});
