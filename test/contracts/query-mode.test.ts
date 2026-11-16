import assert from 'node:assert/strict';
import test from 'node:test';
import * as server from '../../server/src/shared/query-mode.ts';

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

// The search box and the analysis route import this one module, so they share one routing decision
// (test/contracts/shared-contracts.test.ts keeps the client's runtime imports of server/src inside shared/).
test('a comparison takes at most eight words', () => {
  assert.equal(server.MAX_COMPARE_WORDS, 8);
});

test('surrounding space and closing punctuation do not change the routing', () => {
  for (const input of ['bank', ' bank ', 'run the gamut.', 'Wait...']) assert.equal(server.isWordOrPhrase(input), true, input);
  assert.equal(server.isWordOrPhrase('  The kids ran home.  '), false);
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
