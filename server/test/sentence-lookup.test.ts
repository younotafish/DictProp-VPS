import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import {
  exampleSentenceId, normalizeSentenceLookup, sentenceLookupHash, sentenceTextHash,
} from '../src/sentence-lookup.js';
import { SERVER_DIR } from './support/paths.js';

const cases: Array<[string, string]> = [
  ['Keep {{going}} until the [[end]].', 'keep going until the end.'],
  ['I don’t know.', "i don't know."],
  ['I don\'t know.', "i don't know."],
  ['She said “enough” and left.', 'she said "enough" and left.'],
  ['Pages 4–5 — not 6.', 'pages 4-5 - not 6.'],
  ['A ﬁne day.', 'a fine day.'],
  ['{{a [[nested]] target}} and [[a {{nested}} lookup]]', 'a nested target and a nested lookup'],
  ['{{ad}}{{jacent}} [[mark]][[ers]]', 'adjacent markers'],
  ['  Tabs\tand\nnewlines\r\n  collapse. ', 'tabs and newlines collapse.'],
  ['Unclosed {{marker and [[stray]', 'unclosed {{marker and [[stray]'],
  ['', ''],
];

test('a sentence\'s lookup form drops markers and folds case, quotes, dashes, compatibility forms and spacing', () => {
  for (const [text, lookup] of cases) assert.equal(normalizeSentenceLookup(text), lookup, text);
  assert.equal(sentenceLookupHash('I don’t {{know}}.'), createHash('sha256').update("i don't know.").digest('hex'));
  assert.equal(sentenceLookupHash('I don’t {{know}}.'), sentenceLookupHash("i don't know."));
});

test('an example\'s id is its lookup hash cut to 40 characters, and its text hash covers the exact text', () => {
  const lookupHash = sentenceLookupHash('Keep {{going}}.');
  assert.equal(exampleSentenceId(lookupHash), `example-${lookupHash.slice(0, 40)}`);
  assert.equal(sentenceTextHash('Keep {{going}}.'), createHash('sha256').update('Keep {{going}}.').digest('hex'));
  // An edit the lookup form ignores still changes the text hash.
  assert.equal(sentenceLookupHash('Keep going.'), sentenceLookupHash('keep  going.'));
  assert.notEqual(sentenceTextHash('Keep going.'), sentenceTextHash('keep  going.'));
});

test('plain node loads the module, as the offline scripts will, so it can have no relative imports', () => {
  const url = pathToFileURL(`${SERVER_DIR}/src/sentence-lookup.ts`).href;
  const script = `import * as lookup from ${JSON.stringify(url)};
    const hash = lookup.sentenceLookupHash('I don’t {{know}}.');
    process.stdout.write(JSON.stringify([hash, lookup.exampleSentenceId(hash), lookup.sentenceTextHash('x')]));`;
  const { NODE_OPTIONS: _nodeOptions, ...env } = process.env;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8', env });
  assert.equal(child.status, 0, child.stderr);
  const hash = sentenceLookupHash('I don’t {{know}}.');
  assert.deepEqual(JSON.parse(child.stdout), [hash, exampleSentenceId(hash), sentenceTextHash('x')]);
});
