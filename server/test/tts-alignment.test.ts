import assert from 'node:assert/strict';
import test from 'node:test';
import { parseWhisperCppTimings } from '../src/tts-alignment.js';

test('whisper.cpp token timestamps merge subword punctuation into word timings', () => {
  const timings = parseWhisperCppTimings({
    transcription: [{
      offsets: { from: 0, to: 1_000 },
      text: ' Hello, world!',
      tokens: [
        { text: '<|startoftranscript|>', offsets: { from: 0, to: 10 } },
        { text: ' Hello', offsets: { from: 100, to: 400 } },
        { text: ',', offsets: { from: 400, to: 450 } },
        { text: ' world', offsets: { from: 500, to: 850 } },
        { text: '!', offsets: { from: 850, to: 900 } },
      ],
    }],
  });

  assert.deepEqual(timings, [
    { start: 0.1, end: 0.45, text: 'Hello' },
    { start: 0.5, end: 0.9, text: 'world' },
  ]);
});

test('whisper.cpp segment timestamps degrade to proportional word timings', () => {
  assert.deepEqual(parseWhisperCppTimings({
    transcription: [{ text: ' two words', offsets: { from: 200, to: 1_000 } }],
  }), [
    { start: 0.2, end: 0.5, text: 'two' },
    { start: 0.5, end: 1, text: 'words' },
  ]);
});
