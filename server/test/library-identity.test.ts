import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeLabel, sentenceIdentityKey, sentenceTextKey, vocabSenseKey } from '../src/library-identity.js';

test('labels compare without case, outer spacing or repeated inner spacing', () => {
  assert.equal(normalizeLabel('  Limpid \t Prose\n'), 'limpid prose');
  assert.equal(normalizeLabel(undefined), '');
  assert.equal(normalizeLabel(0), '');
  assert.equal(vocabSenseKey('Candid ', 'ADJ:  frank'), vocabSenseKey('candid', 'adj: frank'));
  assert.notEqual(vocabSenseKey('candid', 'adj: frank'), vocabSenseKey('candid', 'noun: frankness'));
  // The separator keeps a word ending where a sense begins from shifting between the two.
  assert.notEqual(vocabSenseKey('a b', 'c'), vocabSenseKey('a', 'b c'));
});

test('a saved sentence is one sentence whatever its markers, and one saved item per source card', () => {
  assert.equal(sentenceTextKey('Keep {{going}} until the [[end]].'), sentenceTextKey('keep going until the end.'));
  assert.equal(sentenceTextKey(undefined), '');
  assert.equal(
    sentenceIdentityKey('Keep {{going}}.', 'Candid', undefined),
    sentenceIdentityKey('keep going.', 'candid', ''),
  );
  assert.notEqual(
    sentenceIdentityKey('Keep going.', 'candid', 'adj: frank'),
    sentenceIdentityKey('Keep going.', 'candid', 'adj: open'),
  );
});
