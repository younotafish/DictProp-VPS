import assert from 'node:assert/strict';
import test from 'node:test';
import { parseWordList } from '../../components/BatchImport.tsx';

test('one entry per line, with a phrase keeping its commas', () => {
  assert.deepEqual(
    parseWordList('ubiquitous\neasy come, easy go\nno pain, no gain\n\na blessing in disguise\r\n'),
    ['ubiquitous', 'easy come, easy go', 'no pain, no gain', 'a blessing in disguise'],
  );
});

test('a line of single words is still a comma-separated list', () => {
  assert.deepEqual(parseWordList('apple, pear\nrun the gamut'), ['apple', 'pear', 'run the gamut']);
});

test('pasted as one line, the list splits at every comma and semicolon', () => {
  assert.deepEqual(parseWordList('apple, a blessing in disguise; pear'), ['apple', 'a blessing in disguise', 'pear']);
});

test('separators and blank lines alone make no entries', () => {
  assert.deepEqual(parseWordList(' , ;\n\n  \n'), []);
});
