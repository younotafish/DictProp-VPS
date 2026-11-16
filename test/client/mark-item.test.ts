import assert from 'node:assert/strict';
import test from 'node:test';
import { ESSAYS } from '../../services/essayCatalog.ts';
import { REAL_LIFE_COLLECTIONS } from '../../services/realLifeCatalog.ts';
import { markItem, stripSentenceMarkers } from '../../services/sentenceMarkers.ts';

test('the focus is wrapped as the studied item where it first appears, in the text\'s own casing', () => {
  assert.equal(markItem('Let me circle back on that.', 'circle back'), 'Let me {{circle back}} on that.');
  assert.equal(markItem('Circle back tomorrow.', 'circle back'), '{{Circle back}} tomorrow.');
  assert.equal(markItem('I would PUSH BACK here.', 'push back'), 'I would {{PUSH BACK}} here.');
  assert.equal(markItem('Ping me, then ping her.', 'ping'), '{{Ping}} me, then ping her.', 'only the first of two');
});

test('a focus missing from the text leaves it as it is', () => {
  assert.equal(markItem('Nothing to see here.', 'touch base'), 'Nothing to see here.');
  assert.equal(markItem('', 'anything'), '');
});

test('every catalog line marks its focus once, and strips back to its own text', () => {
  const lines = [
    ...REAL_LIFE_COLLECTIONS.flatMap(collection => collection.sentences),
    ...ESSAYS.flatMap(essay => essay.sentences),
  ];
  assert.ok(lines.length > 1000);
  for (const line of lines) {
    assert.equal(line.markedText, markItem(line.text, line.focus), line.id);
    assert.equal(stripSentenceMarkers(line.markedText), line.text, line.id);
    const marked = line.markedText.match(/\{\{(.+?)\}\}/g) ?? [];
    assert.equal(marked.length, 1, line.id);
    assert.equal(marked[0].slice(2, -2).toLocaleLowerCase('en-US'), line.focus.toLocaleLowerCase('en-US'), line.id);
  }
});
