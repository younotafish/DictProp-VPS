import assert from 'node:assert/strict';
import test from 'node:test';
import { beginLesson, endLesson, noteLessonSentence, subscribeLessonEnd, type LessonEnd } from '../../services/lessonTrail.ts';
import { SRSAlgorithm } from '../../services/srsAlgorithm.ts';
import type { StoredItem } from '../../types.ts';

/** An essay sentence's progress record, as a lesson opened from that essay shows it. */
const essaySentence = (essayId: string, n: number): StoredItem => ({
  type: 'sentence',
  savedAt: 0,
  data: {
    id: `essay-sentence:${essayId}:p001:s0${n}`,
    text: `Sentence ${n}.`,
    sourceWord: 'sentence',
    catalogKind: 'essay',
    catalogSentenceId: `${essayId}:p001:s0${n}`,
    catalogCollectionId: essayId,
  },
  srs: SRSAlgorithm.createNew(`essay-sentence:${essayId}:p001:s0${n}`, 'sentence', 0),
});
/** A word card's example sentence, opened over the lesson in a second card view. */
const preview: StoredItem = {
  type: 'sentence',
  savedAt: 0,
  data: { id: 'sentence-preview:1', text: 'An example.', sourceWord: 'example' },
  srs: SRSAlgorithm.createNew('sentence-preview:1', 'sentence', 0),
};

const read = { kind: 'essay', collectionId: 'self-reliance', mode: 'read' } as const;
const lastId = (end: LessonEnd) => end.lastItem?.data.id;
/** The ends heard while `run` runs, after the microtask each end waits for. */
async function heard(run: () => void): Promise<LessonEnd[]> {
  const ends: LessonEnd[] = [];
  const stop = subscribeLessonEnd(end => ends.push(end));
  try {
    run();
    await Promise.resolve();
  } finally {
    stop();
  }
  return ends;
}

test('the view that shows a sentence of the begun essay binds the lesson, and its close reports the last one shown', async () => {
  const lesson = {};
  const ends = await heard(() => {
    beginLesson(read);
    noteLessonSentence(lesson, essaySentence('self-reliance', 1));
    noteLessonSentence(lesson, essaySentence('self-reliance', 2));
    noteLessonSentence(lesson, essaySentence('self-reliance', 3));
    endLesson(lesson);
  });
  assert.equal(ends.length, 1);
  assert.deepEqual(ends[0].origin, read);
  assert.equal(lastId(ends[0]), 'essay-sentence:self-reliance:p001:s03');
  // Ended: a later close of the same view reports nothing.
  assert.deepEqual(await heard(() => endLesson(lesson)), []);
});

test('sentences shown with no lesson begun, or from another essay, bind nothing', async () => {
  const view = {};
  assert.deepEqual(await heard(() => {
    noteLessonSentence(view, essaySentence('self-reliance', 1));
    endLesson(view);
  }), []);

  assert.deepEqual(await heard(() => {
    beginLesson(read);
    noteLessonSentence(view, essaySentence('corn-pone-opinions', 1));
    noteLessonSentence(view, preview);
    endLesson(view);
  }), []);
});

test('a view nested in the lesson, like a word card\'s example sentence, neither moves the trail nor ends it', async () => {
  const lesson = {};
  const nested = {};
  const ends = await heard(() => {
    beginLesson(read);
    noteLessonSentence(lesson, essaySentence('self-reliance', 4));
    noteLessonSentence(nested, preview);
    // Even a sentence of the same essay, shown by another view, isn't the lesson's.
    noteLessonSentence(nested, essaySentence('self-reliance', 9));
    endLesson(nested);
  });
  assert.deepEqual(ends, [], 'closing the nested view ends nothing');

  const closed = await heard(() => endLesson(lesson));
  assert.equal(closed.length, 1);
  assert.equal(lastId(closed[0]), 'essay-sentence:self-reliance:p001:s04');
});

test('a Study run reports itself as study', async () => {
  const lesson = {};
  const ends = await heard(() => {
    beginLesson({ ...read, mode: 'study' });
    noteLessonSentence(lesson, essaySentence('self-reliance', 7));
    endLesson(lesson);
  });
  assert.equal(ends[0].origin.mode, 'study');
  assert.equal(lastId(ends[0]), 'essay-sentence:self-reliance:p001:s07');
});

test('a view that shows a sentence again right after closing keeps its lesson, as under StrictMode in development', async () => {
  const lesson = {};
  const ends = await heard(() => {
    beginLesson(read);
    noteLessonSentence(lesson, essaySentence('self-reliance', 1));
    // StrictMode runs the view's effects' cleanups, then the effects again, in the same commit.
    endLesson(lesson);
    noteLessonSentence(lesson, essaySentence('self-reliance', 1));
  });
  assert.deepEqual(ends, []);

  const closed = await heard(() => {
    noteLessonSentence(lesson, essaySentence('self-reliance', 2));
    endLesson(lesson);
  });
  assert.equal(lastId(closed[0]), 'essay-sentence:self-reliance:p001:s02');
});

test('a new lesson replaces one begun or bound before', async () => {
  const first = {};
  const second = {};
  const ends = await heard(() => {
    beginLesson(read);
    noteLessonSentence(first, essaySentence('self-reliance', 1));
    beginLesson({ kind: 'essay', collectionId: 'corn-pone-opinions', mode: 'read' });
    endLesson(first);
    noteLessonSentence(second, essaySentence('corn-pone-opinions', 2));
    endLesson(second);
  });
  assert.equal(ends.length, 1);
  assert.equal(ends[0].origin.collectionId, 'corn-pone-opinions');
  assert.equal(lastId(ends[0]), 'essay-sentence:corn-pone-opinions:p001:s02');
});

test('a listener that stops hears no later ends', async () => {
  const ends: LessonEnd[] = [];
  const stop = subscribeLessonEnd(end => ends.push(end));
  stop();
  const lesson = {};
  beginLesson(read);
  noteLessonSentence(lesson, essaySentence('self-reliance', 1));
  endLesson(lesson);
  await Promise.resolve();
  assert.deepEqual(ends, []);
});
