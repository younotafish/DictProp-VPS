import assert from 'node:assert/strict';
import test from 'node:test';
import { keepServerOwnedData, SERVER_OWNED_FIELDS } from '../../server/src/shared/server-owned-data.ts';
import { mergeItem } from '../../services/sync.ts';
import type { StoredItem } from '../../types.ts';

// Only server-side jobs write the server-owned fields, and a device can save an item from a copy made before such a
// job ran. The server's write path keeps the stored value of a field that save leaves out, and the client's merge keeps
// the server's value under the device's unsynced edit. A field only one side kept would be lost on the next sync.

type Data = Record<string, unknown> & { id: string };

/** A copy of an item at server revision 5: the server's, or this device's with an edit it hasn't pushed yet. */
const copyAtRevision5 = (type: StoredItem['type'], data: Data, unsyncedEdit: boolean) => ({
  type,
  data,
  srs: {
    id: data.id, type, nextReview: 0, interval: 0, memoryStrength: 0, lastReviewDate: 0, totalReviews: 0,
    correctStreak: 0, stability: 0.5,
  },
  savedAt: 1,
  updatedAt: unsyncedEdit ? 2 : 1,
  serverRevision: 5,
  ...(unsyncedEdit ? { lastSyncedHash: 'the copy before the edit' } : {}),
}) as unknown as StoredItem;

/** The server's write path: the data it stores when a save of `saved` meets its `stored` copy. */
const serverKeeps = (type: StoredItem['type'], saved: Data, stored: Data): unknown =>
  keepServerOwnedData(saved, type, stored, type);

/** The client's merge: the data this device keeps when its edited `saved` copy meets the server's `stored` one. */
const clientKeeps = (type: StoredItem['type'], saved: Data, stored: Data): unknown =>
  mergeItem(copyAtRevision5(type, saved, true), copyAtRevision5(type, stored, false)).data;

test('a save that leaves out a server-owned field keeps the field, on the server and in the client merge', () => {
  assert.ok(SERVER_OWNED_FIELDS.length > 0);
  for (const field of SERVER_OWNED_FIELDS) {
    const value = { writtenBy: 'a server-side job' };
    const stored = { id: 'card', word: 'card', definition: 'as the job left it', [field]: value };
    const saved = { id: 'card', word: 'card', definition: 'edited on a device' };
    const kept = { ...saved, [field]: value };
    assert.deepEqual(serverKeeps('vocab', saved, stored), kept, `server, ${field}`);
    assert.deepEqual(clientKeeps('vocab', saved, stored), kept, `client, ${field}`);
  }
});

test('both sides keep a phrase vocab\'s fields by its id, and a sentence\'s analysis only for the text it analyzed', () => {
  const audit = { status: 'modern_american' };
  const enrichment = { version: 1 };
  const analysis = { translation: 'The same text, translated.' };
  const storedPhrase = {
    id: 'phrase', query: 'query',
    vocabs: [{ id: 'a', word: 'a', usageAudit: audit }, { id: 'b', word: 'b', advancedEnrichment: enrichment }],
  };
  const storedSentence = { id: 'sentence', text: 'The same text.', sourceWord: 'same', analysis, analysisGeneratedAt: 7 };
  const cases: Array<{ name: string; type: StoredItem['type']; saved: Data; stored: Data; kept: Data }> = [
    {
      name: 'phrase',
      type: 'phrase',
      saved: { id: 'phrase', query: 'edited query', vocabs: [{ id: 'b', word: 'b' }, { id: 'c', word: 'c' }] },
      stored: storedPhrase,
      kept: {
        id: 'phrase', query: 'edited query', vocabs: [{ id: 'b', word: 'b', advancedEnrichment: enrichment }, { id: 'c', word: 'c' }],
      },
    },
    {
      name: 'sentence with its text',
      type: 'sentence',
      saved: { id: 'sentence', text: 'The same text.', sourceWord: 'edited' },
      stored: storedSentence,
      kept: { id: 'sentence', text: 'The same text.', sourceWord: 'edited', analysis, analysisGeneratedAt: 7 },
    },
    {
      name: 'sentence with new text',
      type: 'sentence',
      saved: { id: 'sentence', text: 'Another text.', sourceWord: 'same' },
      stored: storedSentence,
      kept: { id: 'sentence', text: 'Another text.', sourceWord: 'same' },
    },
  ];
  for (const { name, type, saved, stored, kept } of cases) {
    assert.deepEqual(serverKeeps(type, saved, stored), kept, `server, ${name}`);
    assert.deepEqual(clientKeeps(type, saved, stored), kept, `client, ${name}`);
  }
});
