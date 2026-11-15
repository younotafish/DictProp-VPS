import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { writeExecutable, writeJson } from '../support/fs.ts';
import { repoPath } from '../support/paths.ts';

const generator = repoPath('scripts', 'offline', 'generate-themed-sentence-collection.mjs');
const audit = repoPath('scripts', 'offline', 'audit-themed-sentence-collection.mjs');

// Stands in for `codex exec`: it writes FAKE_CODEX_OUTPUT to the -o path, or else a valid section for the prompt,
// and records each call's arguments.
const fakeCodex = `#!/usr/bin/env node
import { appendFileSync, writeFileSync } from 'node:fs';
const args = process.argv.slice(2);
let prompt = '';
process.stdin.on('data', chunk => { prompt += chunk; });
process.stdin.on('end', () => {
  if (process.env.FAKE_CODEX_CALLS) appendFileSync(process.env.FAKE_CODEX_CALLS, JSON.stringify(args) + '\\n');
  if (process.env.FAKE_CODEX_EXIT) process.exit(Number(process.env.FAKE_CODEX_EXIT));
  let output = process.env.FAKE_CODEX_OUTPUT;
  if (!output) {
    const sectionId = /SECTION ID: (\\S+)/.exec(prompt)[1];
    const count = Number(/Create exactly (\\d+)/.exec(prompt)[1]);
    output = JSON.stringify({
      sectionId,
      sentences: Array.from({ length: count }, (_, index) => ({
        text: \`In the \${sectionId} scene, line \${index + 1} asks the clerk to hold the reservation politely.\`,
        focus: 'hold the reservation',
      })),
    });
  }
  writeFileSync(args[args.indexOf('-o') + 1], output);
});
`;

const brief = {
  version: 1,
  collection: { id: 'travel', title: 'Travel', level: 'B2-C1', description: 'Travel talk.' },
  methodology: ['Natural spoken lines.'],
  sentencesPerSection: 8,
  sections: [
    { id: 'airport', title: 'Airport', description: 'Checking in.', guidance: 'Counter talk.' },
    { id: 'hotel', title: 'Hotel', description: 'Staying over.', guidance: 'Front desk talk.' },
  ],
};

function setup() {
  const root = mkdtempSync(join(tmpdir(), 'dictprop-themed-'));
  const codex = join(root, 'codex');
  writeExecutable(codex, fakeCodex);
  writeJson(join(root, 'brief.json'), brief);
  return { root, codex, calls: join(root, 'calls.jsonl') };
}

function run(script: string, args: string[], env: Record<string, string>) {
  return spawnSync(process.execPath, [script, ...args], { encoding: 'utf8', env: { ...process.env, ...env } });
}

test('the themed generator writes one validated collection from a bounded Codex call per section', () => {
  const { root, codex, calls } = setup();
  const output = join(root, 'out', 'collection.json');

  const result = run(generator, [join(root, 'brief.json'), output], {
    CODEX_BIN: codex, FAKE_CODEX_CALLS: calls, CODEX_MODEL: 'test-model',
  });

  assert.equal(result.status, 0, result.stderr);
  const collection = JSON.parse(readFileSync(output, 'utf8'));
  assert.equal(collection.id, 'travel');
  assert.deepEqual(collection.sections.map((section: { id: string }) => section.id), ['airport', 'hotel']);
  assert.equal(collection.sections[0].sentences.length, 8);
  const callArgs = readFileSync(calls, 'utf8').trim().split('\n').map(line => JSON.parse(line) as string[]);
  assert.equal(callArgs.length, 2);
  for (const args of callArgs) {
    assert.deepEqual(args.slice(0, 7), ['exec', '--sandbox', 'read-only', '--ignore-rules', '--skip-git-repo-check', '-m', 'test-model']);
    assert.equal(args[args.indexOf('--output-schema') + 1], join(root, 'out', 'generation-work', 'output-schema.json'));
  }

  // A second run reuses each section's result instead of calling Codex again.
  const again = run(generator, [join(root, 'brief.json'), output], { CODEX_BIN: codex, FAKE_CODEX_CALLS: calls });
  assert.equal(again.status, 0, again.stderr);
  assert.equal(readFileSync(calls, 'utf8').trim().split('\n').length, 2);
});

test('the themed generator retries a section that fails validation, then gives up', () => {
  const { root, codex, calls } = setup();
  const output = join(root, 'collection.json');
  const quoting = JSON.stringify({
    sectionId: 'airport',
    sentences: Array.from({ length: 8 }, (_, index) => ({
      text: `According to Mike, line ${index + 1} is how you hold the reservation politely.`,
      focus: 'hold the reservation',
    })),
  });

  const result = run(generator, [join(root, 'brief.json'), output], {
    CODEX_BIN: codex, FAKE_CODEX_CALLS: calls, FAKE_CODEX_OUTPUT: quoting, CODEX_CONCURRENCY: '1',
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /practice lines must not impersonate or quote the source/);
  assert.equal(readFileSync(calls, 'utf8').trim().split('\n').length, 3);
  assert.equal(existsSync(output), false);
  assert.deepEqual(readdirSync(root).filter(name => name.startsWith('collection')), []);
});

test('the collection audit writes its report only after checking it, and leaves an earlier report alone otherwise', () => {
  const { root, codex } = setup();
  const output = join(root, 'out', 'collection.json');
  assert.equal(run(generator, [join(root, 'brief.json'), output], { CODEX_BIN: codex }).status, 0);
  const report = join(root, 'out', 'report.json');
  const issue = (sectionId: string, sentenceNumber: number) => ({
    sectionId,
    sentenceNumber,
    severity: 'should_fix',
    reason: 'Repeats a scenario the section already covers.',
    replacementText: 'Could you hold the reservation until noon while I find my passport?',
    replacementFocus: 'hold the reservation',
  });
  const auditWith = (env: Record<string, string>) =>
    run(audit, [output, join(root, 'brief.json'), report], { CODEX_BIN: codex, ...env });

  const passed = auditWith({ FAKE_CODEX_OUTPUT: JSON.stringify({ verdict: 'changes_required', issues: [issue('hotel', 2)] }) });
  assert.equal(passed.status, 0, passed.stderr);
  assert.match(passed.stderr, /Audit changes_required: 1 issue\(s\)/);
  assert.deepEqual(JSON.parse(readFileSync(report, 'utf8')).issues, [issue('hotel', 2)]);

  writeFileSync(report, 'the earlier report');
  const unknownEntry = auditWith({ FAKE_CODEX_OUTPUT: JSON.stringify({ verdict: 'changes_required', issues: [issue('hotel', 40)] }) });
  assert.notEqual(unknownEntry.status, 0);
  assert.match(unknownEntry.stderr, /Audit referenced an unknown entry: hotel\/40/);
  const codexFailed = auditWith({ FAKE_CODEX_EXIT: '3' });
  assert.notEqual(codexFailed.status, 0);
  assert.match(codexFailed.stderr, /Codex exited with 3/);
  assert.equal(readFileSync(report, 'utf8'), 'the earlier report');
  assert.equal(existsSync(`${report}.tmp`), false);
});
