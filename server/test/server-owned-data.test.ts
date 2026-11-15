import assert from 'node:assert/strict';
import test from 'node:test';
import { keepServerOwnedData, SERVER_OWNED_FIELDS, withServerOwnedFields } from '../src/shared/server-owned-data.js';

const audit = { status: 'current_general', reason: 'Normal in current American English.', confidence: 'high', auditedAt: 1 };
const advanced = { version: 1, provider: 'claude-code', model: 'm', generatedAt: 2, contentHash: 'a'.repeat(64) };
const localImage = { version: 1, provider: 'local-ernie', model: 'm', generatedAt: 3, promptHash: 'b'.repeat(64) };
const analysis = { translation: 'x', americanEnglish: { status: 'shared', explanation: 'x' }, terms: [] };

test('the server owns the usage audit and the two enrichment markers', () => {
  assert.deepEqual(SERVER_OWNED_FIELDS, ['usageAudit', 'advancedEnrichment', 'localImageEnrichment']);
});

test('a write keeps the stored server-owned fields it leaves out, and its own values win', () => {
  const stored = { id: 'w', word: 'lucid', usageAudit: audit, advancedEnrichment: advanced, localImageEnrichment: localImage };
  const reaudit = { ...audit, reason: 'Common in the US.' };
  assert.deepEqual(keepServerOwnedData({ id: 'w', word: 'lucid', definition: 'clear', usageAudit: reaudit }, 'vocab', stored, 'vocab'), {
    id: 'w', word: 'lucid', definition: 'clear', usageAudit: reaudit, advancedEnrichment: advanced, localImageEnrichment: localImage,
  });
});

test('nothing to keep returns the same object, and the input is never changed', () => {
  const data = { id: 'w', word: 'lucid' };
  assert.equal(keepServerOwnedData(data, 'vocab', { id: 'w', word: 'old' }, 'vocab'), data);
  const kept = keepServerOwnedData(data, 'vocab', { id: 'w', usageAudit: audit }, 'vocab');
  assert.notEqual(kept, data);
  assert.deepEqual(data, { id: 'w', word: 'lucid' });
  assert.equal(withServerOwnedFields(data, undefined), data);
});

test('an item of another type, or no stored object, keeps nothing', () => {
  const data = { id: 'w', text: 'A lucid account.' };
  assert.equal(keepServerOwnedData(data, 'sentence', { id: 'w', usageAudit: audit }, 'vocab'), data);
  assert.equal(keepServerOwnedData(data, 'sentence', null, 'sentence'), data);
  assert.equal(keepServerOwnedData(data, 'sentence', 'not an item', 'sentence'), data);
});

test('a sentence keeps its analysis only while its text is unchanged', () => {
  const stored = { id: 's', text: 'A lucid account.', analysis, analysisGeneratedAt: 7 };
  assert.deepEqual(keepServerOwnedData({ id: 's', text: 'A lucid account.', preferredSpeechStyle: 'casual' }, 'sentence', stored, 'sentence'), {
    id: 's', text: 'A lucid account.', preferredSpeechStyle: 'casual', analysis, analysisGeneratedAt: 7,
  });
  const edited = { id: 's', text: 'A lucid, calm account.' };
  assert.equal(keepServerOwnedData(edited, 'sentence', stored, 'sentence'), edited);
  // Only a sentence keeps an analysis.
  const vocab = { id: 's', text: 'A lucid account.' };
  assert.equal(keepServerOwnedData(vocab, 'vocab', stored, 'vocab'), vocab);
});

test('a phrase keeps each vocab\'s fields by vocab id, not by position', () => {
  const stored = {
    id: 'p', query: 'lucid dream', localImageEnrichment: localImage,
    vocabs: [{ id: 'lucid', usageAudit: audit, advancedEnrichment: advanced }, { id: 'dream', localImageEnrichment: localImage }, 'stray'],
  };
  const data = { id: 'p', query: 'lucid dream', vocabs: [{ id: 'dream' }, { id: 'lucid', definition: 'clear' }, { id: 'vivid' }, null, { word: 'no id' }] };
  assert.deepEqual(keepServerOwnedData(data, 'phrase', stored, 'phrase'), {
    id: 'p', query: 'lucid dream', localImageEnrichment: localImage,
    vocabs: [
      { id: 'dream', localImageEnrichment: localImage },
      { id: 'lucid', definition: 'clear', usageAudit: audit, advancedEnrichment: advanced },
      { id: 'vivid' },
      null,
      { word: 'no id' },
    ],
  });
  const unchanged = { id: 'p', query: 'lucid dream', localImageEnrichment: localImage, vocabs: [{ id: 'vivid' }] };
  assert.equal(keepServerOwnedData(unchanged, 'phrase', stored, 'phrase'), unchanged);
});
