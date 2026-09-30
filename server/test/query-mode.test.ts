import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import * as client from '../../services/queryMode.ts';
import * as server from '../src/query-mode.js';

const SENTENCES = [
  'The cat sat on the mat',
  'The kids ran home',
  'My dad drove us there',
  'I think so',
  "She's been working all day",
  'There is a problem',
  'Do you want to go',
  'Can we talk later?',
  'The man walked home.',
  'It rained all day long yesterday, so we stayed in.',
  'We missed the bus again.',
  '我今天去银行存钱了',
  '你好，世界',
];

const PHRASES = [
  'bank',
  'run down',
  'a well kept secret',
  'a chain saw',
  'a long lost friend',
  'might as well',
  'the elephant in the room',
  'break the ice',
  'by and large',
  'a blessing in disguise',
  'Go away!',
  '银行',
  '不屈不挠',
];

test('the search box and the analysis route share one routing decision', () => {
  for (const input of [...SENTENCES, ...PHRASES, '', '   ', ' bank ', 'run the gamut.', 'Wait...']) {
    assert.equal(client.isWordOrPhrase(input), server.isWordOrPhrase(input), `isWordOrPhrase(${JSON.stringify(input)})`);
    assert.equal(client.looksLikeSentence(input), server.looksLikeSentence(input), `looksLikeSentence(${JSON.stringify(input)})`);
  }
  assert.equal(client.MAX_COMPARE_WORDS, server.MAX_COMPARE_WORDS);
  assert.equal(server.MAX_COMPARE_WORDS, 8);
});

test('a subject followed by a verb is a sentence', () => {
  for (const input of SENTENCES) assert.equal(server.isWordOrPhrase(input), false, input);
});

test('idioms and attributive participles stay one dictionary entry', () => {
  for (const input of PHRASES) assert.equal(server.isWordOrPhrase(input), true, input);
});

test('blank input is not a sentence', () => {
  assert.equal(server.looksLikeSentence('   '), false);
  assert.equal(server.looksLikeSentence('The kids ran home'), true);
});

test('the search box routes with the shared decision instead of a copy of its own', () => {
  const globalSearch = readFileSync(fileURLToPath(new URL('../../components/GlobalSearch.tsx', import.meta.url)), 'utf8');
  assert.match(globalSearch, /import \{ looksLikeSentence \} from '\.\.\/services\/queryMode'/);
  assert.doesNotMatch(globalSearch, /const looksLikeSentence\b/);
  // A refreshed expression keeps the batch mode it was first analyzed with.
  assert.match(globalSearch, /analyzeInput\(trimmed, analyzeMode \? \{ mode: analyzeMode \} : undefined\)/);
});
