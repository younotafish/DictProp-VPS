import assert from 'node:assert/strict';
import test from 'node:test';
import * as client from '../../services/sentenceMarkers.ts';
import * as shared from '../../server/src/shared/sentence-markers.ts';

test('the client strips sentence markers with the shared function the server backfill keys clips by', () => {
  assert.equal(client.stripSentenceMarkers, shared.stripSentenceMarkers);
});

test('stripping keeps the results the client\'s own copy gave', () => {
  // What the client's former implementation returned for each input.
  const cases: Array<[input: string, speakable: string]> = [
    ['She {{ran}} home.', 'She ran home.'],
    ['{{a}} and [[b]]', 'a and b'],
    ['{{a}}{{b}}', 'ab'],
    ['[[x]][[y]]', 'xy'],
    ['{{[[nested]]}}', 'nested'],
    ['[[{{nested}}]]', 'nested'],
    ['{{{a}}}', '{a}'],
    ['{{a}b}}', 'a}b'],
    ['{{open', '{{open'],
    ['[[open', '[[open'],
    ['a }} b {{', 'a }} b {{'],
    ['{{}}', '{{}}'],
    ['[[]]', '[[]]'],
    ['{{line\nbreak}}', '{{line\nbreak}}'],
    ['plain', 'plain'],
    ['', ''],
  ];
  for (const [input, speakable] of cases) assert.equal(client.stripSentenceMarkers(input), speakable, JSON.stringify(input));
  assert.equal(client.stripSentenceMarkers(undefined as unknown as string), '', 'a missing sentence reads as empty');
});
