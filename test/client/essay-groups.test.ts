import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ESSAYS, type Essay } from '../../services/essayCatalog.ts';
import { indexEssayProgress } from '../../services/essayProgress.ts';
import { EssayReader } from '../../views/reading/EssayReader.tsx';
import { groupModernEssays, nextReading } from '../../views/reading/essayGroups.ts';

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

test('the next reading is the next essay of the same publication, in catalog order', () => {
  const essays = [
    ...ESSAYS,
    essay('a', 'The Atlantic'),
    essay('b', 'A Blog'),
    essay('c', 'The Atlantic'),
    essay('d', 'The Atlantic'),
  ];
  const next = (id: string) => nextReading(essays, id)?.id ?? null;
  assert.equal(next('a'), 'c');
  assert.equal(next('c'), 'd');
  assert.equal(next('d'), null, 'the last of its publication');
  assert.equal(next('b'), null, 'a standalone essay');
  assert.equal(next(ESSAYS[0].id), null, 'a classic');
  assert.equal(next('missing'), null);
  // A classic that shares a publication name with modern essays still has none, and doesn't count among them.
  assert.equal(nextReading([{ ...ESSAYS[0], publication: 'The Atlantic' }, essay('x', 'The Atlantic'), essay('y', 'The Atlantic')], ESSAYS[0].id), null);
  assert.equal(nextReading([essay('x', 'The Atlantic'), { ...ESSAYS[0], publication: 'The Atlantic' }, essay('y', 'The Atlantic')], 'x')?.id, 'y');
});

test('the reader ends with a link to the next reading, and has none without one', () => {
  const reader = (nextEssay: Essay | null) => renderToStaticMarkup(createElement(EssayReader, {
    essay: essay('a', 'The Atlantic'), progressIndex: indexEssayProgress([]), now: 0, onBack: () => {}, onOpenSentence: () => {},
    onScroll: () => {}, nextEssay, onOpenEssay: () => {},
  }));
  const linked = reader({ ...essay('c', 'The Atlantic'), title: 'The Second Reading' });
  assert.match(linked, /<button type="button" class="group flex min-h-12 w-full[^"]*"><span class="min-w-0 truncate">Next: The Second Reading<\/span>/);
  assert.ok(linked.indexOf('Next: The Second Reading') < linked.indexOf('<footer'), 'above the rights note and the source link');
  assert.doesNotMatch(reader(null), /Next:/);
});
