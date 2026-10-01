import type { StoredItem, VocabCard } from '../types';
import { normalizeKey } from './wordMatch';

// Merge variant-duplicate clusters (Phase 2 of the dedup tool). For each merge, every
// live vocab card whose word is a variant in the cluster is relabeled to the canonical
// headword and given the UNION of all members' forms (plus the original variant spellings,
// so future searches still resolve). Cards that collide on the same sense after relabel are
// deduped — the richer / more-reviewed one survives and the rest are soft-deleted. Pure and
// deterministic; returns a new array while preserving unchanged references.
export function applyMerges(
  items: StoredItem[],
  merges: Array<{ baseWords: string[]; canonical: string }>
): StoredItem[] {
  if (!merges || merges.length === 0) return items;
  const now = Date.now();
  const result = items.slice();

  const scoreCard = (it: StoredItem): number => {
    const reviews = it.srs?.totalReviews || 0;
    const c = it.data as VocabCard;
    const richness =
      (c.definition?.length || 0) +
      (Array.isArray(c.examples) ? c.examples.length : 0) * 50 +
      (c.history?.length || 0) +
      (c.imageUrl ? 1000 : 0);
    return reviews * 100000 + richness;
  };

  for (const { baseWords, canonical } of merges) {
    const canon = normalizeKey(canonical);
    if (!canon) continue;
    const baseSet = new Set(baseWords.map(b => normalizeKey(b)));

    const members = result
      .map((it, idx) => ({ it, idx }))
      .filter(({ it }) =>
        it.type === 'vocab' && !it.isDeleted &&
        baseSet.has(normalizeKey((it.data as VocabCard).word || ''))
      );
    if (members.length < 2) continue;

    // Display spelling of the canonical headword: reuse an existing card's exact spelling if present.
    let canonDisplay = canonical.trim();
    for (const { it } of members) {
      if (normalizeKey((it.data as VocabCard).word || '') === canon) {
        canonDisplay = ((it.data as VocabCard).word || '').trim();
        break;
      }
    }

    // Union of forms + the original variant spellings (minus the canonical itself).
    const unionForms = new Set<string>();
    for (const { it } of members) {
      const c = it.data as VocabCard;
      if (Array.isArray(c.forms)) for (const f of c.forms) { const t = (f || '').trim(); if (t) unionForms.add(t); }
      const w = (c.word || '').trim();
      if (w && normalizeKey(w) !== canon) unionForms.add(w);
    }
    const mergedForms = [...unionForms].filter(f => normalizeKey(f) !== canon);

    // Dedupe by sense — keep the best card per sense, soft-delete the rest.
    const bestBySense = new Map<string, number>();
    const losers = new Set<number>();
    for (const { it, idx } of members) {
      const senseKey = ((it.data as VocabCard).sense || '').toLowerCase().trim();
      const prevIdx = bestBySense.get(senseKey);
      if (prevIdx === undefined) {
        bestBySense.set(senseKey, idx);
      } else if (scoreCard(result[prevIdx]) >= scoreCard(it)) {
        losers.add(idx);
      } else {
        losers.add(prevIdx);
        bestBySense.set(senseKey, idx);
      }
    }

    for (const { it, idx } of members) {
      if (losers.has(idx)) {
        result[idx] = { ...it, isDeleted: true, updatedAt: now };
      } else {
        const c = it.data as VocabCard;
        result[idx] = { ...it, data: { ...c, word: canonDisplay, forms: mergedForms }, updatedAt: now };
      }
    }
  }

  return result;
}
