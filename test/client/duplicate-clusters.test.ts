import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { findDuplicateClusterViews } from '../../services/duplicateClusters.ts';
import { applyMerges, dryRunMerge } from '../../services/mergeDuplicates.ts';
import { DuplicatesModal } from '../../components/DuplicatesModal.tsx';
import type { StoredItem } from '../../types.ts';

const card = (word: string, forms?: string[], id = word, definition = '', totalReviews = 0): StoredItem => ({
  type: 'vocab',
  data: { id, word, forms, chinese: '', ipa: '', definition, synonyms: [], antonyms: [], confusables: [], examples: [], history: '', register: '', mnemonic: '' },
  srs: { id, type: 'vocab', nextReview: 0, interval: 0, memoryStrength: 0, lastReviewDate: 0, totalReviews, correctStreak: 0, stability: 0.5 },
  savedAt: 1,
});

test('variant spellings of one word form a cluster that suggests the shortest spelling', () => {
  const items = [card('running'), card('run'), card('apple')];
  const clusters = findDuplicateClusterViews(items);
  assert.equal(clusters.length, 1);
  const [cluster] = clusters;
  assert.equal(cluster.id, 'dup-0');
  assert.equal(cluster.suggestedCanonical, 'run');
  assert.deepEqual([...cluster.baseWords].sort(), ['run', 'running']);
  assert.deepEqual(cluster.items.map(item => item.data.id).sort(), ['run', 'running']);
});

test('a notebook without variants has no clusters', () => {
  assert.deepEqual(findDuplicateClusterViews([card('apple'), card('pear')]), []);
  assert.deepEqual(findDuplicateClusterViews([]), []);
});

test('one pass lists each cluster’s cards in library order and counts them by the normalized base word', () => {
  const items = [
    card('don’t', undefined, 'curly'),
    card('see', ['sees', 'saw']),
    card('apple'),
    card('do', ['does', 'did', "don't"]),
    card("don't", undefined, 'straight'),
    card('saw', ['saws', 'sawed']),
    { ...card('phrase'), type: 'phrase' } as StoredItem,
  ];
  const clusters = findDuplicateClusterViews(items);
  assert.deepEqual(clusters.map(cluster => cluster.baseWords), [['do', "don't"], ['saw', 'see']]);
  assert.deepEqual(clusters.map(cluster => cluster.id), ['dup-0', 'dup-1']);
  const [doCluster, seeCluster] = clusters;
  assert.deepEqual(doCluster.items.map(item => item.data.id), ['curly', 'do', 'straight']);
  assert.deepEqual(doCluster.counts, { do: 1, "don't": 2 }, 'the curly apostrophe counts under the straight one');
  assert.deepEqual(seeCluster.items.map(item => item.data.id), ['see', 'saw']);
  assert.deepEqual(seeCluster.counts, { saw: 1, see: 1 });
});

test('a base word called like an Object property counts from zero', () => {
  const [cluster] = findDuplicateClusterViews([card('constructor', ['constructors']), card('constructors')]);
  assert.deepEqual(cluster.counts, { constructor: 1, constructors: 1 });
});

test('the suggested headword is the one whose forms list the others, and only evidence both ways ticks the merge', () => {
  const pick = (items: StoredItem[]) => findDuplicateClusterViews(items).map(cluster =>
    ({ words: cluster.baseWords, headword: cluster.suggestedCanonical, ticked: cluster.defaultInclude }));
  // ran lists run, and run lists ran: one word. The suggestion is run although ran is as short.
  assert.deepEqual(pick([card('ran', ['run']), card('run', ['runs', 'running', 'ran'])]),
    [{ words: ['ran', 'run'], headword: 'run', ticked: true }]);
  // A past tense saved under its own word lists more forms than the headword's own: still one word.
  assert.deepEqual(pick([card('run', ['runs', 'running', 'ran']), card('ran', ['run', 'runs', 'running'])])[0].ticked, true);
  // Different words that share a spelling: the headword lists the other, which doesn't list it back.
  const unticked: Array<[StoredItem, StoredItem, string]> = [
    [card('find', ['finds', 'finding', 'found']), card('found', ['founds', 'founding', 'founded']), 'find'],
    [card('lie', ['lies', 'lying', 'lay', 'lain', 'lied']), card('lay', ['lays', 'laying', 'laid']), 'lie'],
    [card('see', ['sees', 'seeing', 'saw', 'seen']), card('saw', ['saws', 'sawing', 'sawed', 'sawn']), 'see'],
    [card('leave', ['leaves', 'leaving', 'left']), card('left', ['lefts']), 'leave'],
  ];
  for (const [head, other, headword] of unticked) {
    const [cluster] = pick([head, other]);
    assert.deepEqual({ headword: cluster.headword, ticked: cluster.ticked }, { headword, ticked: false }, headword);
  }
  // A member listing a form beyond the headword's set is a different word too.
  assert.equal(pick([card('run', ['runs', 'ran']), card('ran', ['run', 'rans', 'ranned'])])[0].ticked, false);
  // Without forms there's no evidence: unticked, and the shortest word is suggested.
  assert.deepEqual(pick([card('running'), card('run')]), [{ words: ['run', 'running'], headword: 'run', ticked: false }]);
});

test('each base word comes with the start of its best card’s definition', () => {
  const long = 'to establish or originate an institution, especially by providing an endowment for it';
  const [cluster] = findDuplicateClusterViews([
    card('find', ['found'], 'find-1', 'to discover by chance'),
    card('find', ['found'], 'find-2', 'to discover something by searching for it', 3),
    card('found', [], 'found-1', long),
  ]);
  assert.deepEqual(cluster.members, [
    { base: 'find', definition: 'to discover something by searching for it' },
    { base: 'found', definition: 'to establish or originate an institution, especially by…' },
  ]);
  assert.ok(cluster.members[1].definition.length <= 61);
});

test('the modal ticks only the clusters with evidence, explains the others, and says what Merge will do', () => {
  const clusters = findDuplicateClusterViews([
    card('ran', ['run'], 'ran', 'past tense of run'),
    card('run', ['runs', 'running', 'ran'], 'run', 'to move fast on foot'),
    card('find', ['finds', 'finding', 'found'], 'find', 'to discover'),
    card('found', ['founds', 'founded'], 'found', 'to establish an institution'),
  ]);
  const html = renderToStaticMarkup(createElement(DuplicatesModal, { clusters, onClose: () => {}, onMerge: () => {} }));
  const checkboxes = html.match(/<input type="checkbox"[^>]*>/g) ?? [];
  assert.deepEqual(checkboxes.map(box => box.includes('checked')), [false, true], 'find/found unticked, ran/run ticked');
  assert.equal(html.match(/Possibly different words/g)?.length, 1);
  assert.match(html, /find<\/span> — to discover</);
  assert.match(html, /found<\/span> — to establish an institution</);
  // The suggested headwords are pressed: find, and run rather than the equally short ran.
  assert.deepEqual([...html.matchAll(/aria-pressed="true"[^>]*>([a-z]+)/g)].map(match => match[1]), ['find', 'run']);
  // Merging ran into run relabels the ran card only; run already lists every form.
  assert.match(html, /<span>Merge 1<\/span><span class="text-xs font-normal opacity-80">relabels 1 card, removes 0<\/span>/);
  assert.match(html, /class="[^"]*flex-1 border-0"/);
});

test('each cluster’s dry runs under every headword add up to the merge of the clusters ticked together', () => {
  const withSense = (item: StoredItem, sense: string): StoredItem => ({ ...item, data: { ...item.data, sense } as StoredItem['data'] });
  const items = [
    card('ran', ['run'], 'ran'),
    card('run', ['runs', 'running', 'ran'], 'run'),
    withSense(card('run', [], 'run-move'), 'verb: move'),
    withSense(card('running', [], 'running-move'), 'Verb: move'),
    card('find', ['finds', 'found'], 'find'),
    card('found', [], 'found'),
    card('apple'),
  ];
  const clusters = findDuplicateClusterViews(items);
  assert.equal(clusters.length, 2);
  for (const [first, second] of [['find', 'ran'], ['found', 'run'], ['find', 'running']]) {
    const merges = [
      { baseWords: clusters[0].baseWords, canonical: first },
      { baseWords: clusters[1].baseWords, canonical: second },
    ];
    const summed = clusters.reduce((sum, cluster, i) => {
      const effect = cluster.effects[merges[i].canonical];
      return { relabeled: sum.relabeled + effect.relabeled, removed: sum.removed + effect.removed };
    }, { relabeled: 0, removed: 0 });
    const ticked = clusters.flatMap(cluster => cluster.items);
    assert.deepEqual(summed, dryRunMerge(ticked, merges), `${first}, ${second}`);
    const merged = applyMerges(items, merges);
    assert.equal(summed.removed, merged.filter((item, i) => item !== items[i] && item.isDeleted).length);
    assert.equal(summed.relabeled, merged.filter((item, i) => item !== items[i] && !item.isDeleted).length);
  }
});
