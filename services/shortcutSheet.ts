import type { ViewState } from '../types';
import { TAB_KEYS } from '../hooks/useAppShortcuts';
import { hasSearchBox } from './navReselect';

/**
 * The gestures and shortcuts sheet (components/KeyboardHelpModal) as data, so a test can pin what it says. Each row
 * describes a live handler in that handler's terms; a change to a key or a gesture edits its row here in the same
 * commit. The rows come from:
 * - Touch: views/detail/useSentenceGestures.ts, useWordGestures.ts and touchGestures.ts, the auto-play button's long press
 *   (views/detail/SentencePlaybackControls.tsx); services/navReselect.ts.
 * - Navigation: hooks/useAppShortcuts.ts (TAB_KEYS, ?, Escape, ⌘Z), services/navReselect.ts (the tabs with a search box),
 *   components/GlobalSearch.tsx (⌘F), views/Notebook.tsx (Escape), the Real Life and essay screens (Escape).
 * - Card view: views/detail/cardKeys.ts handleWordKey, hooks/useKeyboardNavigation.ts, views/detail/useWordGestures.ts.
 * - Sentences: views/detail/cardKeys.ts handleSentenceKey, hooks/useKeyboardNavigation.ts,
 *   views/detail/useSentenceGestures.ts and SentenceReviewView.tsx (Escape), views/SentencesView.tsx (the list).
 * - Today: views/today/todayKeys.ts, views/today/TodayView.tsx (Escape).
 * - Card review: services/studyKeys.ts, components/study/StudyCard.tsx (the answer box), views/StudyEnhanced.tsx (Escape).
 * - Word card popup: components/review/popupShortcuts.ts.
 * - Search: components/GlobalSearch.tsx and components/search (the box and the results sheet).
 * - Trackpad: hooks/useKeyboardNavigation.ts useWheelNavigation and the sentence pages' wheel handler.
 * Only components/KeyboardHelpModal imports this module, so it loads with the sheet, never with the app's first chunk.
 */

/** One line of the sheet: what to press or do, and what it does. */
export interface ShortcutRow {
  /**
   * The keys as pressed. A modifier (MODIFIER_KEYS) joins the key after it, as in Shift R; other keys in one row are
   * alternatives, as in ← →. 'Mod' stands for ⌘ on a Mac and Ctrl elsewhere. Touch and trackpad rows name a gesture.
   */
  keys: readonly string[];
  label: string;
}

export type ShortcutSectionId = 'touch' | 'navigation' | 'card' | 'sentences' | 'today' | 'study' | 'popup' | 'search' | 'trackpad';

export interface ShortcutSection {
  id: ShortcutSectionId;
  title: string;
  rows: readonly ShortcutRow[];
}

/** The keys that join the key after them into one chord. */
const MODIFIER_KEYS: ReadonlySet<string> = new Set(['Mod', '⌘', 'Ctrl', 'Shift']);

/** A row's keys as the chords to press, any one of them: ['S', '⌘', 'S'] is S, or ⌘ with S. */
export function keyChords(keys: readonly string[]): string[][] {
  const chords: string[][] = [];
  let chord: string[] = [];
  for (const key of keys) {
    chord.push(key);
    if (!MODIFIER_KEYS.has(key)) {
      chords.push(chord);
      chord = [];
    }
  }
  if (chord.length > 0) chords.push(chord);
  return chords;
}

/** The tab names, as the tab bar shows them. */
const TAB_NAMES: Record<ViewState, string> = {
  notebook: 'Notebook', sentences: 'Sentences', 'real-life': 'Real Life', essays: 'Essays', study: 'Today',
};

/**
 * Which of `views` a reselect at the top sends to the search (services/navReselect), by name: 'Notebook or Sentences'.
 * The other tabs have no search box, so there a second tap or press at the top does nothing.
 */
function tabsWithSearch(views: Iterable<ViewState>): string {
  const names = [...views].filter(hasSearchBox).map(view => TAB_NAMES[view]);
  return names.length > 1 ? `${names.slice(0, -1).join(', ')} or ${names[names.length - 1]}` : names.join('');
}

const SECTIONS: readonly ShortcutSection[] = [
  {
    id: 'touch',
    title: 'Touch',
    rows: [
      { keys: ['Tap a word'], label: 'In a sentence: play from that word' },
      { keys: ['Two-finger tap a word'], label: 'In a sentence: look it up (a saved word opens its card)' },
      { keys: ['Tap'], label: 'In a sentence, on blank space: play or pause, or at 85% or more start it again; during auto-play, pause or resume it' },
      { keys: ['Double-tap'], label: 'On blank space or a sentence’s words: Got it' },
      { keys: ['Swipe left'], label: 'In a sentence: its analysis; on a card: the next meaning' },
      { keys: ['Swipe right'], label: 'Back: to the sentence, to the previous meaning, or out of the view' },
      { keys: ['Swipe up'], label: 'From the bottom of a card or sentence: the next one' },
      { keys: ['Swipe down'], label: 'From the top: the previous one; a short pull at a card’s top shows its header' },
      { keys: ['Tap the top of a card'], label: 'The top quarter reads example 1; the next quarter, example 2' },
      { keys: ['Long-press auto-play'], label: 'In a sentence: open the auto-play panel (a tap resumes a paused auto-play)' },
      {
        keys: ['Tap the current tab'],
        label: `Jump to its top; on ${tabsWithSearch(Object.keys(TAB_NAMES) as ViewState[])}, tap again at the top to search`,
      },
    ],
  },
  {
    id: 'navigation',
    title: 'Navigation',
    rows: [
      {
        keys: [...TAB_KEYS.keys()],
        label: `${[...TAB_KEYS.values()].map(view => TAB_NAMES[view]).join(', ')}; pressed again on its own tab: to the top, `
          + `then, on ${tabsWithSearch(TAB_KEYS.values())}, to the search`,
      },
      { keys: ['Mod', 'F'], label: 'Look up a word' },
      { keys: ['?'], label: 'Show this sheet' },
      { keys: ['Esc'], label: 'Close what’s on top, or go back; in the Notebook, clear the search' },
      { keys: ['Esc'], label: 'In an essay or a Real Life collection: back to its list (the first Esc clears the Real Life search)' },
      { keys: ['Mod', 'Z'], label: 'Undo (while the Undo pill shows)' },
    ],
  },
  {
    id: 'card',
    title: 'Card view',
    rows: [
      { keys: ['←', '→'], label: 'Previous or next meaning' },
      { keys: ['↑', '↓'], label: 'Previous or next word' },
      { keys: ['R'], label: 'Got it' },
      { keys: ['Shift', 'R'], label: 'Reset memory strength' },
      { keys: ['S', 'Mod', 'S'], label: 'Save the card' },
      { keys: ['D'], label: 'Delete the card' },
      { keys: ['A'], label: 'Archive or unarchive' },
      { keys: ['P'], label: 'Pronounce the word' },
      { keys: ['E'], label: 'Read the examples; press again to pause or resume, or at 85% or more to start them again; during auto-play, pause or resume it' },
      { keys: ['Mod', '1–4'], label: 'Read example 1–4' },
      { keys: ['Space'], label: 'Pause or resume a playing sentence, else start or stop the slideshow; during example auto-play, stop it' },
      { keys: ['+', '='], label: 'Slideshow: change the time per slide' },
      { keys: ['H'], label: 'Show or hide the header' },
      { keys: ['Double-click'], label: 'On blank space: Got it' },
      { keys: ['Esc'], label: 'Close the card' },
    ],
  },
  {
    id: 'sentences',
    title: 'Sentences',
    rows: [
      { keys: ['Click'], label: 'On a word: play from it' },
      { keys: ['Mod', 'Click'], label: 'Look up the word, or the selected phrase when you click inside a selection' },
      { keys: ['Click'], label: 'On blank space: play or pause, or at 85% or more start it again; during auto-play, pause or resume it' },
      { keys: ['Double-click'], label: 'On blank space: Got it' },
      { keys: ['↑', '↓'], label: 'Previous or next sentence, read aloud' },
      { keys: ['←', '→'], label: 'Sentence / analysis page' },
      { keys: ['Enter'], label: 'Play from the selected word' },
      { keys: ['E'], label: 'Read the sentence; press again to pause or resume, or at 85% or more to start it again; during auto-play, pause or resume it' },
      { keys: ['Space'], label: 'Pause or resume; with nothing playing, start auto-play; during auto-play, pause or resume it' },
      { keys: ['P'], label: 'Pronounce its word' },
      { keys: ['Mod', '1–4'], label: 'Read example 1–4 of its word' },
      { keys: ['R'], label: 'Got it (the sentence stays on screen)' },
      { keys: ['Shift', 'R'], label: 'Reset memory strength' },
      { keys: ['L'], label: 'Star a saved sentence to learn later, or take its star away' },
      { keys: ['D'], label: 'Delete a saved sentence (Real Life and essay lines stay)' },
      { keys: ['Esc'], label: 'Close a panel or the analysis page, then the sentence' },
      { keys: ['Space', 'Enter'], label: 'In the list: open the focused sentence' },
    ],
  },
  {
    id: 'today',
    title: 'Today',
    rows: [
      { keys: ['Enter'], label: 'On the plan: Start unit, or Continue' },
      { keys: ['Esc'], label: 'In All themes: back to the plan' },
    ],
  },
  {
    id: 'study',
    title: 'Card review',
    rows: [
      { keys: ['Enter'], label: 'Start, or Done on the summary' },
      { keys: ['Space', 'Enter'], label: 'Show the answer' },
      { keys: ['1–4'], label: 'Grade: Again, Hard, Good, Easy' },
      { keys: ['U'], label: 'Undo the last rating' },
      { keys: ['P'], label: 'Say the word (once the answer shows)' },
      { keys: ['E'], label: 'Replay a listening prompt; once the answer shows, play or pause the example' },
      { keys: ['Space'], label: 'In an empty answer box: show the answer' },
      { keys: ['Mod', 'Z'], label: 'In an empty answer box: undo the last rating' },
      { keys: ['Esc'], label: 'Leave the answer box; then end the session early, or close the summary' },
      { keys: ['R'], label: 'Resume an ended session' },
    ],
  },
  {
    id: 'popup',
    title: 'Word card popup',
    rows: [
      { keys: ['←', '→'], label: 'Previous or next meaning' },
      { keys: ['Space'], label: 'Play or pause (the first example when nothing is playing)' },
      { keys: ['P'], label: 'Pronounce the word' },
      { keys: ['E'], label: 'Read the first two examples; press again to pause or resume, or at 85% or more to start them again' },
      { keys: ['Mod', '1–4'], label: 'Read example 1–4' },
      { keys: ['R'], label: 'Got it; on an unsaved meaning, save it' },
      { keys: ['Shift', 'R'], label: 'Reset memory strength' },
      { keys: ['D'], label: 'Delete (press again to confirm)' },
      { keys: ['Enter'], label: 'Save an unsaved meaning' },
      { keys: ['Esc'], label: 'Close the card' },
    ],
  },
  {
    id: 'search',
    title: 'Search',
    rows: [
      { keys: ['Mod', 'F'], label: 'Look up' },
      { keys: ['Enter'], label: 'In the box: look up what you typed' },
      { keys: ['Enter'], label: 'On an empty box: open the results' },
      { keys: ['←', '→'], label: 'Meanings' },
      { keys: ['↑', '↓'], label: 'Results' },
      { keys: ['S'], label: 'Save' },
      { keys: ['Shift', 'S'], label: 'Save every meaning' },
      { keys: ['P'], label: 'Pronounce' },
      { keys: ['E'], label: 'Examples; press again to pause or resume, or at 85% or more to start them again' },
      { keys: ['Space'], label: 'Play or pause' },
      { keys: ['Mod', '1–4'], label: 'Read example 1–4' },
      { keys: ['Esc'], label: 'Close' },
    ],
  },
  {
    id: 'trackpad',
    title: 'Trackpad',
    rows: [
      { keys: ['Two-finger swipe ←/→'], label: 'On a card: its meanings' },
      { keys: ['Two-finger swipe ←/→'], label: 'In a sentence: the sentence or its analysis page' },
    ],
  },
];

/**
 * The sheet's sections in order, with 'Mod' named for the keyboard (⌘ on a Mac, Ctrl elsewhere). The Touch section
 * comes first on a touch screen, `touchFirst`, and is left out otherwise.
 */
export function sheetSections({ touchFirst, isMac }: { touchFirst: boolean; isMac: boolean }): ShortcutSection[] {
  const mod = isMac ? '⌘' : 'Ctrl';
  return SECTIONS
    .filter(section => touchFirst || section.id !== 'touch')
    .map(section => ({
      ...section,
      rows: section.rows.map(row => ({ ...row, keys: row.keys.map(key => (key === 'Mod' ? mod : key)) })),
    }));
}
