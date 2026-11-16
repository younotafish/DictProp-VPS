import assert from 'node:assert/strict';
import test from 'node:test';
import type { SentenceData, StoredItem } from '../../types.ts';
import { SRSAlgorithm } from '../../services/srsAlgorithm.ts';
import { withSpeechStyle } from '../../views/detail/speechStyle.ts';

// views/detail/speechStyle.ts: what sentence review saves when a sentence is heard, or its voice chosen.

const NOW = 1_700_000_000_000;

const sentence = (preferredSpeechStyle?: SentenceData['preferredSpeechStyle']): StoredItem => ({
  type: 'sentence',
  data: {
    id: 'sentence-1',
    text: 'She finally {{came clean}}.',
    sourceWord: 'come clean',
    ...(preferredSpeechStyle ? { preferredSpeechStyle } : {}),
  },
  savedAt: NOW - 86_400_000,
  updatedAt: NOW - 3_600_000,
  srs: { ...SRSAlgorithm.createNew('sentence-1', 'sentence', NOW - 86_400_000), lastExposureDate: NOW - 7_200_000 },
});

test('a sentence that already remembers the voice it was heard in writes nothing', () => {
  assert.equal(withSpeechStyle(sentence('casual'), 'casual', NOW), null);
  assert.equal(withSpeechStyle(sentence('clear'), 'clear', NOW), null);
});

test('another voice gives a copy that differs only in the voice and its updatedAt, with the same progress object', () => {
  const heard = sentence('clear');
  const updated = withSpeechStyle(heard, 'casual', NOW);
  assert.ok(updated);
  assert.notEqual(updated, heard);
  assert.equal(updated.srs, heard.srs, 'a listen is not a review, so the progress is the very same object');
  assert.deepEqual(updated, { ...heard, data: { ...heard.data, preferredSpeechStyle: 'casual' }, updatedAt: NOW });
  assert.equal((heard.data as SentenceData).preferredSpeechStyle, 'clear', 'the sentence it was given is untouched');
});

test('a sentence with no voice yet, like a catalog line before its first listen, takes the voice it was heard in', () => {
  const updated = withSpeechStyle(sentence(), 'clear', NOW);
  assert.equal((updated?.data as SentenceData | undefined)?.preferredSpeechStyle, 'clear');
});
