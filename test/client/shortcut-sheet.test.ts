import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { KeyboardHelpModal } from '../../components/KeyboardHelpModal.tsx';
import { resolvePopupShortcut, type PopupKeyState } from '../../components/review/popupShortcuts.ts';
import { searchSheetKeys, type SheetKeyState } from '../../components/search/searchSheetKeys.ts';
import { TAB_KEYS } from '../../hooks/useAppShortcuts.ts';
import { keyChords, sheetSections, type ShortcutRow, type ShortcutSection } from '../../services/shortcutSheet.ts';
import { resolveDashboardKey, resolveStudyKey, type DashboardKeyState, type StudyKeyState } from '../../services/studyKeys.ts';
import type { StoredItem } from '../../types.ts';
import { handleSentenceKey, handleWordKey, type SentenceKeyHandlers, type WordKeyHandlers } from '../../views/detail/cardKeys.ts';

// services/shortcutSheet.ts, the gestures and shortcuts sheet as data, and components/KeyboardHelpModal.tsx, which
// renders it.

const LAPTOP_ORDER = ['Navigation', 'Card view', 'Sentences', 'Study session', 'Word card popup', 'Search', 'Trackpad'];
const mac = sheetSections({ touchFirst: false, isMac: true });
const phone = sheetSections({ touchFirst: true, isMac: false });
const section = (sections: ShortcutSection[], id: ShortcutSection['id']) => sections.find(item => item.id === id)!;
const rows = (sections: ShortcutSection[]) => sections.flatMap(item => item.rows);
/** Whether `sections` has the row with exactly these keys and this label. */
const hasRow = (rowsOf: readonly ShortcutRow[], keys: string[], label: string) =>
  rowsOf.some(row => row.label === label && row.keys.length === keys.length && row.keys.every((key, i) => key === keys[i]));

test('on a laptop the sheet has no touch section, and lists the rest in order', () => {
  assert.deepEqual(mac.map(item => item.title), LAPTOP_ORDER);
});

test('on a touch screen the gestures come first: a tap on a word reads from it, a two-finger tap looks it up', () => {
  assert.deepEqual(phone.map(item => item.title), ['Touch', ...LAPTOP_ORDER]);
  const touch = phone[0].rows;
  assert.ok(hasRow(touch, ['Tap a word'], 'In a sentence: play from that word'));
  assert.ok(hasRow(touch, ['Two-finger tap a word'], 'In a sentence: look it up (a saved word opens its card)'));
  // Only the tabs with a search box (services/navReselect) search on a second tap at the top.
  assert.ok(hasRow(touch, ['Tap the current tab'], 'Jump to its top; on Notebook or Sentences, tap again at the top to search'));
  // Long vertical swipes change the card or sentence only from the matching edge (UX-18); a card that fits is at both.
  assert.ok(hasRow(touch, ['Swipe up'], 'From the bottom of a card or sentence: the next one'));
  assert.ok(hasRow(touch, ['Swipe down'], 'From the top: the previous one; a short pull at a card’s top shows its header'));
});

test('Mod is ⌘ on a Mac and Ctrl elsewhere', () => {
  const keysOf = (sections: ShortcutSection[]) => rows(sections).flatMap(row => row.keys);
  assert.ok(keysOf(mac).includes('⌘'));
  assert.ok(!keysOf(mac).includes('Ctrl'));
  assert.ok(keysOf(phone).includes('Ctrl'));
  assert.ok(!keysOf(phone).includes('⌘'));
  for (const sections of [mac, phone]) assert.ok(!keysOf(sections).includes('Mod'), 'every Mod is named');
});

test('the number keys are the tab keys, and pressed again they go up, then, on the tabs with a search box, to the search', () => {
  assert.ok(hasRow(section(mac, 'navigation').rows, [...TAB_KEYS.keys()],
    'Notebook, Sentences, Study; pressed again on its own tab: to the top, then, on Notebook or Sentences, to the search'));
  assert.deepEqual([...TAB_KEYS.keys()], ['1', '2', '3']);
});

test('the sheet drops what the app no longer does', () => {
  for (const row of rows(phone)) {
    const text = `${row.keys.join(' ')} ${row.label}`;
    assert.doesNotMatch(text, /toggle save|vertical|footnote|ⁿ|back to sentences/i, text);
  }
  // ⌘-click looks up and a plain click plays (f40102e); no row says ⌘-click plays. Inside a selection ⌘-click looks
  // up the selected phrase (UX-36, on a laptop).
  const sentences = section(mac, 'sentences').rows;
  assert.ok(hasRow(sentences, ['Click'], 'On a word: play from it'));
  assert.ok(hasRow(sentences, ['⌘', 'Click'], 'Look up the word, or the selected phrase when you click inside a selection'));
  assert.ok(!sentences.some(row => row.keys.includes('⌘') && /play/i.test(row.label)));
  // A double-click on a word selects it, as on any page, so only one on blank space is Got it; on a touch screen a
  // double tap on the words is Got it too.
  assert.ok(hasRow(sentences, ['Double-click'], 'On blank space: Got it'));
  assert.ok(hasRow(section(phone, 'touch').rows, ['Double-tap'], 'On blank space or a sentence’s words: Got it'));
  // S only saves, as ⌘S does (UX-04).
  assert.ok(hasRow(section(mac, 'card').rows, ['S', '⌘', 'S'], 'Save the card'));
  // + and = change the slideshow's time per slide, not the voice's speed (useAutoPlay's cycleSpeed).
  assert.ok(hasRow(section(mac, 'card').rows, ['+', '='], 'Slideshow: change the time per slide'));
});

test('each change that shipped with this release has its row', () => {
  const at = (id: ShortcutSection['id']) => section(mac, id).rows;
  // The undo pill (UX-04), Escape in a reading (UX-29).
  assert.ok(hasRow(at('navigation'), ['⌘', 'Z'], 'Undo (while the Undo pill shows)'));
  assert.ok(hasRow(at('navigation'), ['Esc'], 'In an essay or a Real Life collection: back to its list (the first Esc clears the Real Life search)'));
  // The sentence's two pages, and the list's rows (secondary-views-09).
  assert.ok(hasRow(at('sentences'), ['←', '→'], 'Sentence / analysis page'));
  assert.ok(hasRow(at('sentences'), ['Space', 'Enter'], 'In the list: open the focused sentence'));
  // The study session: the answer box (UX-19), the summary (UX-20), the spoken word and example (UX-30), and the keys
  // of services/studyKeys.
  for (const [keys, label] of [
    [['Space', 'Enter'], 'Show the answer'],
    [['1–4'], 'Grade: Again, Hard, Good, Easy'],
    [['U'], 'Undo the last rating'],
    [['P'], 'Say the word (once the answer shows)'],
    [['E'], 'Replay a listening prompt; once the answer shows, play or pause the example'],
    [['Space'], 'In an empty answer box: show the answer'],
    [['⌘', 'Z'], 'In an empty answer box: undo the last rating'],
    [['Enter'], 'Start, or Done on the summary'],
    [['Esc'], 'Leave the answer box; then end the session early, or close the summary'],
    [['R'], 'Resume an ended session'],
  ] as const) assert.ok(hasRow(at('study'), [...keys], label), label);
  // The search sheet's keys (UX-27), and Enter's deliberate lookup in the box (d9d042a). Shift S saves every meaning of
  // the open result, as the header's 'Save all N' does, not every result, as the strip's 'Save all' does.
  for (const [keys, label] of [
    [['⌘', 'F'], 'Look up'], [['Enter'], 'In the box: look up what you typed'], [['Enter'], 'On an empty box: open the results'],
    [['←', '→'], 'Meanings'], [['↑', '↓'], 'Results'], [['S'], 'Save'], [['Shift', 'S'], 'Save every meaning'], [['P'], 'Pronounce'],
    [['E'], 'Examples'], [['Space'], 'Play or pause'], [['⌘', '1–4'], 'Read example 1–4'], [['Esc'], 'Close'],
  ] as const) assert.ok(hasRow(at('search'), [...keys], label), label);
  // Paging a sentence with the trackpad (UX-06).
  assert.ok(hasRow(at('trackpad'), ['Two-finger swipe ←/→'], 'In a sentence: the sentence or its analysis page'));
});

test('during auto-play the blank-space tap or click, E and Space pause or resume it, and a long press opens its panel', () => {
  const during = 'during auto-play, pause or resume it';
  assert.ok(hasRow(section(phone, 'touch').rows, ['Tap'], `In a sentence, on blank space: play or pause, or at 85% or more start it again; ${during}`));
  assert.ok(hasRow(section(mac, 'sentences').rows, ['Click'], `On blank space: play or pause, or at 85% or more start it again; ${during}`));
  assert.ok(hasRow(section(mac, 'sentences').rows, ['E'], `Read the sentence; press again to pause or resume, or at 85% or more to start it again; ${during}`));
  assert.ok(hasRow(section(mac, 'sentences').rows, ['Space'], `Pause or resume; with nothing playing, start auto-play; ${during}`));
  assert.ok(hasRow(section(mac, 'card').rows, ['E'], `Read the examples; press again to pause or resume, or at 85% or more to start them again; ${during}`));
  // Every play control follows the speaker's rule (UX-22): Space on a word card plays or pauses before the slideshow.
  assert.ok(hasRow(section(mac, 'card').rows, ['Space'],
    'Pause or resume a playing sentence, else start or stop the slideshow; during example auto-play, stop it'));
  assert.ok(hasRow(section(phone, 'touch').rows, ['Long-press auto-play'],
    'In a sentence: open the auto-play panel (a tap resumes a paused auto-play)'));
});

test('every row says what to press and what it does, and gestures stay in their own sections', () => {
  for (const item of phone) {
    for (const row of item.rows) {
      assert.ok(row.label.trim().length > 0, `${item.title}: a label`);
      assert.ok(row.keys.length > 0 && row.keys.every(key => key.trim().length > 0), `${item.title}: ${row.label}`);
      const gesture = row.keys.some(key => /\b(tap|swipe)\b/i.test(key));
      if (gesture) assert.ok(item.id === 'touch' || item.id === 'trackpad', `${item.title}: ${row.label}`);
    }
  }
});

test('a row\'s keys are chords to choose from, a modifier joined to the key after it', () => {
  assert.deepEqual(keyChords(['Shift', 'R']), [['Shift', 'R']]);
  assert.deepEqual(keyChords(['←', '→']), [['←'], ['→']]);
  assert.deepEqual(keyChords(['S', '⌘', 'S']), [['S'], ['⌘', 'S']]);
  assert.deepEqual(keyChords(['Ctrl', '1–4']), [['Ctrl', '1–4']]);
  assert.deepEqual(keyChords(['1', '2', '3']), [['1'], ['2'], ['3']]);
});

test('the sheet is titled Gestures & shortcuts, renders every section, and still scrolls inside 80% of the screen', () => {
  const laptop = renderToStaticMarkup(createElement(KeyboardHelpModal, { onClose: () => {}, touchFirst: false, isMac: true }));
  assert.match(laptop, /<h3 class="text-xl font-bold text-slate-800">Gestures &amp; shortcuts<\/h3>/);
  assert.match(laptop, /role="dialog" aria-modal="true" aria-label="Gestures &amp; shortcuts" class="[^"]*max-h-\[80vh\] overflow-y-auto/);
  const titles = [...laptop.matchAll(/<h4 class="[^"]*">([^<]*)<\/h4>/g)].map(match => match[1]);
  assert.deepEqual(titles, LAPTOP_ORDER);
  // A chord is joined by +, alternatives by /.
  assert.match(laptop, />Shift<\/kbd><span class="text-slate-300 text-xs">\+<\/span><kbd [^>]*>R<\/kbd>/);
  assert.match(laptop, />←<\/kbd><span class="text-slate-300 text-xs">\/<\/span><kbd [^>]*>→<\/kbd>/);

  const touch = renderToStaticMarkup(createElement(KeyboardHelpModal, { onClose: () => {}, touchFirst: true, isMac: false }));
  assert.deepEqual([...touch.matchAll(/<h4 class="[^"]*">([^<]*)<\/h4>/g)].map(match => match[1]), ['Touch', ...LAPTOP_ORDER]);
  // Gestures are written out, not drawn as keys.
  assert.match(touch, /<span class="[^"]*text-right[^"]*">Two-finger tap a word<\/span>/);
  assert.doesNotMatch(touch, /<kbd[^>]*>Two-finger/);
  assert.match(touch, /<kbd [^>]*>Ctrl<\/kbd>/);
});

// The key tables against the sheet, one way: every key a table acts on has a row in its section, so a key added to a
// table without its row fails here. A row may name a key no table holds: the arrows, Esc and the study answer box's
// keys have handlers of their own.

/** A key press to try: its key, with or without Shift, and with ⌘ or Ctrl (both the sheet's Mod) or neither. */
interface Probe { key: string; shift: boolean; mod: 'metaKey' | 'ctrlKey' | null }

const LETTERS = [...'abcdefghijklmnopqrstuvwxyz'];
const KEYS = [
  ...LETTERS, ...'0123456789', ' ', 'Enter', 'Escape', 'Tab', 'Backspace', 'Delete',
  'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown', '+', '=', '-', '?', '/', ',', '.',
];
// Shift types a letter in capitals, and so does Caps Lock without it.
const PROBES: Probe[] = KEYS.flatMap(key => [false, true].flatMap(shift => (['metaKey', 'ctrlKey', null] as const).flatMap(mod => {
  const letter = LETTERS.includes(key);
  return [{ key: letter && shift ? key.toUpperCase() : key, shift, mod }, ...(letter && !shift ? [{ key: key.toUpperCase(), shift, mod }] : [])];
})));

/** The sheet's name for a key. */
const KEY_NAMES: Record<string, string> = { ' ': 'Space', Escape: 'Esc', ArrowLeft: '←', ArrowRight: '→', ArrowUp: '↑', ArrowDown: '↓' };
const keyName = (key: string) => KEY_NAMES[key] ?? (key.length === 1 ? key.toUpperCase() : key);

/** The probe as every table reads a key press, noting whether a card's shortcut kept it from the browser. */
const pressOf = ({ key, shift, mod }: Probe) => {
  const event = {
    key, repeat: false, shiftKey: shift, metaKey: mod === 'metaKey', ctrlKey: mod === 'ctrlKey', altKey: false,
    defaultPrevented: false, prevented: false,
    preventDefault() { event.prevented = true; },
  };
  return event;
};

/** What a key does in one context, as text to compare, or null when the table leaves it alone or only swallows it. */
type Resolve = (probe: Probe) => string | null;

/**
 * A card view's keys in one context. Its handlers only record what they're asked to do: `facts` holds every value the
 * table reads, and any other name is taken for a handler, so the probe follows the table as its handlers change. A key
 * acts when it calls a handler or keeps the press from the browser; the title stays empty, so P speaks nothing.
 */
const cardView = <T,>(
  handle: (event: ReturnType<typeof pressOf>, handlers: T) => void,
  facts: Record<string, unknown>,
): Resolve => probe => {
  const done: string[] = [];
  const event = pressOf(probe);
  handle(event, new Proxy({ title: '', isSentenceAutoPlaying: false, ...facts }, {
    get: (target, name) => (typeof name === 'string' && !(name in target) ? () => { done.push(name); } : Reflect.get(target, name)),
  }) as unknown as T);
  return event.prevented || done.length > 0 ? done.join() : null;
};
const wordCard = (facts: Record<string, unknown>) => cardView<WordKeyHandlers>(handleWordKey, { savedItemMatch: undefined, ...facts });
const sentenceCard = (facts: Record<string, unknown>) =>
  cardView<SentenceKeyHandlers>(handleSentenceKey, { isSentencePreview: false, catalogSentencePreview: false, ...facts });

// The pure tables' states name the facts that gate their keys, as each table's own tests do. A fact a table gains
// later reads as undefined, so the probe still compiles and sees every key that fact doesn't gate.
const action = (result: { type: string } | null) => (result === null || result.type === 'swallow' ? null : JSON.stringify(result));
const studySession = (facts: Partial<StudyKeyState>): Resolve => probe => action(resolveStudyKey(pressOf(probe), {
  phase: 'card', revealed: false, canUndo: false, undoing: false, canResume: false, typing: false, onControl: false, dialogOutside: false,
  ...facts,
} as StudyKeyState));
const studyDashboard: Resolve = probe => action(resolveDashboardKey(pressOf(probe), {
  canStart: true, typing: false, onControl: false, dialogOutside: false,
} as DashboardKeyState));
const searchSheet = (facts: Partial<SheetKeyState>): Resolve => probe => action(searchSheetKeys(pressOf(probe), {
  typing: false, dialogAbove: false, onControl: false, resultCount: 3, resultIndex: 1, meaningCount: 4, meaningIndex: 0, hasCard: true,
  ...facts,
} as SheetKeyState));
const popup = (facts: Partial<PopupKeyState>): Resolve => probe => action(resolvePopupShortcut(pressOf(probe), {
  typing: false, onControl: false, pageCount: 3, saved: true, ...facts,
} as PopupKeyState));

const archivedCard = { type: 'vocab', savedAt: 0, isArchived: true, data: { id: 'fig-1', word: 'fig' } } as unknown as StoredItem;
/** Each key table, the section of the sheet that lists its keys, and the contexts it's probed in. */
const KEY_TABLES: { section: ShortcutSection['id']; contexts: Record<string, Resolve> }[] = [
  {
    section: 'card', // views/detail/cardKeys.ts handleWordKey
    contexts: {
      'a saved card': wordCard({ isSaved: true }),
      'an unsaved card': wordCard({ isSaved: false }),
      'an archived card': wordCard({ isSaved: true, savedItemMatch: archivedCard }),
    },
  },
  {
    section: 'sentences', // views/detail/cardKeys.ts handleSentenceKey
    contexts: {
      'a saved sentence': sentenceCard({}),
      'a sentence preview': sentenceCard({ isSentencePreview: true }),
      'a catalog line': sentenceCard({ catalogSentencePreview: true }),
      'a catalog line not yet reviewed': sentenceCard({ isSentencePreview: true, catalogSentencePreview: true }),
    },
  },
  {
    section: 'study', // services/studyKeys.ts
    contexts: {
      'a card before its answer shows': studySession({ canUndo: true }),
      'a card with its answer showing': studySession({ revealed: true, canUndo: true }),
      'the summary of a session ended early': studySession({ phase: 'summary', canUndo: true, canResume: true }),
      'the dashboard': studyDashboard,
    },
  },
  {
    section: 'search', // components/search/searchSheetKeys.ts
    contexts: { 'a result\'s meaning': searchSheet({}), 'a comparison': searchSheet({ hasCard: false }) },
  },
  {
    section: 'popup', // components/review/popupShortcuts.ts
    contexts: { 'a saved meaning': popup({ saved: true }), 'an unsaved meaning': popup({ saved: false }) },
  },
];

/** The chord a probe's action needs a row for: its key, with each modifier that changes what the key does. */
const chordOf = (resolve: Resolve, probe: Probe): string | null => {
  const done = resolve(probe);
  if (done === null) return null;
  const unshifted = { ...probe, shift: false, key: probe.shift && probe.key.length === 1 ? probe.key.toLowerCase() : probe.key };
  const modifiers = [
    ...(probe.mod && resolve({ ...probe, mod: null }) !== done ? ['Mod'] : []),
    ...(probe.shift && resolve(unshifted) !== done ? ['Shift'] : []),
  ];
  return [...modifiers, keyName(probe.key)].join('+');
};

/** The chords one section's rows list, with ⌘ as Mod and a range such as 1–4 as its keys. */
const sheetChords = (id: ShortcutSection['id']): Set<string> => new Set(
  section(sheetSections({ touchFirst: true, isMac: true }), id).rows.flatMap(row => keyChords(row.keys)).flatMap(chord => {
    const modifiers = chord.slice(0, -1).map(key => (key === '⌘' ? 'Mod' : key));
    const range = chord[chord.length - 1].match(/^(\d)–(\d)$/);
    const keys = range ? Array.from({ length: Number(range[2]) - Number(range[1]) + 1 }, (_, i) => String(Number(range[1]) + i)) : [chord[chord.length - 1]];
    return keys.map(key => [...modifiers, key].join('+'));
  }),
);

/** Every chord a table acts on in a context, with the context that showed it. */
const tableChords = (contexts: Record<string, Resolve>): Map<string, string> => {
  const found = new Map<string, string>();
  for (const [context, resolve] of Object.entries(contexts)) {
    for (const probe of PROBES) {
      const chord = chordOf(resolve, probe);
      if (chord !== null && !found.has(chord)) found.set(chord, context);
    }
  }
  return found;
};

test('every key a key table acts on has a row in that table\'s section of the sheet', () => {
  const missing = KEY_TABLES.flatMap(({ section: id, contexts }) => {
    const listed = sheetChords(id);
    return [...tableChords(contexts)].filter(([chord]) => !listed.has(chord)).map(([chord, context]) => `${id}: ${chord} (${context})`);
  });
  assert.deepEqual(missing, [], 'a key with no row in the sheet');
});

test('the cross-check sees the keys each table\'s own tests pin, and a modifier only where it changes the key', () => {
  const chords = (id: ShortcutSection['id']) => new Set(tableChords(KEY_TABLES.find(table => table.section === id)!.contexts).keys());
  const expected: Partial<Record<ShortcutSection['id'], string[]>> = {
    card: ['H', 'P', 'E', 'R', 'Shift+R', 'S', 'D', 'A', 'Space', '+', '=', 'Mod+1', 'Mod+4'],
    sentences: ['P', 'E', 'R', 'Shift+R', 'D', 'Space', 'Mod+1', 'Mod+4'],
    study: ['1', '4', 'U', 'Space', 'Enter', 'R'],
    search: ['←', '→', '↑', '↓', 'S', 'Shift+S', 'P', 'E', 'Space', 'Mod+1', 'Mod+4'],
    popup: ['←', '→', 'Space', 'P', 'E', 'R', 'Shift+R', 'D', 'Enter', 'Mod+1', 'Mod+4'],
  };
  for (const [id, keys] of Object.entries(expected) as [ShortcutSection['id'], string[]][]) {
    const found = chords(id);
    for (const key of keys) assert.ok(found.has(key), `${id}: ${key}`);
    for (const key of ['Mod+R', 'Mod+5', 'Esc', 'Tab']) assert.ok(!found.has(key), `${id}: no ${key}`);
  }
  // Shift and Caps Lock leave a card's A alone, and ⌘ leaves the search sheet's arrows alone.
  assert.ok(!chords('card').has('Shift+A'));
  assert.ok(!chords('search').has('Mod+←'));
});
