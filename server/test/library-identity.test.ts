import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeLabel, sentenceIdentityKey, sentenceTextKey, vocabSenseKey } from '../src/library-identity.js';
import { normalizeSentenceLookup } from '../src/sentence-lookup.js';

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

test('a saved sentence is compared as the server looks it up: quotes, dashes and full-width forms folded', () => {
  const curly = 'I don\u2019t know \u2014 \u201creally\u201d.';
  assert.equal(sentenceTextKey(curly), sentenceTextKey("I don't know - \"really\"."));
  assert.equal(sentenceTextKey('\uff2b\uff45\uff45\uff50 going.'), sentenceTextKey('Keep going.'));
  for (const text of [curly, 'Keep {{going}} until the [[end]].', '  Two\t spaces  ']) {
    assert.equal(sentenceTextKey(text), normalizeSentenceLookup(text));
  }
  assert.equal(
    sentenceIdentityKey(curly, 'candid', 'adj: frank'),
    sentenceIdentityKey("i don't know - \"really\".", 'Candid', 'adj:  frank'),
  );
});
