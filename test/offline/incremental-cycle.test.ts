import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test, { after, before } from 'node:test';
import { writeExecutable, writeJson } from '../support/fs.ts';
import { repoPath } from '../support/paths.ts';

// Runs the real incremental runner in a throwaway checkout of itself, with every script it calls stood in
// for by a stub that records its arguments and the per-call settings the runner gives it. Each scenario
// pins the whole cycle: which stages run in which order, with which inputs, state roots and limits, what
// the runner logs, and how it exits.

const gitEnv = {
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'Cycle Test',
  GIT_AUTHOR_EMAIL: 'cycle@example.com',
  GIT_COMMITTER_NAME: 'Cycle Test',
  GIT_COMMITTER_EMAIL: 'cycle@example.com',
};

function git(cwd: string, ...args: string[]): string {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, ...gitEnv } });
  assert.equal(result.status, 0, `git ${args.join(' ')}: ${result.stderr}`);
  return result.stdout.trim();
}

// The settings a stub records when the runner set them for that call. Settings every child inherits from
// the test (GH_BIN, NODE_BIN, the key file) are left out.
const TRACED_ENV = [
  'CODEX_CONCURRENCY', 'CODEX_IMAGE_CONCURRENCY', 'VOCAB_COMPLETION_BATCH_SIZE', 'SENTENCE_ANALYSIS_BATCH_SIZE',
  'ENRICHMENT_FAILURE_LEDGER', 'ENRICHMENT_FAILURE_STAGE', 'ALLOW_PRODUCTION_COVERED_BASIC_ANALYSIS',
  'IMAGE_MODEL', 'IMAGE_MODEL_QUANTIZE', 'KREA_SHARD_COUNT', 'IMAGE_QUALITY_DEFER_AFTER',
  'REQUIRE_DETAILED_SENTENCE_ANALYSIS', 'ALLOW_DEFERRED_IMAGES',
  'CORPUS_AUDIT_WAVE_STATE_ROOT', 'CORPUS_AUDIT_WAVE_COOLDOWN_SECONDS',
  'SAVED_SENTENCE_ANALYSIS_STATE_ROOT', 'SAVED_SENTENCE_ANALYSIS_COOLDOWN_SECONDS',
  'OFFLINE_IMAGE_WAVE_STATE_ROOT', 'OFFLINE_IMAGE_WAVE_COOLDOWN_SECONDS',
  'EXAMPLE_ANALYSIS_WAVE_STATE_ROOT', 'EXAMPLE_ANALYSIS_WAVE_COOLDOWN_SECONDS',
  'EXAMPLE_ENRICHMENT_WAVE_STATE_ROOT', 'EXAMPLE_ENRICHMENT_WAVE_COOLDOWN_SECONDS',
];

// One stub for every script: it records the call, then answers from the scenario. List-valued scenario
// entries are consumed one call at a time, and the last value repeats.
const STUB = `import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

const args = process.argv.slice(2);
let name = basename(process.argv[1]);
if (args[0] === '--as') { name = args[1]; args.splice(0, 2); }
const scenario = JSON.parse(readFileSync(process.env.SCENARIO, 'utf8'));
const counterFile = process.env.SCENARIO + '.counters';
function next(key, fallback) {
  const values = [].concat(scenario[key] ?? fallback);
  const counters = existsSync(counterFile) ? JSON.parse(readFileSync(counterFile, 'utf8')) : {};
  const index = counters[key] ?? 0;
  counters[key] = index + 1;
  writeFileSync(counterFile, JSON.stringify(counters));
  return values[Math.min(index, values.length - 1)];
}
const traced = ${JSON.stringify(TRACED_ENV)}.filter(key => process.env[key] !== undefined).map(key => key + '=' + process.env[key]);
appendFileSync(process.env.TRACE, [name, ...args.map(arg => arg === '' ? "''" : arg)].join(' ') + (traced.length ? '  [' + traced.join(' ') + ']' : '') + '\\n');
const write = (path, value) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, JSON.stringify(value) + '\\n'); };
const list = (count, make) => Array.from({ length: count }, (_, index) => make(index));
const targets = (prefix, count) => ({ targets: list(count, index => ({ imageId: prefix + '-' + index, filename: prefix + '-' + index + '.webp' })) });
const finish = status => process.exit(status);
const pipeline = path => path.includes('saved-sentences') ? 'saved' : 'example';

switch (name) {
  case 'gh': {
    const call = args.join(' ');
    if (call.startsWith('run list') && call.includes('--limit 1')) console.log('100');
    else if (call.startsWith('run list')) console.log('101');
    else if (call.startsWith('run view 101') && call.includes('--json jobs')) console.log('corpus-export');
    else if (call.startsWith('run view 101')) console.log('completed\\tsuccess');
    break;
  }
  case 'tsx': write(args[2], { version: 1, sentences: [] }); break;
  case 'fetch-workflow-export.sh': write(args[2], { version: 1, items: [] }); break;
  case 'check-structured-model.mjs': finish(next('model', 0));
  case 'prepare-incremental-vocab-source.mjs': write(args[1], { entries: list(scenario.vocab ?? 0, index => ({ id: 'vocab-' + index })) }); break;
  case 'complete-corpus-fields.mjs': {
    const status = scenario.vocabStatus ?? 0;
    if (status === 0) write(args[1], { entries: list(scenario.vocab ?? 0, index => ({ id: 'vocab-' + index })) });
    finish(status);
  }
  case 'failure-ledger.mjs': {
    const [command, , stage, , output] = args;
    if (command === 'filter-sentences') {
      write(output, { sentences: [] });
      console.log(next(stage === 'saved-sentence' ? 'saved' : 'examples', 0));
    } else if (command === 'filter-image-targets') {
      const count = scenario[stage === 'item-image' ? 'itemImages' : 'exampleImages'] ?? 0;
      write(output, targets(stage, count));
      console.log(count);
    }
    break;
  }
  case 'reconcile-sentence-analyses.mjs': {
    const missing = next(pipeline(args[2]) + 'Missing', 0);
    write(join(args[2], 'report.json'), { missing });
    if (missing === 0) write(join(args[2], 'final-analysis.json'), { entries: [] });
    break;
  }
  case 'enrich-sentences.mjs': {
    const status = scenario[process.env.ENRICHMENT_FAILURE_STAGE === 'saved-sentence' ? 'savedEnrichStatus' : 'exampleEnrichStatus'] ?? 0;
    if (status === 0) write(args[1], { entries: [] });
    finish(status);
  }
  case 'prepare-incremental-item-images.mjs':
  case 'prepare-sentence-images.mjs': {
    const stage = name === 'prepare-sentence-images.mjs' ? 'example-image' : 'item-image';
    const count = scenario[stage === 'item-image' ? 'itemImages' : 'exampleImages'] ?? 0;
    const root = name === 'prepare-sentence-images.mjs' ? args[2] : args[3];
    write(join(root, 'targets.json'), targets(stage, count));
    write(join(root, 'manifest.json'), { entries: list(count, index => ({ imageFile: 'images/' + stage + '-' + index + '.webp' })) });
    break;
  }
  case 'run-streaming-image-quality-loop.sh': {
    const item = args[0].includes('item-images');
    const wanted = JSON.parse(readFileSync(args[0], 'utf8')).targets;
    const accepted = scenario[item ? 'itemImagesAccepted' : 'exampleImagesAccepted'] ?? wanted.length;
    for (const target of wanted.slice(0, accepted)) { mkdirSync(args[2], { recursive: true }); writeFileSync(join(args[2], target.filename), 'image'); }
    finish(scenario[item ? 'itemImageLoopStatus' : 'exampleImageLoopStatus'] ?? 0);
  }
  case 'build-example-sentence-pool.mjs': write(args[1], { sentences: [] }); break;
  case 'prepare-incremental-example-source.mjs': write(args[2], { sentences: [] }); break;
  case 'merge-sentence-analysis-manifests.mjs': write(args[0], { entries: [] }); break;
  default:
    if (name.startsWith('dispatch-staged-')) finish(scenario.dispatch?.[name] ?? 0);
}
`;

const NODE_STUBS = [
  'failure-ledger.mjs', 'check-structured-model.mjs', 'prepare-incremental-vocab-source.mjs', 'complete-corpus-fields.mjs',
  'reconcile-sentence-analyses.mjs', 'enrich-sentences.mjs', 'prepare-incremental-item-images.mjs',
  'build-example-sentence-pool.mjs', 'prepare-incremental-example-source.mjs', 'merge-sentence-analysis-manifests.mjs',
  'verify-example-sentence-pool.mjs', 'prepare-sentence-images.mjs',
];
const SHELL_STUBS = [
  'sweep-bridge-leftovers.sh', 'fetch-workflow-export.sh', 'run-streaming-image-quality-loop.sh',
  'dispatch-staged-corpus-audit.sh', 'dispatch-staged-saved-sentence-analyses.sh', 'dispatch-staged-offline-images.sh',
  'dispatch-staged-example-analyses.sh', 'dispatch-staged-example-enrichments.sh',
];
const RUNNER_FILES = ['run-incremental-example-enrichment.sh', 'deadline.sh', 'vetted-checkout.sh'];

const shellStub = (name: string, stub: string) =>
  `#!/bin/bash\nexec "$STUB_NODE" "${stub}" --as ${name} "$@"\n`;

interface Scenario {
  vocab?: number;
  vocabStatus?: number;
  saved?: number[];
  savedMissing?: number[];
  savedEnrichStatus?: number;
  itemImages?: number;
  itemImagesAccepted?: number;
  itemImageLoopStatus?: number;
  examples?: number[];
  exampleMissing?: number[];
  exampleEnrichStatus?: number;
  exampleImages?: number;
  exampleImagesAccepted?: number;
  exampleImageLoopStatus?: number;
  model?: number[];
  dispatch?: Record<string, number>;
  busy?: 'image' | 'text';
  // Files an earlier cycle left in the cycle root, with their contents.
  seed?: Record<string, string>;
  env?: Record<string, string>;
}

const writeFile = (path: string, value: unknown) => {
  mkdirSync(dirname(path), { recursive: true });
  writeJson(path, value);
};

// A checkout of the runner pushed to a bare vps remote, so the vetted-checkout guard passes, with the
// stubs, fake tools and the baseline inputs the runner requires. Every scenario runs in it, each with its
// own cycle root.
function setup() {
  const root = mkdtempSync(join(tmpdir(), 'incremental-cycle-'));
  const work = join(root, 'work');
  const offline = join(work, 'scripts', 'offline');
  const bin = join(root, 'bin');
  mkdirSync(offline, { recursive: true });
  mkdirSync(bin);
  git(root, 'init', '--quiet', '--bare', '--initial-branch=main', join(root, 'vps.git'));
  git(root, 'init', '--quiet', '--initial-branch=main', work);
  for (const file of RUNNER_FILES) copyFileSync(repoPath('scripts', 'offline', file), join(offline, file));
  const stub = join(offline, 'stub.mjs');
  writeFileSync(stub, STUB);
  for (const name of NODE_STUBS) writeFileSync(join(offline, name), "import './stub.mjs';\n");
  for (const name of SHELL_STUBS) writeExecutable(join(offline, name), shellStub(name, stub));
  git(work, 'add', '.');
  git(work, 'commit', '--quiet', '-m', 'cycle under test');
  git(work, 'remote', 'add', 'vps', join(root, 'vps.git'));
  git(work, 'push', '--quiet', 'vps', 'main');

  writeExecutable(join(bin, 'gh'), shellStub('gh', stub));
  writeExecutable(join(bin, 'tsx'), shellStub('tsx', stub));
  // The cycle's own waits would only slow the test down.
  writeExecutable(join(bin, 'sleep'), '#!/bin/sh\nexit 0\n');
  // Another local job is running only when the scenario says so.
  writeExecutable(join(bin, 'pgrep'), `#!/bin/sh
case "$FAKE_BUSY:$*" in
  image:*un-streaming-image-quality-loop*|text:*enrich-sentences*) echo 4242; exit 0 ;;
esac
exit 1
`);
  if (spawnSync('/bin/sh', ['-c', 'command -v shlock']).status !== 0) {
    writeExecutable(join(bin, 'shlock'), `#!/bin/sh
while getopts f:p: opt; do case "$opt" in f) file=$OPTARG ;; p) pid=$OPTARG ;; *) exit 2 ;; esac; done
( set -C; printf '%s\\n' "$pid" > "$file" ) 2>/dev/null
`);
  }
  writeFileSync(join(root, 'key'), 'test-key\n');
  writeFile(join(root, 'base', 'source.json'), { sentences: [] });
  writeFile(join(root, 'base', 'final-reconciliation', 'final-analysis.json'), { entries: [] });
  // The bulk pool expects two images and has accepted one.
  writeFile(join(root, 'base', 'final-images', 'targets.json'), { targets: [{ imageId: 'a' }, { imageId: 'b' }] });
  mkdirSync(join(root, 'base', 'final-images', 'images'));
  writeFileSync(join(root, 'base', 'final-images', 'images', 'a.webp'), 'image');
  return { root, work, bin, stub, head: git(work, 'rev-parse', 'HEAD') };
}

type Fixture = ReturnType<typeof setup>;
type CycleResult = Awaited<ReturnType<typeof runCycle>>;

async function runCycle(fixture: Fixture, name: string, scenario: Scenario) {
  const scenarioRoot = join(fixture.root, name);
  mkdirSync(scenarioRoot);
  const scenarioFile = join(scenarioRoot, 'scenario.json');
  const trace = join(scenarioRoot, 'trace.log');
  writeJson(scenarioFile, scenario);
  writeFileSync(trace, '');
  for (const [path, contents] of Object.entries(scenario.seed ?? {})) {
    mkdirSync(dirname(join(scenarioRoot, 'cycle', path)), { recursive: true });
    writeFileSync(join(scenarioRoot, 'cycle', path), contents);
  }
  const child = spawn('/bin/bash', [
    'scripts/offline/run-incremental-example-enrichment.sh',
    join(scenarioRoot, 'cycle'),
    join(fixture.root, 'base', 'source.json'),
    join(fixture.root, 'base', 'final-images'),
  ], {
    cwd: fixture.work,
    env: {
      ...gitEnv,
      HOME: process.env.HOME ?? fixture.root,
      PATH: `${fixture.bin}:${dirname(process.execPath)}:${process.env.PATH ?? '/usr/bin:/bin'}`,
      TMPDIR: scenarioRoot,
      GH_BIN: join(fixture.bin, 'gh'),
      TSX_BIN: join(fixture.bin, 'tsx'),
      SENTENCE_BRIDGE_KEY_FILE: join(fixture.root, 'key'),
      STUB_NODE: process.execPath,
      SCENARIO: scenarioFile,
      TRACE: trace,
      FAKE_BUSY: scenario.busy ?? '',
      ...scenario.env,
    },
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });
  const status = await new Promise<number | null>(resolvePromise => child.on('close', code => resolvePromise(code)));
  const normalize = (text: string) => text
    .replaceAll(realpathSync(fixture.root), '<root>')
    .replaceAll(fixture.root, '<root>')
    .replaceAll(`/${name}/`, '/<scenario>/')
    .replaceAll(fixture.head, '<head>')
    .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z/g, '<time>');
  const lines = (text: string) => normalize(text).split('\n').filter(line => line !== '');
  return {
    status,
    // The runner's own log lines, without their timestamps.
    log: lines(stdout).map(line => line.replace(/^\[<time>\] /, '')),
    stderr: lines(stderr),
    trace: lines(readFileSync(trace, 'utf8')),
    lock: existsSync(join(scenarioRoot, 'cycle', '.cycle.lock')),
  };
}

// Every scenario runs at once, each in its own cycle root; the tests below check one result each.
const SCENARIOS: Record<string, Scenario> = {
  idle: {},
  full: {
    vocab: 2, saved: [1, 1], savedMissing: [1, 0], itemImages: 2, examples: [3, 3], exampleMissing: [2, 0], exampleImages: 2,
  },
  failures: {
    vocab: 1,
    vocabStatus: 3,
    saved: [1, 1],
    savedMissing: [1, 1],
    savedEnrichStatus: 124,
    itemImages: 2,
    itemImagesAccepted: 1,
    itemImageLoopStatus: 1,
    examples: [2],
    exampleMissing: [0],
    dispatch: { 'dispatch-staged-example-analyses.sh': 1, 'dispatch-staged-offline-images.sh': 1 },
  },
  backoff: { examples: [2, 0], exampleMissing: [2], exampleEnrichStatus: 3 },
  incomplete: { examples: [1, 1], exampleMissing: [1, 1] },
  'model-down': { vocab: 1, vocabStatus: 124, model: [0, 1] },
  'text-busy': { busy: 'text' },
  'image-busy': { examples: [1], exampleMissing: [0], exampleImages: 1, itemImages: 1, busy: 'image' },
  previous: {
    seed: {
      'unfiltered-source.json': '{}\n',
      'source.json': '{}\n',
      'saved-sentences/source.json': '{}\n',
      'saved-sentences/analysis-cache.json': '{}\n',
      'launchd.out.log': 'x'.repeat(64),
      'launchd.out.log.1': 'older output\n',
      'launchd.err.log': 'errors\n',
    },
    env: { LAUNCHD_LOG_MAX_BYTES: '32' },
  },
};

let fixture: Fixture;
const results = new Map<string, Promise<CycleResult>>();
before(() => {
  fixture = setup();
  for (const [name, scenario] of Object.entries(SCENARIOS)) results.set(name, runCycle(fixture, name, scenario));
});
after(async () => {
  await Promise.allSettled(results.values());
  rmSync(fixture.root, { recursive: true, force: true });
});
const cycle = (name: string): Promise<CycleResult> => {
  const result = results.get(name);
  assert.ok(result, name);
  return result;
};

const C = '<root>/<scenario>/cycle';
// Each stage's wave-state root for this cycle, named for its corpus export run, 101.
const STATE = `${C}/publish-state`;

// The calls every cycle makes before its first stage. The sweep gets each stage's root of per-cycle roots,
// then the roots cycles shared before.
const START = [
  `sweep-bridge-leftovers.sh ${STATE}/vocabulary ${STATE}/saved-sentences ${STATE}/item-images ${STATE}/example-analyses ${STATE}/example-enrichments `
    + `${C}/publish-state-coverage-v2 ${C}/analysis-publish-state-coverage-v2 ${C}/saved-sentences/publish-state-detailed-v1 ${C}/vocabulary/publish-state ${C}/item-images/publish-state`,
  'check-structured-model.mjs',
  'gh run list --repo younotafish/DictProp-VPS --workflow sentence-backfill.yml --event workflow_dispatch --limit 1 --json databaseId --jq if length == 0 then 0 else .[0].databaseId end',
  'gh workflow run sentence-backfill.yml --repo younotafish/DictProp-VPS --ref main -f operation=corpus-export',
  'gh run list --repo younotafish/DictProp-VPS --workflow sentence-backfill.yml --event workflow_dispatch --limit 30 --json databaseId,createdAt --jq .[] | select(.databaseId > 100 and .createdAt >= "<time>") | .databaseId',
  'gh run view 101 --repo younotafish/DictProp-VPS --json jobs --jq .jobs[] | select(.name == "corpus-export" and .conclusion != "skipped") | .name',
  'gh run view 101 --repo younotafish/DictProp-VPS --json status,conclusion --jq [.status, .conclusion] | @tsv',
  'fetch-workflow-export.sh 101 corpus-export <root>/<scenario>/cycle/current-corpus.json',
];
const START_LOG = [
  'checking that local Claude claude-opus-5-5 can answer before exporting production data',
  'requesting a fresh encrypted production corpus export',
  'waiting for corpus export run 101',
];

const LEDGER = `${C}/failure-ledger.json`;
const vocabSource = `prepare-incremental-vocab-source.mjs ${C}/current-corpus.json ${C}/vocabulary/source.json.tmp 100 168 ''`
  + `  [ENRICHMENT_FAILURE_LEDGER=${LEDGER} ENRICHMENT_FAILURE_STAGE=vocab]`;
const savedSource = (previous: string) =>
  `tsx server/src/scripts/prepare-incremental-saved-sentence-source.ts ${C}/current-corpus.json ${C}/saved-sentences/source.json.tmp ${previous} ${C}/saved-sentences/current-base-analysis.json`;
const savedFilter = `failure-ledger.mjs filter-sentences ${LEDGER} saved-sentence ${C}/saved-sentences/source.json ${C}/saved-sentences/cycle-source.json`;
const itemImagePrep = (savedAnalysis: string, overlay: string) =>
  `prepare-incremental-item-images.mjs ${C}/current-corpus.json ${savedAnalysis} ${overlay} ${C}/item-images krea/Krea-2-Turbo`;
const itemImageFilter = `failure-ledger.mjs filter-image-targets ${LEDGER} item-image ${C}/item-images/targets.json ${C}/item-images/cycle-targets.json`;
const pool = (overlay: string) => `build-example-sentence-pool.mjs ${C}/current-corpus.json ${C}/current-source.json.tmp ${overlay}`;
const exampleSource = `prepare-incremental-example-source.mjs ${C}/current-source.json <root>/base/source.json ${C}/source.json.tmp`;
const exampleFilter = `failure-ledger.mjs filter-sentences ${LEDGER} example-sentence ${C}/unfiltered-source.json ${C}/source.json`;
const summary = `failure-ledger.mjs summary ${LEDGER}`;

test('a cycle with nothing new exports the corpus, checks every stage and publishes nothing', async () => {
  const result = await cycle('idle');
  assert.equal(result.status, 0, result.stderr.join('\n'));
  assert.deepEqual(result.trace, [
    ...START,
    vocabSource,
    savedSource('-'),
    savedFilter,
    itemImagePrep('-', '-'),
    itemImageFilter,
    pool('-'),
    exampleSource,
    exampleFilter,
    summary,
  ]);
  assert.deepEqual(result.log, [
    ...START_LOG,
    'no recent vocabulary records need structural completion',
    'no saved sentences need detailed analysis',
    'no saved-word/phrase/sentence image needs generating this cycle',
    'no post-baseline example sentences need enrichment',
  ]);
  assert.equal(result.lock, false);
});

test('a full cycle completes, reconciles and publishes every stage in order', async () => {
  const result = await cycle('full');
  assert.equal(result.status, 0, result.stderr.join('\n'));
  assert.deepEqual(result.trace, [
    ...START,
    vocabSource,
    `complete-corpus-fields.mjs ${C}/vocabulary/source.json ${C}/vocabulary/completed.json ${C}/vocabulary/work  [CODEX_CONCURRENCY=16 VOCAB_COMPLETION_BATCH_SIZE=8 ENRICHMENT_FAILURE_LEDGER=${LEDGER} ENRICHMENT_FAILURE_STAGE=vocab]`,
    `dispatch-staged-corpus-audit.sh ${C}/vocabulary/completed.json 100 <head>  [CORPUS_AUDIT_WAVE_STATE_ROOT=${STATE}/vocabulary/101 CORPUS_AUDIT_WAVE_COOLDOWN_SECONDS=30]`,
    savedSource('-'),
    savedFilter,
    `reconcile-sentence-analyses.mjs ${C}/saved-sentences/cycle-source.json ${C}/saved-sentences/analysis-cache.json ${C}/saved-sentences/final-reconciliation`,
    `enrich-sentences.mjs ${C}/saved-sentences/final-reconciliation/missing-source.json ${C}/saved-sentences/new-analysis.json ${C}/saved-sentences/analysis-work ${C}/saved-sentences/current-base-analysis.json  [CODEX_CONCURRENCY=16 SENTENCE_ANALYSIS_BATCH_SIZE=1 ENRICHMENT_FAILURE_LEDGER=${LEDGER} ENRICHMENT_FAILURE_STAGE=saved-sentence]`,
    savedFilter,
    `reconcile-sentence-analyses.mjs ${C}/saved-sentences/cycle-source.json ${C}/saved-sentences/analysis-cache.json ${C}/saved-sentences/final-reconciliation ${C}/saved-sentences/new-analysis.json`,
    `dispatch-staged-saved-sentence-analyses.sh ${C}/saved-sentences/analysis-cache.json 2000 <head>  [REQUIRE_DETAILED_SENTENCE_ANALYSIS=1 SAVED_SENTENCE_ANALYSIS_STATE_ROOT=${STATE}/saved-sentences/101 SAVED_SENTENCE_ANALYSIS_COOLDOWN_SECONDS=30]`,
    itemImagePrep(`${C}/saved-sentences/analysis-cache.json`, `${C}/vocabulary/completed.json`),
    itemImageFilter,
    `run-streaming-image-quality-loop.sh ${C}/item-images/cycle-targets.json ${C}/item-images/candidates ${C}/item-images/images ${C}/item-images/streaming-quality/101 1024 576 8 1 64  [CODEX_CONCURRENCY=16 CODEX_IMAGE_CONCURRENCY=8 IMAGE_MODEL=krea2 IMAGE_MODEL_QUANTIZE= KREA_SHARD_COUNT=1 IMAGE_QUALITY_DEFER_AFTER=8]`,
    `failure-ledger.mjs record-image-outcomes ${LEDGER} item-image ${C}/item-images/cycle-targets.json ${C}/item-images/images 0`,
    `dispatch-staged-offline-images.sh ${C}/item-images 100 <head>  [OFFLINE_IMAGE_WAVE_STATE_ROOT=${STATE}/item-images/101 OFFLINE_IMAGE_WAVE_COOLDOWN_SECONDS=30]`,
    pool(`${C}/vocabulary/completed.json`),
    exampleSource,
    exampleFilter,
    `merge-sentence-analysis-manifests.mjs ${C}/combined-analysis-cache.json <root>/base/final-reconciliation/final-analysis.json ${C}/analysis-cache.json`,
    `reconcile-sentence-analyses.mjs ${C}/source.json ${C}/combined-analysis-cache.json ${C}/final-reconciliation  [ALLOW_PRODUCTION_COVERED_BASIC_ANALYSIS=1]`,
    `enrich-sentences.mjs ${C}/final-reconciliation/missing-source.json ${C}/new-analysis.json ${C}/analysis-work ${C}/analysis-cache.json  [CODEX_CONCURRENCY=16 SENTENCE_ANALYSIS_BATCH_SIZE=1 ENRICHMENT_FAILURE_LEDGER=${LEDGER} ENRICHMENT_FAILURE_STAGE=example-sentence]`,
    exampleFilter,
    `reconcile-sentence-analyses.mjs ${C}/source.json ${C}/combined-analysis-cache.json ${C}/final-reconciliation ${C}/new-analysis.json  [ALLOW_PRODUCTION_COVERED_BASIC_ANALYSIS=1]`,
    `merge-sentence-analysis-manifests.mjs ${C}/analysis-cache.json.next ${C}/analysis-cache.json ${C}/final-reconciliation/final-analysis.json`,
    `verify-example-sentence-pool.mjs ${C}/source.json ${C}/final-reconciliation/final-analysis.json`,
    `dispatch-staged-example-analyses.sh ${C} 2000 <head>  [REQUIRE_DETAILED_SENTENCE_ANALYSIS=1 EXAMPLE_ANALYSIS_WAVE_STATE_ROOT=${STATE}/example-analyses/101 EXAMPLE_ANALYSIS_WAVE_COOLDOWN_SECONDS=30]`,
    `prepare-sentence-images.mjs ${C}/source.json ${C}/final-reconciliation/final-analysis.json ${C}/final-images krea/Krea-2-Turbo <root>/base/final-images/images`,
    `failure-ledger.mjs filter-image-targets ${LEDGER} example-image ${C}/final-images/targets.json ${C}/final-images/cycle-targets.json`,
    `run-streaming-image-quality-loop.sh ${C}/final-images/cycle-targets.json ${C}/final-images/candidates ${C}/final-images/images ${C}/final-images/streaming-quality/101 1024 576 8 1 64  [CODEX_CONCURRENCY=16 CODEX_IMAGE_CONCURRENCY=8 IMAGE_MODEL=krea2 IMAGE_MODEL_QUANTIZE= KREA_SHARD_COUNT=1 IMAGE_QUALITY_DEFER_AFTER=8]`,
    `failure-ledger.mjs record-image-outcomes ${LEDGER} example-image ${C}/final-images/cycle-targets.json ${C}/final-images/images 0`,
    `verify-example-sentence-pool.mjs ${C}/source.json ${C}/final-reconciliation/final-analysis.json ${C}/final-images  [ALLOW_DEFERRED_IMAGES=1]`,
    `dispatch-staged-example-enrichments.sh ${C} 100 <head>  [ALLOW_DEFERRED_IMAGES=1 EXAMPLE_ENRICHMENT_WAVE_STATE_ROOT=${STATE}/example-enrichments/101 EXAMPLE_ENRICHMENT_WAVE_COOLDOWN_SECONDS=30]`,
    summary,
  ]);
  assert.deepEqual(result.log, [
    ...START_LOG,
    'creating advanced Claude claude-opus-5-5 metadata for 2 new or incomplete vocabulary record(s)',
    'publishing locally completed vocabulary records',
    'generating detailed Claude claude-opus-5-5 explanations for 1 saved sentence(s)',
    'publishing detailed saved-sentence analyses',
    'generating locally and judging with Claude claude-opus-5-5 2 missing saved-word/phrase/sentence image(s)',
    'publishing 2 locally generated saved-word/phrase/sentence image(s)',
    'generating detailed Claude claude-opus-5-5 explanations for 2 production gap(s)',
    'publishing validated explanations before their images',
    'bulk image pipeline has 1/2 accepted; continuing with incremental images',
    'generating 2 missing example image(s) locally and judging them with Claude claude-opus-5-5',
    'publishing verified incremental explanation-image pairs',
    'incremental example-enrichment cycle complete: 3 post-baseline sentence(s)',
  ]);
  // The saved-sentence cache took the reconciled analyses, and deferred item images left the manifest.
  const cycleRoot = join(fixture.root, 'full', 'cycle');
  assert.ok(existsSync(join(cycleRoot, 'saved-sentences', 'analysis-cache.json')));
  assert.equal(JSON.parse(readFileSync(join(cycleRoot, 'item-images', 'manifest.json'), 'utf8')).entries.length, 2);
  assert.equal(result.lock, false);
});

test('stages that fail let the rest of the cycle run, and the cycle exits 1 naming them', async () => {
  const result = await cycle('failures');
  assert.equal(result.status, 1, result.stderr.join('\n'));
  assert.deepEqual(result.trace, [
    ...START,
    vocabSource,
    `complete-corpus-fields.mjs ${C}/vocabulary/source.json ${C}/vocabulary/completed.json ${C}/vocabulary/work  [CODEX_CONCURRENCY=16 VOCAB_COMPLETION_BATCH_SIZE=8 ENRICHMENT_FAILURE_LEDGER=${LEDGER} ENRICHMENT_FAILURE_STAGE=vocab]`,
    'check-structured-model.mjs',
    savedSource('-'),
    savedFilter,
    `reconcile-sentence-analyses.mjs ${C}/saved-sentences/cycle-source.json ${C}/saved-sentences/analysis-cache.json ${C}/saved-sentences/final-reconciliation`,
    `enrich-sentences.mjs ${C}/saved-sentences/final-reconciliation/missing-source.json ${C}/saved-sentences/new-analysis.json ${C}/saved-sentences/analysis-work ${C}/saved-sentences/current-base-analysis.json  [CODEX_CONCURRENCY=16 SENTENCE_ANALYSIS_BATCH_SIZE=1 ENRICHMENT_FAILURE_LEDGER=${LEDGER} ENRICHMENT_FAILURE_STAGE=saved-sentence]`,
    'check-structured-model.mjs',
    savedFilter,
    `reconcile-sentence-analyses.mjs ${C}/saved-sentences/cycle-source.json ${C}/saved-sentences/analysis-cache.json ${C}/saved-sentences/final-reconciliation`,
    itemImagePrep(`${C}/saved-sentences/analysis-cache.json`, '-'),
    itemImageFilter,
    `run-streaming-image-quality-loop.sh ${C}/item-images/cycle-targets.json ${C}/item-images/candidates ${C}/item-images/images ${C}/item-images/streaming-quality/101 1024 576 8 1 64  [CODEX_CONCURRENCY=16 CODEX_IMAGE_CONCURRENCY=8 IMAGE_MODEL=krea2 IMAGE_MODEL_QUANTIZE= KREA_SHARD_COUNT=1 IMAGE_QUALITY_DEFER_AFTER=8]`,
    `failure-ledger.mjs record-image-outcomes ${LEDGER} item-image ${C}/item-images/cycle-targets.json ${C}/item-images/images 1`,
    'check-structured-model.mjs',
    `dispatch-staged-offline-images.sh ${C}/item-images 100 <head>  [OFFLINE_IMAGE_WAVE_STATE_ROOT=${STATE}/item-images/101 OFFLINE_IMAGE_WAVE_COOLDOWN_SECONDS=30]`,
    pool('-'),
    exampleSource,
    exampleFilter,
    `merge-sentence-analysis-manifests.mjs ${C}/combined-analysis-cache.json <root>/base/final-reconciliation/final-analysis.json ${C}/analysis-cache.json`,
    `reconcile-sentence-analyses.mjs ${C}/source.json ${C}/combined-analysis-cache.json ${C}/final-reconciliation  [ALLOW_PRODUCTION_COVERED_BASIC_ANALYSIS=1]`,
    `merge-sentence-analysis-manifests.mjs ${C}/analysis-cache.json.next ${C}/analysis-cache.json ${C}/final-reconciliation/final-analysis.json`,
    `verify-example-sentence-pool.mjs ${C}/source.json ${C}/final-reconciliation/final-analysis.json`,
    `dispatch-staged-example-analyses.sh ${C} 2000 <head>  [REQUIRE_DETAILED_SENTENCE_ANALYSIS=1 EXAMPLE_ANALYSIS_WAVE_STATE_ROOT=${STATE}/example-analyses/101 EXAMPLE_ANALYSIS_WAVE_COOLDOWN_SECONDS=30]`,
    `prepare-sentence-images.mjs ${C}/source.json ${C}/final-reconciliation/final-analysis.json ${C}/final-images krea/Krea-2-Turbo <root>/base/final-images/images`,
    `failure-ledger.mjs filter-image-targets ${LEDGER} example-image ${C}/final-images/targets.json ${C}/final-images/cycle-targets.json`,
    `verify-example-sentence-pool.mjs ${C}/source.json ${C}/final-reconciliation/final-analysis.json ${C}/final-images  [ALLOW_DEFERRED_IMAGES=1]`,
    `dispatch-staged-example-enrichments.sh ${C} 100 <head>  [ALLOW_DEFERRED_IMAGES=1 EXAMPLE_ENRICHMENT_WAVE_STATE_ROOT=${STATE}/example-enrichments/101 EXAMPLE_ENRICHMENT_WAVE_COOLDOWN_SECONDS=30]`,
    summary,
  ]);
  assert.deepEqual(result.log, [
    ...START_LOG,
    'creating advanced Claude claude-opus-5-5 metadata for 1 new or incomplete vocabulary record(s)',
    'vocabulary completion did not complete this cycle',
    'generating detailed Claude claude-opus-5-5 explanations for 1 saved sentence(s)',
    'saved-sentence analysis did not complete this cycle',
    'saved-sentence reconciliation did not complete this cycle',
    'generating locally and judging with Claude claude-opus-5-5 2 missing saved-word/phrase/sentence image(s)',
    'saved-item images did not complete this cycle',
    'publishing 1 locally generated saved-word/phrase/sentence image(s)',
    'saved-item image publication did not complete this cycle',
    'publishing validated explanations before their images',
    'example-sentence analysis publication did not complete this cycle',
    'no example image needs generating this cycle',
    'publishing verified incremental explanation-image pairs',
    'incremental example-enrichment cycle complete: 2 post-baseline sentence(s)',
    'stages that did not complete this cycle: vocabulary completion, saved-sentence analysis, saved-sentence reconciliation, saved-item images, saved-item image publication, example-sentence analysis publication',
  ]);
  assert.deepEqual(result.stderr, ['Incremental saved-sentence analysis reconciliation is incomplete']);
  // Only the accepted item image stays in the manifest the publisher reads.
  const manifest = JSON.parse(readFileSync(join(fixture.root, 'failures', 'cycle', 'item-images', 'manifest.json'), 'utf8'));
  assert.deepEqual(manifest.entries, [{ imageFile: 'images/item-image-0.webp' }]);
});

test('the example stage ends the cycle when every sentence is backing off or reconciliation is incomplete', async () => {
  const [backoff, incomplete] = await Promise.all([cycle('backoff'), cycle('incomplete')]);
  const exampleStart = [
    exampleFilter,
    `merge-sentence-analysis-manifests.mjs ${C}/combined-analysis-cache.json <root>/base/final-reconciliation/final-analysis.json ${C}/analysis-cache.json`,
    `reconcile-sentence-analyses.mjs ${C}/source.json ${C}/combined-analysis-cache.json ${C}/final-reconciliation  [ALLOW_PRODUCTION_COVERED_BASIC_ANALYSIS=1]`,
  ];
  const prefix = [...START, vocabSource, savedSource('-'), savedFilter, itemImagePrep('-', '-'), itemImageFilter, pool('-'), exampleSource];
  const enrich = (count: number) =>
    `enrich-sentences.mjs ${C}/final-reconciliation/missing-source.json ${C}/new-analysis.json ${C}/analysis-work ${C}/analysis-cache.json  [CODEX_CONCURRENCY=16 SENTENCE_ANALYSIS_BATCH_SIZE=${count} ENRICHMENT_FAILURE_LEDGER=${LEDGER} ENRICHMENT_FAILURE_STAGE=example-sentence]`;

  assert.equal(backoff.status, 1, backoff.stderr.join('\n'));
  assert.deepEqual(backoff.trace, [...prefix, ...exampleStart, enrich(1), 'check-structured-model.mjs', exampleFilter, summary]);
  assert.deepEqual(backoff.log.slice(-4), [
    'generating detailed Claude claude-opus-5-5 explanations for 2 production gap(s)',
    'example-sentence analysis did not complete this cycle',
    'every post-baseline example sentence is waiting out a failure backoff',
    'stages that did not complete this cycle: example-sentence analysis',
  ]);

  assert.equal(incomplete.status, 1, incomplete.stderr.join('\n'));
  assert.deepEqual(incomplete.trace, [
    ...prefix, ...exampleStart, enrich(1), exampleFilter,
    `reconcile-sentence-analyses.mjs ${C}/source.json ${C}/combined-analysis-cache.json ${C}/final-reconciliation ${C}/new-analysis.json  [ALLOW_PRODUCTION_COVERED_BASIC_ANALYSIS=1]`,
    summary,
  ]);
  assert.deepEqual(incomplete.log.slice(-4), [
    'generating detailed Claude claude-opus-5-5 explanations for 1 production gap(s)',
    'example-sentence reconciliation did not complete this cycle',
    'example sentences are not published this cycle',
    'stages that did not complete this cycle: example-sentence reconciliation',
  ]);
  assert.deepEqual(incomplete.stderr, ['Incremental sentence analysis reconciliation is incomplete']);
});

test('a cycle builds its sources on what the previous cycle left, and sets an outgrown log aside', async () => {
  const result = await cycle('previous');
  assert.equal(result.status, 0, result.stderr.join('\n'));
  // The unfiltered example source carries each sentence's first identity over; the filtered source.json is
  // only this cycle's work list, so it is never passed on.
  assert.deepEqual(result.trace, [
    ...START,
    vocabSource,
    savedSource(`${C}/saved-sentences/source.json`),
    savedFilter,
    itemImagePrep(`${C}/saved-sentences/analysis-cache.json`, '-'),
    itemImageFilter,
    pool('-'),
    `${exampleSource} ${C}/unfiltered-source.json`,
    exampleFilter,
    summary,
  ]);
  // The output log outgrew the limit and replaced the older copy; the error log did not.
  const cycleRoot = join(fixture.root, 'previous', 'cycle');
  assert.equal(existsSync(join(cycleRoot, 'launchd.out.log')), false);
  assert.equal(readFileSync(join(cycleRoot, 'launchd.out.log.1'), 'utf8'), 'x'.repeat(64));
  assert.equal(readFileSync(join(cycleRoot, 'launchd.err.log'), 'utf8'), 'errors\n');
  assert.equal(existsSync(join(cycleRoot, 'launchd.err.log.1')), false);
});

test('a model that stops answering after a failed stage ends the cycle there', async () => {
  const result = await cycle('model-down');
  assert.equal(result.status, 1, result.stderr.join('\n'));
  assert.deepEqual(result.trace, [
    ...START,
    vocabSource,
    `complete-corpus-fields.mjs ${C}/vocabulary/source.json ${C}/vocabulary/completed.json ${C}/vocabulary/work  [CODEX_CONCURRENCY=16 VOCAB_COMPLETION_BATCH_SIZE=8 ENRICHMENT_FAILURE_LEDGER=${LEDGER} ENRICHMENT_FAILURE_STAGE=vocab]`,
    'check-structured-model.mjs',
    summary,
  ]);
  assert.deepEqual(result.log.slice(-3), [
    'vocabulary completion did not complete this cycle',
    'local Claude claude-opus-5-5 stopped answering; ending this cycle',
    'stages that did not complete this cycle: vocabulary completion',
  ]);
  assert.equal(result.lock, false);
});

test('another local job defers the cycle, and a busy image pipeline queues the example images', async () => {
  const [text, image] = await Promise.all([cycle('text-busy'), cycle('image-busy')]);
  assert.equal(text.status, 0, text.stderr.join('\n'));
  assert.deepEqual(text.trace, []);
  assert.deepEqual(text.log, ['another local sentence-analysis job is active (pid 4242); deferring this cycle']);
  assert.equal(text.lock, false);

  assert.equal(image.status, 0, image.stderr.join('\n'));
  assert.deepEqual(image.trace, [
    ...START,
    vocabSource,
    savedSource('-'),
    savedFilter,
    itemImagePrep('-', '-'),
    itemImageFilter,
    `run-streaming-image-quality-loop.sh ${C}/item-images/cycle-targets.json ${C}/item-images/candidates ${C}/item-images/images ${C}/item-images/streaming-quality/101 1024 576 8 1 64  [CODEX_CONCURRENCY=16 CODEX_IMAGE_CONCURRENCY=8 IMAGE_MODEL=krea2 IMAGE_MODEL_QUANTIZE= KREA_SHARD_COUNT=1 IMAGE_QUALITY_DEFER_AFTER=8]`,
    `failure-ledger.mjs record-image-outcomes ${LEDGER} item-image ${C}/item-images/cycle-targets.json ${C}/item-images/images 0`,
    `dispatch-staged-offline-images.sh ${C}/item-images 100 <head>  [OFFLINE_IMAGE_WAVE_STATE_ROOT=${STATE}/item-images/101 OFFLINE_IMAGE_WAVE_COOLDOWN_SECONDS=30]`,
    pool('-'),
    exampleSource,
    exampleFilter,
    `merge-sentence-analysis-manifests.mjs ${C}/combined-analysis-cache.json <root>/base/final-reconciliation/final-analysis.json ${C}/analysis-cache.json`,
    `reconcile-sentence-analyses.mjs ${C}/source.json ${C}/combined-analysis-cache.json ${C}/final-reconciliation  [ALLOW_PRODUCTION_COVERED_BASIC_ANALYSIS=1]`,
    `merge-sentence-analysis-manifests.mjs ${C}/analysis-cache.json.next ${C}/analysis-cache.json ${C}/final-reconciliation/final-analysis.json`,
    `verify-example-sentence-pool.mjs ${C}/source.json ${C}/final-reconciliation/final-analysis.json`,
    `dispatch-staged-example-analyses.sh ${C} 2000 <head>  [REQUIRE_DETAILED_SENTENCE_ANALYSIS=1 EXAMPLE_ANALYSIS_WAVE_STATE_ROOT=${STATE}/example-analyses/101 EXAMPLE_ANALYSIS_WAVE_COOLDOWN_SECONDS=30]`,
    `prepare-sentence-images.mjs ${C}/source.json ${C}/final-reconciliation/final-analysis.json ${C}/final-images krea/Krea-2-Turbo <root>/base/final-images/images`,
    `failure-ledger.mjs filter-image-targets ${LEDGER} example-image ${C}/final-images/targets.json ${C}/final-images/cycle-targets.json`,
    summary,
  ]);
  assert.deepEqual(image.log.slice(-4), [
    'generating locally and judging with Claude claude-opus-5-5 1 missing saved-word/phrase/sentence image(s)',
    'publishing 1 locally generated saved-word/phrase/sentence image(s)',
    'publishing validated explanations before their images',
    'another local image pipeline is active; incremental images are queued',
  ]);
  assert.equal(image.lock, false);
});
