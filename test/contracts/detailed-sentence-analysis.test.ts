import assert from 'node:assert/strict';
import test from 'node:test';
import { hasDetailedSentenceAnalysis } from '../../views/detail/detailUtils.ts';
import { hasCompleteSentenceAnalysis } from '../../server/src/sentence-analysis.js';
import { detailedAnalysis } from '../support/detail-view-fixtures.ts';

// The card view skips the enrichment fetch, and leaves a saved sentence's analysis alone, once the analysis is
// detailed. Its check reads only the fields it needs, so it may accept more than the server's contract, but it
// must accept everything the contract accepts, or a sentence the server finished would be fetched forever.

const variants = [
  detailedAnalysis,
  { ...detailedAnalysis, naturalSpeechIpa: undefined },
  { ...detailedAnalysis, terms: [] },
  { ...detailedAnalysis, americanEnglish: { ...detailedAnalysis.americanEnglish, status: 'american' as const } },
  { ...detailedAnalysis, pronunciation: { ...detailedAnalysis.pronunciation!, fastSpeechFeatures: ['one', 'two'] } },
  // Rejected by the contract; the client's check needn't agree, but these pin where the two differ today.
  { ...detailedAnalysis, pronunciation: undefined },
  { ...detailedAnalysis, americanEnglish: { ...detailedAnalysis.americanEnglish, evidence: [] } },
  { ...detailedAnalysis, terms: [{ ...detailedAnalysis.terms[0], examples: ['Only one.'] }] },
  { ...detailedAnalysis, naturalSpeechIpa: '/different/' },
  { ...detailedAnalysis, grammar: undefined },
];

test('every analysis the server counts as detailed, the card view counts as detailed too', () => {
  for (const analysis of variants) {
    if (hasCompleteSentenceAnalysis(analysis)) {
      assert.equal(hasDetailedSentenceAnalysis(analysis), true, JSON.stringify(analysis).slice(0, 200));
    }
  }
  assert.ok(variants.filter(analysis => hasCompleteSentenceAnalysis(analysis)).length >= 5);
});

test('the card view refetches analyses missing what it shows: pronunciation, evidence, both term examples, grammar', () => {
  assert.deepEqual(variants.slice(5).map(analysis => hasDetailedSentenceAnalysis(analysis)), [false, false, false, true, false]);
  assert.equal(hasDetailedSentenceAnalysis(undefined), false);
});
