import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { writeJson } from '../support/fs.ts';
import { repoPath } from '../support/paths.ts';

const script = repoPath('scripts', 'offline', 'prepare-offline-image-wave.mjs');

interface ImageEntry {
  parentId: string;
  imageId: string;
  parentHash: string;
  imageFile: unknown;
  promptHash: string;
}

const imageEntry = (imageId: string, imageFile: unknown = `images/${imageId}.webp`): ImageEntry => ({
  parentId: `parent-of-${imageId}`,
  imageId,
  parentHash: 'a'.repeat(64),
  imageFile,
  promptHash: 'b'.repeat(64),
});

/** A source bundle as prepare-incremental-item-images.mjs leaves it: manifest.json beside images/. */
function sourceBundle(entries: ImageEntry[], files: string[]) {
  const root = mkdtempSync(join(tmpdir(), 'dictprop-image-wave-'));
  const sourceDir = join(root, 'source');
  mkdirSync(join(sourceDir, 'images'), { recursive: true });
  for (const file of files) writeFileSync(join(sourceDir, file), `bytes of ${file}`);
  writeJson(join(sourceDir, 'manifest.json'), { version: 1, generatedAt: 5, model: 'krea/Krea-2-Turbo', entries });
  return { root, sourceDir, outputDir: join(root, 'wave') };
}

function prepare(bundle: ReturnType<typeof sourceBundle>, args: string[] = [], published: unknown[] = []) {
  const publishedPaths = published.map((manifest, index) => {
    const path = join(bundle.root, `published-${index}.json`);
    writeJson(path, manifest);
    return path;
  });
  const child = spawnSync(process.execPath, [script, bundle.sourceDir, bundle.outputDir, ...args, ...publishedPaths], {
    encoding: 'utf8',
  });
  const manifestPath = join(bundle.outputDir, 'manifest.json');
  return {
    status: child.status,
    stderr: child.stderr,
    summary: child.status === 0 ? JSON.parse(child.stdout) : null,
    manifest: child.status === 0 ? JSON.parse(readFileSync(manifestPath, 'utf8')) : null,
    manifestPath,
  };
}

test('an image wave skips published, missing and unsafe images and stages the rest under images/', () => {
  const entries = [
    imageEntry('published'),
    imageEntry('missing'),
    imageEntry('outside-images', 'other/outside-images.webp'),
    imageEntry('absolute', '/tmp/absolute.webp'),
    imageEntry('escaping', 'images/../../escaping.webp'),
    imageEntry('not-a-string', 42),
    imageEntry('first'),
    imageEntry('second'),
  ];
  const bundle = sourceBundle(entries, [
    'images/published.webp', 'images/first.webp', 'images/second.webp',
  ]);
  mkdirSync(join(bundle.sourceDir, 'other'));
  writeFileSync(join(bundle.sourceDir, 'other', 'outside-images.webp'), 'outside images/');
  writeFileSync(join(bundle.root, 'escaping.webp'), 'outside the source directory');

  const result = prepare(bundle, ['100'], [{ version: 1, entries: [{ imageId: 'published' }] }]);

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.manifest.entries, [entries[6], entries[7]]);
  assert.equal(result.manifest.version, 1);
  assert.equal(result.manifest.model, 'krea/Krea-2-Turbo');
  assert.notEqual(result.manifest.generatedAt, 5);
  assert.deepEqual(Object.keys(result.manifest), ['version', 'generatedAt', 'model', 'entries']);
  assert.deepEqual(result.summary, { sourceEntries: 8, previouslyPublished: 1, waveEntries: 2 });
  assert.deepEqual(readdirSync(join(bundle.outputDir, 'images')).sort(), ['first.webp', 'second.webp']);
  assert.equal(readFileSync(join(bundle.outputDir, 'images', 'first.webp'), 'utf8'), 'bytes of images/first.webp');
  assert.equal(statSync(result.manifestPath).mode & 0o777, 0o600);
});

test('an image wave stops at its cap, which defaults to 100, and keeps an image already staged', () => {
  const entries = Array.from({ length: 101 }, (_, index) => imageEntry(`image-${index}`));
  const bundle = sourceBundle(entries, entries.map(entry => String(entry.imageFile)));
  mkdirSync(join(bundle.outputDir, 'images'), { recursive: true });
  writeFileSync(join(bundle.outputDir, 'images', 'image-0.webp'), 'staged by an earlier attempt');

  const capped = prepare(bundle, ['2']);
  assert.equal(capped.status, 0, capped.stderr);
  assert.deepEqual(capped.manifest.entries.map((entry: ImageEntry) => entry.imageId), ['image-0', 'image-1']);
  assert.equal(readFileSync(join(bundle.outputDir, 'images', 'image-0.webp'), 'utf8'), 'staged by an earlier attempt');
  assert.equal(existsSync(join(bundle.outputDir, 'images', 'image-2.webp')), false);

  const defaulted = prepare(bundle);
  assert.equal(defaulted.status, 0, defaulted.stderr);
  assert.equal(defaulted.manifest.entries.length, 100);
});

test('an image wave refuses a bad cap, a duplicate or missing image id, and a malformed source or published manifest', () => {
  const valid = sourceBundle([imageEntry('one')], ['images/one.webp']);
  for (const cap of ['0', '-1', '1.5', 'many']) {
    const result = prepare(valid, [cap]);
    assert.notEqual(result.status, 0, `cap ${cap}`);
    assert.match(result.stderr, /max-entries must be a positive integer/);
  }

  const duplicate = prepare(sourceBundle([imageEntry('one'), imageEntry('one')], ['images/one.webp']));
  assert.notEqual(duplicate.status, 0);
  assert.match(duplicate.stderr, /Source manifest contains an invalid or duplicate image id: one/);

  const unnamed = prepare(sourceBundle([{ ...imageEntry('one'), imageId: '' }], ['images/one.webp']));
  assert.notEqual(unnamed.status, 0);
  assert.match(unnamed.stderr, /Source manifest contains an invalid or duplicate image id: /);

  const empty = prepare(sourceBundle([], []));
  assert.notEqual(empty.status, 0);
  assert.match(empty.stderr, /Source offline-image manifest is invalid or empty/);

  const badPublished = prepare(valid, ['10'], [{ version: 1 }]);
  assert.notEqual(badPublished.status, 0);
  assert.match(badPublished.stderr, /Published image manifest is invalid: \/.*published-0\.json/);
});
