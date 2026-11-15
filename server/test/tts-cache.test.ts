import assert from 'node:assert/strict';
import { join } from 'node:path';
import test from 'node:test';
import {
  audioPath,
  isCacheKey,
  isOfflineVoice,
  respellingPath,
  sniffContentType,
  timingsPath,
  TTS_DIR,
  ttsKey,
} from '../src/tts/cache.js';
import { partitionBackfillTexts } from '../src/tts/backfill.js';

test('a clip key is the SHA-256 of the voice, a newline and the trimmed text, as the client computes it', () => {
  // Literal digests: the client (services/api.ts ttsKey) derives the same keys, so the format must not drift.
  assert.equal(ttsKey('Hello there.', 'Mia'), '34a7fda7ef25705c6b91e942cfa7f3ee00e54fc69077e90d38e3fc19feb04474');
  assert.equal(ttsKey('  Hello there.\n', 'Mia'), ttsKey('Hello there.', 'Mia'));
  assert.equal(ttsKey('Hello there.', 'casual'), 'd32c1ac7577ce5d329f49b606bcc9e6ccb7b4fe22541ae2fbcc95d4f4e0a12b1');
});

test('a clip, its timings and its respelling sit side by side under the key\'s two-character prefix', () => {
  const key = ttsKey('Hello there.', 'Mia');
  assert.equal(audioPath(key), join(TTS_DIR, '34', key));
  assert.equal(timingsPath(key), `${audioPath(key)}.json`);
  assert.equal(respellingPath(key), `${audioPath(key)}.txt`);
  assert.equal(isCacheKey(key), true);
  assert.equal(isCacheKey(key.toUpperCase()), false);
  assert.equal(isCacheKey(`${key}.mp3`), false);
  assert.equal(isCacheKey('../etc/passwd'), false);
});

test('only the versioned Qwen voices count as offline voices', () => {
  assert.equal(isOfflineVoice('qwen3-aiden-clear-v1'), true);
  assert.equal(isOfflineVoice('qwen3-aiden-casual-v1'), true);
  assert.equal(isOfflineVoice('Mia'), false);
  assert.equal(isOfflineVoice('casual'), false);
});

test('a stored clip\'s content type comes from its leading bytes', () => {
  assert.equal(sniffContentType(Buffer.from('RIFF....WAVE')), 'audio/wav');
  assert.equal(sniffContentType(Buffer.from('OggS....')), 'audio/ogg');
  assert.equal(sniffContentType(Buffer.from('ID3....')), 'audio/mpeg');
  assert.equal(sniffContentType(Buffer.from([0xff, 0xfb, 0x90, 0x00])), 'audio/mpeg');
  assert.equal(sniffContentType(Buffer.from('??')), 'audio/mpeg');
});

test('the backfill keys a sentence by its speakable text: markers stripped, then trimmed', () => {
  const { catalog, library } = partitionBackfillTexts(
    [' I {{turned}} it [[down]]. ', 'A {{brace}} inside a [[marker]] stays plain.'],
    ['I turned it down.', 'One more line.  '],
  );
  assert.deepEqual(catalog, ['I turned it down.', 'A brace inside a marker stays plain.']);
  assert.deepEqual(library, ['One more line.']);
});
