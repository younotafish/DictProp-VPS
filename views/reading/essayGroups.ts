import type { Essay } from '../../services/essayCatalog';

/**
 * The modern essays in sections for the landing page: those from a publication with more than one essay under
 * its name, the rest under 'Standalone essays'. Sections and the essays in them keep catalog order.
 */
export function groupModernEssays(modernEssays: readonly Essay[]): { title: string; essays: Essay[] }[] {
  const publicationCounts = new Map<string, number>();
  for (const essay of modernEssays) {
    publicationCounts.set(essay.publication, (publicationCounts.get(essay.publication) ?? 0) + 1);
  }
  const groups = new Map<string, Essay[]>();
  for (const essay of modernEssays) {
    const key = (publicationCounts.get(essay.publication) ?? 0) > 1
      ? essay.publication
      : 'Standalone essays';
    const group = groups.get(key) ?? [];
    group.push(essay);
    groups.set(key, group);
  }
  return [...groups.entries()].map(([title, groupedEssays]) => ({ title, essays: groupedEssays }));
}

/**
 * The reading after `essayId` for the reader's 'Next' link: the next essay in catalog order from the same publication,
 * among the modern essays grouped under one (groupModernEssays). Null for a classic, a standalone essay and the last of
 * its publication.
 */
export function nextReading(essays: readonly Essay[], essayId: string): Essay | null {
  const essay = essays.find(candidate => candidate.id === essayId);
  if (!essay || essay.collection !== 'modern') return null;
  const publication = essays.filter(candidate => candidate.collection === 'modern' && candidate.publication === essay.publication);
  if (publication.length < 2) return null;
  return publication[publication.indexOf(essay) + 1] ?? null;
}
