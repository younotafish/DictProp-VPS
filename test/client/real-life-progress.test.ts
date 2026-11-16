import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement, isValidElement, type ComponentProps, type ReactElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { REAL_LIFE_COLLECTIONS } from '../../services/realLifeCatalog.ts';
import { summarizeCatalogProgress } from '../../services/catalogProgress.ts';
import {
  buildRealLifeStudyItems,
  createRealLifeProgressItem,
  indexRealLifeProgress,
} from '../../services/realLifeProgress.ts';
import { catalogProgressItemId, catalogProgressKind } from '../../services/catalogProgressIdentity.ts';
import { SRSAlgorithm } from '../../services/srsAlgorithm.ts';
import type { SentenceReviewState } from '../../services/sentenceReviewState.ts';
import type { SentenceData } from '../../types.ts';
import { SentenceSpeakerButton } from '../../components/SentenceSpeakerButton.tsx';
import { RealLifeSentenceRow } from '../../views/reading/RealLifeCollectionScreen.tsx';

const NOW = 2_000_000;

test('Real Life progress ids are stable and include the collection boundary', () => {
  const career = REAL_LIFE_COLLECTIONS[0].sentences[0];
  // The line's catalog id, under which every user's synced progress on it is kept.
  assert.equal(career.id, 'career-conversations:rapport-and-small-talk:01');
  assert.equal(career.text, 'How was your weekend? Did you get a chance to unplug?');
  const item = createRealLifeProgressItem(career, 100);
  const data = item.data as SentenceData;

  assert.equal(item.data.id, 'real-life-sentence:career-conversations:rapport-and-small-talk:01');
  assert.equal(item.data.id, catalogProgressItemId('real-life', career.id));
  assert.equal(data.catalogKind, 'real-life');
  assert.equal(data.catalogCollectionId, 'career-conversations');
  assert.equal(data.catalogSentenceId, career.id);
  assert.equal(catalogProgressKind(item), 'real-life');
  assert.equal(item.savedAt, 100);
  assert.equal(item.srs.id, item.data.id);
  assert.equal(item.srs.type, 'sentence');
  assert.equal(item.srs.totalReviews, 0);
});

test('each collection computes an isolated queue and mastery score', () => {
  const career = REAL_LIFE_COLLECTIONS[0];
  const careerItem = createRealLifeProgressItem(career.sentences[0], 100);
  careerItem.srs = {
    ...SRSAlgorithm.createNew(careerItem.data.id, 'sentence'),
    totalReviews: 3,
    memoryStrength: 60,
    nextReview: NOW - 1,
  };

  const index = indexRealLifeProgress([careerItem]);
  const careerProgress = summarizeCatalogProgress(career.sentences, index, NOW);
  assert.deepEqual(
    { reviewed: careerProgress.reviewed, due: careerProgress.due, memorized: careerProgress.memorized },
    { reviewed: 1, due: 1, memorized: 0 },
  );
  assert.equal(careerProgress.unreviewed, career.sentences.length - 1);
  assert.equal(careerProgress.masteryScore, Math.round(60 / career.sentences.length));

  for (const collection of REAL_LIFE_COLLECTIONS.slice(1)) {
    const isolatedProgress = summarizeCatalogProgress(collection.sentences, index, NOW);
    assert.equal(isolatedProgress.reviewed, 0, `${collection.id} must not inherit Career reviews`);
    assert.equal(isolatedProgress.due, 0, `${collection.id} must not inherit Career due cards`);
    assert.equal(isolatedProgress.masteryScore, 0, `${collection.id} must not inherit Career mastery`);
    assert.equal(isolatedProgress.unreviewed, collection.sentences.length);
  }
});

test('study items overlay only their exact stored catalog progress', () => {
  const career = REAL_LIFE_COLLECTIONS[0];
  const stored = createRealLifeProgressItem(career.sentences[1], 100);
  stored.srs = { ...stored.srs, totalReviews: 2, memoryStrength: 35 };

  const queue = buildRealLifeStudyItems(career.sentences.slice(0, 3), indexRealLifeProgress([stored]), 500);
  assert.equal(queue.length, 3);
  assert.equal(queue[0].srs.totalReviews, 0);
  assert.equal(queue[1], stored);
  assert.equal(queue[2].srs.totalReviews, 0);
  assert.equal(queue[0].savedAt, 500);
  assert.ok(queue.every(item => (item.data as SentenceData).catalogCollectionId === career.id));
});

test('a row\'s pill says where its line stands, Due in orange when it is due, at one width for every state', () => {
  const sentence = REAL_LIFE_COLLECTIONS[0].sentences[0];
  const row = (state: SentenceReviewState) => renderToStaticMarkup(createElement(RealLifeSentenceRow, {
    sentence, softClass: 'bg-indigo-50 text-indigo-700', saved: false, state, masteryPercent: 64, onOpen: () => {}, onMarkReviewed: () => {},
    onPlaybackStart: () => {},
  }));
  const pill = 'flex min-w-[4.5rem] shrink-0 items-center justify-center rounded-full px-2 py-0.5 text-[10px]';
  const reviewed = '<button type="button" class="flex min-h-8 items-center gap-1 rounded-lg bg-emerald-50 px-2.5 text-xs font-bold text-emerald-700 transition-colors hover:bg-emerald-100" title="Mark as reviewed">';

  const memorized = row('memorized');
  assert.ok(memorized.includes(`<span class="${pill} gap-1 bg-emerald-50 font-bold text-emerald-700"><svg`));
  assert.match(memorized, /lucide-circle-check[^>]*>.*?<\/svg> 64%<\/span>/);
  assert.ok(!memorized.includes(reviewed), 'a memorized line has nothing to review');

  const due = row('due');
  assert.ok(due.includes(`<span class="${pill} bg-orange-50 font-bold text-orange-600">Due</span>`));
  assert.ok(due.includes(reviewed));
  assert.ok(!due.includes('64%'), 'a due line no longer looks finished');

  const unreviewed = row('unreviewed');
  assert.ok(unreviewed.includes(`<span class="${pill} bg-slate-100 font-semibold text-slate-500">Unreviewed</span>`));
  assert.ok(unreviewed.includes(reviewed));
});

/** A row's elements, depth first: the memoized row's inner function uses no hooks, so calling it returns them. */
function rowElements(props: ComponentProps<typeof RealLifeSentenceRow>): ReactElement<Record<string, unknown>>[] {
  const out: ReactElement<Record<string, unknown>>[] = [];
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) return node.forEach(walk);
    if (!isValidElement<Record<string, unknown>>(node)) return;
    out.push(node);
    walk(node.props.children);
  };
  walk((RealLifeSentenceRow as unknown as { type: (rowProps: typeof props) => ReactNode }).type(props));
  return out;
}

test('a row\'s speaker hands each read to the list and leaves it playing when the row goes', () => {
  const keepRead = () => {};
  const speaker = rowElements({
    sentence: REAL_LIFE_COLLECTIONS[0].sentences[0], softClass: 'bg-indigo-50 text-indigo-700', saved: false, state: 'due',
    masteryPercent: 0, onOpen: () => {}, onMarkReviewed: () => {}, onPlaybackStart: keepRead,
  }).find(element => element.type === SentenceSpeakerButton);
  assert.ok(speaker, 'the row has its speaker');
  assert.equal(speaker.props.stopOnUnmount, false, 'a row that scrolls out of the list leaves its read playing');
  assert.equal(speaker.props.onPlaybackStart, keepRead, 'the list keeps the read, to stop it when it closes');
});
