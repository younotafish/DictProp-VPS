// Variant-aware word matching for "already-saved" search.
//
// Goal: when the user searches an inflected variant of a word they already have
// (running ↔ run, cats ↔ cat, happier ↔ happy), recognise it as the same entry
// so the app pops up the saved card instead of re-running the AI.
//
// Design principle: GENEROUS on the query side, CONSERVATIVE on the saved side.
// Every VocabCard carries an AI-populated `forms` array (incl. irregulars like
// ran / children / went), so that is the primary, accurate signal. The rule-based
// lemmatiser below is only a fallback for cards whose `forms` is empty/missing,
// and it deliberately avoids the most collision-prone rules (no bare -er/-est).
//
// A generated candidate only causes a wrong pop-up if it collides with a *different*
// real saved base word; over-generation that hits nothing simply falls through to AI.

import { StoredItem, VocabCard } from '../types';

// Words that LOOK inflected (end in -s/-es/-ed/-ing/-ier) but are actually base
// forms. Returned as-is, never reduced. Cheap, high-value guard.
const INVARIANT_STOPLIST = new Set<string>([
  // -s / -es that are not plurals
  'news', 'physics', 'mathematics', 'maths', 'economics', 'politics', 'ethics',
  'statistics', 'species', 'series', 'means', 'lens', 'gas', 'atlas', 'bias',
  'canvas', 'virus', 'status', 'focus', 'campus', 'census', 'octopus', 'corpus',
  'genus', 'crisis', 'basis', 'analysis', 'thesis', 'bonus', 'minus', 'versus',
  'plus', 'chaos', 'iris', 'tennis', 'bus',
  // -ed adjectives that are not past tenses
  'sacred', 'naked', 'wicked', 'hundred', 'kindred', 'rugged', 'wretched',
  'beloved', 'rigid', 'embed',
]);

const VOWELS = new Set(['a', 'e', 'i', 'o', 'u']);
const isConsonant = (ch: string): boolean => /^[a-z]$/.test(ch) && !VOWELS.has(ch);

/**
 * Normalise a raw string to a comparison key: NFC, lowercase, trimmed, internal
 * whitespace collapsed, possessive 's removed, surrounding punctuation/quotes stripped.
 * Leaves CJK and internal apostrophes intact (so Chinese queries fall through to AI).
 */
export function normalizeKey(s: string): string {
  if (!s) return '';
  let t = s.normalize('NFC').toLowerCase().trim().replace(/\s+/g, ' ');
  t = t.replace(/['’]s\b/g, ''); // teacher's -> teacher
  t = t.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, ''); // strip edge quotes/punctuation (incl. dogs')
  return t;
}

/**
 * Flatten + split a (possibly messy) AI `forms` array into normalised keys.
 * Splits each entry on , / → -> ; | so "runs, running / ran" yields three keys.
 */
export function splitForms(forms?: string[]): string[] {
  if (!Array.isArray(forms)) return [];
  const out = new Set<string>();
  for (const entry of forms) {
    if (typeof entry !== 'string') continue;
    for (const part of entry.split(/\s*(?:,|\/|→|->|;|\|)\s*/)) {
      const k = normalizeKey(part);
      if (k) out.add(k);
    }
  }
  return [...out];
}

// running -> runn -> run ; stopped -> stopp -> stop (only for doubled consonants)
function undouble(stem: string): string | null {
  const n = stem.length;
  if (n >= 3 && stem[n - 1] === stem[n - 2] && isConsonant(stem[n - 1])) {
    return stem.slice(0, -1);
  }
  return null;
}

/**
 * Conservative English inflection → base-form candidate set for ONE normalised token.
 * Always includes the token itself. Never emits a candidate shorter than 3 chars.
 * Skips tokens shorter than 4 chars and anything in the invariant stoplist.
 */
export function tokenCandidates(token: string): string[] {
  const w = token;
  const cands = new Set<string>([w]);
  if (w.length < 4 || INVARIANT_STOPLIST.has(w)) return [...cands];

  const add = (c: string | null | undefined) => {
    if (c && c.length >= 3) cands.add(c);
  };

  // -ies / -ied -> -y   (parties->party, studied->study)
  if (w.endsWith('ies') && w.length > 4) add(w.slice(0, -3) + 'y');
  if (w.endsWith('ied') && w.length > 4) add(w.slice(0, -3) + 'y');

  // -ves -> -f / -fe   (leaves->leaf, knives->knife) — best-effort
  if (w.endsWith('ves') && w.length > 4) {
    add(w.slice(0, -3) + 'f');
    add(w.slice(0, -3) + 'fe');
  }

  // -ier / -iest -> -y   (happier->happy, happiest->happy). NOTE: bare -er/-est
  // is intentionally NOT stripped (corner->corn, number->numb are too dangerous).
  if (w.endsWith('iest') && w.length >= 6) add(w.slice(0, -4) + 'y');
  else if (w.endsWith('ier') && w.length >= 5) add(w.slice(0, -3) + 'y');

  // -ing   (jumping->jump, making->make, running->run)
  if (w.endsWith('ing') && w.length >= 6) {
    const stem = w.slice(0, -3);
    add(stem);
    add(stem + 'e');
    add(undouble(stem));
  }

  // -ed    (jumped->jump, used->use, stopped->stop)
  if (w.endsWith('ed')) {
    const stem = w.slice(0, -2);
    add(stem);
    add(stem + 'e');
    add(undouble(stem));
  }

  // -s / -es plural & 3rd-person   (cats->cat, boxes->box, makes->make, goes->go)
  // Guards: never strip after ss / us / is (miss, bus, basis).
  if (w.endsWith('s') && !w.endsWith('ss') && !w.endsWith('us') && !w.endsWith('is')) {
    if (w.endsWith('es')) {
      add(w.slice(0, -2)); // boxes->box, goes->go
      add(w.slice(0, -1)); // makes->make, uses->use
    } else {
      add(w.slice(0, -1)); // cats->cat, runs->run
    }
  }

  return [...cands];
}

/**
 * Candidate keys for a (possibly multi-word) string. Always includes the plain
 * normalised string. For phrases it is the cross-product of per-token candidates,
 * capped (≤4 tokens, ≤3 candidates/token) to avoid combinatorial blow-up.
 */
export function variantKeys(s: string): string[] {
  const norm = normalizeKey(s);
  if (!norm) return [];
  const tokens = norm.split(' ');
  const keys = new Set<string>([norm]);

  if (tokens.length === 1) {
    for (const c of tokenCandidates(tokens[0])) keys.add(c);
    return [...keys];
  }

  if (tokens.length > 4) return [norm];

  let combos: string[][] = [[]];
  for (const tok of tokens) {
    const cands = tokenCandidates(tok).slice(0, 3);
    const next: string[][] = [];
    for (const combo of combos) {
      for (const c of cands) next.push([...combo, c]);
    }
    combos = next;
    if (combos.length > 64) return [norm]; // safety valve
  }
  for (const combo of combos) keys.add(combo.join(' '));
  return [...keys];
}

/**
 * Inverted index: variant key → set of normalised base words owning that key.
 * Built once per item-set change. The saved `word` is lemmatised (the empty-forms
 * fallback); `forms` are added as exact keys only (the conservative saved side).
 */
export function buildVariantIndex(items: StoredItem[]): Map<string, Set<string>> {
  const index = new Map<string, Set<string>>();
  const addKey = (key: string, base: string) => {
    if (!key || !base) return;
    let set = index.get(key);
    if (!set) {
      set = new Set();
      index.set(key, set);
    }
    set.add(base);
  };

  for (const item of items) {
    if (!item || item.type !== 'vocab' || item.isDeleted) continue;
    const card = item.data as VocabCard;
    const base = normalizeKey(card.word || '');
    if (!base) continue;
    for (const k of variantKeys(base)) addKey(k, base);
    for (const f of splitForms(card.forms)) addKey(f, base);
  }
  return index;
}

/**
 * Query-time match: returns the set of saved base words a query maps to (empty = none).
 * Generous on the query side via variantKeys(query).
 */
export function matchBaseWords(query: string, index: Map<string, Set<string>>): Set<string> {
  const result = new Set<string>();
  for (const key of variantKeys(query)) {
    const bases = index.get(key);
    if (bases) for (const b of bases) result.add(b);
  }
  return result;
}

/**
 * Phase 2 detection: cluster base words that are variants of one another.
 * Returns groups of ≥2 normalised base words (e.g. ["run", "running"]).
 * Reuses buildVariantIndex so detection and search matching stay consistent.
 */
export function findDuplicateClusters(items: StoredItem[]): string[][] {
  const index = buildVariantIndex(items);

  // Union-find over base words that co-occur under any shared variant key.
  const parent = new Map<string, string>();
  const ensure = (x: string) => {
    if (!parent.has(x)) parent.set(x, x);
  };
  const find = (x: string): string => {
    let r = x;
    while (parent.get(r) !== r) r = parent.get(r)!;
    let c = x;
    while (parent.get(c) !== r) {
      const n = parent.get(c)!;
      parent.set(c, r);
      c = n;
    }
    return r;
  };
  const union = (a: string, b: string) => {
    ensure(a);
    ensure(b);
    parent.set(find(a), find(b));
  };

  for (const bases of index.values()) {
    if (bases.size < 2) continue;
    const arr = [...bases];
    for (let i = 1; i < arr.length; i++) union(arr[0], arr[i]);
  }

  const groups = new Map<string, Set<string>>();
  for (const x of parent.keys()) {
    const r = find(x);
    let g = groups.get(r);
    if (!g) {
      g = new Set();
      groups.set(r, g);
    }
    g.add(x);
  }

  const clusters: string[][] = [];
  for (const g of groups.values()) {
    if (g.size >= 2) clusters.push([...g].sort((a, b) => a.length - b.length || a.localeCompare(b)));
  }
  // Stable, friendly ordering: smallest clusters and shortest canonical first.
  clusters.sort((a, b) => a[0].localeCompare(b[0]));
  return clusters;
}
