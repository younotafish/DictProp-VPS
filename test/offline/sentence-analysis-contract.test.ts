import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DETAILED_SENTENCE_ANALYSIS_INSTRUCTION,
  detailedSentenceAnalysisSchema,
} from '../../scripts/offline/sentence-analysis-contract.mjs';

// The cycle's sentence-analysis stage (enrich-sentences.mjs) sends exactly this instruction and schema.
const FIELDS = ['translation', 'americanEnglish', 'terms', 'pronunciation', 'grammar', 'imagePrompt'];

test('the live sentence-analysis schema asks for every field, in teaching order', () => {
  assert.deepEqual(Object.keys(detailedSentenceAnalysisSchema.properties), FIELDS);
  assert.deepEqual(detailedSentenceAnalysisSchema.required, FIELDS);
  assert.equal(detailedSentenceAnalysisSchema.additionalProperties, false);
});

test('the live sentence-analysis prompt numbers the fields in schema order', () => {
  const positions = FIELDS.map((field, index) => DETAILED_SENTENCE_ANALYSIS_INSTRUCTION.indexOf(`\n${index + 1}. ${field}:`));
  assert.ok(positions.every(position => position > 0), JSON.stringify(positions));
  assert.deepEqual(positions, [...positions].sort((left, right) => left - right));
});

test('the live sentence-analysis prompt fixes the language, dialect, speech style, image style and audience', () => {
  assert.match(DETAILED_SENTENCE_ANALYSIS_INSTRUCTION, /Everything must be English except translation and each term's chinese field/);
  assert.match(DETAILED_SENTENCE_ANALYSIS_INSTRUCTION, /rhotic General American/);
  assert.match(DETAILED_SENTENCE_ANALYSIS_INSTRUCTION, /connected-speech/);
  assert.match(DETAILED_SENTENCE_ANALYSIS_INSTRUCTION, /photorealistic 16:9/);
  assert.match(DETAILED_SENTENCE_ANALYSIS_INSTRUCTION, /advanced Chinese-speaking learner/);
  assert.match(DETAILED_SENTENCE_ANALYSIS_INSTRUCTION, /copy that grammar object exactly/);
});
