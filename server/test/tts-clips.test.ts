import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import test from 'node:test';
import { audioPath, CASUAL_STYLE, respellingPath, timingsPath, ttsKey } from '../src/tts/cache.js';
import { createClipStore, type ClipDependencies } from '../src/tts/clips.js';

const TIMING = [{ start: 0, end: 0.4, text: 'hi' }];

// Another process storing a file the moment before this one does.
function storeFirst(path: string, contents: string) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, contents);
}

function clipStore(overrides: Partial<ClipDependencies> = {}) {
  const aligned: string[] = [];
  const deps: ClipDependencies = {
    synthClear: async (text) => Buffer.from(`ID3 clear ${text}`),
    synthCasual: async (spoken) => Buffer.from(`ID3 casual ${spoken}`),
    reduce: async (sentence) => `${sentence} (casual)`,
    align: async (audio) => { aligned.push(audio.toString()); return TIMING; },
    ...overrides,
  };
  return { clips: createClipStore(deps), aligned };
}

test('a clip another process stored first keeps its bytes, and the timings are aligned on them', async () => {
  const text = 'Two writers make this clip at once.';
  const key = ttsKey(text, 'Mia');
  const { clips, aligned } = clipStore({
    synthClear: async () => {
      storeFirst(audioPath(key), 'ID3 the other process');
      return Buffer.from('ID3 this process');
    },
  });
  await clips.generateAndVerify(text, 'Mia');
  assert.equal(readFileSync(audioPath(key), 'utf8'), 'ID3 the other process');
  assert.deepEqual(aligned, ['ID3 the other process']);
  assert.deepEqual(JSON.parse(readFileSync(timingsPath(key), 'utf8')), TIMING);
  assert.deepEqual(readdirSync(dirname(audioPath(key))).filter(name => name.startsWith(key)).sort(), [key, `${key}.json`]);
});

test('a casual clip that lost the race leaves the winner\'s respelling alone', async () => {
  const text = 'The losing respelling is not recorded.';
  const key = ttsKey(text, CASUAL_STYLE);
  const { clips } = clipStore({
    synthCasual: async () => {
      storeFirst(audioPath(key), 'ID3 the other process');
      return Buffer.from('ID3 this process');
    },
  });
  await clips.generateAndVerify(text, CASUAL_STYLE);
  assert.equal(readFileSync(audioPath(key), 'utf8'), 'ID3 the other process');
  assert.equal(existsSync(respellingPath(key)), false);
});

test('a winning casual clip records the respelling it says', async () => {
  const text = 'The winning respelling is recorded.';
  const key = ttsKey(text, CASUAL_STYLE);
  const { clips } = clipStore();
  await clips.generateAndVerify(text, CASUAL_STYLE);
  assert.equal(readFileSync(audioPath(key), 'utf8'), `ID3 casual ${text} (casual)`);
  assert.equal(readFileSync(respellingPath(key), 'utf8'), `${text} (casual)`);
});

test('timings another process stored first are kept', async () => {
  const text = 'Two writers align this clip at once.';
  const key = ttsKey(text, 'Mia');
  const theirs = [{ start: 0, end: 0.5, text: 'theirs' }];
  const { clips } = clipStore({
    align: async () => {
      storeFirst(timingsPath(key), JSON.stringify(theirs));
      return TIMING;
    },
  });
  await clips.generateAndVerify(text, 'Mia');
  assert.deepEqual(JSON.parse(readFileSync(timingsPath(key), 'utf8')), theirs);
});
