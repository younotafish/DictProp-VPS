import assert from 'node:assert/strict';
import test from 'node:test';
import { eyesFreeZoneAt } from '../../components/eyesFreeBands.ts';
import { eyesFreeZoneAt as guideZoneAt } from '../../components/EyesFreeZones.tsx';

test('the top quarter reads the first sentence, the second quarter the second, and the bottom half nothing', () => {
  assert.equal(eyesFreeZoneAt(0, 800), 0);
  assert.equal(eyesFreeZoneAt(199.9, 800), 0);
  assert.equal(eyesFreeZoneAt(200, 800), 1);
  assert.equal(eyesFreeZoneAt(399.9, 800), 1);
  assert.equal(eyesFreeZoneAt(400, 800), -1);
  assert.equal(eyesFreeZoneAt(799, 800), -1);
});

test('the split agrees with each handler\'s own arithmetic, quarters and halves alike', () => {
  // DetailView and the search sheet divided by 4 and 2, and the review popup multiplied by 0.25 and 0.5, before all three called eyesFreeZoneAt.
  for (const height of [667, 844.5, 1180, 1366]) {
    for (let y = 0; y <= height; y += 0.5) {
      const divided = y < height / 4 ? 0 : y < height / 2 ? 1 : -1;
      const multiplied = y >= height * 0.5 ? -1 : y < height * 0.25 ? 0 : 1;
      assert.equal(eyesFreeZoneAt(y, height), divided);
      assert.equal(eyesFreeZoneAt(y, height), multiplied);
    }
  }
});

test('the guide component hands out the same split it draws, from the pure module', () => {
  assert.equal(guideZoneAt, eyesFreeZoneAt);
});
