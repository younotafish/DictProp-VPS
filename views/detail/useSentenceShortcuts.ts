import { useEffect, type RefObject } from 'react';
import type { StoredItem } from '../../types';
import { getPlaybackState, pauseCurrent, resumeCurrent, speakWord } from '../../services/lazyTts';
import { isDialogOpenOutside, isImeKey, isTypingTarget } from '../../components/keyboardTarget';

interface SentenceShortcutsOptions {
  enabled: boolean;
  /** The view's root, to tell a dialog over it from one inside it. */
  rootRef: RefObject<HTMLElement | null>;
  /** The sentence's source word, which P pronounces. */
  title: string;
  /** Cmd/Ctrl+1–4: the source card's example sentences. */
  speakSentenceAt: (index: number) => void;
  readCurrentSentence: () => void;
  isSentencePreview: boolean;
  catalogSentencePreview: boolean;
  handleRemember: () => void;
  handleResetSRS: () => void;
  handleDeleteItem: () => void;
  isSentenceAutoPlaying: boolean;
  toggleSentenceAutoPlay: () => void;
  cycleSpeed: () => void;
  /**
   * Changes that register the listener again, the same ones as when both modes shared it: the source card, its
   * saved copy and the library callbacks. The listener keeps the handleDeleteItem of the render it was registered
   * in, so after a move between two sentences of one word, D still deletes the sentence shown before.
   */
  rebindOn: {
    sourceData: StoredItem['data'];
    sourceType: StoredItem['type'];
    sourceSavedCopy: StoredItem | undefined;
    sourceSaved: boolean;
    onSave: (item: StoredItem) => void;
    onDelete: (id: string) => void;
    onUnarchive?: (id: string) => void;
  };
}

/** Sentence review's letter keys: P, E, R and Shift+R, D, Space, +, and Cmd/Ctrl+1–4. */
export function useSentenceShortcuts({
  enabled, rootRef, title, speakSentenceAt, readCurrentSentence, isSentencePreview, catalogSentencePreview,
  handleRemember, handleResetSRS, handleDeleteItem, isSentenceAutoPlaying, toggleSentenceAutoPlay, cycleSpeed,
  rebindOn: { sourceData, sourceType, sourceSavedCopy, sourceSaved, onSave, onDelete, onUnarchive },
}: SentenceShortcutsOptions) {
  useEffect(() => {
    if (!enabled) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      // Typing or composing text isn't a shortcut, a dialog over the view (a confirm, the shortcut list, a
      // search result) has the keys to itself, and a held key acts once rather than deleting card after card.
      if (isTypingTarget(e.target) || isImeKey(e) || e.repeat || isDialogOpenOutside(rootRef.current)) return;

      // Cmd/Ctrl+1–4: Read the corresponding example sentence aloud (neural voice)
      if ((e.metaKey || e.ctrlKey) && /^[1-4]$/.test(e.key)) {
        e.preventDefault();
        speakSentenceAt(Number(e.key) - 1);
        return;
      }
      // The rest are bare keys, so Cmd+R still reloads rather than marking the card remembered.
      if (e.metaKey || e.ctrlKey || e.altKey) return;

      // P: Pronounce the word (system voice)
      if (e.key === 'p' || e.key === 'P') {
        e.preventDefault();
        if (title) speakWord(title);
      }

      // E: Read the sentence aloud (neural voice); press again to stop
      if (e.key === 'e' || e.key === 'E') {
        e.preventDefault();
        readCurrentSentence();
      }

      // R: Remember (Shift+R: Reset)
      if (e.key === 'r' || e.key === 'R') {
         if (isSentencePreview && !catalogSentencePreview) return;
         if (e.shiftKey) {
             if (isSentencePreview) return;
             e.preventDefault();
             handleResetSRS();
         } else {
             e.preventDefault();
             handleRemember();
         }
      }

      // D: Delete the sentence directly (a preview has nothing to delete)
      if (e.key === 'd' || e.key === 'D') {
        e.preventDefault();
        if (!isSentencePreview) handleDeleteItem();
      }

      // Space: pause/resume the sentence that's playing; if nothing is playing, start continuous auto-play.
      if (e.key === ' ') {
        e.preventDefault();
        const st = getPlaybackState().status;
        if (st === 'playing') pauseCurrent();
        else if (st === 'paused') resumeCurrent();
        else if (!isSentenceAutoPlaying) toggleSentenceAutoPlay(); // only the visible Stop control exits autoplay
      }

      // +/=: Cycle speed forward
      if (e.key === '+' || e.key === '=') {
        e.preventDefault();
        cycleSpeed();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
    // handleDeleteItem is left out on purpose, keeping the listener's behavior as it was (see rebindOn).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    enabled, rootRef, title, speakSentenceAt, readCurrentSentence, isSentencePreview, catalogSentencePreview,
    handleRemember, handleResetSRS, isSentenceAutoPlaying, toggleSentenceAutoPlay, cycleSpeed,
    sourceData, sourceType, sourceSavedCopy, sourceSaved, onSave, onDelete, onUnarchive,
  ]);
}
