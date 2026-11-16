import type { SentenceData, StoredItem } from '../types';

/**
 * Where a sentence lesson was opened from, so the page that opened it can follow it: closing a lesson opened from an
 * essay brings the essay back to the last sentence the lesson showed. Module state, as the essay reader and the card
 * view are far apart in the tree; only lazily loaded screens import this file (test/client/entry-graph.test.ts).
 *
 * The essay reader begins a lesson just before it opens one. The card view notes each sentence it shows and ends the
 * lesson when it closes. The first view to show a sentence of the essay binds the lesson: only that view's sentences
 * count and only its close ends it, so a view nested in it (a word card's example sentence opened over the lesson)
 * neither moves nor ends the trail.
 */

/** A lesson opened from an essay: by tapping one of its sentences ('read') or with its Study button ('study'). */
export interface LessonOrigin {
  kind: 'essay';
  /** The essay's id, which its sentences carry as catalogCollectionId. */
  collectionId: string;
  mode: 'read' | 'study';
}

/** What an ended lesson reports: where it was opened from, and the last of the essay's sentences it showed. */
export interface LessonEnd {
  origin: LessonOrigin;
  lastItem: StoredItem | null;
}

interface BoundLesson {
  origin: LessonOrigin;
  view: object;
  lastItem: StoredItem | null;
  /** The view has asked to end the lesson; it ends at the next microtask unless the view shows a sentence first. */
  ending: boolean;
}

let begun: LessonOrigin | null = null;
let bound: BoundLesson | null = null;
const listeners = new Set<(end: LessonEnd) => void>();

const belongsTo = (item: StoredItem, origin: LessonOrigin): boolean => {
  if (item.type !== 'sentence') return false;
  const data = item.data as SentenceData;
  return data.catalogKind === origin.kind && data.catalogCollectionId === origin.collectionId;
};

/** A lesson is about to open from `origin`. It replaces any lesson begun or bound before. */
export function beginLesson(origin: LessonOrigin): void {
  begun = origin;
  bound = null;
}

/**
 * Card view `view` (any object that stays the same while the view is open) shows `item`. The first view to show a
 * sentence of the begun lesson's essay binds the lesson; afterwards only that view's sentences of the essay count.
 */
export function noteLessonSentence(view: object, item: StoredItem): void {
  if (bound) {
    if (bound.view !== view || !belongsTo(item, bound.origin)) return;
    bound.lastItem = item;
    bound.ending = false;
    return;
  }
  if (begun && belongsTo(item, begun)) {
    bound = { origin: begun, view, lastItem: item, ending: false };
    begun = null;
  }
}

/**
 * Card view `view` closes. If it bound the lesson, the lesson ends and its listeners hear where it was opened from and
 * the last sentence it showed. That happens at the next microtask: a view that shows a sentence again before then keeps
 * its lesson, as one does when React's StrictMode mounts it a second time in development.
 */
export function endLesson(view: object): void {
  const lesson = bound;
  if (!lesson || lesson.view !== view) return;
  lesson.ending = true;
  queueMicrotask(() => {
    if (bound !== lesson || !lesson.ending) return;
    bound = null;
    const end: LessonEnd = { origin: lesson.origin, lastItem: lesson.lastItem };
    for (const listener of [...listeners]) listener(end);
  });
}

/** Hears every lesson that ends; the returned function stops. */
export function subscribeLessonEnd(listener: (end: LessonEnd) => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
