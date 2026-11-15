import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  BundleImageError, errorMessage, MAX_BUNDLE_IMAGE_BYTES, readBundleImage, resolveInBundle,
} from '../src/scripts/support/bundle.js';
import { png } from './support/fs.js';
import { SERVER_DIR } from './support/paths.js';

test('a bundle path resolves only while it stays inside the bundle', () => {
  const root = mkdtempSync(join(tmpdir(), 'dictprop-bundle-'));
  assert.equal(resolveInBundle(root, 'images/a.png'), join(root, 'images', 'a.png'));
  assert.equal(resolveInBundle(root, 'images/../a.png'), join(root, 'a.png'));
  assert.equal(resolveInBundle(root, '../outside.png'), null);
  assert.equal(resolveInBundle(root, 'images/../../outside.png'), null);
  assert.equal(resolveInBundle(root, '/etc/passwd'), null);
  // The root itself is not a file in the bundle, and neither is a sibling whose name only starts like it.
  assert.equal(resolveInBundle(root, '.'), null);
  assert.equal(resolveInBundle(root, `../${root.split('/').at(-1)}-sibling/a.png`), null);
});

test('a bundle image is read with its type, and an empty, oversized or unknown one is refused', () => {
  const root = mkdtempSync(join(tmpdir(), 'dictprop-bundle-'));
  mkdirSync(join(root, 'images'));
  const write = (name: string, bytes: Buffer) => {
    writeFileSync(join(root, 'images', name), bytes);
    return join(root, 'images', name);
  };
  assert.deepEqual(readBundleImage(write('good.png', png('good'))), { image: png('good'), mimeType: 'image/png' });

  const refusal = (path: string) => {
    try {
      readBundleImage(path);
    } catch (error) {
      return error;
    }
    assert.fail(`${path} was accepted`);
  };
  for (const [name, bytes, message] of [
    ['empty.png', Buffer.alloc(0), 'image size is invalid'],
    ['huge.png', Buffer.concat([png('huge'), Buffer.alloc(MAX_BUNDLE_IMAGE_BYTES)]), 'image size is invalid'],
    ['text.png', Buffer.from('not an image'), 'image format is invalid'],
  ] as const) {
    const error = refusal(write(name, bytes));
    assert.ok(error instanceof BundleImageError, name);
    assert.equal(error.message, message);
  }
  // A missing file keeps fs's own error, so each importer words it its own way.
  const missing = refusal(join(root, 'images', 'missing.png'));
  assert.equal(missing instanceof BundleImageError, false);
  assert.equal((missing as NodeJS.ErrnoException).code, 'ENOENT');
});

test('an entry\'s failure is reported as its message, or as the value thrown', () => {
  assert.equal(errorMessage(new Error('image size is invalid')), 'image size is invalid');
  assert.equal(errorMessage('plain text'), 'plain text');
  assert.equal(errorMessage(undefined), 'undefined');
});

test('loading the bundle helpers leaves the database alone, so a database-free importer can use them', () => {
  const dataDir = join(mkdtempSync(join(tmpdir(), 'dictprop-bundle-')), 'data');
  const { NODE_TEST_CONTEXT: _testContext, ...env } = process.env;
  const child = spawnSync(process.execPath, [
    '--import', 'tsx', '--input-type=module', '-e', "await import('./src/scripts/support/bundle.ts');",
  ], { cwd: SERVER_DIR, env: { ...env, DATA_DIR: dataDir }, encoding: 'utf8' });
  assert.equal(child.status, 0, child.stderr);
  assert.equal(existsSync(dataDir), false);
});
