import assert from 'node:assert/strict';
import test from 'node:test';
import { indexCatalogProgress } from '../../services/catalogProgress.ts';
import { REAL_LIFE_COLLECTIONS } from '../../services/realLifeCatalog.ts';
import { createRealLifeProgressItem } from '../../services/realLifeProgress.ts';
import { filterRealLifeSentences, type RealLifeListScope } from '../../views/reading/realLifeFilter.ts';

const NOW = 2_000_000;
const restaurant = REAL_LIFE_COLLECTIONS.find(collection => collection.id === 'restaurant-conversations')!;
const noProgress = indexCatalogProgress([], 'real-life');
const everything: RealLifeListScope = { sectionId: 'all', reviewFilter: 'all', query: '' };

const ids = (scope: Partial<RealLifeListScope>, index = noProgress) =>
  filterRealLifeSentences(restaurant.sentences, { ...everything, ...scope }, index, NOW).map(sentence => sentence.id);

test('with nothing chosen, the list is the whole collection in catalog order', () => {
  assert.deepEqual(ids({}), restaurant.sentences.map(sentence => sentence.id));
});

test('a theme narrows the list to its section', () => {
  const dietary = restaurant.sections.find(section => section.id === 'dietary-needs')!;
  assert.deepEqual(ids({ sectionId: 'dietary-needs' }), dietary.sentences.map(sentence => sentence.id));
});

test('a review chip reads each line\'s progress record', () => {
  const [first, second] = restaurant.sentences;
  const due = createRealLifeProgressItem(first, 1);
  due.srs = { ...due.srs, totalReviews: 1, nextReview: NOW - 1 };
  const memorized = createRealLifeProgressItem(second, 1);
  memorized.srs = { ...memorized.srs, totalReviews: 3, nextReview: NOW + 1 };
  const index = indexCatalogProgress([due, memorized], 'real-life');

  assert.deepEqual(ids({ reviewFilter: 'due' }, index), [first.id]);
  assert.deepEqual(ids({ reviewFilter: 'memorized' }, index), [second.id]);
  assert.equal(ids({ reviewFilter: 'unreviewed' }, index).length, restaurant.sentences.length - 2);
});

test('the search matches a line\'s text, studied phrase or theme, ignoring case and surrounding spaces', () => {
  assert.deepEqual(ids({ query: '  I CAN\'T HAVE DAIRY ' }), ['restaurant-conversations:dietary-needs:10']);
  assert.ok(ids({ query: 'milk-derived ingredient' }).includes('restaurant-conversations:dietary-needs:10'));
  const dietaryTheme = ids({ query: 'dietary needs & allergies' });
  assert.deepEqual(dietaryTheme, ids({ sectionId: 'dietary-needs' }));
});

test('theme, chip and search narrow together', () => {
  assert.deepEqual(ids({ sectionId: 'reservations-and-arrival', query: 'dairy' }), []);
  assert.ok(ids({ sectionId: 'dietary-needs', reviewFilter: 'unreviewed', query: 'dairy' }).includes('restaurant-conversations:dietary-needs:10'));
});
