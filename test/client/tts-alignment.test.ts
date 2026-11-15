import assert from 'node:assert/strict';
import test from 'node:test';
import { alignWordsToStripped, seekTimeForOffset } from '../../services/ttsAlignment.ts';

const words = (...entries: Array<[string, number]>) => entries.map(([text, start]) => ({ text, start, end: start + 0.2 }));

test('every transcribed word anchors at its offset in the stripped sentence', () => {
  const aligned = alignWordsToStripped('Put the hat on it.', words(['Put', 0.1], ['the', 0.3], ['hat', 0.5], ['on', 0.7], ['it.', 0.9]));
  assert.deepEqual(aligned, [
    { charOffset: 0, startTime: 0.1 },
    { charOffset: 4, startTime: 0.3 },
    { charOffset: 8, startTime: 0.5 },
    { charOffset: 12, startTime: 0.7 },
    { charOffset: 15, startTime: 0.9 },
  ]);
  assert.equal(seekTimeForOffset(aligned, 8), 0.5, 'a click on "hat" starts at "hat"');
  assert.equal(seekTimeForOffset(aligned, 10), 0.5, 'a click inside a word starts at that word');
  assert.equal(seekTimeForOffset(aligned, 99), 0.9, 'a click past the end starts at the last word');
});

test('matching ignores case, and punctuation-only or unrecognised tokens get no anchor', () => {
  const aligned = alignWordsToStripped('Well, I never!', words(['WELL', 0], [',', 0.2], ['eye', 0.3], ['never', 0.6], ['', 0.8]));
  assert.deepEqual(aligned, [
    { charOffset: 0, startTime: 0 },
    { charOffset: 8, startTime: 0.6 },
  ]);
  assert.equal(seekTimeForOffset(aligned, 6), 0, 'a word without an anchor starts at the nearest earlier anchor');
});

test('a click before the first anchor starts at the first anchored word', () => {
  const aligned = alignWordsToStripped('Honestly, it works.', words(['honestly', 0.2], ['it', 0.6], ['works', 0.8]));
  assert.equal(aligned[0].charOffset, 0);
  const late = alignWordsToStripped('So it works.', words(['sew', 0.1], ['it', 0.4], ['works', 0.6]));
  assert.equal(late[0].charOffset, 3);
  assert.equal(seekTimeForOffset(late, 0), 0.4, 'a click on the unrecognised first word starts at the second');
});

test('no sentence, no timings or no anchors give nothing to seek to', () => {
  assert.deepEqual(alignWordsToStripped('', words(['a', 0])), []);
  assert.deepEqual(alignWordsToStripped('A sentence.', null), []);
  assert.deepEqual(alignWordsToStripped('A sentence.', []), []);
  assert.equal(seekTimeForOffset([], 3), null);
});

test('a misheard short word can anchor inside a later word', () => {
  // 'the' was transcribed as 'a', which matches the a in 'hat' and moves the cursor past it.
  const aligned = alignWordsToStripped('Put the hat on it', words(['Put', 0.1], ['a', 0.3], ['hat', 0.5], ['on', 0.7], ['it', 0.9]));
  assert.deepEqual(aligned.map(anchor => anchor.charOffset), [0, 9, 12, 15]);
  assert.equal(seekTimeForOffset(aligned, 8), 0.1, 'a click on "hat" starts back at "Put"');
});
