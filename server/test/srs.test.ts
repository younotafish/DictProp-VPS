import assert from 'node:assert/strict';
import test from 'node:test';
import { SRSAlgorithm } from '../../services/srsAlgorithm.ts';

test('shared SRS prefers the most recent review over the highest step', () => {
  const olderHighStep = {
    srs: { ...SRSAlgorithm.createNew('older', 'vocab'), lastReviewDate: 1_000, totalReviews: 8 },
  };
  const newerPenalized = {
    srs: { ...SRSAlgorithm.createNew('newer', 'vocab'), lastReviewDate: 2_000, totalReviews: 6 },
  };
  assert.equal(
    SRSAlgorithm.selectCanonical([olderHighStep, newerPenalized]),
    newerPenalized,
  );
});

test('shared SRS uses review count only when timestamps match', () => {
  const lower = {
    srs: { ...SRSAlgorithm.createNew('lower', 'vocab'), lastReviewDate: 2_000, totalReviews: 2 },
  };
  const higher = {
    srs: { ...SRSAlgorithm.createNew('higher', 'vocab'), lastReviewDate: 2_000, totalReviews: 3 },
  };
  assert.equal(SRSAlgorithm.selectCanonical([lower, higher]), higher);
});
