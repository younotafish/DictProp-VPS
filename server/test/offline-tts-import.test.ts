import assert from 'node:assert/strict';
import test from 'node:test';
import { offlineTtsKey, validateOfflineTtsBundle } from '../src/offline-tts-import.js';

const text = 'Could we pressure-test that assumption before we commit?';
const voice = 'qwen3-aiden-clear-v1' as const;
const key = offlineTtsKey(text, voice);
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
const bundle = {
  version: 1,
  generatedAt: 1,
  model: 'mlx-community/Qwen3-TTS-12Hz-1.7B-CustomVoice-8bit',
  aligner: 'mlx-community/Qwen3-ForcedAligner-0.6B-8bit',
  entries: [entry],
};

test('offline TTS manifests bind immutable cache keys to voice, text, audio, and timings', () => {
  assert.equal(validateOfflineTtsBundle(bundle), null);
  assert.match(validateOfflineTtsBundle({ ...bundle, entries: [{ ...entry, text: `${text} changed` }] }) || '', /key does not match/);
  assert.match(validateOfflineTtsBundle({ ...bundle, entries: [{ ...entry, voice: 'Mia' }] }) || '', /voice is invalid/);
  assert.match(validateOfflineTtsBundle({ ...bundle, entries: [entry, entry] }) || '', /duplicates key/);
  assert.match(validateOfflineTtsBundle({ ...bundle, entries: [{ ...entry, audioFile: '../escape.mp3' }] }) || '', /audioFile is invalid/);
});
