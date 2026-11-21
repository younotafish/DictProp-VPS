import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { StoredItem } from '../../types.ts';
import { SRSAlgorithm } from '../../services/srsAlgorithm.ts';
import { acceptDestructive, acceptListReview, acceptRepeat } from '../../services/actionGuards.ts';
import { getMasteryColors } from '../../components/mastery.tsx';
import { SentenceActionsRow } from '../../views/detail/SentenceActionsRow.tsx';
import { WordCardHeader } from '../../views/detail/WordCardHeader.tsx';
import { useSentenceActions } from '../../views/detail/useSentenceActions.ts';
import { useWordActions } from '../../views/detail/useWordActions.ts';

// services/actionGuards.ts, one action per press, and the card view's destructive actions: each acts once, and
// nothing that looks like a status pill deletes.

/** Runs a hook once, in a server render, and hands back what it returned; refs and callbacks keep working after. */
function capture<T>(useHook: () => T): T {
  let result: T | undefined;
  const Probe = () => { result = useHook(); return null; };
  renderToStaticMarkup(createElement(Probe));
  return result as T;
}

test('a press acts once its window has passed since the last press that acted, and the first press always does', () => {
  const lastAt = { current: -Infinity };
  assert.equal(acceptRepeat(lastAt, 1_000, 300), true);
  assert.equal(lastAt.current, 1_000);
  assert.equal(acceptRepeat(lastAt, 1_299, 300), false);
  assert.equal(lastAt.current, 1_000, 'a press that doesn\'t act leaves the clock alone');
  assert.equal(acceptRepeat(lastAt, 1_300, 300), true);
  assert.equal(lastAt.current, 1_300);
});

test('a second delete, archive or reset within 0.7 s is ignored, and a list Reviewed within 0.5 s', () => {
  const destructive = { current: -Infinity };
  assert.equal(acceptDestructive(destructive, 10_000), true);
  assert.equal(acceptDestructive(destructive, 10_699), false);
  assert.equal(acceptDestructive(destructive, 10_700), true);

  const reviewed = { current: -Infinity };
  assert.equal(acceptListReview(reviewed, 10_000), true);
  assert.equal(acceptListReview(reviewed, 10_499), false);
  assert.equal(acceptListReview(reviewed, 10_500), true);
});

const vocabItem = (id: string, word: string): StoredItem => ({
  type: 'vocab',
  data: {
    id, word, sense: '', chinese: '', ipa: '', definition: '', synonyms: [], antonyms: [], confusables: [], examples: [],
    history: '', register: '', mnemonic: '',
  },
  savedAt: 0,
  srs: SRSAlgorithm.createNew(id, 'vocab', 0),
});

test('on a word card a doubled Delete deletes one card, and an archive or reset pressed right after does nothing', () => {
  const done: string[] = [];
  const apple = vocabItem('apple-1', 'apple');
  const actions = capture(() => useWordActions({
    data: apple.data, type: 'vocab', title: 'apple', savedItemMatch: apple, isSaved: true,
    savedItemsRef: { current: [apple] }, isVocabSaved: () => true, onSave: item => { done.push(`save ${item.data.id}`); },
    onDelete: id => { done.push(`delete ${id}`); }, onArchive: id => { done.push(`archive ${id}`); },
    onResetSRS: id => { done.push(`reset ${id}`); return true; }, setShowActionMenu: () => {},
    tryRemember: () => true, showRemembered: () => {},
  }));

  actions.handleDeleteItem();
  actions.handleDeleteItem(); // the second tap of a double tap on the trash
  actions.handleArchiveItem();
  actions.handleResetSRS();
  assert.deepEqual(done, ['delete apple-1']);
});

test('in sentence review a doubled Delete or Shift+R acts once, the two sharing one guard', () => {
  const done: string[] = [];
  const sentence: StoredItem = {
    type: 'sentence',
    data: { id: 'sentence-1', text: 'She finally came clean.', sourceWord: 'come clean' },
    savedAt: 0,
    srs: SRSAlgorithm.createNew('sentence-1', 'sentence', 0),
  };
  const actionsFor = () => capture(() => useSentenceActions({
    currentSentence: sentence, currentSentenceRef: { current: sentence }, isSentencePreview: false,
    catalogSentencePreview: false, onSave: () => {}, onDelete: id => { done.push(`delete ${id}`); },
    onResetSRS: id => { done.push(`reset ${id}`); return true; }, tryRemember: () => true, showRemembered: () => {},
  }));

  const first = actionsFor();
  first.handleResetSRS();
  first.handleResetSRS();
  first.handleDeleteItem();
  const second = actionsFor();
  second.handleDeleteItem();
  second.handleDeleteItem();
  assert.deepEqual(done, ['reset sentence-1', 'delete sentence-1']);
});

test('Got it in a Today unit records its review in the unit\'s session; elsewhere it carries no session, a catalog line its seed', () => {
  const sentence: StoredItem = {
    type: 'sentence',
    data: { id: 'sentence-1', text: 'She finally came clean.', sourceWord: 'come clean' },
    savedAt: 0,
    srs: SRSAlgorithm.createNew('sentence-1', 'sentence', 0),
  };
  const calls: unknown[][] = [];
  const remember = (options: { reviewSessionId?: string; catalog?: boolean }) => capture(() => useSentenceActions({
    currentSentence: sentence, currentSentenceRef: { current: sentence }, isSentencePreview: !!options.catalog,
    catalogSentencePreview: !!options.catalog, onSave: () => {}, onDelete: () => {},
    onUpdateSRS: (...args) => { calls.push(args); }, tryRemember: () => true, showRemembered: () => {},
    reviewSessionId: options.reviewSessionId,
  })).handleRemember();

  remember({ reviewSessionId: 'set:unit-1' });
  remember({});
  remember({ catalog: true, reviewSessionId: 'set:unit-2' });
  assert.deepEqual(calls[0], ['sentence-1', 'good', { sessionId: 'set:unit-1' }]);
  assert.deepEqual(calls[1], ['sentence-1', 'good', undefined]);
  assert.deepEqual(calls[2], ['sentence-1', 'good', { seedItem: sentence, sessionId: 'set:unit-2' }]);
});

const header = (isSaved: boolean) => {
  const srs = SRSAlgorithm.createNew('apple-1', 'vocab', 0);
  const mastery = SRSAlgorithm.getMasteryLevel(srs);
  return renderToStaticMarkup(createElement(WordCardHeader, {
    showHeader: true, onClose: () => {}, itemCount: 1, itemIndex: 0, onRefresh: () => {}, isSaved, onDelete: () => {},
    onSave: () => {}, moreActionsRef: { current: null }, showActionMenu: false, onToggleActionMenu: () => {},
    stats: isSaved ? { srs, mastery, colors: getMasteryColors(mastery.color) } : null, savedItems: [],
  }));
};

/** The colour, border and size classes of the header button that `opening` (its tag up to the end of its attributes) starts. */
const buttonLook = (markup: string, opening: RegExp) => {
  const tag = markup.match(opening)?.[0];
  assert.ok(tag, `no button matches ${opening}`);
  const classes = tag.match(/class="([^"]*)"/)![1].split(/\s+/).filter(Boolean);
  return classes.filter(name => /^(hover:)?(bg|text|border|rounded|px|py|gap)(-|$)/.test(name));
};

test('a saved card\'s header offers the trash and the More menu and no Saved pill; an unsaved one offers Save', () => {
  const saved = header(true);
  assert.match(saved, /title="Delete \(D\)"/);
  assert.match(saved, /title="More actions" aria-haspopup="menu" aria-expanded="false"/);
  assert.doesNotMatch(saved, />Saved?</, 'no Saved or Save button on a saved card');
  assert.doesNotMatch(saved, /lucide-bookmark/);

  const unsaved = header(false);
  assert.match(unsaved, /lucide-bookmark[^>]*>.*?<\/svg><span class="text-xs font-bold">Save<\/span><\/button>/);
  assert.doesNotMatch(unsaved, /title="Delete \(D\)"/);
  assert.doesNotMatch(unsaved, /title="More actions"/);
});

test('the header\'s buttons carry the classes that render: slate-600 with a slate-100 hover, and Close stays ghost', () => {
  const saved = header(true);
  const base = ['rounded-xl', 'px-3', 'py-1.5', 'text-sm', 'text-slate-600', 'hover:bg-slate-100'];
  assert.deepEqual(buttonLook(saved, /<button[^>]*title="Refresh with AI"[^>]*>/), [...base, 'hover:text-indigo-600']);
  assert.deepEqual(buttonLook(saved, /<button[^>]*title="Delete \(D\)"[^>]*>/), [...base, 'hover:text-rose-600']);
  assert.deepEqual(buttonLook(saved, /<button[^>]*title="More actions"[^>]*>/), base);
  assert.deepEqual(
    buttonLook(header(false), /<button[^>]*>(?=<svg[^>]*lucide-bookmark)/),
    ['rounded-xl', 'px-3', 'py-1.5', 'text-sm', 'gap-1.5', 'border', 'border-transparent', 'text-slate-600', 'hover:bg-slate-100'],
  );
  assert.ok(buttonLook(saved, /<button[^>]*>(?=<svg[^>]*lucide-arrow-left)/).includes('bg-transparent'), 'Close keeps the ghost variant');
});

test('Save only ever saves: on a saved card it does nothing, on an unsaved one it saves the card as new', () => {
  const saves: StoredItem[] = [];
  const deletes: string[] = [];
  const apple = vocabItem('apple-1', 'apple');
  const saveFor = (isSaved: boolean) => capture(() => useWordActions({
    data: apple.data, type: 'vocab', title: 'apple', savedItemMatch: isSaved ? apple : undefined, isSaved,
    savedItemsRef: { current: isSaved ? [apple] : [] }, isVocabSaved: () => isSaved, onSave: item => { saves.push(item); },
    onDelete: id => { deletes.push(id); }, setShowActionMenu: () => {}, tryRemember: () => true, showRemembered: () => {},
  })).handleSave;

  saveFor(true)();
  assert.deepEqual([saves, deletes], [[], []]);
  saveFor(false)();
  assert.equal(saves.length, 1);
  assert.equal(saves[0].data, apple.data);
  assert.equal(saves[0].srs.totalReviews, 0);
});

test('a catalog lesson\'s line has no Delete: the row shows Reset and Got it, and the delete handler refuses it', () => {
  const srs = SRSAlgorithm.createNew('real-life-sentence:1', 'sentence', 0);
  const mastery = SRSAlgorithm.getMasteryLevel(srs);
  const row = (catalog: boolean) => renderToStaticMarkup(createElement(SentenceActionsRow, {
    srs, mastery, masteryColors: getMasteryColors(mastery.color), memorizedCount: 0, preview: false, catalog,
    catalogKind: catalog ? 'real-life' : undefined, onRemember: () => {}, onReset: () => {}, onDelete: () => {},
  }));
  assert.doesNotMatch(row(true), /Delete sentence/);
  assert.match(row(true), /title="Reset memory \(Shift\+R\)"/);
  assert.match(row(true), /title="Remember \(R\)"/);
  assert.match(row(false), /title="Delete sentence \(D\)" aria-label="Delete sentence"/);

  const deleted: string[] = [];
  const line: StoredItem = {
    type: 'sentence',
    data: {
      id: 'real-life-sentence:1', text: 'Mind the gap.', sourceWord: 'mind', catalogKind: 'real-life',
      catalogSentenceId: '1', catalogCollectionId: 'london',
    },
    savedAt: 0,
    srs,
  };
  const { handleDeleteItem } = capture(() => useSentenceActions({
    currentSentence: line, currentSentenceRef: { current: line }, isSentencePreview: false, catalogSentencePreview: true,
    onSave: () => {}, onDelete: id => { deleted.push(id); }, tryRemember: () => true, showRemembered: () => {},
  }));
  handleDeleteItem();
  assert.deepEqual(deleted, []);
});
