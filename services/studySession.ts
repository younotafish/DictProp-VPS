import {
  type ReviewRating,
  type ReviewTaskType,
  type StoredItem,
  getItemSpelling,
  getItemTitle,
  isPhraseItem,
  isVocabItem,
} from '../types';

export interface StudyContent {
  word: string;
  chinese: string;
  definition: string;
  example: string;
}

export function stripStudyMarkers(text: string): string {
  return (text || '').replace(/\{\{(.+?)\}\}/g, '$1').replace(/\[\[(.+?)\]\]/g, '$1');
}

export function getStudyContent(item: StoredItem): StudyContent {
  if (isVocabItem(item)) {
    return {
      word: item.data.word,
      chinese: item.data.chinese,
      definition: item.data.definition,
      example: item.data.examples?.[0] || '',
    };
  }
  if (isPhraseItem(item)) {
    const vocab = item.data.vocabs?.find(candidate =>
      candidate.word.trim().toLowerCase() === item.data.query.trim().toLowerCase()
    ) || item.data.vocabs?.[0];
    return {
      word: item.data.query,
      chinese: item.data.translation || vocab?.chinese || '',
      definition: vocab?.definition || item.data.grammar || '',
      example: vocab?.examples?.[0] || '',
    };
  }
  return { word: getItemTitle(item), chinese: '', definition: '', example: '' };
}

export function createClozePrompt(sentence: string, word: string): string {
  const markedCloze = (sentence || '').replace(/\{\{(.+?)\}\}/g, '_____');
  const plain = stripStudyMarkers(markedCloze);
  if (plain.includes('_____')) return plain;
  if (!word.trim()) return plain;
  const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return plain.replace(new RegExp(`\\b${escaped}\\b`, 'i'), '_____');
}

export function selectReviewTask(item: StoredItem): ReviewTaskType {
  const strength = item.srs?.memoryStrength || 0;
  const reviews = item.srs?.totalReviews || 0;
  if (strength < 30) return 'meaning';
  if (strength < 55) return reviews % 2 === 0 ? 'production' : 'meaning';

  const content = getStudyContent(item);
  const cloze = createClozePrompt(content.example, content.word);
  if (!content.example || !cloze.includes('_____')) return 'production';
  return reviews % 2 === 0 ? 'cloze' : 'listening';
}

export function buildReviewQueue(
  items: readonly StoredItem[],
  now = Date.now(),
  dueLimit = 40,
  newLimit = 10,
): StoredItem[] {
  const due = items
    .filter(item => (item.srs?.totalReviews || 0) > 0 && (item.srs?.nextReview || 0) <= now)
    .sort((a, b) => (a.srs?.nextReview || 0) - (b.srs?.nextReview || 0));
  const fresh = items
    .filter(item => (item.srs?.totalReviews || 0) === 0)
    .sort((a, b) => a.savedAt - b.savedAt);
  const seenSpellings = new Set<string>();
  const burySiblings = (list: StoredItem[], limit: number) => list.filter(item => {
    const spelling = getItemSpelling(item);
    if (!spelling || seenSpellings.has(spelling)) return false;
    seenSpellings.add(spelling);
    return true;
  }).slice(0, limit);
  return [...burySiblings(due, dueLimit), ...burySiblings(fresh, newLimit)];
}

/**
 * The position of the card a session shows, from `index` on. Cards that left the study list mid-session
 * (deleted or archived) are passed over, and one passed over since `passedOverFrom` that is back, as an
 * undone delete brings it, is shown again where it was. itemIds.length once no card is left.
 */
export function findSessionCard(
  itemIds: readonly string[],
  index: number,
  passedOverFrom: number | undefined,
  has: (id: string) => boolean,
): number {
  for (let at = passedOverFrom ?? index; at < index; at++) if (has(itemIds[at])) return at;
  let at = index;
  while (at < itemIds.length && !has(itemIds[at])) at++;
  return at;
}

/** A card rated Again comes back at the end of the session, as a further prompt after the rest. */
export function requeueLapse(itemIds: string[], index: number, rating: ReviewRating): string[] {
  return rating === 'again' && index < itemIds.length ? [...itemIds, itemIds[index]] : itemIds;
}

export function formatReviewInterval(minutes: number): string {
  if (minutes < 60) return `${minutes}m`;
  if (minutes < 1440) return `${Math.round(minutes / 60)}h`;
  return `${Math.round(minutes / 1440)}d`;
}
