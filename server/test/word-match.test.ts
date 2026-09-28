import assert from 'node:assert/strict';
import test from 'node:test';
import { SRSAlgorithm } from '../../services/srsAlgorithm.ts';
import { buildVariantIndex, matchBaseWords } from '../../services/wordMatch.ts';
import type { StoredItem, VocabCard } from '../../types.ts';

const vocab = (word: string, forms: string[] = []): StoredItem => {
  const data: VocabCard = {
    id: word, word, chinese: '', ipa: '', definition: word, forms,
    synonyms: [], antonyms: [], confusables: [], examples: [], history: '', register: '', mnemonic: '',
  };
  return { data, type: 'vocab', savedAt: 0, srs: SRSAlgorithm.createNew(word, 'vocab') };
};

test('saved words match their inflections and listed forms', () => {
  const index = buildVariantIndex([vocab('run', ['ran', 'runs / running']), vocab('cat')]);
  assert.deepEqual([...matchBaseWords('ran', index)], ['run']);
  assert.deepEqual([...matchBaseWords('Running', index)], ['run']);
  assert.deepEqual([...matchBaseWords('cats', index)], ['cat']);
  assert.equal(matchBaseWords('dog', index).size, 0);
});

test('a rebuilt index follows replaced cards and leaves out deleted ones', () => {
  const run = vocab('run', ['ran']);
  const cat = vocab('cat');
  buildVariantIndex([run, cat]);

  const edited: StoredItem = { ...run, data: { ...(run.data as VocabCard), forms: ['sprinted'] } };
  const index = buildVariantIndex([edited, { ...cat, isDeleted: true }]);
  assert.deepEqual([...matchBaseWords('sprinted', index)], ['run']);
  assert.equal(matchBaseWords('ran', index).size, 0);
  assert.equal(matchBaseWords('cats', index).size, 0);
});
