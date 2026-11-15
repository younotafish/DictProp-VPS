import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import test from 'node:test';
import { repoPath } from '../support/paths.ts';

const readJson = (relativePath: string) => JSON.parse(readFileSync(repoPath(relativePath), 'utf8'));

test('the client and the server schedule reviews with the same ts-fsrs', () => {
  // The device shows a review's new schedule at once and the server recomputes it, each from its own lockfile.
  // Two versions could round differently, and every review would then visibly jump after the next sync.
  const client = readJson('package-lock.json').packages['node_modules/ts-fsrs']?.version;
  const server = readJson('server/package-lock.json').packages['node_modules/ts-fsrs']?.version;
  assert.ok(client, 'package-lock.json locks ts-fsrs');
  assert.equal(server, client, 'server/package-lock.json locks the ts-fsrs version that package-lock.json does');
});

test('the wasm the Kokoro worker bundles belongs to the onnxruntime-web that transformers runs', () => {
  // services/kokoroWorker.ts imports ../node_modules/onnxruntime-web/dist/*.wasm by path (the package's exports
  // hide it), while transformers loads the onnxruntime-web it resolves itself. A nested copy of either package
  // would pair one version's JavaScript with another's wasm, and Kokoro would fail with an opaque wasm error.
  assert.equal(existsSync(repoPath('node_modules/@huggingface/transformers/node_modules/onnxruntime-web')), false);
  assert.equal(existsSync(repoPath('node_modules/kokoro-js/node_modules/@huggingface/transformers')), false);
  const transformers = readJson('node_modules/@huggingface/transformers/package.json');
  assert.equal(readJson('node_modules/onnxruntime-web/package.json').version, transformers.dependencies['onnxruntime-web']);
});
