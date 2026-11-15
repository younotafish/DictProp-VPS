import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import test from 'node:test';
import { readRepoFile, repoPath } from '../support/paths.ts';

// scripts/offline/README.md gives each file in the folder one entry, a line starting "- `name` — ", under the heading
// that says how the file runs. A new script has to be classified there, and a deleted one has to leave.
const entryLine = /^- `([^`]+)` — /;

test('the offline scripts index has one entry for every file in scripts/offline, and none for a missing file', () => {
  const files = readdirSync(repoPath('scripts', 'offline'), { withFileTypes: true })
    .filter(entry => entry.isFile() && !entry.name.startsWith('.') && entry.name !== 'README.md')
    .map(entry => entry.name);
  const entries = readRepoFile('scripts/offline/README.md').split('\n')
    .map(line => entryLine.exec(line)?.[1])
    .filter((name): name is string => name !== undefined);

  assert.deepEqual(entries.filter((name, index) => entries.indexOf(name) !== index), [], 'files with more than one entry');
  assert.deepEqual(files.filter(name => !entries.includes(name)).sort(), [], 'files with no entry in scripts/offline/README.md');
  assert.deepEqual(entries.filter(name => !files.includes(name)), [], 'entries for files that no longer exist');
});
