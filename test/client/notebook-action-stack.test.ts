import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { makeVocabStoredItem } from '../../services/items.ts';
import { ActionStackContext, DISMISS_CLICK_MS, createActionStackStore } from '../../views/notebook/actionStack.ts';
import { NotebookItem } from '../../views/notebook/NotebookItem.tsx';

const T = 1_700_000_000_000;

test('one stack is open at a time: opening a card closes the other, and listeners hear each change once', () => {
  const store = createActionStackStore();
  let changes = 0;
  const unsubscribe = store.subscribe(() => { changes++; });
  assert.equal(store.openId(), null);
  store.open('bank');
  assert.equal(store.openId(), 'bank');
  store.open('river');
  assert.equal(store.openId(), 'river');
  assert.equal(changes, 2);
  store.open('river');
  assert.equal(changes, 2, 'opening the open card again changes nothing');
  unsubscribe();
  store.close();
  assert.equal(changes, 2, 'an unsubscribed listener hears nothing');
});

test('closing is idempotent', () => {
  const store = createActionStackStore();
  let changes = 0;
  store.subscribe(() => { changes++; });
  store.close();
  assert.equal(changes, 0);
  store.open('bank');
  store.close();
  store.close();
  assert.equal(store.openId(), null);
  assert.equal(changes, 2);
});

test('only a press outside that closed a stack swallows the click within 400 ms', () => {
  const store = createActionStackStore();
  assert.equal(store.justDismissed(T), false);
  // A press outside with nothing open dismisses nothing, so its click opens its card.
  store.dismiss(T);
  assert.equal(store.justDismissed(T + 10), false);

  store.open('bank');
  store.dismiss(T);
  assert.equal(store.openId(), null);
  assert.equal(store.justDismissed(T), true);
  assert.equal(store.justDismissed(T + DISMISS_CLICK_MS - 1), true);
  assert.equal(store.justDismissed(T + DISMISS_CLICK_MS), false);
  assert.equal(DISMISS_CLICK_MS, 400);

  // Closing by an action, Esc or a scroll swallows nothing.
  const other = createActionStackStore();
  other.open('bank');
  other.close();
  assert.equal(other.justDismissed(T + 1), false);
});

test('a card shows its actions only while the notebook’s store has them open, and never outside it', () => {
  const noop = () => {};
  const item = makeVocabStoredItem({
    id: 'bank', word: 'bank', chinese: '', ipa: '', definition: 'bank', synonyms: [], antonyms: [], confusables: [],
    examples: [], history: '', register: '', mnemonic: '',
  });
  const card = createElement(NotebookItem, { item, isDue: false, itemIndex: 0, onOpen: noop, onDelete: noop, onArchive: noop });
  const MORE = 'aria-label="More actions for bank"';
  const DELETE = 'title="Delete"';

  const outside = renderToStaticMarkup(card);
  assert.ok(outside.includes(MORE) && !outside.includes(DELETE));

  const store = createActionStackStore();
  const provided = () => renderToStaticMarkup(createElement(ActionStackContext.Provider, { value: store }, card));
  assert.ok(provided().includes(MORE));
  store.open('bank');
  const open = provided();
  assert.ok(open.includes(DELETE) && open.includes('title="Archive"') && !open.includes(MORE));
  store.open('river');
  assert.ok(!provided().includes(DELETE));
});
