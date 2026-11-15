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
