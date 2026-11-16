import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeSearchText } from '../../services/searchText.ts';
import { normalizeSentenceIdentity } from '../../services/sentenceIdentity.ts';

test('search text is lowercased, without accents, with straight apostrophes', () => {
  assert.equal(normalizeSearchText('I’d rather'), "i'd rather");
  assert.equal(normalizeSearchText('‘Tis'), "'tis");
  assert.equal(normalizeSearchText('Entrée'), 'entree');
  assert.equal(normalizeSearchText('SAUTÉED Crème Brûlée'), 'sauteed creme brulee');
  assert.equal(normalizeSearchText("can't"), "can't");
});

test('curly double quotes and en and em dashes fold to the plain ones, as a sentence identity folds them', () => {
  assert.equal(normalizeSearchText('“Quick fix”'), '"quick fix"');
  assert.equal(normalizeSearchText('well–known'), 'well-known');
  assert.equal(normalizeSearchText('the rollout—how did it go?'), 'the rollout-how did it go?');
  // The punctuation folds are a sentence identity's (which keeps accents and collapses spaces besides).
  for (const text of ['“A” – b — ‘c’', 'Hello, “world”!']) {
    assert.equal(normalizeSearchText(text), normalizeSentenceIdentity(text));
  }
});
