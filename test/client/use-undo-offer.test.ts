import assert from 'node:assert/strict';
import test from 'node:test';
import { undoOfferMessage } from '../../hooks/useUndoOffer.ts';
import type { SRSData, StoredItem } from '../../types.ts';

const srs = (id: string, type: SRSData['type']): SRSData => ({
  id, type, nextReview: 0, interval: 0, memoryStrength: 0, lastReviewDate: 0, totalReviews: 0, correctStreak: 0, stability: 0.5,
});

test('the undo pill names a sentence as it reads, without its {{ }} and [[ ]] markers, and a word or phrase by its title', () => {
  const sentence: StoredItem = { type: 'sentence', data: { id: 's1', text: 'She {{ran}} to the [[station]].', sourceWord: 'run' }, srs: srs('s1', 'sentence'), savedAt: 1 };
  assert.equal(undoOfferMessage('Deleted', sentence), 'Deleted “She ran to the station.”');
  const word: StoredItem = {
    type: 'vocab',
    data: { id: 'w1', word: 'gamut', chinese: '', ipa: '', definition: '', synonyms: [], antonyms: [], confusables: [], examples: [], history: '', register: '', mnemonic: '' },
    srs: srs('w1', 'vocab'),
    savedAt: 1,
  };
  assert.equal(undoOfferMessage('Archived', word), 'Archived “gamut”');
});
