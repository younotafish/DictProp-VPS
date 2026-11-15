import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { writeJson } from '../support/fs.ts';
import { repoPath } from '../support/paths.ts';

const script = repoPath('scripts', 'offline', 'prepare-corpus-audit-wave.mjs');

interface CorpusEntry {
  id: string;
  type: 'vocab' | 'phrase' | 'sentence';
  data: { id: string; usageAudit?: { status: string } };
}

const entry = (id: string, type: CorpusEntry['type'], status?: string): CorpusEntry => ({
  id,
  type,
  data: { id, ...(status ? { usageAudit: { status } } : {}) },
});

function prepare(sourceManifest: unknown, args: string[] = [], published: unknown[] = []) {
  const root = mkdtempSync(join(tmpdir(), 'dictprop-corpus-wave-'));
  const sourcePath = join(root, 'source.json');
  const outputDir = join(root, 'wave');
  writeJson(sourcePath, sourceManifest);
  const publishedPaths = published.map((manifest, index) => {
    const path = join(root, `published-${index}.json`);
    writeJson(path, manifest);
    return path;
  });
  const child = spawnSync(process.execPath, [script, sourcePath, outputDir, ...args, ...publishedPaths], {
    encoding: 'utf8',
  });
  const manifestPath = join(outputDir, 'manifest.json');
  return {
    status: child.status,
    stderr: child.stderr,
    summary: child.status === 0 ? JSON.parse(child.stdout) : null,
    manifest: child.status === 0 ? JSON.parse(readFileSync(manifestPath, 'utf8')) : null,
    manifestPath,
  };
}

test('a corpus wave leaves out published ids and takes the most useful entries first, in source order within a rank', () => {
  const source = {
    version: 1,
    generatedAt: 123,
    model: 'completed vocabulary',
    entries: [
      entry('unknown', 'vocab', 'not_a_status'),
      entry('rare', 'vocab', 'rare_or_dated'),
      entry('published', 'vocab', 'modern_american'),
      entry('british', 'vocab', 'british_only'),
      entry('narrow', 'phrase', 'narrow_specialized'),
      entry('saved-sentence', 'sentence'),
      entry('general-1', 'vocab', 'current_general'),
      entry('unaudited', 'vocab'),
      entry('modern', 'phrase', 'modern_american'),
      entry('general-2', 'phrase', 'current_general'),
    ],
  };

  const result = prepare(source, ['500'], [{ version: 1, entries: [{ id: 'published' }] }]);

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.manifest.entries.map((value: CorpusEntry) => value.id), [
    'modern', 'general-1', 'general-2', 'saved-sentence', 'narrow', 'british', 'rare', 'unknown', 'unaudited',
  ]);
  assert.deepEqual(result.manifest.entries[0], source.entries[8]);
  assert.equal(result.manifest.version, 1);
  assert.equal(result.manifest.generatedAt, 123);
  assert.equal(result.manifest.model, 'completed vocabulary');
  assert.deepEqual(Object.keys(result.manifest), ['version', 'generatedAt', 'model', 'entries']);
  assert.deepEqual(result.summary, { sourceEntries: 10, previouslyPublished: 1, waveEntries: 9 });
  assert.equal(statSync(result.manifestPath).mode & 0o777, 0o600);
  assert.ok(readFileSync(result.manifestPath, 'utf8').endsWith('}\n'));
});

test('a corpus wave stops at its cap, which defaults to 500', () => {
  const entries = Array.from({ length: 502 }, (_, index) => entry(`card-${index}`, 'vocab', 'current_general'));

  const capped = prepare({ version: 1, generatedAt: 1, model: 'm', entries }, ['2']);
  assert.equal(capped.status, 0, capped.stderr);
  assert.deepEqual(capped.manifest.entries.map((value: CorpusEntry) => value.id), ['card-0', 'card-1']);

  const defaulted = prepare({ version: 1, generatedAt: 1, model: 'm', entries });
  assert.equal(defaulted.status, 0, defaulted.stderr);
  assert.equal(defaulted.manifest.entries.length, 500);
  assert.deepEqual(defaulted.summary, { sourceEntries: 502, previouslyPublished: 0, waveEntries: 500 });
});

test('a corpus wave refuses a bad cap, a duplicate or missing source id, and a malformed published manifest', () => {
  const source = { version: 1, generatedAt: 1, model: 'm', entries: [entry('card', 'vocab', 'current_general')] };
  for (const cap of ['0', '1001', '1.5', 'many']) {
    const result = prepare(source, [cap]);
    assert.notEqual(result.status, 0, `cap ${cap}`);
    assert.match(result.stderr, /max-entries must be an integer from 1 to 1000/);
  }

  const duplicate = prepare({ ...source, entries: [entry('card', 'vocab'), entry('card', 'phrase')] });
  assert.notEqual(duplicate.status, 0);
  assert.match(duplicate.stderr, /Source manifest has an invalid or duplicate id: card/);

  const unnamed = prepare({ ...source, entries: [{ type: 'vocab', data: {} }] });
  assert.notEqual(unnamed.status, 0);
  assert.match(unnamed.stderr, /Source manifest has an invalid or duplicate id: <empty>/);

  const empty = prepare({ ...source, entries: [] });
  assert.notEqual(empty.status, 0);
  assert.match(empty.stderr, /Source corpus audit manifest is invalid or empty/);

  const badPublished = prepare(source, ['10'], [{ version: 2, entries: [] }]);
  assert.notEqual(badPublished.status, 0);
  assert.match(badPublished.stderr, /Published corpus manifest is invalid: .*published-0\.json/);

  const badPublishedId = prepare(source, ['10'], [{ version: 1, entries: [{ id: '' }] }]);
  assert.notEqual(badPublishedId.status, 0);
  assert.match(badPublishedId.stderr, /Published manifest has an invalid id: .*published-0\.json/);
});
