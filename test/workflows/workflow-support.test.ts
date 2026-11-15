import assert from 'node:assert/strict';
import test from 'node:test';
import { block, blocks, entry, jobs, runs, settings, steps } from './support/workflow.ts';

const sample = [
  'name: Sample',
  'on:',
  '  workflow_dispatch:',
  'jobs:',
  '  first:',
  '    runs-on: ubuntu-latest',
  '    steps:',
  '      # A comment before the first step belongs to no step.',
  '      - name: Clip',
  '        run: |',
  '          echo one',
  '            indented',
  '',
  '          echo two',
  '',
  '      - run: echo inline # a YAML comment, not part of the command',
  '      - name: Strip',
  '        env:',
  '          REMOTE_SCRIPT: |-',
  '            run: this line is script text, not a key',
  '            echo strip',
  '        run: bash send.sh',
  '  second:',
  '    steps:',
  '      - uses: actions/checkout@0000000000000000000000000000000000000000 # v0',
  '        with:',
  '          sparse-checkout: |+',
  '            a.sh',
  '',
  '      - name: Keep',
  '        run: |',
  '          echo keep',
  '',
].join('\n');

test('block scalars follow YAML: dedented, ended by a shallower line, with their chomping', () => {
  assert.deepEqual(runs(sample), ['echo one\n  indented\n\necho two\n', 'echo inline', 'bash send.sh', 'echo keep\n']);
  assert.equal(block(sample, 'REMOTE_SCRIPT'), 'run: this line is script text, not a key\necho strip');
  assert.equal(block(sample, 'sparse-checkout'), 'a.sh\n\n');
  assert.deepEqual(blocks(sample, 'run'), ['echo one\n  indented\n\necho two\n', 'echo keep\n']);
  assert.throws(() => block(sample, 'script'), /no script: \| block/);
});

test('workflow expressions are filled in only where a value is given', () => {
  const text = 'steps:\n  - script: |\n      echo ${{ github.sha }} ${{ github.run_id }}\n';
  assert.equal(block(text, 'script', { 'github.sha': 'abc' }), 'echo abc ${{ github.run_id }}\n');
});

test('steps run from their list item to the next one or the end of their job, and jobs split at their keys', () => {
  const found = steps(sample);
  assert.equal(found.length, 5);
  assert.ok(found[0].startsWith('      - name: Clip\n'));
  assert.ok(found[0].endsWith('echo two'));
  assert.equal(found[1], '      - run: echo inline # a YAML comment, not part of the command');
  assert.ok(found[2].endsWith('run: bash send.sh'), 'a step ends where its job does');
  assert.ok(found[3].startsWith('      - uses: actions/checkout@'));
  assert.deepEqual([...jobs(sample).keys()], ['first', 'second']);
  assert.match(jobs(sample).get('second') ?? '', /^ {2}second:\n/);
});

test('mapping entries and their settings', () => {
  const text = 'permissions:\n  # read only\n  contents: read\njobs:\n  build:\n    permissions:\n      packages: write\n';
  assert.deepEqual(settings(entry(text, 'permissions', 0)), ['contents: read']);
  assert.deepEqual(settings(entry(entry(text, 'build', 2), 'permissions', 4)), ['packages: write']);
  assert.throws(() => entry(text, 'concurrency', 0), /concurrency: at indentation 0 not found/);
});

test('styles these helpers would misread throw instead of dropping out of a check', () => {
  assert.throws(() => runs('steps:\n  - run: >\n      echo folded\n'), /block scalar ">" is not one these tests read/);
  assert.throws(() => runs('steps:\n  - run: |2\n      echo indented\n'), /block scalar "\|2" is not one these tests read/);
  assert.throws(() => runs('steps:\n  - run: "echo quoted"\n'), /quoted run values are not read/);
});
