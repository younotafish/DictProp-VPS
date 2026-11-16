/**
 * Auto-play's settings: how long each slide of the word slideshow shows, the Duration, the gap between reads and the
 * times each sentence is read. Like the speech style and speed (services/ttsSettings.ts), they're kept on the device, in
 * one localStorage key, and shared by every card view, so a choice holds in the next card or lesson opened, and on a
 * word card under a sentence opened from it. Open tabs share them too: a change starts from what's stored and shows in
 * every other tab. Each control cycles through its presets; a stored value that isn't one of them reads as the default.
 */

export interface AutoPlaySettings {
  /** Milliseconds each slide shows. */
  slideMs: number;
  /** The Duration: minutes before auto-play stops itself, the time spent paused not counted. */
  minutes: number;
  /** Milliseconds of silence between reads. */
  gapMs: number;
  /** Times each sentence is read. */
  repeats: number;
}

/** What each control cycles through, in order. */
const PRESETS: { readonly [K in keyof AutoPlaySettings]: readonly number[] } = {
  slideMs: [1000, 1500, 2000, 3000, 5000],
  minutes: [5, 10, 15, 20, 25],
  gapMs: [2000, 3000, 5000, 10000],
  repeats: [1, 2, 3, 4, 5],
};
const DEFAULTS: AutoPlaySettings = { slideMs: 2000, minutes: 20, gapMs: 2000, repeats: 3 };
const SETTINGS_KEY = 'autoplay_settings';

/**
 * The stored settings, each the default unless it's one of its presets, or null with nothing readable stored: nothing
 * yet, storage blocked, or not an object. Read like ttsSettings: blocked storage throws.
 */
const readStored = (): AutoPlaySettings | null => {
  let stored: unknown = null;
  try { stored = JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? 'null'); } catch { /* blocked, or not JSON */ }
  if (typeof stored !== 'object' || stored === null) return null;
  const fields = stored as Partial<Record<keyof AutoPlaySettings, unknown>>;
  const valid = (key: keyof AutoPlaySettings): number => {
    const value = fields[key];
    return typeof value === 'number' && PRESETS[key].includes(value) ? value : DEFAULTS[key];
  };
  return { slideMs: valid('slideMs'), minutes: valid('minutes'), gapMs: valid('gapMs'), repeats: valid('repeats') };
};

let settings = readStored() ?? DEFAULTS;
const listeners = new Set<() => void>();
const notify = () => listeners.forEach(listener => listener());

// Another tab stored a change (or storage was cleared): this one takes up what's stored now, and tells every view.
if (typeof window !== 'undefined') {
  window.addEventListener('storage', event => {
    if (event.key !== SETTINGS_KEY && event.key !== null) return;
    settings = readStored() ?? DEFAULTS;
    notify();
  });
}

export const getAutoPlaySettings = (): AutoPlaySettings => settings;
/** Hears every change, made in this tab or stored by another. */
export const subscribeAutoPlaySettings = (listener: () => void): (() => void) => {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
};

/**
 * Move one setting to its next preset (after the last, the first), keep the four on the device and tell every view.
 * The other three are taken as stored, so this change keeps any that another tab stored and this one hasn't heard of
 * yet; with nothing readable stored, this tab's own stand.
 */
export const cycleAutoPlaySetting = (key: keyof AutoPlaySettings): void => {
  const presets = PRESETS[key];
  const next = presets[(presets.indexOf(settings[key]) + 1) % presets.length];
  settings = { ...(readStored() ?? settings), [key]: next };
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); } catch { /* blocked: it holds for the session */ }
  notify();
};
