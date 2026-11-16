import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { writeJson } from '../support/fs.ts';
import { repoPath } from '../support/paths.ts';

// prepare-incremental-item-images.mjs prune-missing, which the cycle runs after the saved-item image loop: the
// manifest the image dispatcher publishes keeps only the images the loop accepted. The preparation itself is tested
// in server/test/prepare-incremental-item-images.test.ts.

const script = repoPath('scripts', 'offline', 'prepare-incremental-item-images.mjs');
const run = (...args: string[]) => spawnSync(process.execPath, [script, ...args], { encoding: 'utf8' });

function bundle(t: test.TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'item-image-prune-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'images'));
  const entry = (name: string) => ({ parentId: 'p', imageId: name, parentHash: 'h', imageFile: `images/${name}.webp`, promptHash: 'q' });
  const manifest = { version: 1, generatedAt: 5, model: 'krea/Krea-2-Turbo', entries: ['kept', 'deferred', 'empty', 'also-kept'].map(entry) };
  writeJson(join(root, 'manifest.json'), manifest);
  writeFileSync(join(root, 'images', 'kept.webp'), 'image');
  writeFileSync(join(root, 'images', 'also-kept.webp'), 'image');
  // An empty file counts as missing, as it does for the judge: published, it would fail its wave's image check.
  writeFileSync(join(root, 'images', 'empty.webp'), '');
  return { root, manifest };
}

test('prune-missing keeps the manifest entries whose image was accepted and prints how many are left', t => {
  const { root, manifest } = bundle(t);
  chmodSync(join(root, 'manifest.json'), 0o644);

  const result = run('prune-missing', root);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, '2\n');
  const written = readFileSync(join(root, 'manifest.json'), 'utf8');
  assert.deepEqual(JSON.parse(written), {
    ...manifest,
    entries: manifest.entries.filter(({ imageId }) => imageId === 'kept' || imageId === 'also-kept'),
  });
  // Written the way every offline stage hands JSON on: pretty-printed with a final newline, owner-only.
  assert.equal(written, `${JSON.stringify(JSON.parse(written), null, 2)}\n`);
  assert.equal(statSync(join(root, 'manifest.json')).mode & 0o777, 0o600);

  // Pruning again changes nothing.
  assert.equal(run('prune-missing', root).stdout, '2\n');
});

test('prune-missing prints 0 when no image was accepted, and refuses to run without exactly one directory', t => {
  const { root } = bundle(t);
  rmSync(join(root, 'images'), { recursive: true });
  assert.equal(run('prune-missing', root).stdout, '0\n');
  assert.deepEqual(JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8')).entries, []);

  for (const args of [['prune-missing'], ['prune-missing', root, 'extra']]) {
    const refused = run(...args);
    assert.notEqual(refused.status, 0, args.join(' '));
    assert.match(refused.stderr, /prepare-incremental-item-images\.mjs prune-missing <output-directory>/);
  }
});
