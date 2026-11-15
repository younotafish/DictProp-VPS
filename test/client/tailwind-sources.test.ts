import assert from 'node:assert/strict';
import { existsSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import test from 'node:test';
import { readRepoFile, REPO_ROOT, repoPath } from '../support/paths.ts';

// src/index.css names the files Tailwind scans for class names. A component outside them would lose every utility
// only it uses, which shows only in a browser, so this checks the list against the code instead.

/** Folders with no client code: dependencies, builds, data, private files, the server and the tests. */
const NOT_CLIENT = new Set(['.git', '.tools', 'node_modules', 'dist', 'data', 'tmp', 'personal_1', 'server', 'test']);

/** Every .tsx file outside those folders, as a path from the repository root. */
function componentFiles(directory = REPO_ROOT): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return directory === REPO_ROOT && NOT_CLIENT.has(entry.name) ? [] : componentFiles(path);
    return entry.name.endsWith('.tsx') ? [relative(REPO_ROOT, path)] : [];
  });
}

test('Tailwind scans every file and folder of client code that holds components', () => {
  const css = readRepoFile('src/index.css');
  assert.match(css, /^@import "tailwindcss" source\(none\);$/m, 'automatic detection stays off');
  const sources = [...css.matchAll(/^@source "\.\.\/([^"]+)";$/gm)].map(match => match[1]);
  for (const source of sources) assert.ok(existsSync(repoPath(source)), `@source "../${source}" names nothing`);

  const files = componentFiles();
  assert.ok(files.length > 40, `found ${files.length} component files`);
  for (const file of files) {
    const scanned = sources.some(source => file === source || file.startsWith(`${source}/`));
    assert.ok(scanned, `${file} holds components, but src/index.css has no @source for it, so Tailwind would skip its classes`);
  }
});
