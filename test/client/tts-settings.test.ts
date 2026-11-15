import assert from 'node:assert/strict';
import test from 'node:test';
import { MemoryStorage } from '../support/memory-storage.ts';

type TtsSettings = typeof import('../../services/ttsSettings.ts');

// The module reads the stored values when it loads, so every case loads its own instance over its own storage.
let instance = 0;
const loadWith = async (storage: Storage | 'blocked'): Promise<TtsSettings> => {
  if (storage === 'blocked') {
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      get() { throw new DOMException('The operation is insecure.', 'SecurityError'); },
    });
  } else {
    Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: storage });
  }
  return await import(`../../services/ttsSettings.ts?instance=${++instance}`) as TtsSettings;
};
const storageWith = (values: Record<string, string>) => {
  const storage = new MemoryStorage();
  for (const [key, value] of Object.entries(values)) storage.setItem(key, value);
  return storage as unknown as Storage;
};

test.after(() => { Reflect.deleteProperty(globalThis, 'localStorage'); });

test('the speech style defaults to clear and keeps a stored casual choice', async () => {
  assert.equal((await loadWith(storageWith({}))).getTtsStyle(), 'clear');
  assert.equal((await loadWith(storageWith({ tts_style: 'casual' }))).getTtsStyle(), 'casual');
  assert.equal((await loadWith(storageWith({ tts_style: 'mumbled' }))).getTtsStyle(), 'clear');
});

test('a new speech style is stored and announced once', async () => {
  const storage = storageWith({});
  const settings = await loadWith(storage);
  const heard: string[] = [];
  const unsubscribe = settings.subscribeTtsStyle(style => heard.push(style));
  assert.deepEqual(heard, ['clear'], 'a subscriber hears the current style at once');
  settings.setTtsStyle('casual');
  settings.setTtsStyle('casual');
  assert.deepEqual(heard, ['clear', 'casual']);
  assert.equal(storage.getItem('tts_style'), 'casual');
  unsubscribe();
  settings.setTtsStyle('clear');
  assert.deepEqual(heard, ['clear', 'casual'], 'an unsubscribed listener hears nothing more');
});

test('a stored rate is kept within 1x to 2x, and an unreadable one falls back to 1x', async () => {
  const rateFrom = async (stored: string) => (await loadWith(storageWith({ tts_rate: stored }))).getPlaybackRate();
  assert.equal(await rateFrom('1.5'), 1.5);
  assert.equal(await rateFrom('3'), 2);
  assert.equal(await rateFrom('0.5'), 1);
  assert.equal(await rateFrom('fast'), 1);
  assert.equal(await rateFrom('0'), 1);
  assert.equal(await rateFrom('-2'), 1);
  assert.equal((await loadWith(storageWith({}))).getPlaybackRate(), 1);
});

test('a new rate is clamped, stored and announced once', async () => {
  const storage = storageWith({});
  const settings = await loadWith(storage);
  const heard: number[] = [];
  settings.subscribePlaybackRate(rate => heard.push(rate));
  settings.setPlaybackRate(1.3);
  settings.setPlaybackRate(9);
  settings.setPlaybackRate(2);
  assert.deepEqual(heard, [1, 1.3, 2]);
  assert.equal(storage.getItem('tts_rate'), '2');
  assert.deepEqual([...settings.RATE_PRESETS], [1, 1.1, 1.3, 1.5, 1.75, 2]);
});

test('blocked storage leaves the defaults working', async () => {
  const settings = await loadWith('blocked');
  assert.equal(settings.getTtsStyle(), 'clear');
  assert.equal(settings.getPlaybackRate(), 1);
  settings.setTtsStyle('casual');
  settings.setPlaybackRate(1.5);
  assert.equal(settings.getTtsStyle(), 'casual', 'the choice holds for the session');
  assert.equal(settings.getPlaybackRate(), 1.5);
});
