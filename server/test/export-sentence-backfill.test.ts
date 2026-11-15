import assert from 'node:assert/strict';
import test from 'node:test';
import { completeAnalysis } from './support/fixtures.js';
import { sha256 } from './support/fs.js';
import { addItemImage, createOwner, runScript, saveItem } from './support/library.js';

const { softDeleteItem } = await import('../src/db.js');

const owner = createOwner();
const save = (id: string, type: string, data: Record<string, unknown>) => saveItem(owner.id, id, type, data);
const legacyAnalysis = {
  translation: '新的。',
  americanEnglish: { status: 'shared', explanation: 'Natural shared English.' },
  terms: [],
  imagePrompt: 'A realistic photograph of something new, without text.',
};

save('sb-complete', 'sentence', {
  text: 'Her {{candid}} reply surprised us.', sourceWord: 'candid', sourceSense: 'adj: frank', analysis: completeAnalysis,
});
addItemImage(owner.id, 'sb-complete');
save('sb-legacy', 'sentence', { text: 'A lucid plan emerged.', sourceWord: 'lucid', analysis: legacyAnalysis });
save('sb-bare', 'sentence', { text: 'Nothing analysed yet.', sourceWord: '' });
save('sb-deleted', 'sentence', { text: 'Gone already.', sourceWord: 'gone' });
softDeleteItem('sb-deleted', owner.id);
save('sb-vocab', 'vocab', { word: 'candid' });

test('the saved-sentence export lists each live sentence with its text hash and what it already has', () => {
  const before = Date.now();
  const run = runScript('export-sentence-backfill');
  const after = Date.now();
  assert.equal(run.status, 0, run.stderr);

  const exported = JSON.parse(run.stdout);
  assert.equal(run.stdout, JSON.stringify(exported));
  assert.deepEqual(Object.keys(exported), ['version', 'exportedAt', 'sentences']);
  assert.equal(exported.version, 1);
  assert.ok(exported.exportedAt >= before && exported.exportedAt <= after);
  assert.deepEqual(exported.sentences, [
    {
      id: 'sb-complete',
      text: 'Her {{candid}} reply surprised us.',
      sourceWord: 'candid',
      sourceSense: 'adj: frank',
      textHash: sha256('Her {{candid}} reply surprised us.'),
      hasAnalysis: true,
      hasGrammar: true,
      hasDetailedAnalysis: true,
      hasImage: true,
    },
    {
      id: 'sb-legacy',
      text: 'A lucid plan emerged.',
      sourceWord: 'lucid',
      textHash: sha256('A lucid plan emerged.'),
      hasAnalysis: true,
      hasGrammar: false,
      hasDetailedAnalysis: false,
      hasImage: false,
    },
    {
      id: 'sb-bare',
      text: 'Nothing analysed yet.',
      sourceWord: '',
      textHash: sha256('Nothing analysed yet.'),
      hasAnalysis: false,
      hasGrammar: false,
      hasDetailedAnalysis: false,
      hasImage: false,
    },
  ]);
});
