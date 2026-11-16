import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { SearchToasts, type SearchErrorToast } from '../../components/search/SearchToasts.tsx';

const toasts = (error: SearchErrorToast | null) => renderToStaticMarkup(createElement(SearchToasts, {
  saveToast: null, error, onRetry: () => {}, onEdit: () => {}, onDismissError: () => {}, aboveTabBar: true,
}));

/** The error toast as what it says and the text of each of its buttons (× by its accessible name). */
const errorOf = (markup: string) => {
  const toast = /<div role="alert" class="([^"]*)">(.*?)<\/div>/.exec(markup);
  if (!toast) return null;
  return {
    classes: toast[1].split(' '),
    message: /<p class="[^"]*">(.*?)<\/p>/.exec(toast[2])?.[1],
    buttons: [...toast[2].matchAll(/<button([^>]*)>(.*?)<\/button>/g)]
      .map(([, attributes, text]) => /aria-label="([^"]*)"/.exec(attributes)?.[1] ?? text),
  };
};

test('the toast leads with the newest failure, says how many more there are, and offers Retry all', () => {
  const toast = errorOf(toasts({ msg: 'Couldn’t reach DictProp for “gamut”.', more: 2, action: 'retry-all' }));
  assert.equal(toast?.message, 'Couldn’t reach DictProp for “gamut”. +2 more');
  assert.deepEqual(toast?.buttons, ['Retry all', 'Dismiss error']);
});

test('one failure retrying could fix offers Retry, and a word the model found no entry for offers Edit', () => {
  assert.deepEqual(errorOf(toasts({ msg: 'The model did not finish “gamut” before the timeout.', action: 'retry' }))?.buttons, ['Retry', 'Dismiss error']);
  const notAWord = errorOf(toasts({ msg: 'No dictionary entry found for “qwxzv”. Check the spelling and try again.', more: 0, action: 'edit' }));
  assert.equal(notAWord?.message, 'No dictionary entry found for “qwxzv”. Check the spelling and try again.', 'no "+0 more"');
  assert.deepEqual(notAWord?.buttons, ['Edit', 'Dismiss error']);
});

test('a notice, or a failure nothing could fix, has only its ×', () => {
  const notice = errorOf(toasts({ msg: "You're offline, so only saved words can be looked up." }));
  assert.equal(notice?.message, 'You&#x27;re offline, so only saved words can be looked up.');
  assert.deepEqual(notice?.buttons, ['Dismiss error']);
});

test('the toast is an alert that paints above the search box and its suggestions', () => {
  const toast = errorOf(toasts({ msg: 'Couldn’t reach DictProp for “gamut”.', action: 'retry' }));
  assert.ok(toast?.classes.includes('z-[57]'), 'the box and its suggestions are z-[56]');
  assert.ok(!toast?.classes.some(name => name === 'z-[56]'));
});

test('without an error there is no toast', () => {
  assert.equal(errorOf(toasts(null)), null);
});
