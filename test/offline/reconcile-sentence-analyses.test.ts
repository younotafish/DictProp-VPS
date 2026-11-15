import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { isDetailedSentenceAnalysis, isSentenceAnalysis } from '../../scripts/offline/sentence-analysis-contract.mjs';
import { writeJson } from '../support/fs.ts';
import { repoPath } from '../support/paths.ts';

const script = repoPath('scripts', 'offline', 'reconcile-sentence-analyses.mjs');

const detailed = {
  translation: '这是一个例句。',
  naturalSpeechIpa: '/ðɪs ɪz ə tɛst/',
  grammar: { structure: 'A simple declarative clause.', points: [] },
  americanEnglish: {
    status: 'shared',
    explanation: 'Yes. This is natural in American English.',
    evidence: ['The wording is current and idiomatic.'],
  },
  terms: [],
  pronunciation: {
    slowIpa: '/ðɪs ɪz ə tɛst/',
    fastIpa: '/ðɪs ɪz ə tɛst/',
    carefulSpeakerGuide: 'this IS a TEST',
    fastSpeechFeatures: ['The article is reduced in fluent speech.'],
    intonationAndChunking: 'Use one thought group with a final fall.',
    keyDifference: 'Fluent speech reduces the unstressed article.',
  },
  imagePrompt: 'A photorealistic wide image of a student completing a short test at a desk, with no visible text.',
};
// Importable by the server, but missing the detail the cycle now requires.
const basic = {
  translation: '这是一个例句。',
  americanEnglish: { status: 'shared', explanation: 'Yes. This is natural in American English.' },
  terms: [],
  imagePrompt: 'A photorealistic wide image of a student completing a short test at a desk, with no visible text.',
};

interface Sentence { id: string; textHash: string; hasAnalysis?: boolean }
interface AnalysisEntry { id: string; textHash: string; analysis: unknown; generatedAt?: number }

const sentence = (id: string, extra: Partial<Sentence> = {}): Sentence => ({ id, textHash: `${id}-hash`, ...extra });
const entry = (id: string, analysis: unknown, textHash = `${id}-hash`): AnalysisEntry => ({
  id, textHash, analysis, generatedAt: 1,
});

function reconcile(
  source: unknown,
  base: unknown,
  supplemental?: unknown,
  env: Record<string, string> = {},
) {
  const root = mkdtempSync(join(tmpdir(), 'dictprop-reconcile-'));
  const sourcePath = join(root, 'source.json');
  const basePath = join(root, 'base.json');
  const outputDir = join(root, 'output');
  writeJson(sourcePath, source);
  writeJson(basePath, base);
  const args = [script, sourcePath, basePath, outputDir];
  if (supplemental !== undefined) {
    const supplementalPath = join(root, 'supplemental.json');
    writeJson(supplementalPath, supplemental);
    args.push(supplementalPath);
  }
  const child = spawnSync(process.execPath, args, { encoding: 'utf8', env: { ...process.env, ...env } });
  const read = (name: string) => JSON.parse(readFileSync(join(outputDir, name), 'utf8'));
  return { child, outputDir, read };
}

test('the fixtures are the shapes the contract names', () => {
  assert.equal(isDetailedSentenceAnalysis(detailed), true);
  assert.equal(isDetailedSentenceAnalysis(basic), false);
  assert.equal(isSentenceAnalysis(basic), true);
});

test('reconciliation reuses the base, then the supplement, and lists what is still missing', () => {
  const source = {
    version: 1,
    exportedAt: 10,
    sentences: [
      sentence('reused'),
      sentence('supplemented'),
      sentence('basic-in-base'),
      sentence('changed-text'),
      sentence('missing'),
    ],
  };
  const base = {
    version: 1,
    generatedAt: 20,
    entries: [
      entry('reused', detailed),
      entry('basic-in-base', basic),
      entry('changed-text', detailed, 'old-hash'),
      entry('retired', detailed),
    ],
  };

  const { child, read } = reconcile(source, base);

  assert.equal(child.status, 0, child.stderr);
  const report = read('report.json');
  assert.deepEqual(report, {
    sourceSentences: 5,
    reused: 1,
    supplemented: 0,
    missing: 4,
    staleBase: 2,
    staleSupplemental: 0,
    incompleteBase: 1,
    incompleteSupplemental: 0,
    complete: false,
  });
  assert.deepEqual(JSON.parse(child.stdout), report);
  const missing = read('missing-source.json');
  assert.equal(missing.version, 1);
  assert.deepEqual(missing.sentences, [
    sentence('supplemented'), sentence('basic-in-base'), sentence('changed-text'), sentence('missing'),
  ]);

  const withSupplement = reconcile(source, base, {
    version: 1,
    generatedAt: 30,
    entries: [entry('supplemented', detailed), entry('basic-in-base', detailed), entry('missing', basic)],
  });
  assert.equal(withSupplement.child.status, 1, 'an incomplete reconciliation with a supplement fails');
  assert.deepEqual(withSupplement.read('report.json'), {
    sourceSentences: 5,
    reused: 1,
    supplemented: 2,
    missing: 2,
    staleBase: 2,
    staleSupplemental: 0,
    incompleteBase: 1,
    incompleteSupplemental: 1,
    complete: false,
  });
});

test('a complete reconciliation writes final-analysis.json sorted by id', () => {
  const source = { version: 1, sentences: [sentence('b'), sentence('a'), sentence('c')] };
  const base = { version: 1, generatedAt: 20, entries: [entry('b', detailed), entry('stale', detailed)] };
  const supplemental = { version: 1, generatedAt: 30, entries: [entry('c', detailed), entry('a', detailed)] };

  const { child, read, outputDir } = reconcile(source, base, supplemental);

  assert.equal(child.status, 0, child.stderr);
  assert.equal(read('report.json').complete, true);
  const final = read('final-analysis.json');
  assert.equal(final.version, 1);
  assert.ok(final.generatedAt >= 30);
  assert.deepEqual(final.entries, [entry('a', detailed), entry('b', detailed), entry('c', detailed)]);
  assert.deepEqual(read('missing-source.json').sentences, []);
  assert.ok(existsSync(join(outputDir, 'report.json')));
});

test('a production-covered sentence may keep a basic analysis only when the cycle allows it', () => {
  const source = { version: 1, sentences: [sentence('covered', { hasAnalysis: true }), sentence('uncovered')] };
  const base = { version: 1, generatedAt: 20, entries: [entry('covered', basic), entry('uncovered', basic)] };

  const strict = reconcile(source, base);
  assert.equal(strict.read('report.json').missing, 2);

  const allowed = reconcile(source, base, undefined, { ALLOW_PRODUCTION_COVERED_BASIC_ANALYSIS: '1' });
  assert.deepEqual(allowed.read('report.json'), {
    sourceSentences: 2,
    reused: 1,
    supplemented: 0,
    missing: 1,
    staleBase: 0,
    staleSupplemental: 0,
    incompleteBase: 1,
    incompleteSupplemental: 0,
    complete: false,
  });
  assert.deepEqual(allowed.read('missing-source.json').sentences, [sentence('uncovered')]);
});

test('reconciliation refuses an empty source, a duplicate id and a malformed analysis manifest', () => {
  const base = { version: 1, entries: [] };
  assert.match(reconcile({ version: 1, sentences: [] }, base).child.stderr, /Final sentence source is invalid or empty/);
  assert.match(
    reconcile({ version: 1, sentences: [sentence('a'), sentence('a')] }, base).child.stderr,
    /Duplicate final sentence id: a/,
  );
  assert.match(reconcile({ version: 1, sentences: [sentence('a')] }, { version: 2 }).child.stderr, /base analysis manifest is invalid/);
  assert.match(
    reconcile({ version: 1, sentences: [sentence('a')] }, { version: 1, entries: [entry('a', detailed), entry('a', detailed)] })
      .child.stderr,
    /base analysis contains duplicate id: a/,
  );
});
