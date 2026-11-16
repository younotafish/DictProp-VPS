import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeSentenceIdentity, sameSentenceText } from '../../services/sentenceIdentity.ts';
import { SRSAlgorithm } from '../../services/srsAlgorithm.ts';
import type { SentenceData, StoredItem } from '../../types.ts';

const same = (a: string, b: string) => assert.equal(normalizeSentenceIdentity(a), normalizeSentenceIdentity(b), `${a} | ${b}`);

test('a sentence typed with curly quotes or en/em dashes is the same sentence as its plain-typed twin', () => {
  same('I don’t know what to do', "I don't know what to do");
  same('She said “touché” and left.', 'She said "touché" and left.');
  same('It was—as usual—late.', 'It was-as usual-late.');
  same('Pages 10–20', 'Pages 10-20');
  same('‘Tis the season', "'Tis the season");
});

test('markers, spacing, case and compatibility forms do not change the identity', () => {
  same('I {{don\'t}} know [[what]] to do', "I don't know what to do");
  same('  Break   the\nice  ', 'break the ice');
  same('ＡＢＣ ﬁne', 'abc fine');
  assert.equal(normalizeSentenceIdentity('He said “Hi”—then left.'), 'he said "hi"-then left.');
});

test('different words stay different', () => {
  assert.notEqual(normalizeSentenceIdentity('I know.'), normalizeSentenceIdentity('I knew.'));
  assert.notEqual(normalizeSentenceIdentity("it's"), normalizeSentenceIdentity('its'));
});

test('two copies of a saved sentence are the same text unless the id or the text differs', () => {
  const saved: StoredItem = {
    type: 'sentence',
    data: { id: 's1', text: 'I {{ran}} home.', sourceWord: 'ran' },
    savedAt: 1,
    srs: SRSAlgorithm.createNew('s1', 'sentence', 1),
  };
  const data = saved.data as SentenceData;
  // A review or a listen replaces the schedule; an enrichment adds beside the text. Neither is a new text.
  assert.equal(sameSentenceText(saved, { ...saved, srs: { ...saved.srs!, totalReviews: 1, lastExposureDate: 2 } }), true);
  assert.equal(sameSentenceText(saved, { ...saved, data: { ...data, analysisGeneratedAt: 2, preferredSpeechStyle: 'casual' } }), true);
  // An edited text, even only its markers, or another sentence is different.
  assert.equal(sameSentenceText(saved, { ...saved, data: { ...data, text: 'I ran home.' } }), false);
  assert.equal(sameSentenceText(saved, { ...saved, data: { ...data, id: 's2' } }), false);
});
