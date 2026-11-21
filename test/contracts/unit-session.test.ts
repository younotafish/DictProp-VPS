import assert from 'node:assert/strict';
import test from 'node:test';
import { decodeActiveUnit, unitSessionId } from '../../services/learningLoop/sessionStore.ts';
import { parseReviewEvent } from '../../server/src/validation.js';

// A unit's lesson records each Got it in the unit's session, 'set:<unit id>' (unitSessionId), which the server checks
// as it takes the review. So every unit the device reads back as its active unit must have a session id the server
// takes, or each Got it in the unit it continues would come back refused.

const unitWithId = (id: string) =>
  decodeActiveUnit(JSON.stringify({ version: 1, userId: 'user-1', id, themeId: null, itemIds: ['s1'], startedAt: 1 }), 'user-1');

/** A Got it in the session `sessionId`, as the server parses it from /api/reviews/apply; null when it refuses it. */
const gotIt = (sessionId: string) => parseReviewEvent({
  id: 'event-1', itemId: 's1', itemType: 'sentence', reviewedAt: 1, previousStep: 0, nextStep: 1, rating: 'good', taskType: 'quick', sessionId,
});

test('the server takes a Got it in the session of the longest unit id the device reads back', () => {
  let longest = 0;
  for (let length = 1; length <= 1_000; length++) if (unitWithId('x'.repeat(length))) longest = length;
  assert.ok(longest >= crypto.randomUUID().length, 'a unit id as a start makes it reads back');
  assert.ok(gotIt(unitSessionId({ id: 'x'.repeat(longest) })));
});
