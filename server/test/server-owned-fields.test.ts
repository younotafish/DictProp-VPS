import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

// The server keeps these fields when a write omits them, and the client keeps them when it merges a pull.
// Each side has its own copy of the list, and a field on only one side is lost on the other.
function serverOwnedFields(relativePath: string): string[] {
  const source = readFileSync(new URL(relativePath, import.meta.url), 'utf8');
  const list = source.match(/const SERVER_OWNED_FIELDS = \[([^\]]*)\]/);
  assert.ok(list, `${relativePath} no longer declares SERVER_OWNED_FIELDS`);
  return [...list[1].matchAll(/'([^']+)'|"([^"]+)"/g)].map(match => match[1] ?? match[2]);
}

test('the server and the client agree on which fields the server owns', () => {
  const server = serverOwnedFields('../src/db.ts');
  assert.ok(server.length > 0);
  assert.deepEqual(serverOwnedFields('../../services/sync.ts'), server);
});
