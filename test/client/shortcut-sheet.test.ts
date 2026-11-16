import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { KeyboardHelpModal } from '../../components/KeyboardHelpModal.tsx';
import { TAB_KEYS } from '../../hooks/useAppShortcuts.ts';
import { keyChords, sheetSections, type ShortcutRow, type ShortcutSection } from '../../services/shortcutSheet.ts';

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
  assert.ok(hasRow(touch, ['Tap the current tab'], 'Jump to its top; tap again at the top to search'));
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

test('the number keys are the tab keys, and pressed again they go up, then to the search', () => {
  assert.ok(hasRow(section(mac, 'navigation').rows, [...TAB_KEYS.keys()],
    'Notebook, Sentences, Study; pressed again on its own tab: to the top, then to the search'));
  assert.deepEqual([...TAB_KEYS.keys()], ['1', '2', '3']);
});

test('the sheet drops what the app no longer does', () => {
  for (const row of rows(phone)) {
    const text = `${row.keys.join(' ')} ${row.label}`;
    assert.doesNotMatch(text, /toggle save|vertical|footnote|ⁿ|back to sentences/i, text);
  }
  // ⌘-click looks up and a plain click plays (f40102e); no row says ⌘-click plays.
  const sentences = section(mac, 'sentences').rows;
  assert.ok(hasRow(sentences, ['Click'], 'On a word: play from it'));
  assert.ok(hasRow(sentences, ['⌘', 'Click'], 'On a word: look it up (a saved word opens its card)'));
  assert.ok(!sentences.some(row => row.keys.includes('⌘') && /play/i.test(row.label)));
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
  // The study session: the answer box (UX-19), the summary (UX-20), and the keys of services/studyKeys.
  for (const [keys, label] of [
    [['Space', 'Enter'], 'Show the answer'],
    [['1–4'], 'Grade: Again, Hard, Good, Easy'],
    [['U'], 'Undo the last rating'],
    [['Space'], 'In an empty answer box: show the answer'],
    [['⌘', 'Z'], 'In an empty answer box: undo the last rating'],
    [['Enter'], 'Start, or Done on the summary'],
    [['Esc'], 'Leave the answer box; then end the session early, or close the summary'],
    [['R'], 'Resume an ended session'],
  ] as const) assert.ok(hasRow(at('study'), [...keys], label), label);
  // The search sheet's keys (UX-27), and Enter's deliberate lookup in the box (d9d042a).
  for (const [keys, label] of [
    [['⌘', 'F'], 'Look up'], [['Enter'], 'In the box: look up what you typed'], [['Enter'], 'On an empty box: open the results'],
    [['←', '→'], 'Meanings'], [['↑', '↓'], 'Results'], [['S'], 'Save'], [['Shift', 'S'], 'Save all'], [['P'], 'Pronounce'],
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
