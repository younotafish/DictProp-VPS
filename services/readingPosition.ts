import { defaultStorage, parseJson, type StorageLike } from './browserStorage';

/**
 * Where each essay was left, per signed-in user, so an essay reopens there and the Essays page offers to continue it.
 * Kept on the device in localStorage under 'reading_positions_v1:<userId>', never synced: the essays read most
 * recently, at most eight, in at most 1,024 characters. A missing or damaged value reads as no positions. Only the
 * lazily loaded Essays tab imports this file.
 */

/** One essay's place. The keys are short so that eight fit in 1 KB. */
export interface ReadingPosition {
  /** The essay's id. */
  id: string;
  /** The sentence's id. Stored without its essay's id when it starts with it, as every catalog's sentence ids do. */
  s: string;
  /** The sentence's position in the essay, from 1, for when that sentence is gone (returnTarget). */
  p: number;
  /** How many sentences the essay had, for 'sentence p of n'. */
  n: number;
  /** The essay's title, at most 60 characters, for the Continue card while a private essay is still loading. */
  t: string;
  /** When it was left, in ms. */
  at: number;
  /** The essay was read to its last sentence, so it opens at its title again. */
  f?: 1;
}

const MAX_READING_POSITIONS = 8;
export const MAX_ENCODED_POSITIONS = 1024;
const MAX_TITLE = 60;

export const readingPositionsKey = (userId: string): string => `reading_positions_v1:${userId}`;

/** An essay's place at `sentence`, left at `at`. */
export function readingPosition(
  essay: { id: string; title: string; sentences: readonly unknown[] },
  sentence: { id: string; position: number },
  finished: boolean,
  at: number,
): ReadingPosition {
  const entry: ReadingPosition = {
    id: essay.id,
    s: sentence.id,
    p: sentence.position,
    n: essay.sentences.length,
    t: [...essay.title].slice(0, MAX_TITLE).join(''),
    at,
  };
  if (finished) entry.f = 1;
  return entry;
}

const isPositiveInteger = (value: unknown): value is number => Number.isInteger(value) && (value as number) > 0;

// A sentence id that starts with its essay's id and a colon (the server requires it of a private catalog, and the
// public one follows it) is stored as the colon and the rest, ':p012:s03'. No sentence id starts with a colon.
const storedSentenceId = (entry: ReadingPosition): string =>
  entry.s.startsWith(`${entry.id}:`) ? entry.s.slice(entry.id.length) : entry.s;

/** How `entries` are stored. */
export const encodeReadingPositions = (entries: readonly ReadingPosition[]): string =>
  JSON.stringify(entries.map(entry => ({ ...entry, s: storedSentenceId(entry) })));

function decodeEntry(value: unknown): ReadingPosition | null {
  if (!value || typeof value !== 'object') return null;
  const { id, s, p, n, t, at, f } = value as Record<string, unknown>;
  if (typeof id !== 'string' || !id || typeof s !== 'string' || !s || s === ':' || !isPositiveInteger(p)
    || !isPositiveInteger(n) || typeof t !== 'string' || typeof at !== 'number' || !Number.isFinite(at)
    || (f !== undefined && f !== 1)) return null;
  const entry: ReadingPosition = { id, s: s.startsWith(':') ? id + s : s, p, n, t: [...t].slice(0, MAX_TITLE).join(''), at };
  if (f === 1) entry.f = 1;
  return entry;
}

/**
 * The positions to keep: newest first, one per essay (the newest), at most eight, and fewer when eight wouldn't fit in
 * 1,024 characters as stored.
 */
export function keepRecentPositions(entries: readonly ReadingPosition[]): ReadingPosition[] {
  const kept: ReadingPosition[] = [];
  const essays = new Set<string>();
  for (const entry of [...entries].sort((a, b) => b.at - a.at)) {
    if (essays.has(entry.id)) continue;
    essays.add(entry.id);
    kept.push(entry);
    if (kept.length === MAX_READING_POSITIONS) break;
  }
  while (kept.length > 1 && encodeReadingPositions(kept).length > MAX_ENCODED_POSITIONS) kept.pop();
  return kept;
}

/** The positions stored as `raw`, newest first, without any entry that isn't one. Never throws. */
export function decodeReadingPositions(raw: string | null): ReadingPosition[] {
  const parsed = parseJson(raw);
  if (!Array.isArray(parsed)) return [];
  return keepRecentPositions(parsed.map(decodeEntry).filter(entry => entry !== null));
}

/** The user's stored positions, newest first. */
export function readReadingPositions(userId: string, storage: StorageLike | null = defaultStorage()): ReadingPosition[] {
  try {
    return decodeReadingPositions(storage?.getItem(readingPositionsKey(userId)) ?? null);
  } catch {
    return [];
  }
}

/** `entry` saved as its essay's place among the user's stored positions, which are returned as kept. */
export function writeReadingPosition(
  userId: string,
  entry: ReadingPosition,
  storage: StorageLike | null = defaultStorage(),
): ReadingPosition[] {
  const kept = keepRecentPositions([entry, ...readReadingPositions(userId, storage)]);
  try {
    storage?.setItem(readingPositionsKey(userId), encodeReadingPositions(kept));
  } catch {
    // Storage full or refused: the place is kept for this visit only.
  }
  return kept;
}

/**
 * The sentence to come back to: the one `last` names, or, if it has gone from the essay (its catalog changed), the
 * one now at its position or the first after it, or else the last sentence. Null for an essay without sentences.
 */
export function returnTarget<S extends { id: string; position: number }>(
  last: { id: string; position: number },
  sentences: readonly S[],
): S | null {
  if (sentences.length === 0) return null;
  return sentences.find(sentence => sentence.id === last.id)
    ?? sentences.find(sentence => sentence.position >= last.position)
    ?? sentences[sentences.length - 1];
}

/** The essay the Essays page offers to continue, and its place. */
export interface ContinueReading<E> {
  entry: ReadingPosition;
  /** Null while a private essay's catalog hasn't loaded: the card shows the stored title and can't be opened yet. */
  essay: E | null;
}

/**
 * The most recently left essay not read to its end. An essay not in `essays` is offered, unopenable, only while the
 * private catalog hasn't loaded (it may be one of its essays); once it has, such an essay is gone and is passed over.
 */
export function continueCandidate<E extends { id: string }>(
  entries: readonly ReadingPosition[],
  essays: readonly E[],
  privateCatalogLoaded: boolean,
): ContinueReading<E> | null {
  for (const entry of [...entries].sort((a, b) => b.at - a.at)) {
    if (entry.f) continue;
    const essay = essays.find(candidate => candidate.id === entry.id);
    if (essay) return { entry, essay };
    if (!privateCatalogLoaded) return { entry, essay: null };
  }
  return null;
}

/** A sentence the page brings back into view sits on this line, a third of the way down the reader. */
const READING_LINE = 1 / 3;
/** Rounding slack, in px, when telling whether a sentence starts on the reading line. */
const SLACK = 2;

/** Where a sentence is in the reader's scrolled content, in px from its top. */
export interface SentenceBox {
  top: number;
  bottom: number;
}

/**
 * The scrollTop that puts a sentence on the reading line (never below 0), or null when the sentence is already wholly
 * in view at `scrollTop` and the page needn't move.
 */
export function scrollTopToShow(box: SentenceBox, scrollTop: number, viewportHeight: number): number | null {
  if (box.top >= scrollTop && box.bottom <= scrollTop + viewportHeight) return null;
  return Math.max(0, Math.round(box.top - viewportHeight * READING_LINE));
}

/**
 * The sentence (an index into `boxes`, in reading order) a reader leaving the page at `scrollTop` comes back to: the
 * first that starts on the reading line or below it, or the last sentence once the line is past its start. That is the
 * sentence scrollTopToShow puts on the line, so leaving and coming back without scrolling keeps the place. -1 while
 * the first sentence is still below the view, the reader in the essay's opening pages.
 */
export function sentenceAtReadingLine(boxes: readonly SentenceBox[], scrollTop: number, viewportHeight: number): number {
  if (boxes.length === 0 || boxes[0].top >= scrollTop + viewportHeight) return -1;
  const line = scrollTop + viewportHeight * READING_LINE - SLACK;
  const index = boxes.findIndex(box => box.top >= line);
  return index === -1 ? boxes.length - 1 : index;
}

/** Whether the reader has reached the last sentence: it is in view at `scrollTop`, or above it. */
export const lastSentenceReached = (boxes: readonly SentenceBox[], scrollTop: number, viewportHeight: number): boolean =>
  boxes.length > 0 && boxes[boxes.length - 1].top < scrollTop + viewportHeight;
