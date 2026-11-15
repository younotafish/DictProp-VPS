import assert from 'node:assert/strict';
import test from 'node:test';
import { edgeZoneAt, gutterZoneAt, readBandAt } from '../../components/review/readZones.ts';

test('the top quarter reads the first example, the second quarter the second, and the lower half nothing', () => {
  assert.deepEqual([0, 24.9, 25, 49.9, 50, 99, -5].map(y => readBandAt(y, 100)), [0, 0, 1, 1, null, null, 0]);
});

test('on the phone sheet the zones are the outer 28% of the card body on either side', () => {
  const body = { left: 10, top: 100, width: 400, height: 800 };
  assert.equal(edgeZoneAt(body, 10 + 111, 100 + 199), 0, 'left column, top quarter');
  assert.equal(edgeZoneAt(body, 10 + 289, 100 + 201), 1, 'right column, second quarter');
  assert.equal(edgeZoneAt(body, 10 + 113, 100 + 50), null, 'just inside the middle column');
  assert.equal(edgeZoneAt(body, 10 + 287, 100 + 50), null, 'just inside it on the right');
  assert.equal(edgeZoneAt(body, 10 + 200, 100 + 50), null, 'middle column');
  assert.equal(edgeZoneAt(body, 10 + 5, 100 + 400), null, 'lower half');
});

test('from sm up the zones are the gutters beside the card, as quarters of the screen', () => {
  const panel = { left: 100, right: 900 };
  assert.equal(gutterZoneAt(panel, 1000, 99, 249), 0);
  assert.equal(gutterZoneAt(panel, 1000, 901, 250), 1);
  assert.equal(gutterZoneAt(panel, 1000, 100, 100), null, 'on the card edge');
  assert.equal(gutterZoneAt(panel, 1000, 500, 100), null, 'over the card');
  assert.equal(gutterZoneAt(panel, 1000, 50, 500), null, 'lower half');
});
