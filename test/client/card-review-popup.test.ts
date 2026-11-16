import assert from 'node:assert/strict';
import test from 'node:test';
import type { SRSData } from '../../types.ts';
import { installFakeMedia } from '../support/audio/fakeMedia.ts';

// The popup imports the speech engine, which reads the browser's media when it loads.
installFakeMedia();
const { resetFlash } = await import('../../components/CardReviewPopup.tsx');

const srs = (totalReviews: number): SRSData => ({
  id: 'w1', type: 'vocab', nextReview: 0, interval: 0, memoryStrength: 0, lastReviewDate: 0, totalReviews, correctStreak: 0, stability: 0.5,
});

test('Reset flashes "Memory reset" only on a meaning with a review to reset, and otherwise says there is nothing to reset yet', () => {
  assert.equal(resetFlash(srs(3)), 'Memory reset');
  assert.equal(resetFlash(srs(0)), 'Nothing to reset yet');
  assert.equal(resetFlash(undefined), 'Nothing to reset yet');
});
