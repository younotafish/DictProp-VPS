import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeSentenceIdentity } from '../../services/sentenceIdentity.ts';

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
