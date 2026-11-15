import assert from 'node:assert/strict';
import test from 'node:test';
import { FakeAudioContext, FakeAudioElement, installFakeMedia } from '../support/audio/fakeMedia.ts';

installFakeMedia();
type KeepAlive = typeof import('../../services/audio/keepAlive.ts');

// The keep-alive's element, context and hold count live in module state, so each case loads its own instance.
let instance = 0;
const freshKeepAlive = async () => {
  const elements = FakeAudioElement.created.length;
  const contexts = FakeAudioContext.created.length;
  const module = await import(`../../services/audio/keepAlive.ts?instance=${++instance}`) as KeepAlive;
  return {
    module,
    element: () => FakeAudioElement.created[elements],
    context: () => FakeAudioContext.created[contexts],
  };
};

test('the keep-alive runs while anyone holds it and stops with the last release', async () => {
  const { module, element, context } = await freshKeepAlive();
  module.acquireKeepAlive();
  module.acquireKeepAlive();
  assert.equal(element().paused, false, 'the silent loop plays');
  assert.equal(element().loop, true);
  assert.equal(element().volume, 0);
  assert.equal(context().state, 'running');
  assert.equal(context().oscillatorsStarted, 1);
  module.releaseKeepAlive();
  assert.equal(element().paused, false, 'one holder is left');
  module.releaseKeepAlive();
  assert.equal(element().paused, true);
  assert.equal(context().state, 'suspended');
  module.releaseKeepAlive();
  module.acquireKeepAlive();
  assert.equal(element().paused, false, 'an extra release did not leave the count below zero');
  assert.equal(context().oscillatorsStarted, 1, 'the oscillator starts once and is resumed with the context');
});

test('priming starts the keep-alive without a hold, so a release with no hold stops it', async () => {
  const { module, element, context } = await freshKeepAlive();
  module.primeKeepAlive();
  assert.equal(element().paused, false);
  assert.equal(context().state, 'running');
  module.releaseKeepAlive();
  assert.equal(element().paused, true);
  assert.equal(context().state, 'suspended');
});

test('without a running audio clock the gap is timed by a timer, which the canceller stops', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { module } = await freshKeepAlive();
  const fired: string[] = [];
  module.afterGap(2000, () => fired.push('gap'));
  const cancel = module.afterGap(2000, () => fired.push('cancelled'));
  cancel();
  t.mock.timers.tick(1999);
  assert.deepEqual(fired, []);
  t.mock.timers.tick(1);
  assert.deepEqual(fired, ['gap']);
});

test('with a running audio clock the gap also ends on a silent source scheduled to stop, whichever comes first', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { module, context } = await freshKeepAlive();
  module.acquireKeepAlive();
  const ctx = context();
  ctx.currentTime = 12;
  const fired: string[] = [];
  module.afterGap(10_000, () => fired.push('gap'));
  const source = ctx.sources.at(-1);
  assert.ok(source);
  assert.equal(source.buffer?.length, 1, 'one frame, not ten seconds of silence');
  assert.equal(source.loop, true);
  assert.equal(source.startedAt, 0);
  assert.equal(source.stoppedAt, 22, 'scheduled to stop when the gap ends');
  source.onended?.();
  assert.deepEqual(fired, ['gap']);
  t.mock.timers.tick(10_000);
  assert.deepEqual(fired, ['gap'], 'the timer was cancelled');

  module.afterGap(3000, () => fired.push('timer first'));
  const second = ctx.sources.at(-1);
  t.mock.timers.tick(3000);
  assert.deepEqual(fired, ['gap', 'timer first']);
  assert.equal(second?.onended, null, 'the audio source was stopped and unhooked');
  assert.equal(second?.stoppedAt, 0);

  const cancel = module.afterGap(2000, () => fired.push('cancelled'));
  const third = ctx.sources.at(-1);
  cancel();
  assert.equal(third?.onended, null);
  t.mock.timers.tick(2000);
  assert.deepEqual(fired, ['gap', 'timer first']);
  module.releaseKeepAlive();
});
