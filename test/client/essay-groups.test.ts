import assert from 'node:assert/strict';
import test from 'node:test';
import { ESSAYS, type Essay } from '../../services/essayCatalog.ts';
import { groupModernEssays } from '../../views/reading/essayGroups.ts';

const essay = (id: string, publication: string): Essay => ({ ...ESSAYS[0], id, publication, collection: 'modern' });

test('a publication with several essays gets its own section; single essays share one', () => {
  const groups = groupModernEssays([
    essay('a', 'The Atlantic'),
    essay('b', 'A Blog'),
    essay('c', 'The Atlantic'),
    essay('d', 'A Newsletter'),
  ]);
  assert.deepEqual(groups.map(group => [group.title, group.essays.map(item => item.id)]), [
    ['The Atlantic', ['a', 'c']],
    ['Standalone essays', ['b', 'd']],
  ]);
});

test('sections follow the catalog order of their first essay', () => {
  const groups = groupModernEssays([
    essay('a', 'A Blog'),
    essay('b', 'The Atlantic'),
    essay('c', 'The Atlantic'),
  ]);
  assert.deepEqual(groups.map(group => group.title), ['Standalone essays', 'The Atlantic']);
  assert.deepEqual(groupModernEssays([]), []);
});
