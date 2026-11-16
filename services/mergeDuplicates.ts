import { isVocabItem, senseMatchKey, type StoredItem, type VocabCard } from '../types';
import { normalizeKey } from './wordMatch';

/**
 * Which of two cards for one sense the merge keeps: the more reviewed, then the richer (definition, examples,
 * history, a picture). The duplicates modal shows the definition of each base word's best card by the same measure.
 */
export function mergeScore(item: StoredItem): number {
  const reviews = item.srs?.totalReviews || 0;
  const c = item.data as VocabCard;
  const richness =
    (c.definition?.length || 0) +
    (Array.isArray(c.examples) ? c.examples.length : 0) * 50 +
    (c.history?.length || 0) +
    (c.imageUrl ? 1000 : 0);
  return reviews * 100000 + richness;
}

/** What a merge does: the cards it relabels and the cards it removes. */
export interface MergeEffect {
  relabeled: number;
  removed: number;
}

const sameForms = (forms: string[] | undefined, merged: string[]): boolean =>
  Array.isArray(forms) && forms.length === merged.length && forms.every((form, i) => form === merged[i]);

// Merge variant-duplicate clusters (Phase 2 of the dedup tool). For each merge, every
// live vocab card whose word is a variant in the cluster is relabeled to the canonical
// headword and given the UNION of all members' forms (plus the original variant spellings,
// so future searches still resolve), one spelling per normalized form. Cards that collide on
// the same labeled sense after relabel are deduped — the richer / more-reviewed one survives
// and the rest are soft-deleted; cards without a sense label never collide. Pure and
// deterministic; returns a new array while preserving unchanged references, a member already
// spelled and formed as the merge would leave it among them.
export function applyMerges(
  items: StoredItem[],
  merges: Array<{ baseWords: string[]; canonical: string }>
): StoredItem[] {
  if (!merges || merges.length === 0) return items;
  const now = Date.now();
  const result = items.slice();

  for (const { baseWords, canonical } of merges) {
    const canon = normalizeKey(canonical);
    if (!canon) continue;
    const baseSet = new Set(baseWords.map(b => normalizeKey(b)));

    const members = result
      .map((it, idx) => ({ it, idx }))
      .filter((member): member is { it: StoredItem & { type: 'vocab'; data: VocabCard }; idx: number } =>
        isVocabItem(member.it) && !member.it.isDeleted &&
        baseSet.has(normalizeKey(member.it.data.word || ''))
      );
    if (members.length < 2) continue;

    // Display spelling of the canonical headword: reuse an existing card's exact spelling if present.
    let canonDisplay = canonical.trim();
    for (const { it } of members) {
      if (normalizeKey(it.data.word || '') === canon) {
        canonDisplay = (it.data.word || '').trim();
        break;
      }
    }

    // Union of forms + the original variant spellings (minus the canonical itself), keeping the first spelling
    // seen of each normalized form, so "Running" and "running" make one form. The headword's own cards go first,
    // so a headword that already lists every form keeps its list as it is.
    const unionForms = new Map<string, string>();
    const addForm = (form: string) => {
      const text = form.trim();
      const key = normalizeKey(text);
      if (key && key !== canon && !unionForms.has(key)) unionForms.set(key, text);
    };
    const isHeadword = (c: VocabCard) => normalizeKey(c.word || '') === canon;
    const headwordFirst = [...members.filter(m => isHeadword(m.it.data)), ...members.filter(m => !isHeadword(m.it.data))];
    for (const { it } of headwordFirst) {
      const c = it.data;
      if (Array.isArray(c.forms)) for (const f of c.forms) addForm(f || '');
      addForm(c.word || '');
    }
    const mergedForms = [...unionForms.values()];

    // Dedupe by labeled sense — keep the best card per sense, soft-delete the rest. A card without a sense label
    // could be any meaning, of any of the words, so it is never taken for another one.
    const bestBySense = new Map<string, number>();
    const losers = new Set<number>();
    for (const { it, idx } of members) {
      const senseKey = senseMatchKey(it.data.sense);
      if (!senseKey) continue;
      const prevIdx = bestBySense.get(senseKey);
      if (prevIdx === undefined) {
        bestBySense.set(senseKey, idx);
      } else if (mergeScore(result[prevIdx]) >= mergeScore(it)) {
        losers.add(idx);
      } else {
        losers.add(prevIdx);
        bestBySense.set(senseKey, idx);
      }
    }

    for (const { it, idx } of members) {
      if (losers.has(idx)) {
        result[idx] = { ...it, isDeleted: true, updatedAt: now };
      } else if (it.data.word !== canonDisplay || !sameForms(it.data.forms, mergedForms)) {
        result[idx] = { ...it, data: { ...it.data, word: canonDisplay, forms: mergedForms }, updatedAt: now };
      }
    }
  }

  return result;
}

/**
 * What applyMerges would do to `items`, counted from applyMerges itself so the two always agree: the cards it
 * relabels (survivors whose spelling or forms change) and the ones it removes (each labeled sense's duplicates).
 */
export function dryRunMerge(
  items: StoredItem[],
  merges: Array<{ baseWords: string[]; canonical: string }>
): MergeEffect {
  const merged = applyMerges(items, merges);
  let relabeled = 0;
  let removed = 0;
  merged.forEach((item, index) => {
    if (item === items[index]) return;
    if (item.isDeleted) removed++;
    else relabeled++;
  });
  return { relabeled, removed };
}
