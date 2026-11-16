import assert from 'node:assert/strict';
import test from 'node:test';
import { isNewCardInPlace, type CardInPlace } from '../../views/detail/useCardNavigation.ts';

const at = (groupIndex: number, itemIndex: number, cardId: string): CardInPlace => ({ groupIndex, itemIndex, cardId });

test('a card that slides into the place on screen after a delete or archive is a new card there', () => {
  // The second of a word's three meanings goes, and the third takes its place.
  assert.equal(isNewCardInPlace(at(0, 1, 'meaning-2'), at(0, 1, 'meaning-3')), true);
  // A word with one meaning goes, and the next word takes its place.
  assert.equal(isNewCardInPlace(at(3, 0, 'word'), at(3, 0, 'next-word')), true);
});

test('deleting the last meaning shows the one before it as a new card, and the clamp that follows moves nothing', () => {
  // The state's index stays at 2, past the end, so the card shown is the clamped one, meaning 2.
  assert.equal(isNewCardInPlace(at(0, 2, 'meaning-3'), at(0, 2, 'meaning-2')), true);
  // Then the index is brought back in range, onto the card already shown.
  assert.equal(isNewCardInPlace(at(0, 2, 'meaning-2'), at(0, 1, 'meaning-2')), false);
});

test('moving to another meaning or word is not a new card in place, nor is the same card shown again', () => {
  assert.equal(isNewCardInPlace(at(0, 0, 'meaning-1'), at(0, 1, 'meaning-2')), false, 'a move between meanings keeps the place');
  assert.equal(isNewCardInPlace(at(0, 1, 'meaning-2'), at(1, 0, 'next-word')), false, 'a move between words resets on its own');
  assert.equal(isNewCardInPlace(at(0, 1, 'meaning-2'), at(0, 1, 'meaning-2')), false, 'an edit or a sync of the card on screen');
});
