import assert from 'node:assert/strict';
import test from 'node:test';
import { validateOfflineTtsBundle } from '../src/offline-tts-import.js';
import { ttsKey } from '../src/tts/cache.js';

// The checks the speech-bundle validator takes from validation-helpers.ts, each with the message it has always given.
const text = 'Could we pressure-test that assumption before we commit?';
const voice = 'qwen3-aiden-clear-v1' as const;
const key = ttsKey(text, voice);
const entry = {
  key,
  voice,
  text,
  audioFile: `audio/${key.slice(0, 2)}/${key}.mp3`,
  timingsFile: `audio/${key.slice(0, 2)}/${key}.json`,
  audioSha256: 'a'.repeat(64),
  timingsSha256: 'b'.repeat(64),
  durationSeconds: 3.4,
};
const bundle = { version: 1, generatedAt: 1, model: 'test-tts-model', aligner: 'test-aligner', entries: [entry] };
const withEntry = (patch: Record<string, unknown>) => ({ ...bundle, entries: [{ ...entry, ...patch }] });

test('a speech bundle that is not an object, or holds an entry that is not one, is refused as before', () => {
  assert.equal(validateOfflineTtsBundle(bundle), null);
  for (const value of [null, [], 'bundle', 1]) assert.equal(validateOfflineTtsBundle(value), 'bundle must be an object');
  for (const value of [null, [], 'entry']) {
    assert.equal(validateOfflineTtsBundle({ ...bundle, entries: [value] }), 'entry 0 must be an object');
  }
});

test('a speech bundle needs a positive, finite generatedAt', () => {
  for (const generatedAt of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, '1', undefined]) {
    assert.equal(validateOfflineTtsBundle({ ...bundle, generatedAt }), 'bundle generatedAt is invalid');
  }
  assert.equal(validateOfflineTtsBundle({ ...bundle, generatedAt: 0.5 }), null);
});

test('a speech entry\'s key and file digests must be lowercase hex SHA-256 digests', () => {
  const notDigests = ['A'.repeat(64), 'a'.repeat(63), 'a'.repeat(65), 'g'.repeat(64), 42, undefined];
  for (const value of notDigests) {
    assert.equal(validateOfflineTtsBundle(withEntry({ key: value })), 'entry 0 key is invalid');
    assert.equal(validateOfflineTtsBundle(withEntry({ audioSha256: value })), 'entry 0 audioSha256 is invalid');
    assert.equal(validateOfflineTtsBundle(withEntry({ timingsSha256: value })), 'entry 0 timingsSha256 is invalid');
  }
});
