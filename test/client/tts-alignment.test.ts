import assert from 'node:assert/strict';
import test from 'node:test';
import { alignWordsToStripped, leadInSkip, seekTimeForOffset } from '../../services/ttsAlignment.ts';

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

test('a misheard short word anchors nothing rather than matching inside a later word', () => {
  // 'the' was transcribed as 'a', which used to match the a in 'hat' and move the cursor past it.
  const aligned = alignWordsToStripped('Put the hat on it', words(['Put', 0.1], ['a', 0.3], ['hat', 0.5], ['on', 0.7], ['it', 0.9]));
  assert.deepEqual(aligned.map(anchor => anchor.charOffset), [0, 8, 12, 15]);
  assert.equal(seekTimeForOffset(aligned, 8), 0.5, 'a click on "hat" starts at "hat"');
  assert.equal(seekTimeForOffset(aligned, 4), 0.1, 'a click on the misheard word starts at the word before');
});

test('a token matches only whole words, though punctuation at its edges needs no boundary', () => {
  const anchors = (sentence: string, ...tokens: string[]) =>
    alignWordsToStripped(sentence, words(...tokens.map((token, index): [string, number] => [token, index]))).map(anchor => anchor.charOffset);
  assert.deepEqual(anchors('Thinking in the bin', 'in', 'bin'), [9, 16], '"in" skips the two inside "Thinking"');
  assert.deepEqual(anchors("Don't stop", 'don', "'t", 'stop'), [0, 3, 6]);
  assert.deepEqual(anchors('A well-known fact', 'a', 'well', '-known', 'fact'), [0, 2, 6, 13]);
});

test('a misheard word that recurs later anchors nothing, rather than jumping past the words in between', () => {
  // 'the' was heard as 'a', and the sentence has an 'a' of its own further on.
  const aligned = alignWordsToStripped('Put the hat in a box.', words(['Put', 0], ['a', 0.25], ['hat', 0.45], ['in', 0.65], ['a', 0.8], ['box', 0.9]));
  assert.deepEqual(aligned, [
    { charOffset: 0, startTime: 0 },
    { charOffset: 8, startTime: 0.45 },
    { charOffset: 12, startTime: 0.65 },
    { charOffset: 15, startTime: 0.8 },
    { charOffset: 17, startTime: 0.9 },
  ]);
  assert.equal(seekTimeForOffset(aligned, 12), 0.65, 'a click on "in" starts at "in"');
  assert.equal(seekTimeForOffset(aligned, 15), 0.8, 'a click on "a" starts at "a"');
  assert.equal(seekTimeForOffset(aligned, 4), 0, 'a click on the misheard word starts at the word before');
});

test('a word heard as two anchors at its first part, and the words after it keep their own anchors', () => {
  const aligned = alignWordsToStripped('I cannot say if you can.', words(
    ['I', 0], ['can', 0.2], ['not', 0.4], ['say', 0.6], ['if', 0.85], ['you', 1.05], ['can', 1.25],
  ));
  assert.deepEqual(aligned.map(anchor => [anchor.charOffset, anchor.startTime]), [[0, 0], [2, 0.2], [9, 0.6], [13, 0.85], [16, 1.05], [20, 1.25]]);
  assert.equal(seekTimeForOffset(aligned, 9), 0.6, 'a click on "say" starts at "say"');
  assert.equal(seekTimeForOffset(aligned, 20), 1.25, 'a click on the last "can" starts there');
});

test('a short word that begins the next word anchors at that word, even when the short word occurs later as well', () => {
  const anchors = (sentence: string, ...tokens: string[]) =>
    alignWordsToStripped(sentence, words(...tokens.map((token, index): [string, number] => [token, index]))).map(anchor => anchor.charOffset);
  // 'and' heard as 'an', in a sentence with an 'an' further on.
  assert.deepEqual(anchors('She sat down and ate an apple.', 'she', 'sat', 'down', 'an', 'ate', 'an', 'apple'), [0, 4, 8, 13, 17, 21, 24]);
  // The casual voice's respelling, as the server's word builder passes it on.
  assert.deepEqual(anchors('She was running late.', 'she', 'was', "runnin'", 'late'), [0, 4, 8, 16]);
  assert.deepEqual(anchors('She walks home', 'she', 'walk', 'home'), [0, 4, 10]);
  // Only the word that comes next counts, and one letter is too little to go on.
  assert.deepEqual(anchors('Put the cannon down', 'put', 'can', 'down'), [0, 15]);
  assert.deepEqual(anchors('Put all hats away', 'put', 'a', 'hats', 'away'), [0, 8, 13]);
});

test('merged or dropped words cost only their own anchors', () => {
  const anchors = (sentence: string, ...tokens: string[]) =>
    alignWordsToStripped(sentence, words(...tokens.map((token, index): [string, number] => [token, index]))).map(anchor => anchor.charOffset);
  assert.deepEqual(anchors("I'm going to put the hat in a box.", "I'm", 'gonna', 'put', 'the', 'hat', 'in', 'a', 'box'), [0, 13, 17, 21, 25, 28, 30]);
  assert.deepEqual(anchors('It is one of the best films I have seen', 'it', 'is', 'one', 'best', 'films', 'i', 'have', 'seen'), [0, 3, 6, 17, 22, 28, 30, 35]);
  // A word heard twice anchors once, at its nearest place, and doesn't take a later repeat from the words between.
  assert.deepEqual(anchors('We went home and then we slept', 'we', 'we', 'went', 'home', 'and', 'then', 'slept'), [0, 3, 8, 13, 17, 25]);
});

test('playback skips the quiet lead-in, starting 30 ms before the first word, and from 0 without timings', () => {
  assert.ok(Math.abs(leadInSkip(words(['Hello', 0.13])) - 0.1) < 1e-9);
  assert.equal(leadInSkip(words(['Hello', 0.01])), 0, 'never before the start');
  assert.equal(leadInSkip(words(['Hello', 0])), 0);
  assert.equal(leadInSkip([]), 0);
  assert.equal(leadInSkip(null), 0);
});
