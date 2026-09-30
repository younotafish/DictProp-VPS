// Variant-aware word matching for "already-saved" search.
//
// Goal: when the user searches an inflected variant of a word they already have
// (running ↔ run, cats ↔ cat, happier ↔ happy), recognise it as the same entry
// so the app pops up the saved card instead of re-running the AI.
//
// Design principle: GENEROUS on the query side, CONSERVATIVE on the saved side.
// Every VocabCard carries an AI-populated `forms` array (incl. irregulars like
// ran / children / went), so that is the primary, accurate signal: a card that lists
// its forms is reached only by its word and those forms (cares never reaches car, nor
// hoped hop). The rule-based lemmatiser below is only a fallback for cards whose `forms`
// is empty/missing, and it deliberately avoids the most collision-prone rules (no bare -er/-est).
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

// Short function words a rule must never reduce a word to (herring is not her + -ing, noted not not + -ed).
const CLOSED_CLASS = new Set<string>([
  'her', 'hers', 'his', 'its', 'our', 'ours', 'she', 'him', 'you', 'who', 'the', 'and', 'but', 'nor',
  'not', 'yet', 'for', 'was', 'are', 'has', 'had',
]);

// Here 's is "is" or "us", not a possessive: let's must not match let, nor it's it.
const CONTRACTED_S = new Set<string>(['let', 'it', 'he', 'she', 'that', 'what', 'there', 'here', 'who', 'where', 'how']);

const VOWELS = new Set(['a', 'e', 'i', 'o', 'u']);
const isConsonant = (ch: string): boolean => /^[a-z]$/.test(ch) && !VOWELS.has(ch);

/**
 * Normalise a raw string to a comparison key: NFC, lowercase, trimmed, internal
 * whitespace collapsed, curly apostrophes straightened, possessive 's removed (contractions
 * like let's keep theirs), surrounding punctuation/quotes stripped.
 * Leaves CJK and internal apostrophes intact (so Chinese queries fall through to AI).
 */
export function normalizeKey(s: string): string {
  if (!s) return '';
  let t = s.normalize('NFC').toLowerCase().trim().replace(/\s+/g, ' ').replace(/[‘’]/g, "'");
  t = t.replace(/(\p{L}*)'s\b/gu, (m, w: string) => (CONTRACTED_S.has(w) ? m : w)); // teacher's -> teacher
  t = t.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, ''); // strip edge quotes/punctuation (incl. dogs')
  return t;
}

/**
 * Keys for a string with brackets in it. "break in(to)" and "catch up (with)" mark an optional particle, and
 * AI forms often carry a label, as in "abhors (verb)": each is keyed without the brackets and what's in them,
 * and, when they pair up, as written and with only the brackets dropped. So "break in" and "break into" both
 * reach "break in(to)", while a fragment like "present)" left by splitting "(3rd person, present)" keys nothing.
 */
function bracketKeys(raw: string): string[] {
  const keys: string[] = [];
  const add = (k: string) => {
    if (k && !keys.includes(k)) keys.push(k);
  };
  add(normalizeKey(raw.replace(/\([^()]*\)/g, ' ').replace(/\(.*$/, '').replace(/^.*\)/, '')));
  if (/^[^()]*(?:\([^()]*\)[^()]*)*$/.test(raw)) {
    add(normalizeKey(raw));
    add(normalizeKey(raw.replace(/[()]/g, '')));
  }
  return keys;
}

/**
 * Flatten + split a (possibly messy) AI `forms` array into normalised keys.
 * Splits each entry on , / → -> ; | so "runs, running / ran" yields three keys, and drops the labels the AI
 * sometimes adds, so "plural: compasses" and "abhors (verb)" key as compasses and abhors.
 */
export function splitForms(forms?: string[]): string[] {
  if (!Array.isArray(forms)) return [];
  const out = new Set<string>();
  for (const entry of forms) {
    if (typeof entry !== 'string') continue;
    for (const part of entry.split(/\s*(?:,|\/|→|->|;|\|)\s*/)) {
      const text = part.replace(/^[^:()]*:\s*/, ''); // "plural: compasses" -> "compasses"
      if (/[()]/.test(text)) {
        for (const k of bracketKeys(text)) out.add(k);
        continue;
      }
      const k = normalizeKey(text);
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
    if (c && c.length >= 3 && !CLOSED_CLASS.has(c)) cands.add(c);
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

  // -ed    (jumped->jump, used->use, stopped->stop, freed->free)
  if (w.endsWith('ed')) {
    const stem = w.slice(0, -2);
    add(stem);
    if (stem.length >= 3 || !stem.endsWith('e')) add(stem + 'e'); // but seed, need, weed aren't see, nee, wee
    add(undouble(stem));
  }

  // -s / -es plural & 3rd-person   (cats->cat, boxes->box, makes->make, heroes->hero)
  // Guards: never strip after ss / us / is (miss, bus, basis).
  if (w.endsWith('s') && !w.endsWith('ss') && !w.endsWith('us') && !w.endsWith('is')) {
    // -es is a suffix only after a sibilant or o (boxes, wishes, heroes); cares, notes, planes just add -s.
    if (/(?:[sxzo]|ch|sh)es$/.test(w)) add(w.slice(0, -2));
    add(w.slice(0, -1)); // cats->cat, makes->make, uses->use
  }

  return [...cands];
}

/**
 * Candidate keys for a (possibly multi-word) string. The plain normalised string always
 * comes first. For phrases it is the cross-product of per-token candidates, capped
 * (≤4 tokens, ≤64 combinations) to avoid combinatorial blow-up.
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
    const cands = tokenCandidates(tok);
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
 * Inverted index: variant key → the normalised base word owning that key, or the few base words
 * when several share it (about one key in a thousand), which spares a set per key on each rebuild.
 * A card is keyed by its word and its listed forms; a card without forms is also keyed by the
 * lemmatiser's variants of its word, under RULE + key.
 */
export type VariantIndex = Map<string, string | string[]>;

// Marks the keys only a lemmatised query looks up. No normalised key can start with it, since
// normalizeKey strips leading punctuation.
const RULE = '~';

/**
 * Built once per item-set change. The saved `word` and `forms` are exact keys (the conservative
 * saved side); the word is lemmatised only for cards without forms (the fallback).
 */
export function buildVariantIndex(items: StoredItem[]): VariantIndex {
  const index: VariantIndex = new Map();
  for (const item of items) {
    if (!item || item.type !== 'vocab' || item.isDeleted) continue;
    const { base, keys } = cardKeys(item.data as VocabCard);
    for (const key of keys) {
      const owners = index.get(key);
      if (owners === undefined) index.set(key, base);
      else if (typeof owners === 'string') {
        if (owners !== base) index.set(key, [owners, base]);
      } else if (!owners.includes(base)) owners.push(base);
    }
  }
  return index;
}

// Deriving the keys is most of the index's cost, so they're cached per card. Cards are replaced rather
// than mutated, so a rebuild after a save or a sync derives keys only for the cards that changed.
const cardKeyCache = new WeakMap<VocabCard, { base: string; keys: string[] }>();

function cardKeys(card: VocabCard): { base: string; keys: string[] } {
  let entry = cardKeyCache.get(card);
  if (!entry) {
    const base = normalizeKey(card.word || '');
    const keys = new Set<string>();
    if (base) {
      const words = [base, ...(/[()]/.test(card.word) ? bracketKeys(card.word) : [])];
      const forms = splitForms(card.forms);
      for (const k of words) keys.add(k);
      for (const k of forms) keys.add(k);
      if (forms.length === 0) for (const w of words) for (const k of variantKeys(w)) keys.add(RULE + k);
    }
    entry = { base, keys: [...keys] };
    cardKeyCache.set(card, entry);
  }
  return entry;
}

/** A card's base word, normalizeKey(card.word), from the same per-card cache as the index. */
export function cardBase(card: VocabCard): string {
  return cardKeys(card).base;
}

const ownerList = (owners: string | string[] | undefined): string[] =>
  owners === undefined ? [] : typeof owners === 'string' ? [owners] : owners;

/**
 * Query-time match: returns the set of saved base words a query maps to (empty = none).
 * Generous on the query side via variantKeys(query): the query as typed reaches any card by
 * its word or a listed form, while its lemmatised variants reach only cards without forms.
 */
export function matchBaseWords(query: string, index: VariantIndex): Set<string> {
  const result = new Set<string>();
  let asTyped = true;
  for (const key of variantKeys(query)) {
    if (asTyped) for (const b of ownerList(index.get(key))) result.add(b);
    for (const b of ownerList(index.get(RULE + key))) result.add(b);
    asTyped = false;
  }
  return result;
}

/**
 * Phase 2 detection: cluster base words that are variants of one another.
 * Returns groups of ≥2 normalised base words (e.g. ["run", "running"]).
 * Reuses buildVariantIndex so detection and search matching stay consistent: two words
 * cluster when typing some key would pop up both.
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

  for (const [key, owners] of index) {
    const isRule = key.startsWith(RULE);
    // Typing a plain key also reaches the cards that lemmatise to it, so a key and its RULE twin count together.
    if (isRule && index.has(key.slice(RULE.length))) continue;
    const group = isRule ? ownerList(owners) : [...ownerList(owners), ...ownerList(index.get(RULE + key))];
    for (let i = 1; i < group.length; i++) if (group[i] !== group[0]) union(group[0], group[i]);
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
