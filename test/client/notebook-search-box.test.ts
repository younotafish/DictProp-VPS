import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { HttpError } from '../../services/http.ts';
import {
  OFFLINE_SEARCH_MESSAGE, aiCardStillValid, offlineSearchError, retryOffered, searchFailure, shouldBlurOnDrag,
} from '../../services/notebook/searchBox.ts';
import { NotebookSearchBar } from '../../views/notebook/NotebookSearchBar.tsx';
import { EmptyNotebook } from '../../views/notebook/EmptyNotebook.tsx';

test('an AI card belongs to the query it was asked for, up to case and spacing', () => {
  // Nothing asked for: nothing to drop.
  assert.equal(aiCardStillValid(null, 'anything'), true);
  assert.equal(aiCardStillValid(null, ''), true);
  assert.equal(aiCardStillValid('ubiquitous', 'ubiquitous'), true);
  assert.equal(aiCardStillValid('ubiquitous', 'ubiquitous '), true, 'a trailing space');
  assert.equal(aiCardStillValid('ubiquitous', 'Ubiquitous'), true, 'a capital letter');
  assert.equal(aiCardStillValid('break  a leg', ' break a  leg'), true, 'spaces collapsed');
  assert.equal(aiCardStillValid('ubiquitous', 'ubiquitou'), false, 'an edited word');
  assert.equal(aiCardStillValid('ubiquitous', 'ubiquitously'), false);
  assert.equal(aiCardStillValid('ubiquitous', ''), false, 'cleared');
});

test('a mostly vertical drag of the list past 10 px drops the keyboard, unless it started in the header', () => {
  assert.equal(shouldBlurOnDrag({ dx: 0, dy: 11 }, false), true);
  assert.equal(shouldBlurOnDrag({ dx: 3, dy: -11 }, false), true, 'up as well as down');
  assert.equal(shouldBlurOnDrag({ dx: 0, dy: 10 }, false), false);
  assert.equal(shouldBlurOnDrag({ dx: 0, dy: 9 }, false), false);
  assert.equal(shouldBlurOnDrag({ dx: 40, dy: 12 }, false), false, 'a sideways swipe through the senses');
  assert.equal(shouldBlurOnDrag({ dx: 12, dy: 12 }, false), false);
  assert.equal(shouldBlurOnDrag({ dx: 0, dy: 60 }, true), false, 'started in the header');
});

test('Retry shows only when retrying can work: never for a word the model rejected, offline only once back online', () => {
  const rejected = searchFailure('qwxzv', new HttpError('Analysis failed (422)', 422, 'Not a word'));
  assert.deepEqual(rejected, { message: 'No dictionary entry found for "qwxzv". Check the spelling and try again.', retryable: false });
  assert.equal(retryOffered(rejected, true, 'qwxzv'), false);

  const network = searchFailure('bank', new TypeError('Failed to fetch'));
  assert.deepEqual(network, { message: 'Could not analyze "bank".', retryable: true });
  assert.equal(retryOffered(network, true, 'bank'), true);
  const timeout = searchFailure('bank', new Error('Request timed out'));
  assert.deepEqual(timeout, { message: 'The model did not finish "bank" before the timeout.', retryable: true });
  assert.equal(retryOffered(timeout, true, 'bank'), true);
  assert.equal(retryOffered(searchFailure('bank', new HttpError('Analysis failed (503)', 503, '')), true, 'bank'), true);

  const offline = offlineSearchError();
  assert.deepEqual(offline, { message: OFFLINE_SEARCH_MESSAGE, retryable: false, offline: true });
  assert.equal(OFFLINE_SEARCH_MESSAGE, 'You’re offline — showing saved matches only.');
  assert.equal(retryOffered(offline, false, 'bank'), false);
  assert.equal(retryOffered(offline, true, 'bank'), true);

  // Nothing in the box: nothing to retry.
  for (const error of [network, offline]) assert.equal(retryOffered(error, true, '  '), false);
});

test('both notebook boxes are search boxes: no capitals or autofill, and Return reads search', () => {
  const noop = () => {};
  const bar = renderToStaticMarkup(createElement(NotebookSearchBar, {
    query: 'ubiquitous', onQueryChange: noop, onKeyDown: noop, onTouchStart: noop, onTouchEnd: noop, isOnline: false,
    isRecording: false, isTranscribing: false, isSearching: false, onToggleRecording: noop, onSearchWithAI: noop,
    onClear: noop, inputRef: null, onFocusChange: noop,
  }));
  const empty = renderToStaticMarkup(createElement(EmptyNotebook, { query: '', onQueryChange: noop }));
  for (const html of [bar, empty]) {
    const input = html.match(/<input [^>]*>/)?.[0] ?? '';
    for (const attribute of ['autoComplete="off"', 'autoCapitalize="off"', 'enterKeyHint="search"']) {
      assert.ok(input.toLowerCase().includes(attribute.toLowerCase()), `${attribute} in ${input}`);
    }
  }
  // Offline, the wand still answers (with the offline banner) instead of sitting disabled.
  const wand = bar.match(/<button[^>]*aria-label="Search with AI"[^>]*>/)?.[0] ?? '';
  assert.ok(wand && !wand.includes('disabled'), wand);
});
