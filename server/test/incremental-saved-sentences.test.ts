import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { collectIncompleteSavedSentences } from '../src/incremental-saved-sentences.js';

const waveScript = fileURLToPath(new URL(
  '../../scripts/offline/prepare-saved-sentence-analysis-wave.mjs',
  import.meta.url,
));
const reconcileScript = fileURLToPath(new URL(
  '../../scripts/offline/reconcile-sentence-analyses.mjs',
  import.meta.url,
));
const dispatchScript = fileURLToPath(new URL(
  '../../scripts/offline/dispatch-staged-saved-sentence-analyses.sh',
  import.meta.url,
));

const completeAnalysis = {
  translation: '它起作用了。',
  americanEnglish: {
    status: 'shared',
    explanation: 'Yes. This is natural in educated American English.',
    evidence: ['The simple wording is shared across major English varieties.'],
  },
  terms: [],
  pronunciation: {
    slowIpa: '/ɪt wɝkt/',
    fastIpa: '/ɪt wɝkt/',
    carefulSpeakerGuide: 'IT WORKED',
    fastSpeechFeatures: ['worked: the final consonant cluster is released lightly.'],
    intonationAndChunking: 'It worked ↘',
    keyDifference: 'Fast speech uses a lighter final release.',
  },
  grammar: {
    structure: 'A simple declarative clause with a subject and past-tense predicate.',
    points: [{
      label: 'Simple past',
      excerpt: 'worked',
      explanation: 'The simple past presents the result as a completed event.',
    }],
  },
  imagePrompt: 'A realistic photograph of a repaired machine operating successfully in natural light.',
};

test('saved-sentence discovery uses the complete analysis contract and notices text changes', () => {
  const changedOldHash = createHash('sha256').update('Old text.').digest('hex');
  const corpus = {
    version: 1,
    exportedAt: 50,
    items: [
      { type: 'sentence', data: { id: 'complete', text: 'It worked.', analysis: completeAnalysis } },
      { type: 'sentence', data: {
        id: 'legacy', text: 'Legacy.', analysis: { ...completeAnalysis, pronunciation: undefined },
      } },
      { type: 'sentence', data: { id: 'changed', text: 'New text.' } },
      { type: 'sentence', wasArchived: true, data: { id: 'archived', text: 'Skip me.' } },
      { type: 'vocab', data: { id: 'word', word: 'word' } },
    ],
  };
  const previous = {
    version: 1,
    sentences: [{ id: 'changed', textHash: changedOldHash }],
  };

  const source = collectIncompleteSavedSentences(corpus, previous, 100);
  assert.deepEqual(source.sentences.map(sentence => sentence.id), ['changed', 'legacy']);
  assert.deepEqual(source.stats, {
    corpusRecords: 5,
    savedSentences: 3,
    incompleteSentences: 2,
    newlyDiscovered: 1,
    changedSentences: 1,
  });
});

test('saved-sentence waves republish the same item id when its text hash changes', () => {
  const root = mkdtempSync(join(tmpdir(), 'dictprop-saved-incremental-'));
  try {
    const currentPath = join(root, 'current.json');
    const publishedPath = join(root, 'published.json');
    const waveDir = join(root, 'wave');
    const oldHash = 'a'.repeat(64);
    const newHash = 'b'.repeat(64);
    const entry = { id: 'same-id', textHash: newHash, analysis: completeAnalysis, generatedAt: 10 };
    writeFileSync(currentPath, JSON.stringify({ version: 1, generatedAt: 10, entries: [entry] }));
    writeFileSync(publishedPath, JSON.stringify({
      version: 1,
      generatedAt: 15,
      entries: [{ ...entry, textHash: oldHash }],
    }));

    const summary = JSON.parse(execFileSync(process.execPath, [
      waveScript, currentPath, waveDir, '100', publishedPath,
    ], { encoding: 'utf8' }));
    assert.equal(summary.waveEntries, 1);
    const wave = JSON.parse(readFileSync(join(waveDir, 'manifest.json'), 'utf8'));
    assert.equal(wave.entries[0].textHash, newHash);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('saved-sentence waves republish an analysis production lost after an older publication', () => {
  const root = mkdtempSync(join(tmpdir(), 'dictprop-saved-republish-'));
  try {
    const currentPath = join(root, 'current.json');
    const olderPath = join(root, 'older.json');
    const newerPath = join(root, 'newer.json');
    const waveDir = join(root, 'wave');
    const lost = { id: 'lost', textHash: 'a'.repeat(64), analysis: completeAnalysis, generatedAt: 10 };
    const kept = { id: 'kept', textHash: 'b'.repeat(64), analysis: completeAnalysis, generatedAt: 10 };
    writeFileSync(currentPath, JSON.stringify({ version: 1, generatedAt: 10, entries: [lost, kept] }));
    writeFileSync(olderPath, JSON.stringify({ version: 1, generatedAt: 5, entries: [lost] }));
    writeFileSync(newerPath, JSON.stringify({ version: 1, generatedAt: 15, entries: [kept] }));

    const summary = JSON.parse(execFileSync(process.execPath, [
      waveScript, currentPath, waveDir, '100', olderPath, newerPath,
    ], { encoding: 'utf8' }));
    assert.equal(summary.waveEntries, 1);
    const wave = JSON.parse(readFileSync(join(waveDir, 'manifest.json'), 'utf8'));
    assert.deepEqual(wave.entries.map((entry: { id: string }) => entry.id), ['lost']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('saved-sentence publication does not count a publication production has since lost', () => {
  const root = mkdtempSync(join(tmpdir(), 'dictprop-saved-dispatch-'));
  try {
    // The publisher resolves its helpers from the working directory; these stand in for the GitHub bridge.
    const offline = join(root, 'scripts', 'offline');
    const releases = join(root, 'releases.log');
    mkdirSync(offline, { recursive: true });
    mkdirSync(join(root, 'tmp'));
    symlinkSync(waveScript, join(offline, 'prepare-saved-sentence-analysis-wave.mjs'));
    writeFileSync(join(offline, 'wait-for-incremental-enrichment.sh'), '#!/bin/sh\nexit 0\n');
    writeFileSync(join(offline, 'publish-backfill-release.sh'), `#!/bin/sh\necho "$1" >> '${releases}'\n`);
    writeFileSync(join(root, 'gh'), '#!/bin/sh\nexit 0\n');
    for (const script of ['scripts/offline/wait-for-incremental-enrichment.sh', 'scripts/offline/publish-backfill-release.sh', 'gh']) {
      chmodSync(join(root, script), 0o700);
    }
    writeFileSync(join(root, 'key'), 'test-key\n');

    const lost = { id: 'lost', textHash: 'a'.repeat(64), analysis: completeAnalysis, generatedAt: 10 };
    const kept = { id: 'kept', textHash: 'b'.repeat(64), analysis: completeAnalysis, generatedAt: 10 };
    const analysisPath = join(root, 'analysis.json');
    writeFileSync(analysisPath, JSON.stringify({ version: 1, generatedAt: 10, entries: [lost, kept] }));
    // An older cycle published "lost" before production dropped it again; this cycle already published "kept".
    const state = join(root, 'state');
    const waves: Array<[string, number, typeof lost]> = [['wave-0001', 5, lost], ['wave-0002', 15, kept]];
    for (const [wave, generatedAt, entry] of waves) {
      mkdirSync(join(state, wave), { recursive: true });
      writeFileSync(join(state, wave, 'manifest.json'), JSON.stringify({ version: 1, generatedAt, entries: [entry] }));
      writeFileSync(join(state, wave, 'published'), 'published\n');
    }

    const output = execFileSync('bash', [dispatchScript, analysisPath, '100', 'test-sha'], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 30_000,
      env: {
        ...process.env,
        GH_BIN: join(root, 'gh'),
        SENTENCE_BRIDGE_KEY_FILE: join(root, 'key'),
        SAVED_SENTENCE_ANALYSIS_STATE_ROOT: state,
        SAVED_SENTENCE_ANALYSIS_COOLDOWN_SECONDS: '0',
        TMPDIR: join(root, 'tmp'),
      },
    });

    assert.match(output, /wave-0003 published \(1 analyses\)/);
    assert.match(output, /saved sentence analysis publication complete: 2\/2/);
    const wave = JSON.parse(readFileSync(join(state, 'wave-0003', 'manifest.json'), 'utf8'));
    assert.deepEqual(wave.entries.map((entry: { id: string }) => entry.id), ['lost']);
    assert.equal(readFileSync(releases, 'utf8').trim().split('\n').length, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('recurring reconciliation does not reuse a legacy incomplete analysis cache', () => {
  const root = mkdtempSync(join(tmpdir(), 'dictprop-saved-reconcile-'));
  try {
    const sourcePath = join(root, 'source.json');
    const cachePath = join(root, 'cache.json');
    const outputDir = join(root, 'output');
    const textHash = createHash('sha256').update('It worked.').digest('hex');
    writeFileSync(sourcePath, JSON.stringify({
      version: 1,
      sentences: [{ id: 'legacy', text: 'It worked.', textHash }],
    }));
    writeFileSync(cachePath, JSON.stringify({
      version: 1,
      generatedAt: 5,
      entries: [{
        id: 'legacy',
        textHash,
        generatedAt: 5,
        analysis: {
          translation: '它起作用了。',
          naturalSpeechIpa: '/ɪt wɝkt/',
          americanEnglish: { status: 'shared', explanation: 'Natural shared English.' },
          terms: [],
          grammar: completeAnalysis.grammar,
          imagePrompt: completeAnalysis.imagePrompt,
        },
      }],
    }));

    execFileSync(process.execPath, [reconcileScript, sourcePath, cachePath, outputDir]);
    const report = JSON.parse(readFileSync(join(outputDir, 'report.json'), 'utf8'));
    assert.equal(report.missing, 1);
    assert.equal(report.incompleteBase, 1);
    assert.equal(report.complete, false);

    writeFileSync(sourcePath, JSON.stringify({
      version: 1,
      sentences: [{ id: 'legacy', text: 'It worked.', textHash, hasAnalysis: true }],
    }));
    const coveredOutputDir = join(root, 'production-covered-output');
    execFileSync(process.execPath, [reconcileScript, sourcePath, cachePath, coveredOutputDir], {
      env: { ...process.env, ALLOW_PRODUCTION_COVERED_BASIC_ANALYSIS: '1' },
    });
    const coveredReport = JSON.parse(readFileSync(join(coveredOutputDir, 'report.json'), 'utf8'));
    assert.equal(coveredReport.reused, 1);
    assert.equal(coveredReport.missing, 0);
    assert.equal(coveredReport.complete, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function savedSentenceDispatchFixture(prefix: string) {
  const root = mkdtempSync(join(tmpdir(), prefix));
  const offline = join(root, 'scripts', 'offline');
  const releases = join(root, 'releases.log');
  const state = join(root, 'state');
  mkdirSync(offline, { recursive: true });
  mkdirSync(join(root, 'tmp'));
  symlinkSync(waveScript, join(offline, 'prepare-saved-sentence-analysis-wave.mjs'));
  writeFileSync(join(offline, 'wait-for-incremental-enrichment.sh'), '#!/bin/sh\nexit 0\n');
  // Like the real publisher, a transient failure leaves its state alone and a terminal one marks it failed.
  writeFileSync(join(offline, 'publish-backfill-release.sh'), `#!/bin/sh
echo "$1" >> '${releases}'
case "$FAKE_PUBLISH_MODE" in
  transient) exit 1 ;;
  fail) mkdir -p "$PUBLISH_STATE_DIR" && date > "$PUBLISH_STATE_DIR/failed"; exit 1 ;;
esac
`);
  writeFileSync(join(root, 'gh'), '#!/bin/sh\nexit "${FAKE_GH_STATUS:-0}"\n');
  for (const script of ['scripts/offline/wait-for-incremental-enrichment.sh', 'scripts/offline/publish-backfill-release.sh', 'gh']) {
    chmodSync(join(root, script), 0o700);
  }
  writeFileSync(join(root, 'key'), 'test-key\n');
  const analysisPath = join(root, 'analysis.json');
  writeFileSync(analysisPath, JSON.stringify({
    version: 1,
    generatedAt: 10,
    entries: [{ id: 'saved', textHash: 'c'.repeat(64), analysis: completeAnalysis, generatedAt: 10 }],
  }));
  const dispatch = (env: Record<string, string> = {}) => spawnSync('bash', [dispatchScript, analysisPath, '100', 'test-sha'], {
    cwd: root,
    encoding: 'utf8',
    timeout: 30_000,
    env: {
      ...process.env,
      FAKE_GH_STATUS: '0',
      FAKE_PUBLISH_MODE: '',
      GH_BIN: join(root, 'gh'),
      SENTENCE_BRIDGE_KEY_FILE: join(root, 'key'),
      SAVED_SENTENCE_ANALYSIS_STATE_ROOT: state,
      SAVED_SENTENCE_ANALYSIS_COOLDOWN_SECONDS: '0',
      TMPDIR: join(root, 'tmp'),
      ...env,
    },
  });
  const waves = () => readdirSync(state).filter(name => name.startsWith('wave-')).sort();
  return { root, releases, dispatch, waves };
}

test('saved-sentence publication sets a failed wave aside so the next run starts a fresh one', () => {
  const fixture = savedSentenceDispatchFixture('dictprop-saved-set-aside-');
  try {
    // A transient failure keeps the wave, and its release, for the next run.
    const transient = fixture.dispatch({ FAKE_PUBLISH_MODE: 'transient' });
    assert.equal(transient.status, 1, transient.stderr);
    assert.deepEqual(fixture.waves(), ['wave-0001']);

    const failed = fixture.dispatch({ FAKE_PUBLISH_MODE: 'fail' });
    assert.equal(failed.status, 1, failed.stderr);
    assert.match(failed.stdout,
      /publication of wave-0001 failed; set it aside as wave-0001\.failed so the next run starts a fresh wave/);
    assert.deepEqual(fixture.waves(), ['wave-0001.failed']);

    const failedAgain = fixture.dispatch({ FAKE_PUBLISH_MODE: 'fail' });
    assert.equal(failedAgain.status, 1, failedAgain.stderr);
    const [first, second, ...rest] = fixture.waves();
    assert.equal(first, 'wave-0001.failed');
    assert.match(second, /^wave-0001\.failed-\d{8}T\d{6}Z$/);
    assert.deepEqual(rest, []);

    const published = fixture.dispatch();
    assert.equal(published.status, 0, published.stderr);
    assert.match(published.stdout, /wave-0001 published \(1 analyses\)/);
    assert.match(published.stdout, /saved sentence analysis publication complete: 1\/1/);
    assert.equal(readFileSync(fixture.releases, 'utf8').trim().split('\n').length, 4);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('saved-sentence publication stops after its release-creation attempts', () => {
  const fixture = savedSentenceDispatchFixture('dictprop-saved-release-create-');
  try {
    const result = fixture.dispatch({ FAKE_GH_STATUS: '1', RELEASE_CREATE_ATTEMPTS: '1' });
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /GitHub release creation for wave-0001 failed 1 times; giving up for this run/);
    assert.equal(existsSync(fixture.releases), false);
    assert.deepEqual(fixture.waves(), ['wave-0001']);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});
