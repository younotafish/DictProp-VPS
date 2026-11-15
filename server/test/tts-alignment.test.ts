import assert from 'node:assert/strict';
import test from 'node:test';
import { parseWhisperCppTimings } from '../src/tts-alignment.js';

// One token as whisper-cli -ojf writes it.
const stamp = (ms: number) => new Date(ms).toISOString().slice(11, 23).replace('.', ',');
const token = (text: string, from: number, to: number, id: number) =>
  ({ text, timestamps: { from: stamp(from), to: stamp(to) }, offsets: { from, to }, id, p: 0.9, t_dtw: -1 });

// "Hello, world!" as whisper-cli -ojf -ml 1 -sow writes it for ggml-tiny.en: one segment per word, the begin token
// opening the first and a timestamp token closing the last (ids from tiny.en's vocabulary).
function helloWorld({ begin = [0, 0], timestamp = [1_000, 1_000] }: { begin?: [number, number]; timestamp?: [number, number] } = {}) {
  return {
    systeminfo: 'AVX = 1 | AVX2 = 1 | FMA = 1 | NEON = 0 | F16C = 1',
    model: { type: 'tiny', multilingual: false, vocab: 51864 },
    params: { model: '/opt/whisper/ggml-tiny.en.bin', language: 'en', translate: false },
    result: { language: 'en' },
    transcription: [
      {
        timestamps: { from: stamp(0), to: stamp(450) },
        offsets: { from: 0, to: 450 },
        text: ' Hello,',
        tokens: [token('[_BEG_]', begin[0], begin[1], 50363), token(' Hello', 100, 400, 15496), token(',', 400, 450, 11)],
      },
      {
        timestamps: { from: stamp(450), to: stamp(1_000) },
        offsets: { from: 450, to: 1_000 },
        text: ' world!',
        tokens: [token(' world', 500, 850, 995), token('!', 850, 900, 0), token('[_TT_50]', timestamp[0], timestamp[1], 50413)],
      },
    ],
  };
}

const HELLO_WORLD = [
  { start: 0.1, end: 0.45, text: 'Hello' },
  { start: 0.5, end: 0.9, text: 'world' },
];

test('whisper.cpp token timestamps merge subword punctuation into word timings', () => {
  assert.deepEqual(parseWhisperCppTimings(helloWorld()), HELLO_WORLD);
});

test('whisper.cpp\'s begin and timestamp tokens never become words, whatever span they carry', () => {
  assert.deepEqual(parseWhisperCppTimings(helloWorld({ timestamp: [900, 1_000] })), HELLO_WORLD);
  assert.deepEqual(parseWhisperCppTimings(helloWorld({ begin: [0, 100] })), HELLO_WORLD);
  const openAiSpelling = helloWorld();
  openAiSpelling.transcription[0].tokens[0] = token('<|startoftranscript|>', 0, 10, 50257);
  assert.deepEqual(parseWhisperCppTimings(openAiSpelling), HELLO_WORLD);
});

test('whisper.cpp segment timestamps degrade to proportional word timings', () => {
  assert.deepEqual(parseWhisperCppTimings({
    transcription: [{ text: ' two words', offsets: { from: 200, to: 1_000 } }],
  }), [
    { start: 0.2, end: 0.5, text: 'two' },
    { start: 0.5, end: 1, text: 'words' },
  ]);
});
