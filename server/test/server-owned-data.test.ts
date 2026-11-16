import assert from 'node:assert/strict';
import test from 'node:test';
import { keepServerOwnedData, SERVER_OWNED_FIELDS, serverOwnedPart, withServerOwnedFields } from '../src/shared/server-owned-data.js';

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

/** Keeping from the stored copy's server-owned part keeps exactly what keeping from the whole stored copy does. */
const assertPartKeepsTheSame = (type: string, stored: unknown, copies: unknown[]) => {
  const part = serverOwnedPart(stored, type);
  // As the PUT reply carries it.
  const sent = part === undefined ? undefined : JSON.parse(JSON.stringify(part));
  for (const copy of copies) {
    assert.deepEqual(keepServerOwnedData(copy, type, sent, type), keepServerOwnedData(copy, type, stored, type), JSON.stringify(copy));
  }
};

test('a vocab\'s server-owned part is its server-owned fields, and keeping from it keeps the same', () => {
  const stored = { id: 'w', word: 'lucid', definition: 'clear', usageAudit: audit, advancedEnrichment: advanced, localImageEnrichment: localImage };
  assert.deepEqual(serverOwnedPart(stored, 'vocab'), { usageAudit: audit, advancedEnrichment: advanced, localImageEnrichment: localImage });
  assertPartKeepsTheSame('vocab', stored, [
    { id: 'w', word: 'lucid', definition: 'edited' },
    { id: 'w', word: 'lucid', usageAudit: { ...audit, reason: 'Common in the US.' } },
    { id: 'w', word: 'lucid', advancedEnrichment: advanced, localImageEnrichment: localImage, usageAudit: audit },
  ]);
});

test('a phrase\'s part holds each vocab\'s fields by id, the last vocab of an id counting, as when keeping', () => {
  const stored = {
    id: 'p', query: 'lucid dream', localImageEnrichment: localImage,
    vocabs: [
      { id: 'lucid', word: 'lucid', usageAudit: audit, advancedEnrichment: advanced },
      { id: 'dream', word: 'dream', localImageEnrichment: localImage },
      { id: 'twice', usageAudit: audit },
      { id: 'twice', word: 'twice' },
      { id: 'plain', word: 'plain' },
      'stray', null, { word: 'no id' },
    ],
  };
  assert.deepEqual(serverOwnedPart(stored, 'phrase'), {
    localImageEnrichment: localImage,
    vocabs: [{ id: 'lucid', usageAudit: audit, advancedEnrichment: advanced }, { id: 'dream', localImageEnrichment: localImage }],
  });
  assertPartKeepsTheSame('phrase', stored, [
    { id: 'p', query: 'lucid dream', vocabs: [{ id: 'dream' }, { id: 'twice' }, { id: 'lucid', definition: 'clear' }, { id: 'vivid' }, null, { word: 'no id' }] },
    { id: 'p', query: 'edited', localImageEnrichment: localImage, vocabs: [{ id: 'lucid', usageAudit: audit }] },
    { id: 'p', query: 'no vocabs here' },
  ]);
});

test('a sentence\'s part holds its analysis with the text it analyzed, so only a copy with that text keeps it', () => {
  const stored = { id: 's', text: 'A lucid account.', sourceWord: 'lucid', analysis, analysisGeneratedAt: 7, usageAudit: audit };
  assert.deepEqual(serverOwnedPart(stored, 'sentence'), { usageAudit: audit, text: 'A lucid account.', analysis, analysisGeneratedAt: 7 });
  assertPartKeepsTheSame('sentence', stored, [
    { id: 's', text: 'A lucid account.', preferredSpeechStyle: 'casual' },
    { id: 's', text: 'A lucid, calm account.' },
    { id: 's', text: 'A lucid account.', analysis: { ...analysis, translation: 'its own' } },
  ]);
  // An analysis stored without its time still goes, as keeping from the stored copy takes it.
  const untimed = { id: 's', text: 'A lucid account.', analysis };
  assert.deepEqual(serverOwnedPart(untimed, 'sentence'), { text: 'A lucid account.', analysis });
  assertPartKeepsTheSame('sentence', untimed, [{ id: 's', text: 'A lucid account.' }]);
});

test('there is no server-owned part when a stored copy has nothing to keep', () => {
  assert.equal(serverOwnedPart({ id: 'w', word: 'lucid', definition: 'clear' }, 'vocab'), undefined);
  assert.equal(serverOwnedPart({ id: 's', text: 'A lucid account.' }, 'sentence'), undefined);
  assert.equal(serverOwnedPart({ id: 'p', query: 'q', vocabs: [{ id: 'a', word: 'a' }] }, 'phrase'), undefined);
  // Only a sentence keeps an analysis, and only a phrase its vocabs' fields.
  assert.equal(serverOwnedPart({ id: 'v', text: 'A lucid account.', analysis }, 'vocab'), undefined);
  assert.equal(serverOwnedPart({ id: 'v', vocabs: [{ id: 'a', usageAudit: audit }] }, 'vocab'), undefined);
  for (const stored of [undefined, null, 'not an item', 42]) assert.equal(serverOwnedPart(stored, 'vocab'), undefined);
});
