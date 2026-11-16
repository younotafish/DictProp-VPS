import assert from 'node:assert/strict';
import test from 'node:test';
import { stripSentenceMarkers } from '../../services/sentenceMarkers.ts';
import {
  parseSentenceMarkers,
  stripEdgePunct,
  tokenizeSentence,
  type SentencePiece,
  type SentenceUnit,
} from '../../services/sentenceTokens.ts';
import type { StoredItem } from '../../types.ts';

const saved = (word: string): StoredItem => ({ type: 'vocab', savedAt: 0, data: { id: word, word } }) as unknown as StoredItem;
// The app's findSaved normalizes its term (wordMatch's normalizeKey); this stand-in folds case, whitespace and
// edge punctuation the same way.
const findSavedFrom = (words: string[]) => {
  const items = new Map(words.map(word => [word, saved(word)]));
  return (term: string) => items.get(term.toLowerCase().replace(/\s+/g, ' ').replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '')) ?? null;
};

const unitsOfRun = (pieces: SentencePiece[]): SentenceUnit[] =>
  pieces.flatMap(piece => (piece.kind === 'run' && typeof piece.content !== 'string' ? piece.content : []));

const unitsOf = (pieces: SentencePiece[]): SentenceUnit[] =>
  pieces.flatMap(piece => (piece.kind === 'run' ? (typeof piece.content === 'string' ? [] : piece.content) : [piece]));

const WELL_FORMED = [
  'He tried to {{break the ice}} at the party.',
  'She [[serendipitously]] found the {{coffee}} shop — wow!',
  '{{Ice}}{{ice}}[[ice]] ice',
  '  Leading {{and}} trailing  ',
  'No markers at all.',
  '{{x}} [[y]] {{z}}',
];

test('marker segments come in order, with offsets into the marker-stripped text', () => {
  assert.deepEqual(parseSentenceMarkers('She [[serendipitously]] found the {{coffee}} shop.'), [
    { kind: 'plain', text: 'She ', offset: 0 },
    { kind: 'uncommon', text: 'serendipitously', offset: 4 },
    { kind: 'plain', text: ' found the ', offset: 19 },
    { kind: 'item', text: 'coffee', offset: 30 },
    { kind: 'plain', text: ' shop.', offset: 36 },
  ]);
  assert.deepEqual(parseSentenceMarkers(''), []);
  // Unclosed or empty markers are plain text, as stripSentenceMarkers leaves them.
  assert.deepEqual(parseSentenceMarkers('{{}} [[x'), [{ kind: 'plain', text: '{{}} [[x', offset: 0 }]);

  for (const text of WELL_FORMED) {
    const segments = parseSentenceMarkers(text);
    const stripped = stripSentenceMarkers(text);
    assert.equal(segments.map(s => s.text).join(''), stripped, text);
    for (const segment of segments) assert.equal(stripped.slice(segment.offset, segment.offset + segment.text.length), segment.text, text);
  }
});

test('segments spell the spoken text even when markers nest or cross, which the server never emits', () => {
  assert.deepEqual(parseSentenceMarkers('{{a [[b]] c}} end'), [
    { kind: 'item', text: 'a b c', offset: 0 },
    { kind: 'plain', text: ' end', offset: 5 },
  ]);
  assert.deepEqual(parseSentenceMarkers('[[a {{b]] c}} end'), [{ kind: 'plain', text: 'a b c end', offset: 0 }]);
  const malformed = ['[[a {{b}} c]]', '{{[[a]]}}', '{{[[a}}]]', '{{a [[b}} c]]', '{{a}}}}', '{{{a}}', '[[a]] {{b ]] c}}', '{{}}x[[]]'];
  for (const text of [...WELL_FORMED, ...malformed]) {
    const segments = parseSentenceMarkers(text);
    assert.equal(segments.map(s => s.text).join(''), stripSentenceMarkers(text), text);
    let offset = 0;
    for (const segment of segments) {
      assert.equal(segment.offset, offset, text);
      offset += segment.text.length;
    }
  }
});

test('edge punctuation is stripped from lookup terms, keeping apostrophes', () => {
  assert.equal(stripEdgePunct('cat.'), 'cat');
  assert.equal(stripEdgePunct('"Hello,"'), 'Hello');
  assert.equal(stripEdgePunct('“Hello,”'), 'Hello');
  assert.equal(stripEdgePunct("don't."), "don't");
  assert.equal(stripEdgePunct('‘tis'), 'tis');
  assert.equal(stripEdgePunct('(a)'), 'a');
  assert.equal(stripEdgePunct('...'), '');
  assert.equal(stripEdgePunct('—'), '');
});

test('a lookup term keeps the accented letters it starts or ends with', () => {
  assert.equal(stripEdgePunct('café.'), 'café');
  assert.equal(stripEdgePunct('touché!'), 'touché');
  assert.equal(stripEdgePunct('élan'), 'élan');
  assert.equal(stripEdgePunct('(über)'), 'über');
  assert.equal(stripEdgePunct('“naïveté”'), 'naïveté');
  // A combining accent (NFD) stays on its letter, and digits stay too.
  assert.equal(stripEdgePunct('cafe\u0301,'), 'cafe\u0301');
  assert.equal(stripEdgePunct('1990s,'), '1990s');
  // Look-ups read the whole word, from plain text and from the studied item.
  const units = unitsOf(tokenizeSentence('Touché! A café in {{Montréal.}}', { itemWord: '', lookupAnyWord: true }));
  assert.deepEqual(units.flatMap(u => (u.kind === 'lookup' || u.kind === 'item' ? [u.term] : [])), ['Touché', 'A', 'café', 'in', 'Montréal']);
  // A saved phrase that starts with an accented letter is found too.
  const phrases = unitsOf(tokenizeSentence('Order it à la carte.', { itemWord: '', findSaved: findSavedFrom(['à la carte']), lookupAnyWord: false }));
  assert.deepEqual(phrases.filter(u => u.kind === 'phrase').map(u => u.text), ['à la carte.']);
});

test('without saved lookup or tap-any-word, plain runs stay whole and nothing is addressable', () => {
  assert.deepEqual(tokenizeSentence('A {{b}} c.', { itemWord: '', lookupAnyWord: false }), [
    { kind: 'run', key: 'p0', content: 'A ' },
    { kind: 'item', key: 'i0', text: 'b', offset: undefined, term: '' },
    { kind: 'run', key: 'p1', content: ' c.' },
  ]);
  assert.deepEqual(tokenizeSentence('[[x]]', { itemWord: '', lookupAnyWord: false }), [
    { kind: 'uncommon', key: 'l0', text: 'x', offset: undefined },
  ]);
});

test('an unmarked run emphasizes the studied item wherever it appears as a whole word', () => {
  const [run] = tokenizeSentence('I need my coffee. Coffee, not coffees!', { itemWord: ' Coffee ', lookupAnyWord: false });
  assert.equal(run.kind, 'run');
  const content = (run as Extract<SentencePiece, { kind: 'run' }>).content as SentenceUnit[];
  assert.deepEqual(content.filter(unit => unit.kind === 'emphasis').map(unit => unit.text), ['coffee', 'Coffee']);
  assert.equal(content.map(unit => unit.text).join(''), 'I need my coffee. Coffee, not coffees!');
  // A multi-word item and regex characters in it are matched literally.
  const [phraseRun] = tokenizeSentence('We broke the ice (finally).', { itemWord: 'broke the ice', lookupAnyWord: false });
  assert.deepEqual(((phraseRun as Extract<SentencePiece, { kind: 'run' }>).content as SentenceUnit[]).filter(u => u.kind === 'emphasis').map(u => u.text), ['broke the ice']);
});

test('in an unmarked run the item matches as a whole word even when it starts or ends with an accented letter', () => {
  const emphasized = (text: string, itemWord: string) =>
    unitsOfRun(tokenizeSentence(text, { itemWord, lookupAnyWord: false })).filter(u => u.kind === 'emphasis').map(u => u.text);
  assert.deepEqual(emphasized('Café time at the café, then touché.', 'café'), ['Café', 'café']);
  assert.deepEqual(emphasized('Pure élan!', 'élan'), ['élan']);
  assert.deepEqual(emphasized('Not cafés, nor écafé.', 'café'), []);
  assert.deepEqual(emphasized('A list, etc. and so on', 'etc.'), ['etc.']);
  // ASCII words match as they always did.
  assert.deepEqual(emphasized('I need my coffee. Coffee, not coffees or coffee_cups!', 'coffee'), ['coffee', 'Coffee']);
});

test('saved lookup takes the longest saved phrase, then single saved words, keeping whitespace as it is', () => {
  const findSaved = findSavedFrom(['break', 'break the ice', 'ice', 'run the gamut', 'party']);
  const pieces = tokenizeSentence('Try to break  the ice, then {{run the gamut}} at the party.', { itemWord: 'run the gamut', findSaved, lookupAnyWord: false });
  const units = unitsOf(pieces);
  assert.deepEqual(units.filter(u => u.kind === 'phrase').map(u => [u.text, u.offset]), [['break  the ice,', 7]]);
  assert.deepEqual(units.filter(u => u.kind === 'saved').map(u => [u.text, u.offset, u.kind === 'saved' && u.studied]), [
    ['run the gamut', 28, true],
    ['party.', 49, false],
  ]);
  // Unsaved words are plain text here (no tap-any-word), and the text survives intact.
  assert.deepEqual(units.filter(u => u.kind === 'text' && u.text.trim()).map(u => u.text), ['Try', 'to', 'then', 'at', 'the']);
  assert.equal(units.map(u => u.text).join(''), stripSentenceMarkers('Try to break  the ice, then {{run the gamut}} at the party.'));
  // A phrase is at most six words long.
  const long = findSavedFrom(['a b c d e f', 'a b c d e f g']);
  assert.deepEqual(unitsOf(tokenizeSentence('a b c d e f g', { itemWord: '', findSaved: long, lookupAnyWord: false })).filter(u => u.kind === 'phrase').map(u => u.text), ['a b c d e f']);
});

test('tap-any-word makes every unsaved word a lookup of its edge-trimmed text; punctuation alone stays plain', () => {
  const findSaved = findSavedFrom(['ice']);
  const text = 'Well — the {{ice}} is "thin", isn\'t it?';
  const units = unitsOf(tokenizeSentence(text, { itemWord: 'ice', findSaved, lookupAnyWord: true }));
  assert.deepEqual(units.filter(u => u.kind === 'lookup').map(u => u.kind === 'lookup' && u.term), ['Well', 'the', 'is', 'thin', "isn't", 'it']);
  assert.deepEqual(units.filter(u => u.kind === 'text').map(u => u.text.trim()).filter(Boolean), ['—']);
  const stripped = stripSentenceMarkers(text);
  for (const unit of units) {
    if (unit.kind === 'text' || unit.kind === 'emphasis') continue;
    assert.equal(typeof unit.offset, 'number', unit.text);
    assert.equal(stripped.slice(unit.offset, unit.offset! + unit.text.length), unit.text);
  }
  // An unsaved studied item is looked up too, and a legacy whole-word match keeps its emphasis.
  assert.deepEqual(tokenizeSentence('{{Ice!}}', { itemWord: '', lookupAnyWord: true }), [{ kind: 'item', key: 'i0', text: 'Ice!', offset: 0, term: 'Ice' }]);
  assert.deepEqual(unitsOf(tokenizeSentence('thin ice', { itemWord: 'ice', lookupAnyWord: true }))[2], { kind: 'lookup', key: 'p0-2', text: 'ice', offset: 5, term: 'ice', studied: true });
});

test('keys follow the markers: the run before marker n is p{n}, the item i{n}, the uncommon term l{n}', () => {
  const keys = tokenizeSentence('a {{b}} c [[d]] e', { itemWord: '', lookupAnyWord: false }).map(piece => piece.key);
  assert.deepEqual(keys, ['p0', 'i0', 'p1', 'l1', 'p2']);
});
