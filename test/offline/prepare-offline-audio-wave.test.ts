import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { sha256, writeJson } from '../support/fs.ts';
import { repoPath } from '../support/paths.ts';

const script = repoPath('scripts', 'offline', 'prepare-offline-audio-wave.mjs');

interface AudioEntry {
  key: string;
  audioFile: string;
  timingsFile: string;
  audioSha256: string;
  timingsSha256: string;
}

/** A source root as generate-real-life-audio.py leaves it: manifest.json beside audio/<xx>/<key>.{mp3,json}. */
function sourceRoot(keys: string[]) {
  const root = mkdtempSync(join(tmpdir(), 'dictprop-audio-wave-'));
  const source = join(root, 'source');
  const entries: AudioEntry[] = keys.map(key => {
    const audioFile = `audio/${key.slice(0, 2)}/${key}.mp3`;
    const timingsFile = `audio/${key.slice(0, 2)}/${key}.json`;
    const audio = `audio ${key}`;
    const timings = JSON.stringify([{ start: 0, end: 0.5, text: key }]);
    mkdirSync(dirname(join(source, audioFile)), { recursive: true });
    writeFileSync(join(source, audioFile), audio);
    writeFileSync(join(source, timingsFile), timings);
    return { key, audioFile, timingsFile, audioSha256: sha256(audio), timingsSha256: sha256(timings) };
  });
  return { root, source, output: join(root, 'wave'), entries };
}

function prepare(bundle: ReturnType<typeof sourceRoot>, entries: unknown[], args: string[], published: unknown[] = []) {
  writeJson(join(bundle.source, 'manifest.json'), {
    version: 1, generatedAt: 7, model: 'tts-model', aligner: 'aligner-model', entries,
  });
  const publishedPaths = published.map((manifest, index) => {
    const path = join(bundle.root, `published-${index}.json`);
    writeJson(path, manifest);
    return path;
  });
  const child = spawnSync(process.execPath, [script, bundle.source, bundle.output, ...args, ...publishedPaths], {
    encoding: 'utf8',
  });
  return {
    status: child.status,
    stderr: child.stderr,
    summary: child.status === 0 ? JSON.parse(child.stdout) : null,
    manifestText: child.status === 0 ? readFileSync(join(bundle.output, 'manifest.json'), 'utf8') : '',
  };
}

test('an audio wave copies unpublished, hash-checked clips up to its limit', () => {
  const bundle = sourceRoot(['aa11', 'bb22', 'cc33', 'dd44']);

  const result = prepare(bundle, bundle.entries, ['2'], [{ version: 1, entries: [{ key: 'aa11' }] }]);

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.summary, { waveEntries: 2, publishedEntries: 1 });
  assert.equal(result.manifestText, JSON.stringify({
    version: 1, generatedAt: 7, model: 'tts-model', aligner: 'aligner-model', entries: bundle.entries.slice(1, 3),
  }));
  assert.equal(readFileSync(join(bundle.output, 'audio', 'bb', 'bb22.mp3'), 'utf8'), 'audio bb22');
  assert.ok(existsSync(join(bundle.output, 'audio', 'cc', 'cc33.json')));
  assert.equal(existsSync(join(bundle.output, 'audio', 'aa', 'aa11.mp3')), false);
  assert.equal(existsSync(join(bundle.output, 'audio', 'dd', 'dd44.mp3')), false);
});

test('an audio wave refuses a bad limit, a changed clip and a path outside its root', () => {
  const bundle = sourceRoot(['aa11']);
  for (const limit of ['0', '2001', '1.5']) {
    const result = prepare(bundle, bundle.entries, [limit]);
    assert.notEqual(result.status, 0, `limit ${limit}`);
    assert.match(result.stderr, /limit must be between 1 and 2000/);
  }

  const changed = prepare(bundle, [{ ...bundle.entries[0], audioSha256: 'c'.repeat(64) }], ['5']);
  assert.notEqual(changed.status, 0);
  assert.match(changed.stderr, /hash mismatch for aa11/);

  const escaping = prepare(bundle, [{ ...bundle.entries[0], audioFile: '../outside.mp3' }], ['5']);
  assert.notEqual(escaping.status, 0);
  assert.match(escaping.stderr, /unsafe audio path: \.\.\/outside\.mp3/);
});
