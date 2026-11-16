import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement, type ComponentProps } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { makeVocabStoredItem } from '../../services/items.ts';
import type { StoredItem } from '../../types.ts';
import { NotebookView } from '../../views/Notebook.tsx';

const noop = () => {};
const render = (items: StoredItem[], extra: Partial<ComponentProps<typeof NotebookView>> = {}) =>
  renderToStaticMarkup(createElement(NotebookView, {
    items, user: { id: 'owner', email: 'owner@example.com', displayName: 'Ji Song', photoUrl: null, isAdmin: true },
    isOnline: true, offline: false, forceSyncRunning: false, onDelete: noop, onSearch: noop, onViewDetail: noop,
    onSignOut: async () => false, onViewRefusedReviews: noop, onScroll: noop,
    onForceSync: noop, isVocabSaved: () => false, onFindDuplicates: noop, onArchive: noop, onUnarchive: noop,
    onSave: noop, onCompare: noop, onSaveSentence: noop, isSentenceSaved: () => false, onBatchImport: noop,
    batchImportRunning: false, onJSONImported: noop, onGenerateAllSpeech: noop, speechGenerationRunning: false,
    onRestoreImagesToServer: noop, imageRestoreRunning: false, onDownloadOfflineImages: noop,
    matchSavedBases: () => new Set<string>(), onSyncScroll: noop, onShowShortcuts: noop,
    ...extra,
  }));

const word = (text: string): StoredItem => makeVocabStoredItem({
  id: text, word: text, chinese: '', ipa: '', definition: text, synonyms: [], antonyms: [], confusables: [],
  examples: [], history: '', register: '', mnemonic: '',
});

const SEARCH_BAR = 'aria-label="Search the notebook, or look up a new word"';
const LIST_CONTROLS = ['aria-label="Compare words"', 'title="Filter: ', 'title="Sort: '];

test('an empty notebook keeps its header, with the tools and Sign out, over its invitation and its one box', () => {
  for (const items of [[], [{ ...word('gone'), isDeleted: true }]]) {
    const html = render(items);
    assert.match(html, /<h2[^>]*>Notebook<\/h2>/);
    assert.ok(html.includes('aria-label="Notebook tools"'));
    assert.ok(html.includes('aria-label="Sign out"'));
    assert.ok(html.includes('Your notebook is empty'));
    assert.equal(html.match(/<input /g)?.length, 1, 'one box: the invitation keeps its own');
    assert.ok(html.includes('placeholder="Search a word or phrase..."'));
    assert.ok(!html.includes(SEARCH_BAR));
    // Nothing to compare, filter or sort.
    for (const control of LIST_CONTROLS) assert.ok(!html.includes(control), control);
  }
});

test('a batch import under way adds nothing to the notebook: its progress is a pill in the notice stack', () => {
  for (const items of [[], [word('ubiquitous')]]) {
    assert.doesNotMatch(render(items, { batchImportRunning: true }), /Importing words|Adding words/);
  }
});

test('a notebook with a word in it has the search bar and the list controls, and no invitation', () => {
  const html = render([word('ubiquitous')]);
  assert.ok(html.includes('aria-label="Notebook tools"'));
  assert.ok(html.includes('aria-label="Sign out"'));
  assert.ok(html.includes(SEARCH_BAR));
  for (const control of LIST_CONTROLS) assert.ok(html.includes(control), control);
  assert.ok(!html.includes('Your notebook is empty'));
});
