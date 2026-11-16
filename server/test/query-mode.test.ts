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

test('the noun a participle or -ed word describes stays in the phrase, -ed nouns and conjunctions included', () => {
  for (const input of [
    'a much needed coffee break', 'a much needed garden shed', 'a newly planted flower bed', 'a freshly opened can',
    'a carefully tended flower bed', 'a newly elected city mayor', 'the bright red sports car', 'a few hundred dollars',
    'a highly skilled and dedicated worker', 'a classic red and white checkered', 'the newly elected',
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

test('a verb after the noun that a participle or an -ed word describes makes a sentence', () => {
  for (const input of [
    'the newly elected mayor resigned', 'the recently released film flopped', 'my so called friend lied',
    'a well trained dog obeyed', 'the badly damaged car crashed', 'my highly educated aunt retired',
    'The highly regarded scholar retired', 'The long haired cat purred', 'the most wanted man escaped',
    'the newly elected mayor has resigned', 'the newly elected mayor took office', 'my so called best friend lied',
    'the flower bed was ruined', 'the river bed dried up', 'his good deed went unnoticed', 'the bright red car crashed',
    'the bright red sports car crashed', 'a few hundred people died',
  ]) {
    assert.equal(isWordOrPhrase(input), false, input);
  }
});

test('a well is a noun, so a lone -ed word after it is the verb', () => {
  for (const input of ['The well collapsed.', 'the well flooded', 'our well failed']) {
    assert.equal(isWordOrPhrase(input), false, input);
  }
  assert.equal(isWordOrPhrase('a well kept secret'), true);
  assert.equal(isWordOrPhrase('a well trained dog'), true);
});
