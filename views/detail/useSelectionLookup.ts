import { useCallback, useRef, type PointerEvent as ReactPointerEvent } from 'react';
import type { StoredItem } from '../../types';
import { useLatest } from '../../hooks/useStableValue';
import { isSentenceSelection, pointInRects, selectionLookupTerm } from '../../services/selectionLookup';
import { flashWord } from './wordFlash';

/** How long after its pointerdown a click may still take the selection the pointerdown found. */
const CLICK_WINDOW_MS = 1_000;

interface SelectionLookupOptions {
  /** A saved word or phrase for the selection opens its card (with onOpenCard), as a saved word in the sentence does. */
  findSaved?: (term: string) => StoredItem | null;
  onOpenCard?: (item: StoredItem) => void;
  /** Looks the selection up otherwise: as one expression, however many words, with the sentence as its context. */
  onSearch: (term: string) => void;
}

/** A selection a Command/Ctrl-pointerdown found inside the sentence, for the click that follows it. */
interface FoundSelection {
  term: string;
  /** The sentence's words the selection covers, which flash as it's looked up. */
  words: HTMLElement[];
  at: number;
}

/**
 * Sentence review's phrase look-up, on a laptop: text selected in the sentence and then Command/Ctrl-clicked inside the
 * selection looks up the selection (1–6 words) instead of the word under the pointer. The click comes too late to read
 * it, because a click inside a selection collapses it first, so the sentence's element reads it at pointerdown, in the
 * capture phase (onPointerDownCapture), and the click that follows within a second takes it (lookUpSelection). With no
 * selection, one that isn't the sentence's or too long, or the pointer off it, Command/Ctrl-click looks up the word as
 * before, and a plain click still plays from the word. The phone's two-finger tap doesn't read selections (yet).
 */
export function useSelectionLookup(options: SelectionLookupOptions) {
  const optionsRef = useLatest(options);
  const foundRef = useRef<FoundSelection | null>(null);

  const onPointerDownCapture = useCallback((e: ReactPointerEvent<HTMLElement>) => {
    foundRef.current = null;
    if (!e.metaKey && !e.ctrlKey) return;
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed || selection.rangeCount === 0) return;
    const sentence = e.currentTarget;
    const term = selectionLookupTerm(
      selection.toString(),
      isSentenceSelection(selection.anchorNode, selection.focusNode, sentence),
    );
    if (!term) return;
    const range = selection.getRangeAt(0);
    if (!pointInRects(e.clientX, e.clientY, range.getClientRects())) return;
    const words = [...sentence.querySelectorAll<HTMLElement>('[data-word-offset]')].filter(word => range.intersectsNode(word));
    foundRef.current = { term, words, at: Date.now() };
  }, []);

  /** In a Command/Ctrl-click: looks up the selection its pointerdown found, if any, and says whether it did. */
  const lookUpSelection = useCallback((): boolean => {
    const found = foundRef.current;
    foundRef.current = null;
    if (!found || Date.now() - found.at > CLICK_WINDOW_MS) return false;
    for (const word of found.words) flashWord(word, 'lookup');
    const { findSaved, onOpenCard, onSearch } = optionsRef.current;
    const saved = findSaved?.(found.term) ?? null;
    if (saved && onOpenCard) onOpenCard(saved);
    else onSearch(found.term);
    return true;
  }, [optionsRef]);

  return { onPointerDownCapture, lookUpSelection };
}
