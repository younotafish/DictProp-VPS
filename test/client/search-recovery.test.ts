import assert from 'node:assert/strict';
import test from 'node:test';
import { HttpError, TimeoutError } from '../../services/http.ts';
import {
  consumeSearchRetries, decodePendingRequests, describeSearchError, encodePendingRequests, failureOf, isNetworkFailure,
  isRetryableSearchError, readPendingRequests, rememberSearchRetry, searchRequestKey, writePendingRequests, type PendingRequest,
  type SearchRequest, type SearchSubject,
} from '../../services/searchRecovery.ts';
import { MemoryStorage } from '../support/memory-storage.ts';

const lookup = (label: string): SearchSubject => ({ kind: 'analysis', label });
const comparison = (label: string): SearchSubject => ({ kind: 'comparison', label });
const scan = (label: string): SearchSubject => ({ kind: 'scan', label });
const networkDown = () => new Error('Failed to fetch', { cause: new TypeError('Failed to fetch') });

test('expired-session searches survive an OAuth redirect and retain a useful error', () => {
  const storage = new MemoryStorage();
  // Builds before typed requests kept a lookup this way, to run again as a refresh.
  storage.setItem('dictprop_pending_search_retry', JSON.stringify({ query: 'visceral', analyzeMode: 'batch' }));

  assert.deepEqual(consumeSearchRetries(storage), [{ kind: 'analyze', query: 'visceral', analyzeMode: 'batch', forceAI: true }]);
  assert.deepEqual(consumeSearchRetries(storage), []);
  assert.match(
    describeSearchError(lookup('visceral'), new HttpError('failed', 401, 'Session expired')),
    /session expired/i,
  );
});

test('search errors explain not-found, quota and rate limits distinctly', () => {
  assert.equal(
    describeSearchError(lookup('qwxzv'), new HttpError('Analysis failed (422)', 422, 'No dictionary entry found. Check the spelling and try again.')),
    'No dictionary entry found for “qwxzv”. Check the spelling and try again.',
  );
  assert.equal(
    describeSearchError(lookup('bank'), new HttpError('Analysis failed (429)', 429, 'QUOTA_EXCEEDED')),
    'The AI provider quota is exhausted. Please try again later.',
  );
  assert.equal(
    describeSearchError(lookup('bank'), new HttpError('Analysis failed (429)', 429, 'RATE_LIMITED')),
    'The AI provider rate-limited this request. Try again shortly.',
  );
  assert.equal(describeSearchError(lookup('bank'), new Error('QUOTA_EXCEEDED')), 'The AI provider quota is exhausted. Please try again later.');
  assert.match(describeSearchError(lookup('bank'), new HttpError('Analysis failed (502)', 502, '')), /no usable definition/);
});

test('a search is offered again only when repeating it could succeed', () => {
  assert.equal(isRetryableSearchError(new HttpError('Analysis failed (422)', 422, 'No dictionary entry found.')), false);
  assert.equal(isRetryableSearchError(new HttpError('Analysis failed (400)', 400, 'Text is too long')), false);
  assert.equal(isRetryableSearchError(new HttpError('failed', 401, 'Session expired')), true);
  assert.equal(isRetryableSearchError(new HttpError('Analysis failed (429)', 429, 'RATE_LIMITED')), true);
  assert.equal(isRetryableSearchError(new HttpError('Analysis failed (504)', 504, '')), true);
  assert.equal(isRetryableSearchError(new Error('The model did not finish this search before the timeout.')), true);
  // The toast adds the retry prompt itself, so the message doesn't repeat it.
  assert.doesNotMatch(describeSearchError(lookup('bank'), new HttpError('Analysis failed (504)', 504, '')), /retry/i);
});

test('a request that never reached DictProp says so, for a lookup, a comparison and a scan', () => {
  assert.equal(describeSearchError(lookup('gamut'), networkDown()), 'Couldn’t reach DictProp for “gamut”.');
  assert.equal(describeSearchError(lookup('gamut'), new TypeError('Load failed')), 'Couldn’t reach DictProp for “gamut”.', 'as thrown');
  assert.equal(describeSearchError(comparison('fable vs parable'), networkDown()), 'Couldn’t reach DictProp for “fable vs parable”.');
  assert.equal(describeSearchError(scan('It ran the gamut.'), new TypeError('Failed to fetch')), 'Couldn’t reach DictProp to scan “It ran the gamut.”.');
});

test('a timeout says the model did not finish, by its name or a 504', () => {
  const timedOut = 'The model did not finish “gamut” before the timeout.';
  assert.equal(describeSearchError(lookup('gamut'), new TimeoutError()), timedOut);
  assert.equal(describeSearchError(lookup('gamut'), new DOMException('The operation was aborted.', 'AbortError')), timedOut);
  assert.equal(describeSearchError(lookup('gamut'), new HttpError('Analysis failed (504)', 504, '')), timedOut);
  assert.equal(describeSearchError(scan('It ran the gamut.'), new TimeoutError()), 'The model did not finish “It ran the gamut.” before the timeout.');
});

test('the server\'s statuses keep their own words, a 502 in each kind\'s', () => {
  assert.equal(describeSearchError(lookup('gamut'), new HttpError('failed', 502, '')), 'The model returned no usable definition for “gamut”.');
  assert.equal(describeSearchError(comparison('fable vs parable'), new HttpError('failed', 502, '')), 'The model returned no usable comparison for “fable vs parable”.');
  assert.equal(describeSearchError(scan('It ran the gamut.'), new HttpError('failed', 502, '')), 'The model found no usable expressions in this text.');
  assert.equal(describeSearchError(lookup('gamut'), new HttpError('failed', 503, '')), 'The AI provider is temporarily unavailable for “gamut”.');
  assert.equal(describeSearchError(lookup('qwxzv'), new HttpError('failed', 422, 'Not a word')), 'No dictionary entry found for “qwxzv”. Check the spelling and try again.');
  assert.equal(describeSearchError(lookup('gamut'), new HttpError('failed', 401, 'Session expired')), 'Your session expired. Sign in again to retry “gamut”.');
  assert.equal(describeSearchError(scan('Lorem ipsum'), new HttpError('failed', 400, 'Text is too long.')), 'Could not scan “Lorem ipsum”: Text is too long.');
  assert.equal(describeSearchError(comparison('a vs b'), new HttpError('failed', 400, 'Please provide at least 2 different words to compare.')),
    'Could not compare “a vs b”: Please provide at least 2 different words to compare.');
  for (const subject of [lookup('bank'), comparison('a vs b'), scan('A sentence.')]) {
    assert.equal(describeSearchError(subject, new HttpError('failed', 429, 'QUOTA_EXCEEDED')), 'The AI provider quota is exhausted. Please try again later.');
    assert.equal(describeSearchError(subject, new Error('QUOTA_EXCEEDED')), 'The AI provider quota is exhausted. Please try again later.');
    assert.equal(describeSearchError(subject, new HttpError('failed', 429, 'RATE_LIMITED')), 'The AI provider rate-limited this request. Try again shortly.');
  }
});

test('anything else could not be done, in the words of what was asked', () => {
  assert.equal(describeSearchError(lookup('gamut'), new Error('Search failed. Please try again.')), 'Could not analyze “gamut”.');
  assert.equal(describeSearchError(comparison('fable vs parable'), undefined), 'Could not compare “fable vs parable”.');
  assert.equal(describeSearchError(scan('It ran the gamut.'), new SyntaxError('Unexpected token')), 'Could not scan “It ran the gamut.”.');
});

test('an error quotes at most 40 characters of what was asked, on one line, with an ellipsis when it cuts', () => {
  const sentence = 'The committee could not reach a consensus, so the meeting ran on.';
  assert.equal(describeSearchError(scan(sentence), networkDown()), 'Couldn’t reach DictProp to scan “The committee could not reach a consensu…”.');
  assert.equal(describeSearchError(lookup('x'.repeat(40)), networkDown()), `Couldn’t reach DictProp for “${'x'.repeat(40)}”.`, 'exactly 40 stays whole');
  assert.equal(describeSearchError(scan('Line one.\n\n  Line   two.'), networkDown()), 'Couldn’t reach DictProp to scan “Line one. Line two.”.');
  assert.equal(describeSearchError(lookup(`${'字'.repeat(39)}😀😀`), networkDown()), `Couldn’t reach DictProp for “${'字'.repeat(39)}😀…”.`, 'counting characters, not code units');
});

test('a network failure is found through the causes of the errors wrapping it, and only there', () => {
  assert.equal(isNetworkFailure(new TypeError('Failed to fetch')), true);
  assert.equal(isNetworkFailure(networkDown()), true);
  assert.equal(isNetworkFailure(new Error('outer', { cause: networkDown() })), true);
  assert.equal(isNetworkFailure(new Error('Search failed.')), false);
  assert.equal(isNetworkFailure(new HttpError('failed', 503, '')), false);
  assert.equal(isNetworkFailure(new TimeoutError()), false);
  assert.equal(isNetworkFailure('Failed to fetch'), false);
  assert.equal(isNetworkFailure(undefined), false);
});

test('a failure keeps its wording, whether retrying could fix it, and whether the model found no entry', () => {
  assert.deepEqual(failureOf(lookup('gamut'), networkDown(), 5), { message: 'Couldn’t reach DictProp for “gamut”.', retryable: true, notAWord: false, at: 5 });
  assert.deepEqual(failureOf(lookup('qwxzv'), new HttpError('failed', 422, 'Not a word'), 6),
    { message: 'No dictionary entry found for “qwxzv”. Check the spelling and try again.', retryable: false, notAWord: true, at: 6 });
  assert.deepEqual(failureOf(scan('Lorem'), new HttpError('failed', 400, 'Too long.'), 7), { message: 'Could not scan “Lorem”: Too long.', retryable: false, notAWord: false, at: 7 });
  assert.equal(failureOf(lookup('gamut'), undefined, 8).retryable, true, 'an unknown cause may well pass');
});

const REQUESTS: SearchRequest[] = [
  { kind: 'scan', query: 'It ran the gamut of emotions.' },
  { kind: 'analyze', query: 'gamut' },
  { kind: 'analyze', query: 'run the gamut', analyzeMode: 'batch' },
  { kind: 'analyze', query: 'impasse', forceAI: true },
  { kind: 'compare', words: ['fable', 'parable'] },
];

test('a request whose session expired comes back once, as the request it was', () => {
  for (const request of REQUESTS) {
    const storage = new MemoryStorage();
    rememberSearchRetry(request, storage);
    assert.deepEqual(consumeSearchRetries(storage), [request]);
    assert.deepEqual(consumeSearchRetries(storage), []);
  }
});

test('every request a session\'s end cut off comes back after signing in, in order, each once', () => {
  const storage = new MemoryStorage();
  for (const request of REQUESTS) rememberSearchRetry(request, storage);
  rememberSearchRetry({ kind: 'analyze', query: ' Gamut ', forceAI: true }, storage);
  rememberSearchRetry({ kind: 'compare', words: ['Parable', 'fable'] }, storage);
  rememberSearchRetry({ kind: 'scan', query: 'it ran the gamut of emotions.' }, storage);
  assert.deepEqual(consumeSearchRetries(storage), REQUESTS, 'the same request again is kept once, as it was first');
  assert.deepEqual(consumeSearchRetries(storage), []);
});

test('at most the newest 20 retries are kept', () => {
  const storage = new MemoryStorage();
  for (let i = 0; i < 25; i++) rememberSearchRetry({ kind: 'analyze', query: `word${i}` }, storage);
  assert.deepEqual(consumeSearchRetries(storage).map(request => (request as { query: string }).query), Array.from({ length: 20 }, (_, i) => `word${i + 5}`));
});

test('a retry the build before the list kept comes back too, with any kept after it', () => {
  const storage = new MemoryStorage();
  storage.setItem('dictprop_pending_search_retry', JSON.stringify({ kind: 'scan', query: 'It ran the gamut of emotions.' }));
  rememberSearchRetry({ kind: 'compare', words: ['fable', 'parable'] }, storage);
  assert.deepEqual(consumeSearchRetries(storage), [{ kind: 'scan', query: 'It ran the gamut of emotions.' }, { kind: 'compare', words: ['fable', 'parable'] }]);
  storage.setItem('dictprop_pending_search_retry', JSON.stringify({ kind: 'analyze', query: 'gamut' }));
  assert.deepEqual(consumeSearchRetries(storage), [{ kind: 'analyze', query: 'gamut' }], 'alone');
  storage.setItem('dictprop_pending_search_retry', JSON.stringify({ query: 'visceral' }));
  rememberSearchRetry({ kind: 'analyze', query: 'gamut' }, storage);
  assert.deepEqual(consumeSearchRetries(storage), [{ kind: 'analyze', query: 'visceral', forceAI: true }, { kind: 'analyze', query: 'gamut' }], 'and the oldest shape');
});

test('kept retries that are damaged, empty or of an unknown kind are dropped', () => {
  for (const raw of ['{', 'null', '42', '"gamut"', '[]', '{"kind":"scan","query":"  "}', '{"kind":"compare","words":["only"]}', '{"kind":"delete","query":"x"}', '{"query":""}']) {
    const storage = new MemoryStorage();
    storage.setItem('dictprop_pending_search_retry', raw);
    assert.deepEqual(consumeSearchRetries(storage), [], raw);
    assert.equal(storage.getItem('dictprop_pending_search_retry'), null, 'and forgotten');
  }
  const mixed = new MemoryStorage();
  mixed.setItem('dictprop_pending_search_retry', JSON.stringify([null, 7, { kind: 'nope' }, { query: 'visceral' }, { kind: 'analyze', query: 'gamut' }]));
  assert.deepEqual(consumeSearchRetries(mixed), [{ kind: 'analyze', query: 'gamut' }], 'a list keeps its well-formed requests');
  const storage = new MemoryStorage();
  rememberSearchRetry({ kind: 'analyze', query: '   ' }, storage);
  assert.equal(storage.length, 0, 'nothing to retry is never kept');
  const refusing = { getItem: () => { throw new Error('denied'); }, setItem: () => { throw new Error('denied'); }, removeItem: () => { throw new Error('denied'); } };
  assert.doesNotThrow(() => rememberSearchRetry({ kind: 'analyze', query: 'gamut' }, refusing));
  assert.deepEqual(consumeSearchRetries(refusing), []);
  assert.deepEqual(consumeSearchRetries(null), []);
});

test('a request is the same request whatever its case, the spaces around it, its mode, or the order of the words compared', () => {
  assert.equal(searchRequestKey({ kind: 'analyze', query: ' Gamut ' }), searchRequestKey({ kind: 'analyze', query: 'gamut', analyzeMode: 'batch', forceAI: true }));
  assert.equal(searchRequestKey({ kind: 'compare', words: ['Parable', 'fable'] }), searchRequestKey({ kind: 'compare', words: ['fable', 'parable'] }));
  assert.notEqual(searchRequestKey({ kind: 'scan', query: 'gamut' }), searchRequestKey({ kind: 'analyze', query: 'gamut' }), 'a scan is not a lookup');
  assert.notEqual(searchRequestKey({ kind: 'analyze', query: 'gamut' }), searchRequestKey({ kind: 'analyze', query: 'gamuts' }));
});

const pending = (request: SearchRequest, at: number): PendingRequest => ({ request, at });
const HOUR = 60 * 60 * 1000;

test('across a reload, requests come back as they were asked for: queries and modes only', () => {
  const now = 10 * HOUR;
  const raw = encodePendingRequests(REQUESTS.map((request, i) => pending(request, now - i * 1_000)));
  assert.deepEqual(decodePendingRequests(raw, now), REQUESTS);
  const withExtras = encodePendingRequests([pending({ kind: 'analyze', query: 'gamut', context: 'It ran the gamut.', results: [1] } as unknown as SearchRequest, now)]);
  assert.deepEqual(JSON.parse(withExtras), [{ request: { kind: 'analyze', query: 'gamut' }, at: now }], 'never a result or the sentence');
});

test('at most the newest 20 requests are kept, and only those asked for within the hour', () => {
  const now = 10 * HOUR;
  const many = Array.from({ length: 25 }, (_, i) => pending({ kind: 'analyze', query: `word${i}` }, now - (25 - i) * 1_000));
  const kept = decodePendingRequests(encodePendingRequests(many), now).map(request => (request as { query: string }).query);
  assert.deepEqual(kept, Array.from({ length: 20 }, (_, i) => `word${i + 5}`));
  const ages = [pending({ kind: 'analyze', query: 'old' }, now - HOUR), pending({ kind: 'analyze', query: 'recent' }, now - HOUR + 1), pending({ kind: 'analyze', query: 'ahead' }, now + 1)];
  assert.deepEqual(decodePendingRequests(encodePendingRequests(ages), now), [{ kind: 'analyze', query: 'recent' }]);
});

test('a damaged list reads as empty, and damaged entries are skipped', () => {
  for (const raw of [null, '', '{', '{"request":{}}', '"text"']) assert.deepEqual(decodePendingRequests(raw, HOUR), [], String(raw));
  const mixed = JSON.stringify([null, 7, { at: 'soon', request: { kind: 'analyze', query: 'a' } }, { at: HOUR, request: { kind: 'nope' } }, { at: HOUR, request: { kind: 'analyze', query: 'gamut' } }]);
  assert.deepEqual(decodePendingRequests(mixed, HOUR), [{ kind: 'analyze', query: 'gamut' }]);
});

test('the list lives in sessionStorage, is forgotten when empty, and a refusing storage changes nothing', () => {
  const storage = new MemoryStorage();
  writePendingRequests([pending({ kind: 'analyze', query: 'gamut' }, 100)], storage);
  assert.deepEqual(readPendingRequests(200, storage), [{ kind: 'analyze', query: 'gamut' }]);
  assert.notEqual(storage.getItem('search_pending_v1'), null);
  writePendingRequests([], storage);
  assert.equal(storage.getItem('search_pending_v1'), null);
  const refusing = { getItem: () => { throw new Error('denied'); }, setItem: () => { throw new Error('denied'); }, removeItem: () => { throw new Error('denied'); } };
  assert.doesNotThrow(() => writePendingRequests([pending({ kind: 'analyze', query: 'gamut' }, 100)], refusing));
  assert.deepEqual(readPendingRequests(200, refusing), []);
  assert.deepEqual(readPendingRequests(200, null), []);
});
