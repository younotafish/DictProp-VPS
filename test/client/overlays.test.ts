import assert from 'node:assert/strict';
import test from 'node:test';
import { openDialogs, popupIsEmpty, type CardPopup } from '../../hooks/useOverlays.ts';
import type { StoredItem } from '../../types.ts';

// hooks/useOverlays.ts: which dialogs cover the page, and when the card popup has nothing left to show.

const sense = (id: string): StoredItem => ({
  type: 'vocab',
  data: { id, word: 'gamut', chinese: '', ipa: '', definition: '', synonyms: [], antonyms: [], confusables: [], examples: [], history: '', register: '', mnemonic: '' },
  srs: { id, type: 'vocab', nextReview: 0, interval: 0, memoryStrength: 0, lastReviewDate: 0, totalReviews: 0, correctStreak: 0, stability: 0.5 },
  savedAt: 1,
});
const popup: CardPopup = { spelling: 'gamut', initialId: 's1' };
const closed = {
  cardPopup: null, popupItems: [], confirmModal: null, showKeyboardHelp: false, showRefusedReviews: false, duplicateClusters: null,
};

test('the popup is empty once every sense it showed is gone, and a closed popup never is', () => {
  assert.equal(popupIsEmpty(popup, []), true);
  assert.equal(popupIsEmpty(popup, [sense('s1')]), false);
  assert.equal(popupIsEmpty(null, []), false);
  assert.equal(popupIsEmpty(null, [sense('s1')]), false);
});

test('each decision dialog is modal and covers the page', () => {
  const dialogs = {
    confirmModal: { confirmText: 'OK', onConfirm: () => {}, title: 'Delete?', message: 'Gone for good.' },
    showKeyboardHelp: true,
    showRefusedReviews: true,
    duplicateClusters: [],
  };
  assert.deepEqual(openDialogs(closed), { modalOpen: false, dialogOpen: false });
  for (const [name, open] of Object.entries(dialogs)) {
    assert.deepEqual(openDialogs({ ...closed, [name]: open }), { modalOpen: true, dialogOpen: true }, name);
  }
});

test('the card popup covers the page while it shows a card, without counting as modal', () => {
  assert.deepEqual(openDialogs({ ...closed, cardPopup: popup, popupItems: [sense('s1')] }), { modalOpen: false, dialogOpen: true });
  assert.deepEqual(openDialogs({ ...closed, cardPopup: popup, popupItems: [] }), { modalOpen: false, dialogOpen: false }, 'nothing left to show');
  assert.deepEqual(
    openDialogs({ ...closed, cardPopup: popup, popupItems: [sense('s1')], showKeyboardHelp: true }),
    { modalOpen: true, dialogOpen: true },
  );
});
