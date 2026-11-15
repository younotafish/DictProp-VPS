import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeSearchText } from '../../services/searchText.ts';

test('search text is lowercased, without accents, with straight apostrophes', () => {
  assert.equal(normalizeSearchText('I’d rather'), "i'd rather");
  assert.equal(normalizeSearchText('‘Tis'), "'tis");
  assert.equal(normalizeSearchText('Entrée'), 'entree');
  assert.equal(normalizeSearchText('SAUTÉED Crème Brûlée'), 'sauteed creme brulee');
  assert.equal(normalizeSearchText("can't"), "can't");
});
