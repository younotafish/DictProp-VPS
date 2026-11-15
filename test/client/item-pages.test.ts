import assert from 'node:assert/strict';
import test from 'node:test';
import { loadAllItems, loadItemChangesSince, type ItemChanges } from '../../services/api.ts';
import type { RevisionCursor, StoredItem } from '../../types.ts';

// The pager only needs fetch; each test serves pages keyed by the cursor they start after.
const realFetch = globalThis.fetch;
test.after(() => { globalThis.fetch = realFetch; });

const item = (id: string) => ({ type: 'vocab', data: { id } }) as unknown as StoredItem;
const at = (revision: number, id: string): RevisionCursor => ({ revision, id });

function servePages(pages: Record<string, ItemChanges>): URLSearchParams[] {
  const requests: URLSearchParams[] = [];
  globalThis.fetch = (async (url: string) => {
    const params = new URL(url, 'http://localhost').searchParams;
    requests.push(params);
    const page = pages[`${params.get('afterRevision')}:${params.get('afterId')}`];
    return page ? Response.json(page) : new Response('no such page', { status: 500 });
  }) as typeof fetch;
  return requests;
}

test('the pager follows pages of 500 until the server has no more', async () => {
  const requests = servePages({
    '0:': { items: [item('a'), item('b')], cursor: at(2, 'b'), hasMore: true, headRevision: 3 },
    '2:b': { items: [item('c')], cursor: at(3, 'c'), hasMore: false, headRevision: 3 },
  });
  const all = await loadAllItems();
  assert.deepEqual(all.items.map(entry => entry.data.id), ['a', 'b', 'c']);
  assert.deepEqual(all.cursor, at(3, 'c'));
  assert.deepEqual(requests.map(params => params.get('limit')), ['500', '500']);

  assert.deepEqual(await loadItemChangesSince(at(2, 'b')), { items: [item('c')], cursor: at(3, 'c'), serverBehind: false });
});

test('a server behind the cursor, on any page, means its database was replaced', async () => {
  servePages({ '7:x': { items: [], cursor: at(7, 'x'), hasMore: false, headRevision: 4 } });
  assert.deepEqual(await loadItemChangesSince(at(7, 'x')), { items: [], cursor: at(7, 'x'), serverBehind: true });

  servePages({
    '5:e': { items: [item('f')], cursor: at(6, 'f'), hasMore: true, headRevision: 9 },
    '6:f': { items: [item('g')], cursor: at(7, 'g'), hasMore: false, headRevision: 2 },
  });
  assert.deepEqual(await loadItemChangesSince(at(5, 'e')), { items: [], cursor: at(5, 'e'), serverBehind: true });

  // An older server sends no head revision, and is never taken to be behind.
  servePages({ '7:x': { items: [item('h')], cursor: at(8, 'h'), hasMore: false } });
  assert.equal((await loadItemChangesSince(at(7, 'x'))).serverBehind, false);
});

test('a page that promises more without moving the cursor on stops the pager', async () => {
  servePages({ '0:': { items: [item('a')], cursor: at(0, ''), hasMore: true } });
  await assert.rejects(loadAllItems(), /cursor did not advance/);
  servePages({
    '0:': { items: [item('a')], cursor: at(5, 'e'), hasMore: true },
    '5:e': { items: [item('b')], cursor: at(4, 'z'), hasMore: true },
  });
  await assert.rejects(loadAllItems(), /cursor did not advance/, 'a cursor that moved back');
});
