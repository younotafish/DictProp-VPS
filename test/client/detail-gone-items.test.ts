import assert from 'node:assert/strict';
import test from 'node:test';
import { automaticWrite } from '../../views/detail/goneItems.ts';

// An item deleted on another device, as the open card view meets it (views/detail/goneItems.ts): the writes the view
// makes on its own never bring it back.

test('a write the view makes on its own patches a live record, creates a catalog line\'s first record, and skips the rest', () => {
  assert.equal(automaticWrite({ live: true, catalogLine: false }), 'patch', 'a saved sentence');
  assert.equal(automaticWrite({ live: true, catalogLine: true }), 'patch', 'a catalog line with its record');
  assert.equal(automaticWrite({ live: false, catalogLine: true }), 'create', 'a catalog line\'s first listen');
  assert.equal(automaticWrite({ live: false, catalogLine: false }), 'skip', 'deleted on another device, or an unsaved example');
});
