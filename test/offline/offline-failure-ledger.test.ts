import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import {
  backoffMs,
  emptyLedger,
  imageTargetHash,
  isDeferred,
  prune,
  recordFailure,
  recordSuccess,
  updateLedger,
} from '../../scripts/offline/failure-ledger.mjs';

type LedgerEntry = {
  hash: string;
  failures: number;
  firstFailedAt: number;
  lastFailedAt: number;
  retryAfter: number;
  error: string;
};
type Ledger = { version: number; updatedAt: number; stages: Record<string, Record<string, LedgerEntry>> };

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const script = (name: string) => join(repoRoot, 'scripts', 'offline', name);
const HOUR = 60 * 60 * 1_000;
const DAY = 24 * HOUR;
const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');

const entry = (hash: string, retryAfter: number, lastFailedAt = retryAfter - HOUR): LedgerEntry => ({
  hash,
  failures: 1,
  firstFailedAt: lastFailedAt,
  lastFailedAt,
  retryAfter,
  error: 'earlier failure',
});

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function readJson(path: string): any {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function runLedger(args: string[]) {
  return spawnSync(process.execPath, [script('failure-ledger.mjs'), ...args], { encoding: 'utf8' });
}

test('failure backoff doubles from an hour and settles at one attempt a week', () => {
  assert.equal(backoffMs(1), HOUR);
  assert.equal(backoffMs(2), 2 * HOUR);
  assert.equal(backoffMs(4), 8 * HOUR);
  assert.equal(backoffMs(8), 128 * HOUR);
  assert.equal(backoffMs(9), 7 * DAY);
  assert.equal(backoffMs(500), 7 * DAY);
});

test('a repeated failure counts up, and changed content starts the count over', () => {
  const ledger = emptyLedger() as Ledger;
  assert.deepEqual(recordFailure(ledger, 'vocab', 'poison', 'hash-a', 'first error', 1_000), {
    hash: 'hash-a',
    failures: 1,
    firstFailedAt: 1_000,
    lastFailedAt: 1_000,
    retryAfter: 1_000 + HOUR,
    error: 'first error',
  });
  const repeated = recordFailure(ledger, 'vocab', 'poison', 'hash-a', 'x'.repeat(600), 5_000);
  assert.equal(repeated.failures, 2);
  assert.equal(repeated.firstFailedAt, 1_000);
  assert.equal(repeated.retryAfter, 5_000 + 2 * HOUR);
  assert.equal(repeated.error.length, 500);
  const edited = recordFailure(ledger, 'vocab', 'poison', 'hash-b', 'edited error', 9_000);
  assert.equal(edited.failures, 1);
  assert.equal(edited.firstFailedAt, 9_000);
});

test('an item is deferred only while its backoff runs and its content is unchanged', () => {
  const waiting = entry('hash-a', 10_000);
  assert.equal(isDeferred(waiting, 'hash-a', 9_999), true);
  assert.equal(isDeferred(waiting, 'hash-a', 10_000), false);
  assert.equal(isDeferred(waiting, 'hash-b', 9_999), false);
  assert.equal(isDeferred(undefined, 'hash-a', 0), false);
});

test('a success clears the entry and drops a stage with no failures left', () => {
  const ledger = emptyLedger() as Ledger;
  recordFailure(ledger, 'vocab', 'one', 'a', 'error', 0);
  recordFailure(ledger, 'vocab', 'two', 'b', 'error', 0);
  recordSuccess(ledger, 'vocab', 'one');
  assert.deepEqual(Object.keys(ledger.stages.vocab), ['two']);
  recordSuccess(ledger, 'vocab', 'two');
  assert.deepEqual(ledger.stages, {});
  recordSuccess(ledger, 'item-image', 'never-failed');
  assert.deepEqual(ledger.stages, {});
});

test('pruning forgets items that stopped failing a month ago', () => {
  const now = 100 * DAY;
  const ledger = emptyLedger() as Ledger;
  ledger.stages.vocab = {
    recent: entry('a', now - 22 * DAY, now - 29 * DAY),
    abandoned: entry('b', now - 24 * DAY, now - 31 * DAY),
  };
  ledger.stages['item-image'] = { gone: entry('c', now - 53 * DAY, now - 60 * DAY) };
  prune(ledger, now);
  assert.deepEqual(Object.keys(ledger.stages), ['vocab']);
  assert.deepEqual(Object.keys(ledger.stages.vocab), ['recent']);
});

test('ledger updates create a private versioned file without leaving a temporary one', () => {
  const root = mkdtempSync(join(tmpdir(), 'dictprop-ledger-update-'));
  try {
    const ledgerPath = join(root, 'cycle', 'failures.json');
    updateLedger(ledgerPath, (ledger: Ledger) => {
      recordFailure(ledger, 'vocab', 'one', 'a', 'error', 5_000);
    }, 5_000);
    const written = readJson(ledgerPath);
    assert.equal(written.version, 1);
    assert.equal(written.updatedAt, 5_000);
    assert.equal(written.stages.vocab.one.failures, 1);
    assert.equal(statSync(ledgerPath).mode & 0o777, 0o600);
    assert.deepEqual(readdirSync(join(root, 'cycle')), ['failures.json']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a damaged ledger is reported and replaced instead of stopping the cycle', () => {
  const root = mkdtempSync(join(tmpdir(), 'dictprop-ledger-damaged-'));
  try {
    const ledgerPath = join(root, 'failures.json');
    writeFileSync(ledgerPath, '{not json');
    const summary = runLedger(['summary', ledgerPath]);
    assert.equal(summary.status, 0, summary.stderr);
    assert.equal(summary.stdout, '');
    assert.match(summary.stderr, /Ignoring unreadable failure ledger/);

    writeJson(ledgerPath, { version: 2, stages: {} });
    const targetsPath = join(root, 'targets.json');
    const images = join(root, 'images');
    mkdirSync(images);
    writeJson(targetsPath, { version: 1, targets: [{ imageId: 'missing', filename: 'missing.webp', prompt: 'A harbor.' }] });
    const record = runLedger(['record-image-outcomes', ledgerPath, 'item-image', targetsPath, images, '0']);
    assert.equal(record.status, 0, record.stderr);
    assert.match(record.stderr, /Ignoring unreadable failure ledger .*unsupported ledger format/);
    const rewritten = readJson(ledgerPath);
    assert.equal(rewritten.version, 1);
    assert.equal(rewritten.stages['item-image'].missing.failures, 1);
    assert.deepEqual(readdirSync(root).filter(name => name.endsWith('.tmp')), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('sentence filtering skips only unchanged sentences whose backoff is still running', () => {
  const root = mkdtempSync(join(tmpdir(), 'dictprop-ledger-sentences-'));
  try {
    const now = Date.now();
    const ledgerPath = join(root, 'failures.json');
    const sourcePath = join(root, 'source.json');
    const outputPath = join(root, 'filtered.json');
    writeJson(ledgerPath, {
      version: 1,
      updatedAt: now,
      stages: {
        'example-sentence': {
          deferred: entry('deferred-hash', now + DAY),
          edited: entry('edited-old-hash', now + DAY),
          expired: entry('expired-hash', now - 1_000),
        },
        'saved-sentence': { 'other-stage': entry('other-hash', now + DAY) },
      },
    });
    const sentences = [
      { id: 'deferred', text: 'Deferred sentence.', textHash: 'deferred-hash', sourceWord: 'defer' },
      { id: 'edited', text: 'Edited sentence.', textHash: 'edited-new-hash', sourceWord: 'edit' },
      { id: 'expired', text: 'Expired sentence.', textHash: 'expired-hash', sourceWord: 'expire' },
      { id: 'other-stage', text: 'Another stage failed this.', textHash: 'other-hash', sourceWord: 'other' },
    ];
    writeJson(sourcePath, { version: 1, exportedAt: 12_345, sentences });

    const result = runLedger(['filter-sentences', ledgerPath, 'example-sentence', sourcePath, outputPath]);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, '3\n');
    assert.match(result.stderr, /Skipping 1 sentence\(s\) in failure backoff \(example-sentence\)/);
    const filtered = readJson(outputPath);
    assert.equal(filtered.exportedAt, 12_345);
    assert.deepEqual(filtered.sentences, sentences.slice(1));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('image filtering treats a reworded prompt as a new image', () => {
  const root = mkdtempSync(join(tmpdir(), 'dictprop-ledger-images-'));
  try {
    const now = Date.now();
    const ledgerPath = join(root, 'failures.json');
    const targetsPath = join(root, 'targets.json');
    const outputPath = join(root, 'filtered.json');
    const learningTarget = { kind: 'word sense', text: 'harbor', sense: 'noun: a sheltered port', definition: '' };
    const targets = [
      { imageId: 'same', filename: 'same.webp', prompt: '  A calm harbor at dawn.  ', learningTarget },
      { imageId: 'reworded', filename: 'reworded.webp', prompt: 'A busy harbor at noon.', learningTarget },
    ];
    writeJson(ledgerPath, {
      version: 1,
      updatedAt: now,
      stages: {
        'example-image': {
          same: entry(imageTargetHash({ prompt: 'A calm harbor at dawn.', learningTarget }), now + DAY),
          reworded: entry(imageTargetHash({ prompt: 'A quiet harbor at dusk.', learningTarget }), now + DAY),
        },
      },
    });
    writeJson(targetsPath, { version: 1, generatedAt: 7, targets });

    const result = runLedger(['filter-image-targets', ledgerPath, 'example-image', targetsPath, outputPath]);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, '1\n');
    assert.match(result.stderr, /Skipping 1 image\(s\) in failure backoff \(example-image\)/);
    assert.deepEqual(readJson(outputPath), { version: 1, generatedAt: 7, targets: [targets[1]] });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('image outcomes clear accepted images and defer missing ones only after the loop finished', () => {
  const root = mkdtempSync(join(tmpdir(), 'dictprop-ledger-outcomes-'));
  try {
    const ledgerPath = join(root, 'failures.json');
    const targetsPath = join(root, 'targets.json');
    const images = join(root, 'images');
    mkdirSync(images);
    const targets = [
      { imageId: 'accepted', filename: 'accepted.webp', prompt: 'A lighthouse in fog.' },
      { imageId: 'missing', filename: 'missing.webp', prompt: 'A cricket bowler mid-delivery.' },
    ];
    writeJson(targetsPath, { version: 1, targets });
    writeJson(ledgerPath, {
      version: 1,
      updatedAt: Date.now(),
      stages: { 'item-image': { accepted: entry(imageTargetHash(targets[0]), Date.now() + DAY) } },
    });
    writeFileSync(join(images, 'accepted.webp'), 'image');
    const record = (loopStatus: string) => {
      const result = runLedger(['record-image-outcomes', ledgerPath, 'item-image', targetsPath, images, loopStatus]);
      assert.equal(result.status, 0, result.stderr);
      return result.stderr;
    };

    // After a timeout a missing image may simply not have had its turn, so it is not held against it.
    assert.match(record('124'), /accepted=1, deferred=0/);
    assert.deepEqual(readJson(ledgerPath).stages, {});

    record('0');
    assert.match(record('0'), /accepted=1, deferred=1/);
    const missing = readJson(ledgerPath).stages['item-image'].missing;
    assert.equal(missing.failures, 2);
    assert.equal(missing.hash, imageTargetHash(targets[1]));
    const summary = runLedger(['summary', ledgerPath]);
    assert.match(summary.stdout,
      /^item-image: 1 failing item\(s\), 1 in backoff \(next retry \d{4}-\d\d-\d\dT[\d:.]+Z\), most failures 2\n$/);

    writeFileSync(join(images, 'missing.webp'), 'image');
    assert.match(record('0'), /accepted=2, deferred=0/);
    assert.deepEqual(readJson(ledgerPath).stages, {});
    assert.equal(runLedger(['summary', ledgerPath]).stdout, '');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// Fails any batch of more than one sentence and any sentence that "always fails", like a model that
// cannot handle one item and takes its batch down with it.
const fakeSentenceModel = `#!/usr/bin/env node
import { writeFileSync } from 'node:fs';
let prompt = '';
process.stdin.on('data', chunk => { prompt += chunk; });
process.stdin.on('end', () => {
  const marker = 'ANALYZE THESE SENTENCES:\\n';
  const items = JSON.parse(prompt.slice(prompt.lastIndexOf(marker) + marker.length));
  if (items.length > 1 || items[0].text.includes('always fails')) {
    process.stderr.write('deliberate fake provider failure\\n');
    process.exitCode = 1;
    return;
  }
  const results = items.map(item => ({
    itemIndex: item.itemIndex,
    analysis: {
      translation: 'A precise translation.',
      americanEnglish: {
        status: 'shared',
        explanation: 'Yes. This sentence is natural in educated American English.',
        evidence: ['Its vocabulary and grammar are shared across major English varieties.'],
      },
      terms: [],
      pronunciation: {
        slowIpa: '/ɪt wɝkt/',
        fastIpa: '/ɪt wɝkt/',
        carefulSpeakerGuide: 'IT WORKED',
        fastSpeechFeatures: ['worked has a lightly released final consonant cluster.'],
        intonationAndChunking: 'It worked ↘',
        keyDifference: 'Fluent speech uses a lighter final release than careful speech.',
      },
      grammar: {
        structure: 'A simple declarative clause.',
        points: [{ label: 'Clause', excerpt: item.text.split(' ')[0], explanation: 'This begins the clause.' }],
      },
      imagePrompt: 'A realistic photograph of the described event in natural light, with no visible text.',
    },
  }));
  writeFileSync(process.argv[process.argv.indexOf('-o') + 1], JSON.stringify({ results }));
});
`;

test('sentence analysis defers a sentence the model cannot analyze and publishes the rest', () => {
  const root = mkdtempSync(join(tmpdir(), 'dictprop-ledger-sentence-stage-'));
  try {
    const fakeModel = join(root, 'fake-codex.mjs');
    const ledgerPath = join(root, 'failures.json');
    writeFileSync(fakeModel, fakeSentenceModel);
    chmodSync(fakeModel, 0o700);
    const sentence = (id: string, text: string) => ({ id, text, sourceWord: id, textHash: sha256(text) });
    const env = {
      ...process.env,
      ENRICHMENT_MODEL_PROVIDER: 'codex',
      CODEX_BIN: fakeModel,
      CODEX_MODEL: 'gpt-5.6-sol',
      CODEX_CONCURRENCY: '1',
      CODEX_RETRY_DELAY_MS: '0',
      SENTENCE_ANALYSIS_BATCH_SIZE: '3',
      ENRICHMENT_FAILURE_LEDGER: ledgerPath,
      ENRICHMENT_FAILURE_STAGE: 'example-sentence',
    };
    const analyze = (name: string, sentences: ReturnType<typeof sentence>[]) => {
      const sourcePath = join(root, `${name}-source.json`);
      writeJson(sourcePath, { version: 1, sentences });
      const outputPath = join(root, `${name}-analysis.json`);
      const workDir = join(root, `${name}-work`);
      const result = spawnSync(process.execPath, [script('enrich-sentences.mjs'), sourcePath, outputPath, workDir], {
        encoding: 'utf8',
        env,
      });
      return { result, outputPath, workDir };
    };

    const first = analyze('first', [
      sentence('one', 'First works.'),
      sentence('two', 'Second works.'),
      sentence('three', 'This always fails.'),
    ]);
    assert.equal(first.result.status, 0, first.result.stderr);
    assert.deepEqual(readJson(first.outputPath).entries.map((value: { id: string }) => value.id).sort(), ['one', 'two']);
    assert.equal(readJson(join(first.workDir, 'progress.json')).status, 'partial');
    assert.match(first.result.stderr, /1 sentence\(s\) deferred to a later cycle/);
    const recorded = readJson(ledgerPath).stages['example-sentence'];
    assert.deepEqual(Object.keys(recorded), ['three']);
    assert.equal(recorded.three.failures, 1);
    assert.equal(recorded.three.hash, sha256('This always fails.'));

    // A run in which nothing succeeds says so with its own exit status and publishes nothing.
    const second = analyze('second', [sentence('three', 'This always fails.')]);
    assert.equal(second.result.status, 3, second.result.stderr);
    assert.match(second.result.stderr, /No sentence analysis succeeded/);
    assert.equal(existsSync(second.outputPath), false);
    assert.equal(readJson(ledgerPath).stages['example-sentence'].three.failures, 2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

const completeCard = (id: string) => ({
  id,
  word: id,
  sense: 'noun: an illustrative instance',
  chinese: '例子',
  ipa: '/ˈsæmpəl/',
  definition: 'One item used to illustrate a larger group or idea.',
  forms: ['sample', 'samples'],
  wordFamily: [],
  history: 'From Old French essample, ultimately from Latin exemplum.',
  register: 'Common in present-day American English.',
  mnemonic: 'A sample lets you see a small part of the whole.',
  imagePrompt: 'A photorealistic close view of one sample jar selected from a larger organized collection.',
  synonyms: ['example'],
  antonyms: [],
  confusables: [],
  examples: [
    'She brought a {{sample}} home before choosing the paint color.',
    'The lab tested a {{sample}} from each shipment.',
  ],
  usageAudit: {
    status: 'current_general',
    reason: 'This is current general English.',
    confidence: 'high',
    auditedAt: 1,
  },
});

// Completes every card except the headword "poison", whose batch always fails.
const fakeCompletionModel = `#!/usr/bin/env node
import { writeFileSync } from 'node:fs';
let prompt = '';
process.stdin.on('data', chunk => { prompt += chunk; });
process.stdin.on('end', () => {
  const marker = 'COMPLETE THESE CARDS:\\n';
  const items = JSON.parse(prompt.slice(prompt.lastIndexOf(marker) + marker.length));
  if (items.some(item => item.word === 'poison')) {
    process.stderr.write('deliberate fake provider failure\\n');
    process.exitCode = 1;
    return;
  }
  const results = items.map(item => ({
    itemIndex: item.itemIndex,
    sense: item.sense,
    chinese: '本地高级版本',
    ipa: '/ˈsæmpəl/',
    definition: 'A locally generated advanced definition for this exact sense.',
    forms: ['sample', 'samples'],
    wordFamily: [{ word: 'sampling', pos: 'noun', chinese: '抽样' }],
    synonyms: ['example'],
    antonyms: [],
    confusables: ['simple'],
    examples: [
      'I tested a {{sample}} before ordering the full batch.',
      'The lab kept a {{sample}} from every shipment.',
    ],
    history: 'The word developed through Old French from Latin exemplum, meaning an example.',
    register: 'Common in present-day American English across everyday and technical settings.',
    mnemonic: 'A sample is a small example of the whole.',
    imagePrompt: 'A realistic close photograph of one sample jar beside a larger organized collection, natural light, no text.',
    usageAudit: {
      status: 'current_general',
      reason: 'This exact sense is common in modern American English.',
      confidence: 'high',
    },
  }));
  writeFileSync(process.argv[process.argv.indexOf('-o') + 1], JSON.stringify({ results }));
});
`;

test('vocabulary completion splits a failing batch and defers only the card that fails alone', () => {
  const root = mkdtempSync(join(tmpdir(), 'dictprop-ledger-vocab-stage-'));
  try {
    const fakeModel = join(root, 'fake-codex.mjs');
    const ledgerPath = join(root, 'failures.json');
    writeFileSync(fakeModel, fakeCompletionModel);
    chmodSync(fakeModel, 0o700);
    const env = {
      ...process.env,
      ENRICHMENT_MODEL_PROVIDER: 'codex',
      CODEX_BIN: fakeModel,
      CODEX_MODEL: 'gpt-5.6-sol',
      CODEX_CONCURRENCY: '1',
      CODEX_RETRY_DELAY_MS: '0',
      VOCAB_COMPLETION_BATCH_SIZE: '3',
      ENRICHMENT_FAILURE_LEDGER: ledgerPath,
    };
    const complete = (name: string, ids: string[]) => {
      const sourcePath = join(root, `${name}-source.json`);
      writeJson(sourcePath, {
        version: 1,
        generatedAt: 1,
        model: 'Test source',
        entries: ids.map(id => ({ id, type: 'vocab', sourceHash: `source-${id}`, data: completeCard(id) })),
      });
      const outputPath = join(root, name, 'completed.json');
      const workDir = join(root, `${name}-work`);
      const result = spawnSync(process.execPath, [script('complete-corpus-fields.mjs'), sourcePath, outputPath, workDir], {
        encoding: 'utf8',
        env,
      });
      return { result, outputPath, workDir };
    };

    const first = complete('first', ['alpha', 'beta', 'poison']);
    assert.equal(first.result.status, 0, first.result.stderr);
    assert.deepEqual(readJson(first.outputPath).entries.map((value: { id: string }) => value.id), ['alpha', 'beta']);
    assert.match(first.result.stderr, /Card poison of poison failed on its own/);
    assert.match(first.result.stderr, /1 item\(s\) deferred to a later cycle/);
    assert.deepEqual(readJson(join(first.workDir, 'failures.json')).failures.map((value: { id: string }) => value.id),
      ['poison']);
    assert.ok(readdirSync(first.workDir).some(name => /^split-0001-[0-9a-f]{16}\.json$/.test(name)));
    const recorded = readJson(ledgerPath).stages.vocab;
    assert.deepEqual(Object.keys(recorded), ['poison']);
    assert.equal(recorded.poison.hash, 'source-poison');
    assert.equal(recorded.poison.failures, 1);

    const second = complete('second', ['poison']);
    assert.equal(second.result.status, 3, second.result.stderr);
    assert.match(second.result.stderr, /No vocabulary item was completed/);
    assert.equal(existsSync(second.outputPath), false);
    assert.equal(readJson(ledgerPath).stages.vocab.poison.failures, 2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('vocabulary selection skips a deferred item until its content changes', () => {
  const root = mkdtempSync(join(tmpdir(), 'dictprop-ledger-vocab-select-'));
  try {
    const now = Date.now();
    const ledgerPath = join(root, 'failures.json');
    const corpusPath = join(root, 'corpus.json');
    const outputPath = join(root, 'source.json');
    const item = (id: string, sourceHash: string, word = id) => ({
      type: 'vocab',
      savedAt: now,
      sourceHash,
      data: { ...completeCard(id), word },
    });
    writeJson(corpusPath, {
      version: 1,
      items: [
        item('poison', 'poison-v1'),
        item('edited', 'edited-v2'),
        item('headless', 'headless-v1', ''),
        item('fresh', 'fresh-v1'),
      ],
    });
    writeJson(ledgerPath, {
      version: 1,
      updatedAt: now,
      stages: { vocab: { poison: entry('poison-v1', now + DAY), edited: entry('edited-v1', now + DAY) } },
    });

    const result = spawnSync(process.execPath, [script('prepare-incremental-vocab-source.mjs'), corpusPath, outputPath, '8', '168'], {
      encoding: 'utf8',
      env: { ...process.env, ENRICHMENT_FAILURE_LEDGER: ledgerPath },
    });
    assert.equal(result.status, 0, result.stderr);
    const summary = JSON.parse(result.stdout);
    assert.equal(summary.deferred, 1);
    assert.equal(summary.missingHeadword, 1);
    assert.equal(summary.selected, 2);
    assert.deepEqual(readJson(outputPath).entries.map((value: { id: string }) => value.id), ['edited', 'fresh']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
