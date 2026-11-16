import type { Dispatch, SetStateAction } from 'react';
import type { StoredItem } from '../../types';
import { getPlaybackState, pauseCurrent, resumeCurrent, speakWord } from '../../services/neuralTts';
import { acceptKeyRepeat } from '../../components/keyboardTarget';

/**
 * The card view's letter shortcuts, apart from React and the DOM so node tests can pin them. Each view's listener
 * (useSentenceShortcuts, useWordShortcuts) leaves alone keys being typed or composed and keys a dialog over the view
 * has, and hands every other key here with the handlers of the card on screen, read as the key is pressed. A held
 * key acts once, when pressed (acceptKeyRepeat), so holding D can't delete card after card.
 */

/** What the shortcuts read from a key press. */
export type CardKeyEvent = Pick<KeyboardEvent, 'key' | 'repeat' | 'shiftKey' | 'metaKey' | 'ctrlKey' | 'altKey' | 'preventDefault'>;

/** What sentence review's keys act with: the handlers of the sentence on screen and the flags that gate them. */
export interface SentenceKeyHandlers {
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
}

/** Sentence review's keys: P, E, R and Shift+R, D, Space, and Cmd/Ctrl+1–4. */
export function handleSentenceKey(e: CardKeyEvent, handlers: SentenceKeyHandlers): void {
  const {
    title, speakSentenceAt, readCurrentSentence, isSentencePreview, catalogSentencePreview, handleRemember,
    handleResetSRS, handleDeleteItem, isSentenceAutoPlaying, toggleSentenceAutoPlay,
  } = handlers;
  if (!acceptKeyRepeat(e)) return;

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

  // D: Delete the sentence directly (a preview has nothing to delete, and a catalog lesson's lines aren't the
  // learner's to delete)
  if (e.key === 'd' || e.key === 'D') {
    e.preventDefault();
    if (!isSentencePreview && !catalogSentencePreview) handleDeleteItem();
  }

  // Space: pause/resume the sentence that's playing; if nothing is playing, start continuous auto-play.
  if (e.key === ' ') {
    e.preventDefault();
    const st = getPlaybackState().status;
    if (st === 'playing') pauseCurrent();
    else if (st === 'paused') resumeCurrent();
    else if (!isSentenceAutoPlaying) toggleSentenceAutoPlay(); // only the visible Stop control exits autoplay
  }
}

/** What the word card's keys act with: the handlers of the card on screen and the flags that gate them. */
export interface WordKeyHandlers {
  speakSentenceAt: (index: number) => void;
  setShowHeader: Dispatch<SetStateAction<boolean>>;
  title: string;
  readCardExamples: () => void;
  handleRemember: () => void;
  handleResetSRS: () => void;
  /** Saves the card, as Cmd/Ctrl+S does; a saved card stays as it is. */
  handleSaveShortcut: () => void;
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

/** The word card's keys: H, P, E, R and Shift+R, S, D, A, Space, +, and Cmd/Ctrl+1–4. */
export function handleWordKey(e: CardKeyEvent, handlers: WordKeyHandlers): void {
  const {
    speakSentenceAt, setShowHeader, title, readCardExamples, handleRemember, handleResetSRS, handleSaveShortcut,
    handleDeleteItem, handleArchiveItem, isSaved, savedItemMatch, onUnarchive, isSentenceAutoPlaying,
    toggleSentenceAutoPlay, toggleAutoPlay, cycleSpeed,
  } = handlers;
  if (!acceptKeyRepeat(e)) return;

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
    e.preventDefault();
    if (e.shiftKey) handleResetSRS();
    else handleRemember();
  }

  // S: Save, as Cmd/Ctrl+S does; it never unsaves (D deletes)
  if (e.key === 's' || e.key === 'S') {
    e.preventDefault();
    handleSaveShortcut();
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
    if (isSentenceAutoPlaying) toggleSentenceAutoPlay();
    else toggleAutoPlay();
  }

  // +/=: Cycle speed forward
  if (e.key === '+' || e.key === '=') {
    e.preventDefault();
    cycleSpeed();
  }
}
