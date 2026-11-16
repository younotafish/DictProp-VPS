import assert from 'node:assert/strict';
import test from 'node:test';
import type { SpeakHandle } from '../../services/neuralTts.ts';
import { createSpeechSlot } from '../../views/reading/speechSlot.ts';

/** A read's handle that counts how often it is stopped. */
const read = () => {
  const counted = { stops: 0, handle: { stop: () => { counted.stops++; }, isActive: () => true } satisfies SpeakHandle };
  return counted;
};

test('closing the list stops the read a row started, once', () => {
  const slot = createSpeechSlot();
  const sentence = read();
  slot.remember(sentence.handle);
  assert.equal(sentence.stops, 0, 'remembering a read leaves it playing');
  slot.stop();
  slot.stop();
  assert.equal(sentence.stops, 1);
});

test('a newer read replaces the one before, so closing stops only the newer', () => {
  const slot = createSpeechSlot();
  const first = read();
  const second = read();
  slot.remember(first.handle);
  slot.remember(second.handle);
  slot.stop();
  assert.deepEqual([first.stops, second.stops], [0, 1]);
});

test('closing with no read started stops nothing, and the slot keeps working after a close', () => {
  const slot = createSpeechSlot();
  assert.doesNotThrow(() => slot.stop());
  // A tab hidden and shown again keeps its list, and so its slot.
  const before = read();
  slot.remember(before.handle);
  slot.stop();
  const after = read();
  slot.remember(after.handle);
  slot.stop();
  assert.deepEqual([before.stops, after.stops], [1, 1]);
});
