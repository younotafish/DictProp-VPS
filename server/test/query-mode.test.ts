import assert from 'node:assert/strict';
import test from 'node:test';
import { isWordOrPhrase } from '../src/shared/query-mode.js';

test('a participle after a degree adverb, or an -ed noun or adjective, leaves a phrase one dictionary entry', () => {
  for (const input of [
    'a much needed break', 'a long awaited sequel', 'a so called expert', 'a highly rated restaurant', 'a well received book',
    'an ill advised move', 'a half baked idea', 'a hard earned lesson', 'a highly skilled worker', 'a well deserved rest',
    'the river bed', 'the flower bed', 'the bright red car', 'a good deed', 'a garden shed', 'a basic need', 'a rare breed',
  ]) {
    assert.equal(isWordOrPhrase(input), true, input);
  }
});

test('a past tense after a subject still makes a sentence, the -ed verbs that are also nouns included', () => {
  for (const input of [
    'my mom fed the cat', 'the guide led us', 'the farmer bred horses', 'the kids need help', 'my family moved away',
    'the supply dropped fast', 'the snake shed its skin', 'the team agreed', 'the family moved', 'the car needed fuel',
    'my belly ached',
  ]) {
    assert.equal(isWordOrPhrase(input), false, input);
  }
});
