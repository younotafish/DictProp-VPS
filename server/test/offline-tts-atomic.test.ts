import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { offlineTtsKey } from '../src/offline-tts-import.js';

const DATA_DIR = mkdtempSync(join(tmpdir(), 'dictprop-offline-tts-test-'));
const TTS_DIR = join(DATA_DIR, 'tts');
const serverDir = fileURLToPath(new URL('..', import.meta.url));
const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

// ffprobe stands in for the real one: every clip is two seconds long.
const binDir = mkdtempSync(join(tmpdir(), 'dictprop-offline-tts-bin-'));
writeFileSync(join(binDir, 'ffprobe'), '#!/bin/sh\necho 2.0\n', { mode: 0o755 });

type Clip = { key: string; text: string; audio: Buffer; timings: Buffer };
const clip = (text: string): Clip => ({
  key: offlineTtsKey(text, 'qwen3-aiden-clear-v1'),
  text,
  audio: Buffer.concat([Buffer.from('ID3'), Buffer.alloc(1_200, text)]),
  timings: Buffer.from(JSON.stringify([{ start: 0, end: 0.6, text: 'Hello' }, { start: 0.6, end: 1.4, text: text.slice(0, 8) }])),
});
const installed = (key: string) => join(TTS_DIR, key.slice(0, 2), key);

function bundle(clips: Clip[]): string {
  const dir = mkdtempSync(join(tmpdir(), 'dictprop-offline-tts-bundle-'));
  const entries = clips.map(({ key, text, audio, timings }) => {
    const prefix = key.slice(0, 2);
    mkdirSync(join(dir, 'audio', prefix), { recursive: true });
    writeFileSync(join(dir, 'audio', prefix, `${key}.mp3`), audio);
    writeFileSync(join(dir, 'audio', prefix, `${key}.json`), timings);
    return {
      key, voice: 'qwen3-aiden-clear-v1', text,
      audioFile: `audio/${prefix}/${key}.mp3`, timingsFile: `audio/${prefix}/${key}.json`,
      audioSha256: sha256(audio), timingsSha256: sha256(timings), durationSeconds: 2,
    };
  });
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify({
    version: 1, generatedAt: Date.now(), model: 'test-tts', aligner: 'test-aligner', entries,
  }));
  return join(dir, 'manifest.json');
}

function runImport(manifest: string) {
  const { NODE_TEST_CONTEXT: _testContext, ...parentEnv } = process.env;
  const child = spawnSync(process.execPath, ['--import', 'tsx', 'src/scripts/import-offline-tts.ts', manifest], {
    cwd: serverDir,
    env: { ...parentEnv, DATA_DIR, PATH: `${binDir}:${process.env.PATH}` },
    encoding: 'utf8',
  });
  const lines = child.stdout.trim().split('\n');
  return { status: child.status, stderr: child.stderr, output: JSON.parse(lines[lines.length - 1] || 'null') };
}

const leftovers = (): string[] => !existsSync(TTS_DIR) ? [] : readdirSync(TTS_DIR, { recursive: true })
  .map(String).filter(name => name.endsWith('.importing'));

test('an import installs each clip whole, leaves no temp files, and a re-run skips what is there', () => {
  const clips = [clip('A clip the first run installs.'), clip('Another clip the first run installs.')];
  const manifest = bundle(clips);
  let run = runImport(manifest);
  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual({ imported: run.output.imported, skipped: run.output.skipped, errors: run.output.errors },
    { imported: 2, skipped: 0, errors: [] });
  for (const { key, audio, timings } of clips) {
    assert.deepEqual(readFileSync(installed(key)), audio);
    assert.deepEqual(readFileSync(`${installed(key)}.json`), timings);
  }
  assert.deepEqual(leftovers(), []);

  run = runImport(manifest);
  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual({ imported: run.output.imported, skipped: run.output.skipped }, { imported: 0, skipped: 2 });
});

test('a re-run finishes a clip an interrupted import left half installed', () => {
  const timingsOnly = clip('The interrupted import wrote only these timings.');
  const audioOnly = clip('An older import wrote only this audio.');
  mkdirSync(join(TTS_DIR, timingsOnly.key.slice(0, 2)), { recursive: true });
  mkdirSync(join(TTS_DIR, audioOnly.key.slice(0, 2)), { recursive: true });
  writeFileSync(`${installed(timingsOnly.key)}.json`, timingsOnly.timings);
  writeFileSync(installed(audioOnly.key), audioOnly.audio);
  writeFileSync(`${installed(audioOnly.key)}.json.importing`, 'a temp file an older import left behind');

  const run = runImport(bundle([timingsOnly, audioOnly]));
  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual({ imported: run.output.imported, errors: run.output.errors }, { imported: 2, errors: [] });
  for (const { key, audio, timings } of [timingsOnly, audioOnly]) {
    assert.deepEqual(readFileSync(installed(key)), audio);
    assert.deepEqual(readFileSync(`${installed(key)}.json`), timings);
  }
  assert.deepEqual(leftovers(), []);
});

test('a cache key that already holds different content is left alone and reported', () => {
  const clash = clip('This key already holds other audio.');
  mkdirSync(join(TTS_DIR, clash.key.slice(0, 2)), { recursive: true });
  writeFileSync(installed(clash.key), Buffer.alloc(1_500, 'other audio'));

  const run = runImport(bundle([clash]));
  assert.equal(run.status, 1);
  assert.match(run.output.errors[0].error, /already contains different content/);
  assert.deepEqual(readFileSync(installed(clash.key)), Buffer.alloc(1_500, 'other audio'));
  assert.equal(existsSync(`${installed(clash.key)}.json`), false);
});
