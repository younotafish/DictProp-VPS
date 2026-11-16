import assert from 'node:assert/strict';
import test from 'node:test';
import type { SRSData } from '../../types.ts';
import { MASTERY_LEVELS, SRSAlgorithm, masteryLevelFor } from '../../services/srsAlgorithm.ts';
import { masteryText } from '../../components/mastery.tsx';

test('display strength is 18·ln(1 + stability), rounded and capped, as the table in its doc says', () => {
  const table: [stability: number, strength: number][] = [
    [1, 12], [3, 25], [7, 37], [12, 46], [25, 59], [47, 70], [84, 80], [143, 89], [180, 94],
  ];
  for (const [stability, strength] of table) {
    assert.equal(SRSAlgorithm.stabilityToDisplayStrength(stability), strength, `stability ${stability}`);
  }
  assert.equal(SRSAlgorithm.stabilityToDisplayStrength(0), 0);
  assert.equal(SRSAlgorithm.stabilityToDisplayStrength(-3), 0);
  assert.equal(SRSAlgorithm.stabilityToDisplayStrength(10_000), 100);
});

test('a new record is due at its creation time, and a reset stamps its own time as the review clock', () => {
  const created = SRSAlgorithm.createNew('fresh', 'vocab', 1_000);
  assert.equal(created.nextReview, 1_000);
  assert.equal(created.lastReviewDate, 0);
  assert.equal(created.totalReviews, 0);

  const reset = SRSAlgorithm.reset('fresh', 'phrase', 2_000);
  assert.deepEqual(reset, { ...SRSAlgorithm.createNew('fresh', 'phrase', 2_000), lastReviewDate: 2_000 });
});

test('ensure creates a record for an item without one and migrates one that exists', () => {
  const created = SRSAlgorithm.ensure(undefined, 'missing', 'sentence');
  assert.equal(created.id, 'missing');
  assert.equal(created.type, 'sentence');
  assert.equal(created.totalReviews, 0);

  // The methods don't depend on `this`, so they still work detached, as callbacks.
  const { ensure, migrate } = SRSAlgorithm;
  const legacy = { id: 'old', type: 'vocab' as const, nextReview: 5, interval: 1_440, memoryStrength: 0, lastReviewDate: 4, totalReviews: 2, correctStreak: 2, stability: 7 };
  assert.deepEqual(ensure(legacy, 'old', 'vocab'), migrate(legacy));
  assert.equal(migrate(legacy).memoryStrength, 37);
  assert.equal(migrate(legacy).lastExposureDate, 0);
});

test('a schedule needs migrating when it has no memory strength, or is a never-reviewed sentence with other starting values', () => {
  const current = SRSAlgorithm.createNew('a', 'vocab', 0);
  assert.equal(SRSAlgorithm.needsMigration(current, 'vocab'), false);
  assert.equal(SRSAlgorithm.needsMigration({ ...current, memoryStrength: undefined } as unknown as SRSData, 'vocab'), true);
  assert.equal(SRSAlgorithm.needsMigration(undefined, 'vocab'), true, 'no schedule at all');

  const sentence = SRSAlgorithm.createNew('s', 'sentence', 0);
  assert.equal(SRSAlgorithm.needsMigration(sentence, 'sentence'), false);
  assert.equal(SRSAlgorithm.needsMigration({ ...sentence, memoryStrength: 30 }, 'sentence'), true, "another type's strength");
  assert.equal(SRSAlgorithm.needsMigration({ ...sentence, stability: 2 }, 'sentence'), true, "another type's stability");
  assert.equal(SRSAlgorithm.needsMigration({ ...sentence, memoryStrength: 30, totalReviews: 4 }, 'sentence'), false, 'a reviewed sentence keeps its strength');
  assert.equal(SRSAlgorithm.needsMigration({ ...current, memoryStrength: 30 }, 'vocab'), false, 'only sentences drop seed strength');
});

test('mastery levels run from Grandmaster down to Struggling by minimum strength, then New, which has none', () => {
  assert.deepEqual(MASTERY_LEVELS.map(level => [level.key, level.label, level.min, level.color]), [
    ['grandmaster', 'Grandmaster', 85, 'purple'],
    ['mastered', 'Mastered', 70, 'emerald'],
    ['proficient', 'Proficient', 50, 'blue'],
    ['learning', 'Learning', 30, 'amber'],
    ['struggling', 'Struggling', -Infinity, 'orange'],
    ['new', 'New', null, 'slate'],
  ]);
  // A reviewed card bands by strength, down to Struggling.
  const keyOf = (strength: number) => masteryLevelFor(strength, 3)?.key;
  assert.deepEqual([100, 85, 84.9, 70, 69.9, 50, 49.9, 30, 29.9, 10, 9.9, 0, -1].map(keyOf), [
    'grandmaster', 'grandmaster', 'mastered', 'mastered', 'proficient', 'proficient', 'learning', 'learning',
    'struggling', 'struggling', 'struggling', 'struggling', 'struggling',
  ]);
  assert.equal(masteryLevelFor(NaN, 3), undefined, 'NaN reaches no band');
  // A card never reviewed is New, whatever its strength.
  for (const strength of [0, 7, 95, NaN]) assert.equal(masteryLevelFor(strength, 0)?.key, 'new', `strength ${strength}`);
  assert.equal(masteryLevelFor(40, Number.NaN)?.key, 'new', 'an unreadable count is no review');
});

test('a badge reads New at 0 for a card never reviewed, else the band of the strength recomputed from stability', () => {
  const fresh = SRSAlgorithm.createNew('x', 'vocab', 0);
  for (const stability of [0.5, 7, 143, NaN]) {
    assert.deepEqual(SRSAlgorithm.getMasteryLevel({ ...fresh, stability }), { label: 'New', color: 'slate', percentage: 0 }, `stability ${stability}`);
  }
  assert.deepEqual(SRSAlgorithm.getMasteryLevel({ ...fresh, totalReviews: undefined as unknown as number }), { label: 'New', color: 'slate', percentage: 0 });

  const badge = (stability: number) => SRSAlgorithm.getMasteryLevel({ ...fresh, totalReviews: 2, stability });
  assert.deepEqual(badge(0.5), { label: 'Struggling', color: 'orange', percentage: 7 }, 'reviewed and weak is Struggling, not New');
  assert.deepEqual(badge(1), { label: 'Struggling', color: 'orange', percentage: 12 });
  assert.deepEqual(badge(7), { label: 'Learning', color: 'amber', percentage: 37 });
  assert.deepEqual(badge(25), { label: 'Proficient', color: 'blue', percentage: 59 });
  assert.deepEqual(badge(47), { label: 'Mastered', color: 'emerald', percentage: 70 });
  assert.deepEqual(badge(143), { label: 'Grandmaster', color: 'purple', percentage: 89 });
  assert.deepEqual(badge(NaN), { label: 'Struggling', color: 'orange', percentage: NaN });
});

test('a badge says the level and strength, and just New for a card never reviewed', () => {
  const fresh = SRSAlgorithm.createNew('x', 'vocab', 0);
  assert.equal(masteryText(SRSAlgorithm.getMasteryLevel(fresh)), 'New');
  assert.equal(masteryText(SRSAlgorithm.getMasteryLevel({ ...fresh, totalReviews: 4, stability: 7 })), 'Learning 37%');
  assert.equal(masteryText(SRSAlgorithm.getMasteryLevel({ ...fresh, totalReviews: 1, stability: 0.5 })), 'Struggling 7%');
  assert.equal(masteryText({ label: 'Learning', percentage: 44.6 }), 'Learning 45%');
});
