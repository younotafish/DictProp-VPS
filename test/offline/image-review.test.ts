import assert from 'node:assert/strict';
import { join } from 'node:path';
import test from 'node:test';
import {
  candidateFile,
  judgmentRecords,
  readRefinements,
  readVerdicts,
  refinementRecords,
} from '../../scripts/offline/image-review.mjs';

const learningTarget = { kind: 'word sense', text: 'harbor', sense: 'noun: a sheltered port', definition: 'A port.' };
const target = (id: string, overrides: Record<string, unknown> = {}) => ({
  imageId: id,
  filename: `${id}.webp`,
  prompt: `A calm harbor scene for ${id}.`,
  learningTarget,
  ...overrides,
});

test('candidate n of an image carries -n before its extension', () => {
  assert.equal(candidateFile('/candidates', 'abc.webp', 3), join('/candidates', 'abc-3.webp'));
  assert.equal(candidateFile('/candidates', 'a.b.png', 12), join('/candidates', 'a.b-12.png'));
});

test('the judge sees each brief with its candidate number, in batch order', () => {
  assert.deepEqual(judgmentRecords([target('one'), target('two')], 2), [
    { itemIndex: 0, candidateNumber: 2, learningTarget, brief: 'A calm harbor scene for one.' },
    { itemIndex: 1, candidateNumber: 2, learningTarget, brief: 'A calm harbor scene for two.' },
  ]);
});

test('verdicts are read by item index and must say whether each image is acceptable', () => {
  const batch = [target('one'), target('two')];
  const candidates = ['/c/one-1.webp', '/c/two-1.webp'];
  const verdicts = readVerdicts({
    results: [
      { itemIndex: 1, acceptable: false, reason: 'Wrong sense.' },
      { itemIndex: 0, acceptable: true, reason: 'Clear.' },
    ],
  }, batch, candidates, 4);
  type Verdict = { target: { imageId: string }; result: { acceptable: boolean }; candidate: string };
  assert.deepEqual(verdicts.map(({ target: { imageId }, result, candidate }: Verdict) => [imageId, result.acceptable, candidate]), [
    ['one', true, '/c/one-1.webp'],
    ['two', false, '/c/two-1.webp'],
  ]);
  assert.throws(() => readVerdicts({ results: [] }, batch, candidates, 4), /^Error: Batch 4 returned the wrong result count$/);
  assert.throws(() => readVerdicts({ results: [{ itemIndex: 0 }, { itemIndex: 0 }] }, batch, candidates, 4),
    /^Error: Batch 4 returned duplicate indexes$/);
  assert.throws(() => readVerdicts({
    results: [{ itemIndex: 0, acceptable: true }, { itemIndex: 1, acceptable: 'yes' }],
  }, batch, candidates, 4), /^Error: Batch 4 omitted index 1$/);
});

test('the refiner sees each rejected brief with the reason, or a default one', () => {
  assert.deepEqual(refinementRecords([target('one', { rejectionReason: 'Too busy.' }), target('two')]), [
    { itemIndex: 0, learningTarget, rejectedBrief: 'A calm harbor scene for one.', rejectionReason: 'Too busy.' },
    {
      itemIndex: 1,
      learningTarget,
      rejectedBrief: 'A calm harbor scene for two.',
      rejectionReason: 'The previous image did not communicate the exact meaning clearly enough.',
    },
  ]);
});

test('a refined brief replaces the prompt and the first brief is kept as originalPrompt', () => {
  const batch = [target('one', { rejectionReason: 'Too busy.' }), target('two', { originalPrompt: 'The very first brief.' })];
  const refined = readRefinements({
    results: [
      { itemIndex: 0, prompt: '  One fishing boat moored in a calm, sheltered harbor at dawn, no text.  ', change: ' Fewer boats. ' },
      { itemIndex: 1, prompt: 'A lone sailboat entering a sheltered harbor behind a stone breakwater.', change: 'Shows shelter.' },
    ],
  }, batch, 1);
  assert.deepEqual(refined[0], {
    ...batch[0],
    originalPrompt: 'A calm harbor scene for one.',
    prompt: 'One fishing boat moored in a calm, sheltered harbor at dawn, no text.',
    promptRefinement: 'Fewer boats.',
  });
  assert.equal(refined[1].originalPrompt, 'The very first brief.');
  assert.throws(() => readRefinements({
    results: [{ itemIndex: 0, prompt: 'Too short.', change: 'x' }, { itemIndex: 1, prompt: 'x'.repeat(40), change: 'x' }],
  }, batch, 7), /^Error: Batch 7 omitted index 0$/);
});
