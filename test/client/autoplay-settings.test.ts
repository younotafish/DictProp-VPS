import assert from 'node:assert/strict';
import test from 'node:test';
import { MemoryStorage } from '../support/memory-storage.ts';

// services/audio/autoplaySettings.ts: auto-play's slide speed, Duration, gap and repeats, kept on the device.

type AutoPlaySettingsModule = typeof import('../../services/audio/autoplaySettings.ts');

// The module reads the stored settings when it loads, so every case loads its own instance over its own storage.
let instance = 0;
const loadWith = async (storage: Storage | 'blocked'): Promise<AutoPlaySettingsModule> => {
  if (storage === 'blocked') {
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      get() { throw new DOMException('The operation is insecure.', 'SecurityError'); },
    });
  } else {
    Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: storage });
  }
  return await import(`../../services/audio/autoplaySettings.ts?instance=${++instance}`) as AutoPlaySettingsModule;
};
const storageWith = (stored?: string) => {
  const storage = new MemoryStorage();
  if (stored !== undefined) storage.setItem('autoplay_settings', stored);
  return storage as unknown as Storage;
};
const DEFAULTS = { slideMs: 2000, minutes: 20, gapMs: 2000, repeats: 3 };

test.after(() => { Reflect.deleteProperty(globalThis, 'localStorage'); });

test('with nothing stored the settings are the defaults: 2 s slides, 20 minutes, a 2 s gap and three reads', async () => {
  assert.deepEqual((await loadWith(storageWith())).getAutoPlaySettings(), DEFAULTS);
});

test('the stored settings come back, each one that is not among its presets as its default', async () => {
  const kept = { slideMs: 5000, minutes: 5, gapMs: 10000, repeats: 1 };
  assert.deepEqual((await loadWith(storageWith(JSON.stringify(kept)))).getAutoPlaySettings(), kept);
  const mixed = { slideMs: 1500, minutes: 30, gapMs: '3000', repeats: 2.5 };
  assert.deepEqual((await loadWith(storageWith(JSON.stringify(mixed)))).getAutoPlaySettings(), { ...DEFAULTS, slideMs: 1500 });
  for (const unreadable of ['not json', '3', '[]', 'null', '"fast"']) {
    assert.deepEqual((await loadWith(storageWith(unreadable))).getAutoPlaySettings(), DEFAULTS, unreadable);
  }
});

test('each control steps to its next preset, back to the first after the last, and all four are stored in one key', async () => {
  const storage = storageWith();
  const settings = await loadWith(storage);
  let heard = 0;
  const unsubscribe = settings.subscribeAutoPlaySettings(() => { heard++; });
  settings.cycleAutoPlaySetting('minutes');
  assert.deepEqual(settings.getAutoPlaySettings(), { ...DEFAULTS, minutes: 25 });
  settings.cycleAutoPlaySetting('minutes');
  assert.equal(settings.getAutoPlaySettings().minutes, 5, 'after 25 minutes, 5');
  settings.cycleAutoPlaySetting('repeats');
  settings.cycleAutoPlaySetting('gapMs');
  settings.cycleAutoPlaySetting('slideMs');
  const chosen = { slideMs: 3000, minutes: 5, gapMs: 3000, repeats: 4 };
  assert.deepEqual(settings.getAutoPlaySettings(), chosen);
  assert.deepEqual(JSON.parse(storage.getItem('autoplay_settings') ?? 'null'), chosen);
  assert.equal(heard, 5, 'every view hears each change');
  unsubscribe();
  settings.cycleAutoPlaySetting('repeats');
  assert.equal(heard, 5, 'an unsubscribed view hears nothing more');
  assert.deepEqual((await loadWith(storage)).getAutoPlaySettings(), { ...chosen, repeats: 5 }, 'the next launch has them');
});

test('blocked storage leaves the defaults working, and each change holds for the session', async () => {
  const settings = await loadWith('blocked');
  assert.deepEqual(settings.getAutoPlaySettings(), DEFAULTS);
  settings.cycleAutoPlaySetting('gapMs');
  assert.equal(settings.getAutoPlaySettings().gapMs, 3000);
  settings.cycleAutoPlaySetting('repeats');
  assert.deepEqual(settings.getAutoPlaySettings(), { ...DEFAULTS, gapMs: 3000, repeats: 4 }, 'the gap chosen before stays');
});

test('two open tabs keep each other\'s changes: each starts from what is stored, and shows in the other tab', async t => {
  // The browser tells every other tab of a change to localStorage with a storage event on its window.
  const page = new EventTarget();
  Object.defineProperty(globalThis, 'window', { configurable: true, value: page });
  t.after(() => { Reflect.deleteProperty(globalThis, 'window'); });
  const storedChange = (key: string) => page.dispatchEvent(Object.assign(new Event('storage'), { key }));
  const storage = storageWith();
  const tabA = await loadWith(storage);
  const tabB = await loadWith(storage);
  let heardInA = 0;
  tabA.subscribeAutoPlaySettings(() => { heardInA++; });

  tabA.cycleAutoPlaySetting('minutes');
  // Tab B still holds the 20 minutes it read when it loaded; its change keeps tab A's 25.
  tabB.cycleAutoPlaySetting('repeats');
  const both = { ...DEFAULTS, minutes: 25, repeats: 4 };
  assert.deepEqual(JSON.parse(storage.getItem('autoplay_settings') ?? 'null'), both);
  assert.deepEqual(tabB.getAutoPlaySettings(), both);
  assert.deepEqual((await loadWith(storage)).getAutoPlaySettings(), both, 'the next card or lesson opens with both');

  storedChange('autoplay_settings');
  assert.deepEqual(tabA.getAutoPlaySettings(), both, 'tab A shows tab B\'s change');
  assert.equal(heardInA, 2, 'tab A\'s views hear of it');
  storedChange('tts_rate');
  assert.equal(heardInA, 2, 'another key\'s change is none of theirs');

  // A control moves on from the value its tab shows, though the other tab's change hasn't reached it yet.
  tabA.cycleAutoPlaySetting('gapMs');
  tabB.cycleAutoPlaySetting('gapMs');
  assert.deepEqual(JSON.parse(storage.getItem('autoplay_settings') ?? 'null'), { ...both, gapMs: 3000 });
});
