/**
 * What sentence auto-play preloads: only the part of the list the session can reach. From the card on screen, in the
 * order auto-play reads, it takes cards until their estimated reading time covers 1.25 times what's left of the
 * Duration, and at least ten of them, with each sentence's clips in the voice it will be read in. Pure, so the plan is
 * tested in node; components/SessionPreload.tsx downloads it.
 */
import type { TtsStyle } from '../ttsSettings';
import { EMPTY_CARD_MS } from './autoplayController';

/** A comfortable reading pace for the estimate, in words per second at normal speed. */
const WORDS_PER_SECOND = 2.6;
/** How much more than the time left the plan covers, for reads that go faster than the estimate. */
const PRELOAD_COVER = 1.25;
/** The fewest cards a plan covers, however little time is left. */
export const PRELOAD_MIN_CARDS = 10;

/** A card as the preload sees it. */
export interface PreloadCard {
  /** The card's item id (in sentence review, the sentence's). */
  id: string;
  /** What auto-play reads on it, in order. */
  texts: readonly string[];
  /** The voice the card switches to when it comes up, if it keeps one of its own (a saved sentence's choice). */
  preferredStyle?: TtsStyle;
  /** Its picture, if one is stored on the device or the server: the item's id, and the server's version when known. */
  image?: { id: string; version?: string };
}

/** One clip to fetch: a text in the voice it will be read in. */
export interface PreloadClip {
  text: string;
  style: TtsStyle;
}

export interface PreloadPlan {
  /** The cards covered: from fromIndex up to, not including, toIndex. */
  fromIndex: number;
  toIndex: number;
  /** Their clips, in reading order, each text once per voice. */
  clips: PreloadClip[];
  /** Their pictures, by item id, with the server's version when known. */
  images: Map<string, string | undefined>;
  /** How long reading those cards should take. */
  estimateMs: number;
}

export interface PreloadInput {
  cards: readonly PreloadCard[];
  /** The card on screen, where auto-play reads next. */
  fromIndex: number;
  /** What's left of the Duration. */
  remainingMs: number;
  repeats: number;
  /** The silence between reads. */
  gapMs: number;
  /** The silence after a card's last read: the gap in sentence review, a short beat between word cards. */
  cardGapMs: number;
  /** The voice speed (1 is normal). */
  rate: number;
  /** The speech style now: the card on screen plays in it, and the cards after it start from it. */
  currentStyle: TtsStyle;
  minCards?: number;
  cover?: number;
}

const wordCount = (text: string): number => text.split(/\s+/).filter(Boolean).length;

/** How long one read of `text` takes at `rate`, at WORDS_PER_SECOND. */
export const estimateReadMs = (text: string, rate: number): number =>
  (wordCount(text) / WORDS_PER_SECOND / (rate > 0 ? rate : 1)) * 1000;

/** How long auto-play spends on `card`: each text read `repeats` times with the gap between reads, then the gap after the card. */
const cardMs = (card: PreloadCard, { repeats, gapMs, cardGapMs, rate }: PreloadInput): number => {
  if (card.texts.length === 0) return EMPTY_CARD_MS;
  const reads = card.texts.reduce((total, text) => total + repeats * (estimateReadMs(text, rate) + gapMs), 0);
  return reads - gapMs + cardGapMs;
};

/**
 * The cards from `fromIndex` the session can reach, and their clips and pictures. Voices follow the reading as the card
 * view sets them: the card on screen plays in the style now on, even when a click on Clear or Casual set it apart from
 * the card's own voice; after it, a card with its own voice switches to it, and one without keeps the voice the card
 * before left.
 */
export function planAutoplayPreload(input: PreloadInput): PreloadPlan {
  const { cards, remainingMs, currentStyle, minCards = PRELOAD_MIN_CARDS, cover = PRELOAD_COVER } = input;
  const fromIndex = Math.max(0, Math.min(Math.floor(input.fromIndex), cards.length));
  const target = cover * Math.max(0, remainingMs);
  const clips: PreloadClip[] = [];
  const seen = new Set<string>();
  const images = new Map<string, string | undefined>();
  let style = currentStyle;
  let estimateMs = 0;
  let index = fromIndex;
  while (index < cards.length && (index - fromIndex < minCards || estimateMs < target)) {
    const card = cards[index];
    if (index > fromIndex) style = card.preferredStyle ?? style;
    for (const text of card.texts) {
      const key = `${style}\n${text}`;
      if (seen.has(key)) continue;
      seen.add(key);
      clips.push({ text, style });
    }
    if (card.image) images.set(card.image.id, card.image.version);
    estimateMs += cardMs(card, input);
    index++;
  }
  return { fromIndex, toIndex: index, clips, images, estimateMs };
}

/** Whether the card at `index` lies outside `plan`, as after a swipe or a lock-screen skip past it, so it needs a new one. */
export const needsReplan = (plan: PreloadPlan, index: number): boolean => index < plan.fromIndex || index >= plan.toIndex;
