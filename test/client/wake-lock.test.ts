import assert from 'node:assert/strict';
import test from 'node:test';
import { PAUSED_WAKE_HOLD_MS, createWakeLockKeeper } from '../../views/detail/useWakeLock.ts';

// views/detail/useWakeLock.ts createWakeLockKeeper: the screen wake lock behind auto-play, over a fake navigator.wakeLock
// and a fake page.

class FakeSentinel {
  released = false;
  release() { this.released = true; return Promise.resolve(); }
}

/** navigator.wakeLock, answering each request when the test says. */
class FakeWakeLock {
  readonly requests: Array<(sentinel: FakeSentinel) => void> = [];
  readonly sentinels: FakeSentinel[] = [];
  request() {
    return new Promise<FakeSentinel>(resolve => this.requests.push(sentinel => { this.sentinels.push(sentinel); resolve(sentinel); }));
  }
  /** Grant the request waiting longest. */
  grant() {
    const answer = this.requests.shift();
    assert.ok(answer, 'a request is waiting');
    answer(new FakeSentinel());
    return flush();
  }
  held() { return this.sentinels.filter(sentinel => !sentinel.released).length; }
}

const flush = async () => { for (let round = 0; round < 5; round++) await Promise.resolve(); };

function fakePage() {
  const listeners = new Set<() => void>();
  return {
    visibilityState: 'visible' as DocumentVisibilityState,
    addEventListener: (_type: 'visibilitychange', listener: () => void) => { listeners.add(listener); },
    removeEventListener: (_type: 'visibilitychange', listener: () => void) => { listeners.delete(listener); },
    /** The page goes out of view (the browser lets every screen lock go) or comes back. */
    show(visible: boolean, wakeLock?: FakeWakeLock) {
      this.visibilityState = visible ? 'visible' : 'hidden';
      if (!visible) for (const sentinel of wakeLock?.sentinels ?? []) sentinel.released = true;
      for (const listener of listeners) listener();
    },
  };
}

test('auto-play keeps the screen awake, and takes the lock again when the page comes back', async () => {
  const wakeLock = new FakeWakeLock();
  const page = fakePage();
  const keeper = createWakeLockKeeper(wakeLock, page);
  keeper.setActive(true);
  await wakeLock.grant();
  assert.equal(keeper.isHeld(), true);

  page.show(false, wakeLock);
  assert.equal(keeper.isHeld(), false, 'the browser let it go');
  assert.equal(wakeLock.requests.length, 0, 'not asked again while hidden');
  page.show(true);
  await wakeLock.grant();
  assert.equal(keeper.isHeld(), true, 'taken again on the way back');

  keeper.setActive(false);
  assert.equal(wakeLock.held(), 0);
  page.show(false, wakeLock);
  page.show(true);
  assert.equal(wakeLock.requests.length, 0, 'off, nothing more is asked');
});

test('it never holds two locks, and lets go of one that arrives after auto-play stopped', async () => {
  const wakeLock = new FakeWakeLock();
  const page = fakePage();
  const keeper = createWakeLockKeeper(wakeLock, page);
  keeper.setActive(true);
  keeper.rearm();
  page.show(true);
  assert.equal(wakeLock.requests.length, 1, 'one request at a time');
  keeper.setActive(false);
  await wakeLock.grant();
  assert.equal(wakeLock.held(), 0, 'the late lock is let go');
  assert.equal(keeper.isHeld(), false);
});

test('paused auto-play holds the lock for two minutes, then lets the screen sleep; a resume takes it again', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const wakeLock = new FakeWakeLock();
  const page = fakePage();
  const keeper = createWakeLockKeeper(wakeLock, page);
  keeper.setActive(true);
  await wakeLock.grant();
  keeper.setPaused(true);
  t.mock.timers.tick(PAUSED_WAKE_HOLD_MS - 1);
  assert.equal(keeper.isHeld(), true, 'still held near the end of the two minutes');
  t.mock.timers.tick(1);
  assert.equal(keeper.isHeld(), false);
  assert.equal(wakeLock.held(), 0);

  // Coming back to the page while paused doesn't take it again.
  page.show(false, wakeLock);
  page.show(true);
  assert.equal(wakeLock.requests.length, 0);

  keeper.setPaused(false);
  await wakeLock.grant();
  assert.equal(keeper.isHeld(), true, 'resumed, the screen stays awake again');

  // A short pause keeps the same lock throughout.
  keeper.setPaused(true);
  t.mock.timers.tick(30_000);
  keeper.setPaused(false);
  assert.equal(wakeLock.requests.length, 0, 'still held, so nothing to ask');
  t.mock.timers.tick(PAUSED_WAKE_HOLD_MS);
  assert.equal(keeper.isHeld(), true, 'the hold\'s timer went with the resume');
});

test('a lock still on its way when the pause\'s two minutes run out is let go as it arrives', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const wakeLock = new FakeWakeLock();
  const keeper = createWakeLockKeeper(wakeLock, fakePage());
  keeper.setActive(true);
  keeper.setPaused(true);
  t.mock.timers.tick(PAUSED_WAKE_HOLD_MS);
  await wakeLock.grant();
  assert.equal(wakeLock.held(), 0);
  assert.equal(keeper.isHeld(), false);
});
