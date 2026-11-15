import assert from 'node:assert/strict';
import { linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { copyFileAtomic, fileReady, writeFileAtomic, writeJsonAtomic } from '../../scripts/offline/atomic-file.mjs';

function workDir(t: test.TestContext): string {
  const dir = mkdtempSync(join(tmpdir(), 'dictprop-atomic-file-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('a write replaces the file whole, privately, and leaves no temp file behind', t => {
  const dir = workDir(t);
  const path = join(dir, 'checkpoint.json');
  writeFileSync(path, 'old contents', { mode: 0o644 });
  writeFileAtomic(path, 'new contents');
  assert.equal(readFileSync(path, 'utf8'), 'new contents');
  assert.equal(statSync(path).mode & 0o777, 0o600);
  writeJsonAtomic(path, { targets: [1] });
  assert.equal(readFileSync(path, 'utf8'), '{\n  "targets": [\n    1\n  ]\n}\n');
  assert.deepEqual(readdirSync(dir), ['checkpoint.json']);
});

test('a write that cannot be put in place fails and removes its temp file', t => {
  const dir = workDir(t);
  const occupied = join(dir, 'occupied');
  mkdirSync(join(occupied, 'inside'), { recursive: true });
  assert.throws(() => writeJsonAtomic(occupied, {}));
  assert.throws(() => writeFileAtomic(join(dir, 'missing', 'file.json'), '{}'), /ENOENT/);
  assert.deepEqual(readdirSync(dir), ['occupied']);
});

test('a copy replaces its destination instead of writing through another name linked to it', t => {
  const dir = workDir(t);
  const baseline = join(dir, 'baseline.webp');
  const accepted = join(dir, 'accepted.webp');
  const candidate = join(dir, 'candidate.webp');
  writeFileSync(baseline, 'baseline image');
  linkSync(baseline, accepted);
  writeFileSync(candidate, 'new candidate');
  copyFileAtomic(candidate, accepted);
  assert.equal(readFileSync(accepted, 'utf8'), 'new candidate');
  assert.equal(readFileSync(baseline, 'utf8'), 'baseline image');
  assert.deepEqual(readdirSync(dir).sort(), ['accepted.webp', 'baseline.webp', 'candidate.webp']);
  assert.throws(() => copyFileAtomic(join(dir, 'missing.webp'), accepted), /ENOENT/);
  assert.deepEqual(readdirSync(dir).sort(), ['accepted.webp', 'baseline.webp', 'candidate.webp']);
});

test('a file is ready only when it exists and is not empty', t => {
  const dir = workDir(t);
  writeFileSync(join(dir, 'empty.webp'), '');
  writeFileSync(join(dir, 'image.webp'), 'RIFF');
  assert.equal(fileReady(join(dir, 'missing.webp')), false);
  assert.equal(fileReady(join(dir, 'empty.webp')), false);
  assert.equal(fileReady(join(dir, 'image.webp')), true);
});
