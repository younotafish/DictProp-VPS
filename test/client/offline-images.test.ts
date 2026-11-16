import assert from 'node:assert/strict';
import test from 'node:test';
import { IDBKeyRange, indexedDB } from 'fake-indexeddb';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { StoredItem, VocabCard } from '../../types.ts';

// hooks/useOfflineImages.ts, run once through a server render, over this device's picture store in fake-indexeddb.
// fetch serves every picture and records which ones were asked for.
Object.assign(globalThis, { indexedDB, IDBKeyRange });
const { useOfflineImages } = await import('../../hooks/useOfflineImages.ts');

const realFetch = globalThis.fetch;
test.after(() => { globalThis.fetch = realFetch; });

function servePictures(): string[] {
  const asked: string[] = [];
  globalThis.fetch = (async (url: string) => {
    const id = decodeURIComponent(url.split('/')[3]);
    asked.push(id);
    return new Response(new Blob([`picture ${id}`], { type: 'image/webp' }));
  }) as typeof fetch;
  return asked;
}

const card = (id: string, fields: Partial<StoredItem> = {}): StoredItem => ({
  type: 'vocab',
  data: {
    id, word: id, chinese: '', ipa: '', definition: '', synonyms: [], antonyms: [], confusables: [], examples: [],
    history: '', register: '', mnemonic: '', imageUrl: `server:has_image:${id}-v1`,
  } satisfies VocabCard,
  srs: {
    id, type: 'vocab', nextReview: 0, interval: 0, memoryStrength: 0, lastReviewDate: 0, totalReviews: 0,
    correctStreak: 0, stability: 0.5,
  },
  savedAt: 1,
  updatedAt: 1,
  ...fields,
});

function renderHook(items: StoredItem[]) {
  let hook: ReturnType<typeof useOfflineImages> | undefined;
  const Probe = () => {
    hook = useOfflineImages({ latestItemsRef: { current: items } });
    return null;
  };
  renderToStaticMarkup(createElement(Probe));
  return hook!;
}

test('the offline download fetches every card\'s picture, archived ones too, and never a deleted card\'s', async () => {
  const items = [card('pack-live'), card('pack-archived', { isArchived: true }), card('pack-deleted', { isDeleted: true })];
  const asked = servePictures();
  await renderHook(items).prefetchImages(items, 'all');
  assert.deepEqual(asked.sort(), ['pack-archived', 'pack-live']);
});

test('the quiet caching of study pictures leaves archived and deleted cards out', async () => {
  const items = [card('study-live'), card('study-archived', { isArchived: true }), card('study-deleted', { isDeleted: true })];
  const asked = servePictures();
  await renderHook(items).prefetchImages(items, 'priority');
  assert.deepEqual(asked, ['study-live']);
});
