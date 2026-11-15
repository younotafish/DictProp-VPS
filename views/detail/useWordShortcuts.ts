import { useEffect, type Dispatch, type RefObject, type SetStateAction } from 'react';
import type { StoredItem } from '../../types';
import { speakWord } from '../../services/lazyTts';
import { isDialogOpenOutside, isImeKey, isTypingTarget } from '../../components/keyboardTarget';

interface WordShortcutsOptions {
  enabled: boolean;
  /** The view's root, to tell a dialog over it from one inside it. */
  rootRef: RefObject<HTMLElement | null>;
  speakSentenceAt: (index: number) => void;
  setShowHeader: Dispatch<SetStateAction<boolean>>;
  title: string;
  readCardExamples: () => void;
  handleRemember: () => void;
  handleResetSRS: () => void;
  handleToggleSave: () => void;
  handleDeleteItem: () => void;
  handleArchiveItem: () => void;
  isSaved: boolean;
  savedItemMatch: StoredItem | undefined;
  onUnarchive?: (id: string) => void;
  isSentenceAutoPlaying: boolean;
  toggleSentenceAutoPlay: () => void;
  toggleAutoPlay: () => void;
  cycleSpeed: () => void;
}

/** The word card's letter keys: H, P, E, R and Shift+R, S, D, A, Space, +, and Cmd/Ctrl+1–4. */
export function useWordShortcuts({
  enabled, rootRef, speakSentenceAt, setShowHeader, title, readCardExamples, handleRemember, handleResetSRS,
  handleToggleSave, handleDeleteItem, handleArchiveItem, isSaved, savedItemMatch, onUnarchive, isSentenceAutoPlaying,
  toggleSentenceAutoPlay, toggleAutoPlay, cycleSpeed,
}: WordShortcutsOptions) {
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

      // H: Toggle the header
      if (e.key === 'h' || e.key === 'H') {
        e.preventDefault();
        setShowHeader(prev => !prev);
      }

      // P: Pronounce the word (system voice)
      if (e.key === 'p' || e.key === 'P') {
        e.preventDefault();
        if (title) speakWord(title);
      }

      // E: Read the example sentence(s) aloud (neural voice); press again to stop
      if (e.key === 'e' || e.key === 'E') {
        e.preventDefault();
        readCardExamples();
      }

      // R: Remember (Shift+R: Reset)
      if (e.key === 'r' || e.key === 'R') {
         if (e.shiftKey) {
             e.preventDefault();
             handleResetSRS();
         } else {
             e.preventDefault();
             handleRemember();
         }
      }
      
      // S: Toggle save
      if (e.key === 's' || e.key === 'S') {
        e.preventDefault();
        handleToggleSave();
      }

      // D: Delete the saved word directly
      if (e.key === 'd' || e.key === 'D') {
        e.preventDefault();
        if (isSaved) handleDeleteItem();
      }

      // A: Archive / Unarchive
      if (e.key === 'a' || e.key === 'A') {
        e.preventDefault();
        if (savedItemMatch?.isArchived) onUnarchive?.(savedItemMatch.data.id);
        else if (isSaved) handleArchiveItem();
      }

      // Space: stops whichever auto-play is running, or starts the slideshow — the two never run at once.
      if (e.key === ' ') {
        e.preventDefault();
        if (isSentenceAutoPlaying) {
          toggleSentenceAutoPlay();
        } else {
          toggleAutoPlay();
        }
      }

      // +/=: Cycle speed forward
      if (e.key === '+' || e.key === '=') {
        e.preventDefault();
        cycleSpeed();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
    // The listener registers again on the same changes as before the split. handleDeleteItem and handleArchiveItem
    // are fresh closures each render and stay out, as before; what they read is listed, apart from onArchive.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    enabled, rootRef, title, handleRemember, handleResetSRS, handleToggleSave, isSaved, savedItemMatch, onUnarchive,
    cycleSpeed, readCardExamples, speakSentenceAt, setShowHeader, isSentenceAutoPlaying, toggleSentenceAutoPlay,
    toggleAutoPlay,
  ]);
}
