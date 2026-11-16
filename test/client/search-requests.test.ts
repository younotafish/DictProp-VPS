import assert from 'node:assert/strict';
import test from 'node:test';
import {
  requestCompare, requestLookup, subscribeSearchRequests, type CompareRequest, type LookupRequest,
} from '../../services/searchRequests.ts';

/** A subscriber that records what reaches it, in order. */
function recorder() {
  const received: Array<['lookup', LookupRequest] | ['compare', CompareRequest]> = [];
  const unsubscribe = subscribeSearchRequests({
    lookup: request => received.push(['lookup', request]),
    compare: request => received.push(['compare', request]),
  });
  return { received, unsubscribe };
}

const lookup = (query: string): LookupRequest => ({ query, source: 'expression' });

test('a request made while the search listens reaches it at once', () => {
  const search = recorder();
  const request: LookupRequest = { query: 'gamut', source: 'text', forceAI: true, context: 'It ran the gamut.' };
  requestLookup(request);
  requestCompare({ words: ['fable', 'parable'], cached: null });
  assert.deepEqual(search.received, [['lookup', request], ['compare', { words: ['fable', 'parable'], cached: null }]]);
  search.unsubscribe();
});

test('requests made before the search subscribes wait, and reach it in order when it does', () => {
  requestLookup(lookup('gamut'));
  requestCompare({ words: ['rot', 'decay'], cached: null });
  requestLookup(lookup('impasse'));
  const search = recorder();
  assert.deepEqual(search.received.map(([kind, request]) => [kind, 'query' in request ? request.query : request.words.join(' vs ')]), [
    ['lookup', 'gamut'], ['compare', 'rot vs decay'], ['lookup', 'impasse'],
  ]);
  // Delivered once: a later subscriber gets none of them again.
  search.unsubscribe();
  const later = recorder();
  assert.deepEqual(later.received, []);
  later.unsubscribe();
});

test('at most 20 requests wait; the oldest give way to newer ones', () => {
  for (let i = 1; i <= 25; i++) requestLookup(lookup(`word${i}`));
  const search = recorder();
  assert.equal(search.received.length, 20);
  assert.deepEqual(search.received.map(([, request]) => (request as LookupRequest).query),
    Array.from({ length: 20 }, (_, i) => `word${i + 6}`));
  search.unsubscribe();
});

test('after unsubscribing, requests wait for the next subscriber instead', () => {
  const first = recorder();
  first.unsubscribe();
  requestLookup(lookup('gamut'));
  assert.deepEqual(first.received, []);
  const second = recorder();
  assert.deepEqual(second.received, [['lookup', lookup('gamut')]]);
  second.unsubscribe();
});

test('a second subscriber takes over from the first, whose unsubscribe then changes nothing', () => {
  const first = recorder();
  const second = recorder();
  requestLookup(lookup('gamut'));
  assert.deepEqual(first.received, []);
  assert.deepEqual(second.received, [['lookup', lookup('gamut')]]);
  first.unsubscribe();
  requestLookup(lookup('impasse'));
  assert.deepEqual(second.received.map(([, request]) => (request as LookupRequest).query), ['gamut', 'impasse']);
  second.unsubscribe();
});
