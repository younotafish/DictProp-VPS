import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test, { after, before } from 'node:test';
import sharp from 'sharp';
import { sha256, writeExecutable, writeJson } from '../support/fs.ts';
import { repoPath } from '../support/paths.ts';

// Runs each real wave dispatcher in a scratch working directory. The wave preparers and the publisher,
// which the dispatchers resolve from the working directory, are stood in for: the preparer takes the next
// unpublished entries from wave-pool.json, and the publisher records its call and checks that the archive
// decrypts for its own import and release only. The GitHub CLI is a fake that records every call.

const DEPLOY_SHA = 'c0ffee'.repeat(6) + 'c0ff';

// Where each preparer finds its wave directory, batch size and source files, and the key a published
// manifest excludes.
const PREPARE_STUB = `import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

const layouts = {
  'prepare-corpus-audit-wave.mjs': { wave: 1, batch: 2, key: 'id' },
  'prepare-example-analysis-wave.mjs': { wave: 2, batch: 3, key: 'id' },
  'prepare-saved-sentence-analysis-wave.mjs': { wave: 1, batch: 2, key: 'id' },
  'prepare-example-enrichment-wave.mjs': { wave: 3, batch: 4, key: 'id', files: 2 },
  'prepare-offline-image-wave.mjs': { wave: 1, batch: 2, key: 'imageId', files: 0 },
  'prepare-offline-audio-wave.mjs': { wave: 1, batch: 2, key: 'key', files: 0 },
};
if (process.env.FAKE_PREPARE === 'fail') {
  console.error('preparer failed');
  process.exit(3);
}
const layout = layouts[basename(process.argv[1])];
const args = process.argv.slice(2);
const published = new Set(args.slice(layout.batch + 1)
  .flatMap(path => JSON.parse(readFileSync(path, 'utf8')).entries.map(entry => entry[layout.key])));
const pool = JSON.parse(readFileSync('wave-pool.json', 'utf8'));
const selected = pool.filter(entry => !published.has(entry[layout.key])).slice(0, Number(args[layout.batch]));
const waveDir = args[layout.wave];
mkdirSync(waveDir, { recursive: true });
for (const entry of selected) {
  for (const file of [entry.imageFile, entry.audioFile].filter(Boolean)) {
    mkdirSync(join(waveDir, dirname(file)), { recursive: true });
    copyFileSync(join(args[layout.files], file), join(waveDir, file));
  }
}
writeFileSync(join(waveDir, 'manifest.json'), JSON.stringify({ version: 1, generatedAt: Date.now(), entries: selected }));
console.log(JSON.stringify({ waveEntries: selected.length }));
`;

// Records the call and the archive's contents, decrypted for this import and release only.
const PUBLISHER_STUB = `#!/bin/bash
set -euo pipefail
bundle="$(mktemp -d)/bundle.tar.gz"
node "$BRIDGE_CRYPTO" decrypt --key-file "$TEST_KEY_FILE" --purpose "import:$4:$1" --in "$2" --out "$bundle"
printf '%s %s %s %s %s %s state=%s files=%s\\n' "$1" "$2" "$3" "$4" "$5" "$6" "\${PUBLISH_STATE_DIR:-}" \\
  "$(tar -tzf "$bundle" | grep -v '/$' | sort | paste -sd , -)" >> "$PUBLISH_LOG"
case "\${FAKE_PUBLISH:-}" in
  fail) mkdir -p "$PUBLISH_STATE_DIR"; date > "$PUBLISH_STATE_DIR/failed"; exit 1 ;;
esac
`;

const GH_STUB = `#!/bin/bash
printf '%s\\n' "$*" >> "$GH_LOG"
case "$1 $2" in
  "release view") exit 1 ;;
  "release create") exit "\${FAKE_RELEASE_CREATE_STATUS:-0}" ;;
esac
exit 0
`;

const webp = (width: number, height: number) =>
  sharp({ create: { width, height, channels: 3, background: { r: 40, g: 90, b: 160 } } }).webp().toBuffer();

const writeFile = (path: string, value: unknown) => {
  mkdirSync(dirname(path), { recursive: true });
  writeJson(path, value);
};

interface Run {
  dispatcher: string;
  args: string[];
  env?: Record<string, string>;
  // Builds the inputs inside the working directory and returns the entries the preparer can offer.
  inputs: (cwd: string) => Promise<unknown[]> | unknown[];
}

async function dispatch(root: string, name: string, run: Run) {
  const cwd = join(root, name);
  const offline = join(cwd, 'scripts', 'offline');
  mkdirSync(offline, { recursive: true });
  for (const preparer of [
    'prepare-corpus-audit-wave.mjs', 'prepare-example-analysis-wave.mjs', 'prepare-saved-sentence-analysis-wave.mjs',
    'prepare-example-enrichment-wave.mjs', 'prepare-offline-image-wave.mjs', 'prepare-offline-audio-wave.mjs',
  ]) writeFileSync(join(offline, preparer), PREPARE_STUB);
  writeExecutable(join(offline, 'publish-backfill-release.sh'), PUBLISHER_STUB);
  writeExecutable(join(offline, 'wait-for-incremental-enrichment.sh'), '#!/bin/sh\nexit 0\n');
  writeExecutable(join(cwd, 'gh'), GH_STUB);
  // The cycle runs the dispatchers from the repository root, where the image check finds sharp.
  symlinkSync(repoPath('node_modules'), join(cwd, 'node_modules'));
  writeFileSync(join(cwd, 'key'), 'dispatcher-test-key\n');
  writeFile(join(cwd, 'wave-pool.json'), await run.inputs(cwd));
  const publishLog = join(cwd, 'publish.log');
  const ghLog = join(cwd, 'gh.log');
  const child = spawn('bash', [repoPath('scripts', 'offline', run.dispatcher), ...run.args], {
    cwd,
    env: {
      ...process.env,
      GH_BIN: join(cwd, 'gh'),
      GITHUB_REPOSITORY: 'test-owner/test-repo',
      SENTENCE_BRIDGE_KEY_FILE: join(cwd, 'key'),
      TEST_KEY_FILE: join(cwd, 'key'),
      BRIDGE_CRYPTO: repoPath('scripts', 'offline', 'bridge-crypto.mjs'),
      PUBLISH_LOG: publishLog,
      GH_LOG: ghLog,
      TMPDIR: join(cwd, 'tmp'),
      ...run.env,
    },
  });
  mkdirSync(join(cwd, 'tmp'));
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });
  const status = await new Promise<number | null>(resolvePromise => child.on('close', code => resolvePromise(code)));
  const normalize = (text: string) => text
    .replaceAll(realpathSync(cwd), '<cwd>')
    .replaceAll(cwd, '<cwd>')
    .replace(/\d{8}T\d{6}Z/g, '<stamp>')
    .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z/g, '<time>');
  const lines = (path: string) => existsSync(path) ? normalize(readFileSync(path, 'utf8')).split('\n').filter(Boolean) : [];
  return {
    cwd,
    status,
    stdout: normalize(stdout).split('\n').filter(Boolean).map(line => line.replace(/^\[<time>\] /, '')),
    stderr: normalize(stderr),
    published: lines(publishLog),
    gh: lines(ghLog),
  };
}

type Result = Awaited<ReturnType<typeof dispatch>>;

const imageId = (id: string) => `${sha256(id).slice(0, 32)}.webp`;

const RUNS: Record<string, Run> = {
  corpus: {
    dispatcher: 'dispatch-staged-corpus-audit.sh',
    args: ['source.json', '2', DEPLOY_SHA],
    env: { CORPUS_AUDIT_WAVE_STATE_ROOT: 'state', CORPUS_AUDIT_WAVE_COOLDOWN_SECONDS: '0' },
    inputs: cwd => {
      const entries = ['c1', 'c2', 'c3'].map(id => ({ id }));
      writeFile(join(cwd, 'source.json'), { entries });
      return entries;
    },
  },
  analyses: {
    dispatcher: 'dispatch-staged-example-analyses.sh',
    args: ['pool', '1', DEPLOY_SHA],
    env: { EXAMPLE_ANALYSIS_WAVE_STATE_ROOT: 'state', EXAMPLE_ANALYSIS_WAVE_COOLDOWN_SECONDS: '0' },
    inputs: cwd => {
      writeFile(join(cwd, 'pool', 'source.json'), {
        exportedAt: 1,
        sentences: [{ id: 'e1' }, { id: 'e2' }, { id: 'e3', hasAnalysis: true }],
      });
      writeFile(join(cwd, 'pool', 'final-reconciliation', 'final-analysis.json'), { entries: [] });
      return [{ id: 'e1' }, { id: 'e2' }];
    },
  },
  saved: {
    dispatcher: 'dispatch-staged-saved-sentence-analyses.sh',
    args: ['analysis.json', '5000', DEPLOY_SHA],
    env: { SAVED_SENTENCE_ANALYSIS_STATE_ROOT: 'state', SAVED_SENTENCE_ANALYSIS_COOLDOWN_SECONDS: '0' },
    inputs: cwd => {
      const entries = [{ id: 's1', textHash: 'a'.repeat(64) }, { id: 's2', textHash: 'b'.repeat(64) }];
      writeFile(join(cwd, 'analysis.json'), { generatedAt: 1, entries });
      return entries;
    },
  },
  enrichments: {
    dispatcher: 'dispatch-staged-example-enrichments.sh',
    args: ['pool', '1', DEPLOY_SHA],
    env: {
      ALLOW_DEFERRED_IMAGES: '1',
      EXAMPLE_ENRICHMENT_WAVE_STATE_ROOT: 'state',
      EXAMPLE_ENRICHMENT_WAVE_COOLDOWN_SECONDS: '0',
    },
    inputs: async cwd => {
      const sentences = ['x1', 'x2'].map(id => ({ id, textHash: sha256(id) }));
      writeFile(join(cwd, 'pool', 'source.json'), { exportedAt: 1, sentences });
      writeFile(join(cwd, 'pool', 'final-reconciliation', 'final-analysis.json'), { entries: [] });
      const entries = sentences.map(({ id, textHash }) => ({ id, textHash, imageFile: `images/${imageId(id)}` }));
      writeFile(join(cwd, 'pool', 'final-images', 'manifest.json'), { version: 1, entries });
      for (const entry of entries) {
        mkdirSync(join(cwd, 'pool', 'final-images', 'images'), { recursive: true });
        writeFileSync(join(cwd, 'pool', 'final-images', entry.imageFile), await webp(1024, 576));
      }
      return entries;
    },
  },
  images: {
    dispatcher: 'dispatch-staged-offline-images.sh',
    args: ['item-images', '1', DEPLOY_SHA],
    env: {
      OFFLINE_IMAGE_WAVE_STATE_ROOT: 'state',
      OFFLINE_IMAGE_WAVE_COOLDOWN_SECONDS: '0',
    },
    inputs: async cwd => {
      const entries = ['i1', 'i2'].map(id => ({ imageId: id, imageFile: `images/${id}.webp` }));
      writeFile(join(cwd, 'item-images', 'manifest.json'), { version: 1, entries });
      for (const entry of entries) {
        mkdirSync(join(cwd, 'item-images', 'images'), { recursive: true });
        writeFileSync(join(cwd, 'item-images', entry.imageFile), await webp(768, 432));
      }
      return entries;
    },
  },
  audio: {
    dispatcher: 'dispatch-staged-offline-audio.sh',
    args: ['audio-root', '1', DEPLOY_SHA],
    env: {
      OFFLINE_AUDIO_WAVE_STATE_ROOT: 'state',
      OFFLINE_AUDIO_WAVE_COOLDOWN_SECONDS: '0',
      OFFLINE_AUDIO_CATALOG: 'catalog.json',
      OFFLINE_AUDIO_EXPECTED_COUNT: '2',
    },
    inputs: cwd => {
      writeFile(join(cwd, 'catalog.json'), { collections: [] });
      const entries = ['k1', 'k2'].map(key => ({ key, audioFile: `audio/${key}.wav` }));
      writeFile(join(cwd, 'audio-root', 'manifest.json'), { version: 1, entries });
      for (const entry of entries) {
        mkdirSync(join(cwd, 'audio-root', 'audio'), { recursive: true });
        writeFileSync(join(cwd, 'audio-root', entry.audioFile), 'wav');
      }
      return entries;
    },
  },
  'corpus-fails': {
    dispatcher: 'dispatch-staged-corpus-audit.sh',
    args: ['source.json', '2', DEPLOY_SHA],
    env: { CORPUS_AUDIT_WAVE_STATE_ROOT: 'state', CORPUS_AUDIT_WAVE_COOLDOWN_SECONDS: '0', FAKE_PUBLISH: 'fail' },
    inputs: cwd => {
      const entries = [{ id: 'c1' }];
      writeFile(join(cwd, 'source.json'), { entries });
      return entries;
    },
  },
  'images-recovered': {
    dispatcher: 'dispatch-staged-offline-images.sh',
    args: ['item-images', '1', DEPLOY_SHA],
    env: {
      OFFLINE_IMAGE_WAVE_STATE_ROOT: 'state',
      OFFLINE_IMAGE_WAVE_COOLDOWN_SECONDS: '0',
    },
    inputs: async cwd => {
      const entries = ['i1', 'i2'].map(id => ({ imageId: id, imageFile: `images/${id}.webp` }));
      writeFile(join(cwd, 'item-images', 'manifest.json'), { version: 1, entries });
      for (const entry of entries) {
        mkdirSync(join(cwd, 'item-images', 'images'), { recursive: true });
        writeFileSync(join(cwd, 'item-images', entry.imageFile), await webp(1024, 576));
      }
      // The first wave's import was verified, but its dispatcher stopped before marking it published.
      const wave = join(cwd, 'state', 'wave-0001');
      writeFile(join(wave, 'manifest.json'), { version: 1, entries: [entries[0]] });
      writeFileSync(join(wave, 'release-tag'), 'vocab-images-wave-0001-20260101T000000Z\n');
      mkdirSync(join(wave, 'publisher'));
      writeFileSync(join(wave, 'publisher', 'complete'), '2026-01-01T00:00:00Z\n');
      return entries;
    },
  },
  'audio-fails': {
    dispatcher: 'dispatch-staged-offline-audio.sh',
    args: ['audio-root', '5', DEPLOY_SHA],
    env: {
      OFFLINE_AUDIO_WAVE_STATE_ROOT: 'state',
      OFFLINE_AUDIO_WAVE_COOLDOWN_SECONDS: '0',
      OFFLINE_AUDIO_CATALOG: 'catalog.json',
      OFFLINE_AUDIO_EXPECTED_COUNT: '1',
      FAKE_PUBLISH: 'fail',
    },
    inputs: cwd => {
      writeFile(join(cwd, 'catalog.json'), { collections: [] });
      const entries = [{ key: 'k1', audioFile: 'audio/k1.wav' }];
      writeFile(join(cwd, 'audio-root', 'manifest.json'), { version: 1, entries });
      mkdirSync(join(cwd, 'audio-root', 'audio'), { recursive: true });
      writeFileSync(join(cwd, 'audio-root', 'audio', 'k1.wav'), 'wav');
      return entries;
    },
  },
  'audio-release-unavailable': {
    dispatcher: 'dispatch-staged-offline-audio.sh',
    args: ['audio-root', '5', DEPLOY_SHA],
    env: {
      OFFLINE_AUDIO_WAVE_STATE_ROOT: 'state',
      OFFLINE_AUDIO_CATALOG: 'catalog.json',
      OFFLINE_AUDIO_EXPECTED_COUNT: '1',
      FAKE_RELEASE_CREATE_STATUS: '1',
      RELEASE_CREATE_ATTEMPTS: '1',
    },
    inputs: cwd => {
      writeFile(join(cwd, 'catalog.json'), { collections: [] });
      const entries = [{ key: 'k1', audioFile: 'audio/k1.wav' }];
      writeFile(join(cwd, 'audio-root', 'manifest.json'), { version: 1, entries });
      mkdirSync(join(cwd, 'audio-root', 'audio'), { recursive: true });
      writeFileSync(join(cwd, 'audio-root', 'audio', 'k1.wav'), 'wav');
      return entries;
    },
  },
  'enrichments-bad-image': {
    dispatcher: 'dispatch-staged-example-enrichments.sh',
    args: ['pool', '5', DEPLOY_SHA],
    env: { ALLOW_DEFERRED_IMAGES: '1', EXAMPLE_ENRICHMENT_WAVE_STATE_ROOT: 'state' },
    inputs: async cwd => {
      const sentences = [{ id: 'x1', textHash: sha256('x1') }];
      writeFile(join(cwd, 'pool', 'source.json'), { exportedAt: 1, sentences });
      writeFile(join(cwd, 'pool', 'final-reconciliation', 'final-analysis.json'), { entries: [] });
      const entries = [{ id: 'x1', textHash: sha256('x1'), imageFile: `images/${imageId('x1')}` }];
      writeFile(join(cwd, 'pool', 'final-images', 'manifest.json'), { version: 1, entries });
      mkdirSync(join(cwd, 'pool', 'final-images', 'images'), { recursive: true });
      writeFileSync(join(cwd, 'pool', 'final-images', entries[0].imageFile), await webp(640, 480));
      return entries;
    },
  },
  'saved-preparer-fails': {
    dispatcher: 'dispatch-staged-saved-sentence-analyses.sh',
    args: ['analysis.json', '5000', DEPLOY_SHA],
    env: { SAVED_SENTENCE_ANALYSIS_STATE_ROOT: 'state', FAKE_PREPARE: 'fail' },
    inputs: cwd => {
      const entries = [{ id: 's1', textHash: 'a'.repeat(64) }];
      writeFile(join(cwd, 'analysis.json'), { generatedAt: 1, entries });
      return entries;
    },
  },
  'corpus-without-source': { dispatcher: 'dispatch-staged-corpus-audit.sh', args: [], inputs: () => [] },
  'images-without-root': { dispatcher: 'dispatch-staged-offline-images.sh', args: [], inputs: () => [] },
};

let root: string;
const results = new Map<string, Promise<Result>>();
before(() => {
  root = mkdtempSync(join(tmpdir(), 'wave-dispatchers-'));
  for (const [name, run] of Object.entries(RUNS)) results.set(name, dispatch(root, name, run));
});
after(async () => {
  await Promise.allSettled(results.values());
  rmSync(root, { recursive: true, force: true });
});
const result = (name: string): Promise<Result> => {
  const pending = results.get(name);
  assert.ok(pending, name);
  return pending;
};

const waves = (cwd: string) => readdirSync(join(cwd, 'state')).filter(name => name.startsWith('wave-')).sort();
const marked = (cwd: string, ...path: string[]) => existsSync(join(cwd, 'state', ...path));
const create = (prefix: string, wave: string, title: string, notes: string) =>
  `release create ${prefix}-${wave}-<stamp> --repo test-owner/test-repo --title ${title} ${wave} --notes ${notes} --latest=false`;
const view = (prefix: string, wave: string) => `release view ${prefix}-${wave}-<stamp> --repo test-owner/test-repo`;

test('the corpus dispatcher publishes the completed records in waves until all are in production', async () => {
  const run = await result('corpus');
  assert.equal(run.status, 0, run.stderr);
  const notes = 'Locally generated and verified advanced corpus metadata; removed after import.';
  assert.deepEqual(run.gh, [
    view('corpus-audit', 'wave-0001'), create('corpus-audit', 'wave-0001', 'Temporary encrypted corpus metadata', notes),
    view('corpus-audit', 'wave-0002'), create('corpus-audit', 'wave-0002', 'Temporary encrypted corpus metadata', notes),
  ]);
  assert.deepEqual(run.published, [
    `corpus-audit-wave-0001-<stamp> state/wave-0001/corpus-audit.enc corpus-audit.enc corpus-import ${DEPLOY_SHA} 300 state=state/wave-0001/publisher files=manifest.json`,
    `corpus-audit-wave-0002-<stamp> state/wave-0002/corpus-audit.enc corpus-audit.enc corpus-import ${DEPLOY_SHA} 300 state=state/wave-0002/publisher files=manifest.json`,
  ]);
  assert.deepEqual(run.stdout, [
    'wave-0001 published (2 records); cooling down for 0s',
    'wave-0002 published (1 records); cooling down for 0s',
    'corpus metadata publication complete: 3/3',
  ]);
  assert.deepEqual(waves(run.cwd), ['wave-0001', 'wave-0002']);
  assert.ok(marked(run.cwd, 'wave-0001', 'published') && marked(run.cwd, 'wave-0002', 'published') && marked(run.cwd, 'complete'));
});

test('the example-analysis dispatcher publishes only sentences production lacks an analysis for', async () => {
  const run = await result('analyses');
  assert.equal(run.status, 0, run.stderr);
  const notes = 'Locally generated and verified example-sentence analyses; removed after import.';
  assert.deepEqual(run.gh, [
    view('example-analyses', 'wave-0001'), create('example-analyses', 'wave-0001', 'Temporary encrypted example analyses', notes),
    view('example-analyses', 'wave-0002'), create('example-analyses', 'wave-0002', 'Temporary encrypted example analyses', notes),
  ]);
  assert.deepEqual(run.published, [
    `example-analyses-wave-0001-<stamp> state/wave-0001/sentence-enrichments.enc sentence-enrichments.enc enrichment-import ${DEPLOY_SHA} 300 state=state/wave-0001/publisher files=manifest.json`,
    `example-analyses-wave-0002-<stamp> state/wave-0002/sentence-enrichments.enc sentence-enrichments.enc enrichment-import ${DEPLOY_SHA} 300 state=state/wave-0002/publisher files=manifest.json`,
  ]);
  assert.deepEqual(run.stdout, [
    'wave-0001 published (1 analyses); cooling down for 0s',
    'wave-0002 published (1 analyses); cooling down for 0s',
    'example-sentence analysis publication complete: 2/2',
  ]);
});

test('the saved-sentence dispatcher publishes every detailed analysis in one wave when it fits', async () => {
  const run = await result('saved');
  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual(run.gh, [
    view('sentence-grammar', 'wave-0001'),
    create('sentence-grammar', 'wave-0001', 'Temporary encrypted saved sentence grammar',
      'Locally generated detailed sentence analyses; removed after import.'),
  ]);
  assert.deepEqual(run.published, [
    `sentence-grammar-wave-0001-<stamp> state/wave-0001/sentence-backfill.enc sentence-backfill.enc import ${DEPLOY_SHA} 300 state=state/wave-0001/publisher files=manifest.json`,
  ]);
  assert.deepEqual(run.stdout, [
    'wave-0001 published (2 analyses); cooling down for 0s',
    'saved sentence analysis publication complete: 2/2',
  ]);
});

test('the example-enrichment dispatcher publishes accepted images with their analyses, one batch at a time', async () => {
  const run = await result('enrichments');
  assert.equal(run.status, 0, run.stderr);
  const notes = 'Locally generated and verified example-sentence analysis and images; removed after import.';
  assert.deepEqual(run.gh, [
    view('example-enrichments', 'wave-0001'), create('example-enrichments', 'wave-0001', 'Temporary encrypted example enrichment', notes),
    view('example-enrichments', 'wave-0002'), create('example-enrichments', 'wave-0002', 'Temporary encrypted example enrichment', notes),
  ]);
  assert.deepEqual(run.published, [
    `example-enrichments-wave-0001-<stamp> state/wave-0001/sentence-enrichments.enc sentence-enrichments.enc enrichment-import ${DEPLOY_SHA} 300 state=state/wave-0001/publisher files=images/${imageId('x1')},manifest.json`,
    `example-enrichments-wave-0002-<stamp> state/wave-0002/sentence-enrichments.enc sentence-enrichments.enc enrichment-import ${DEPLOY_SHA} 300 state=state/wave-0002/publisher files=images/${imageId('x2')},manifest.json`,
  ]);
  assert.deepEqual(run.stdout, [
    'waiting for reconciled example-sentence metadata and image targets',
    'Validated 1 staged example enrichments',
    'wave-0001 published (1 enrichments); cooling down for 0s',
    'Validated 1 staged example enrichments',
    'wave-0002 published (1 enrichments); cooling down for 0s',
    'example-sentence enrichment publication complete: 2/2',
  ]);
});

test('the item-image dispatcher validates and publishes accepted images in waves', async () => {
  const run = await result('images');
  assert.equal(run.status, 0, run.stderr);
  const notes = 'Locally generated and strictly reviewed item images; removed after verified import.';
  assert.deepEqual(run.gh, [
    view('vocab-images', 'wave-0001'), create('vocab-images', 'wave-0001', 'Temporary encrypted item images', notes),
    view('vocab-images', 'wave-0002'), create('vocab-images', 'wave-0002', 'Temporary encrypted item images', notes),
  ]);
  assert.deepEqual(run.published, [
    `vocab-images-wave-0001-<stamp> state/wave-0001/offline-images.enc offline-images.enc image-import ${DEPLOY_SHA} 300 state=state/wave-0001/publisher files=images/i1.webp,manifest.json`,
    `vocab-images-wave-0002-<stamp> state/wave-0002/offline-images.enc offline-images.enc image-import ${DEPLOY_SHA} 300 state=state/wave-0002/publisher files=images/i2.webp,manifest.json`,
  ]);
  assert.deepEqual(run.stdout, [
    'Validated 1 staged offline images',
    'wave-0001 published (1 new images); cooling down for 0s',
    'Validated 1 staged offline images',
    'wave-0002 published (1 new images); cooling down for 0s',
    'all 2 item images are published',
    'item image publication complete: 2/2',
  ]);
});

test('the audio dispatcher publishes generated clips in waves', async () => {
  const run = await result('audio');
  assert.equal(run.status, 0, run.stderr);
  const notes = 'Locally generated, aligned, and quality-gated Qwen3-TTS audio; removed after verified import.';
  assert.deepEqual(run.gh, [
    view('real-life-audio', 'wave-0001'), create('real-life-audio', 'wave-0001', 'Temporary encrypted Real Life audio', notes),
    view('real-life-audio', 'wave-0002'), create('real-life-audio', 'wave-0002', 'Temporary encrypted Real Life audio', notes),
  ]);
  assert.deepEqual(run.published, [
    `real-life-audio-wave-0001-<stamp> state/wave-0001/offline-audio.enc offline-audio.enc audio-import ${DEPLOY_SHA} 300 state=state/wave-0001/publisher files=audio/k1.wav,manifest.json`,
    `real-life-audio-wave-0002-<stamp> state/wave-0002/offline-audio.enc offline-audio.enc audio-import ${DEPLOY_SHA} 300 state=state/wave-0002/publisher files=audio/k2.wav,manifest.json`,
  ]);
  assert.deepEqual(run.stdout, [
    'wave-0001 published (1 clips); cooling down for 0s',
    'wave-0002 published (1 clips); cooling down for 0s',
    'all 2/2 local audio clips are published',
  ]);
});

test('a wave whose publication failed is set aside for inspection', async () => {
  const run = await result('corpus-fails');
  assert.equal(run.status, 1, run.stderr);
  assert.deepEqual(run.stdout, [
    'publication of wave-0001 failed; set it aside as wave-0001.failed so the next run starts a fresh wave',
  ]);
  assert.deepEqual(waves(run.cwd), ['wave-0001.failed']);
});

test('a wave the publisher verified before its dispatcher stopped counts as published, without a second release', async () => {
  const run = await result('images-recovered');
  assert.equal(run.status, 0, run.stderr);
  assert.equal(run.gh.length, 2);
  assert.deepEqual(run.published.map(line => line.split(' ').slice(1, 4).join(' ')), [
    'state/wave-0002/offline-images.enc offline-images.enc image-import',
  ]);
  assert.ok(marked(run.cwd, 'wave-0001', 'published'));
  assert.equal(run.stdout.at(-1), 'item image publication complete: 2/2');
});

test('the audio dispatcher keeps its publisher state in the wave and sets a failed wave aside', async () => {
  const run = await result('audio-fails');
  assert.equal(run.status, 1, run.stderr);
  assert.deepEqual(run.stdout, [
    'publication of wave-0001 failed; set it aside as wave-0001.failed so the next run starts a fresh wave',
  ]);
  assert.deepEqual(waves(run.cwd), ['wave-0001.failed']);
});

test('the audio dispatcher stops after its release-creation attempts', async () => {
  const run = await result('audio-release-unavailable');
  assert.equal(run.status, 1, run.stderr);
  assert.match(run.stderr, /GitHub release creation for wave-0001 failed 1 times; giving up for this run/);
  assert.deepEqual(run.published, []);
});

test('an image that is not a 1024x576 or 768x432 WebP stops the wave before anything is published', async () => {
  const run = await result('enrichments-bad-image');
  assert.equal(run.status, 1, run.stderr);
  assert.match(run.stderr, /invalid wave image: .*640x480 webp/);
  assert.deepEqual(run.gh, []);
  assert.deepEqual(run.published, []);
});

test('the corpus and item-image dispatchers need their source; neither falls back to a bulk-era pool', async () => {
  for (const name of ['corpus-without-source', 'images-without-root']) {
    const run = await result(name);
    assert.equal(run.status, 1, name);
    assert.match(run.stderr, new RegExp(`Usage: ${RUNS[name].dispatcher.replace('.', '\\.')} <`), name);
    assert.deepEqual(run.gh, [], name);
  }
});

test('a wave preparer that fails stops the dispatcher before anything is sealed or published', async () => {
  const run = await result('saved-preparer-fails');
  assert.equal(run.status, 3, run.stderr);
  assert.match(run.stderr, /preparer failed/);
  assert.deepEqual(run.gh, []);
  assert.deepEqual(run.published, []);
  assert.equal(existsSync(join(run.cwd, 'state', 'wave-0001', 'sentence-backfill.enc')), false);
});
