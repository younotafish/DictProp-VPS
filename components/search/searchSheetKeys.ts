import { acceptKeyRepeat } from '../keyboardTarget';
import { stepMeaning } from './searchViewing';

/** What the results sheet knows when a key is pressed. */
export interface SheetKeyState {
  /** The key went to a text field. */
  typing: boolean;
  /** A dialog sits above the sheet (the review popup, a confirmation), so the keys are its. */
  dialogAbove: boolean;
  /** The keyboard moved focus to a control, so Space presses that control. */
  onControl: boolean;
  /** The ready results, and the open one's position among them. */
  resultCount: number;
  resultIndex: number;
  /** The open result's meanings, and the one on screen. */
  meaningCount: number;
  meaningIndex: number;
  /** A meaning's card is on screen; a comparison has none. */
  hasCard: boolean;
}

/** What a key does in the results sheet. */
export type SheetAction =
  /** Show this meaning, saying its word. */
  | { type: 'meaning'; index: number }
  /** Open this result at its first meaning, saying its word. */
  | { type: 'result'; index: number }
  /** Nothing to do, but nothing behind the sheet may act on the key either. Its default stays, so a card can scroll. */
  | { type: 'swallow' }
  /** Read example `index` of the meaning on screen, or pause or resume it. */
  | { type: 'readExample'; index: number }
  /** S: save the meaning on screen; ⇧S: every meaning of the result. */
  | { type: 'save' }
  | { type: 'saveAll' }
  /** P: say the word. */
  | { type: 'pronounce' }
  /** E: read the meaning's examples in turn, or pause or resume them. */
  | { type: 'readExamples' }
  /** Space: pause or resume the sentence playing, or read the first example. */
  | { type: 'togglePlayback' };

export type SheetKeyEvent = Pick<KeyboardEvent, 'key' | 'repeat' | 'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey'>;

/**
 * What `event` does in the results sheet, or null when the sheet leaves it alone. Nothing while typing or under a
 * dialog; a held key acts again only if it's an arrow. ←/→ step through the meanings, round from either end; ↑/↓ move
 * between results without wrapping, and are always the sheet's while it's open, so a view behind never scrolls or
 * steps. With a card on screen: ⌘/Ctrl+1–4 read an example, S saves the meaning (⇧S all of them), P says the word,
 * E reads the examples and Space plays or pauses, unless the keyboard focused a control, which Space then presses.
 * Alt combinations are never the sheet's.
 */
export function searchSheetKeys(event: SheetKeyEvent, state: SheetKeyState): SheetAction | null {
  if (state.typing || state.dialogAbove || event.altKey || !acceptKeyRepeat(event)) return null;
  if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
    const index = stepMeaning(state.meaningIndex, state.meaningCount, event.key === 'ArrowLeft' ? -1 : 1, true);
    return index === null ? { type: 'swallow' } : { type: 'meaning', index };
  }
  if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
    const index = state.resultIndex + (event.key === 'ArrowUp' ? -1 : 1);
    return index >= 0 && index < state.resultCount ? { type: 'result', index } : { type: 'swallow' };
  }
  if (!state.hasCard) return null;
  if (event.metaKey || event.ctrlKey) return /^[1-4]$/.test(event.key) ? { type: 'readExample', index: Number(event.key) - 1 } : null;
  if (event.key === ' ') return state.onControl || event.shiftKey ? null : { type: 'togglePlayback' };
  // By letter, whatever the case, so Caps Lock doesn't change what a key does; Shift does.
  switch (event.key.toLowerCase()) {
    case 's': return event.shiftKey ? { type: 'saveAll' } : { type: 'save' };
    case 'p': return event.shiftKey ? null : { type: 'pronounce' };
    case 'e': return event.shiftKey ? null : { type: 'readExamples' };
    default: return null;
  }
}

/** What the search box's Enter does. */
export type InputEnterAction = 'open-suggestion' | 'submit' | 'view-results';

/**
 * Enter in the search box: open the highlighted saved sentence, else look up what was typed, else, in an empty box,
 * open the results (the first one not seen yet, or the newest); null when there's nothing to do.
 */
export function inputEnterAction({ query, highlightedIndex, suggestionCount, readyCount }: {
  query: string;
  highlightedIndex: number;
  suggestionCount: number;
  readyCount: number;
}): InputEnterAction | null {
  if (highlightedIndex >= 0 && highlightedIndex < suggestionCount) return 'open-suggestion';
  if (query.trim()) return 'submit';
  return readyCount > 0 ? 'view-results' : null;
}
