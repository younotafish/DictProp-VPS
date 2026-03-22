import { test, expect } from '@playwright/test';

test.describe('VPS Fork Smoke Tests', () => {
  test.beforeEach(async ({ context }) => {
    // Clear all browser storage to simulate fresh visit
    await context.clearCookies();
  });

  test('server health check', async ({ request }) => {
    const res = await request.get('http://localhost:3001/api/health');
    expect(res.ok()).toBeTruthy();
    const body = await res.json();
    expect(body.status).toBe('ok');
  });

  test('items CRUD via API', async ({ request }) => {
    const baseUrl = 'http://localhost:3001';

    // GET should return array (may or may not be empty depending on prior test state)
    const listRes = await request.get(`${baseUrl}/api/items`);
    expect(listRes.ok()).toBeTruthy();
    const items = await listRes.json();
    expect(Array.isArray(items)).toBeTruthy();

    // PUT single item
    const testItem = {
      type: 'vocab',
      data: {
        id: 'smoke-test-001',
        word: 'ephemeral',
        sense: 'adj: short-lived',
        chinese: '短暂的',
        ipa: '/ɪˈfɛmərəl/',
        definition: 'Lasting for a very short time.',
        forms: [],
        synonyms: ['fleeting', 'transient'],
        antonyms: ['permanent', 'enduring'],
        confusables: [],
        examples: ['The ephemeral beauty of cherry blossoms.'],
        history: 'From Greek ephemeros, lasting only a day.',
        register: 'formal',
        mnemonic: 'Sounds like "a femoral" — a femoral artery pumps briefly.',
        imagePrompt: 'cherry blossoms falling',
      },
      srs: {
        id: 'smoke-test-001',
        type: 'vocab',
        nextReview: 0,
        interval: 0,
        memoryStrength: 0,
        lastReviewDate: 0,
        totalReviews: 0,
        correctStreak: 0,
        stability: 0,
      },
      savedAt: Date.now(),
    };

    const putRes = await request.put(`${baseUrl}/api/items/smoke-test-001`, {
      data: testItem,
    });
    expect(putRes.ok()).toBeTruthy();

    // GET should now include our item
    const listRes2 = await request.get(`${baseUrl}/api/items`);
    const items2 = await listRes2.json();
    const found = items2.find((i: any) => i.data.id === 'smoke-test-001');
    expect(found).toBeTruthy();
    expect(found.data.word).toBe('ephemeral');

    // GET single item
    const getRes = await request.get(`${baseUrl}/api/items/smoke-test-001`);
    expect(getRes.ok()).toBeTruthy();
    const single = await getRes.json();
    expect(single.data.word).toBe('ephemeral');

    // DELETE
    const delRes = await request.delete(`${baseUrl}/api/items/smoke-test-001`);
    expect(delRes.ok()).toBeTruthy();

    // Verify soft-deleted
    const getAfterDel = await request.get(`${baseUrl}/api/items/smoke-test-001`);
    const deleted = await getAfterDel.json();
    expect(deleted.is_deleted || deleted.isDeleted).toBeTruthy();
  });

  test('batch upsert via API', async ({ request }) => {
    const baseUrl = 'http://localhost:3001';

    const items = [
      {
        type: 'vocab',
        data: { id: 'batch-1', word: 'ubiquitous', chinese: '无处不在的', ipa: '/juːˈbɪkwɪtəs/', definition: 'Present everywhere.', sense: 'adj', forms: [], synonyms: [], antonyms: [], confusables: [], examples: [], history: '', register: '', mnemonic: '', imagePrompt: '' },
        srs: { id: 'batch-1', type: 'vocab', nextReview: 0, interval: 0, memoryStrength: 0, lastReviewDate: 0, totalReviews: 0, correctStreak: 0, stability: 0 },
        savedAt: Date.now(),
      },
      {
        type: 'vocab',
        data: { id: 'batch-2', word: 'sanguine', chinese: '乐观的', ipa: '/ˈsæŋɡwɪn/', definition: 'Optimistic in difficult situations.', sense: 'adj', forms: [], synonyms: [], antonyms: [], confusables: [], examples: [], history: '', register: '', mnemonic: '', imagePrompt: '' },
        srs: { id: 'batch-2', type: 'vocab', nextReview: 0, interval: 0, memoryStrength: 0, lastReviewDate: 0, totalReviews: 0, correctStreak: 0, stability: 0 },
        savedAt: Date.now(),
      },
    ];

    const putRes = await request.put(`${baseUrl}/api/items`, { data: items });
    expect(putRes.ok()).toBeTruthy();
    const body = await putRes.json();
    expect(body.count).toBe(2);

    // Cleanup
    await request.delete(`${baseUrl}/api/items/batch-1`);
    await request.delete(`${baseUrl}/api/items/batch-2`);
  });

  test('frontend loads without auth UI', async ({ page }) => {
    // Clear IndexedDB + localStorage to simulate fresh browser
    await page.goto('http://localhost:3000');
    await page.evaluate(() => {
      localStorage.clear();
      const dbs = indexedDB.databases ? indexedDB.databases() : Promise.resolve([]);
      return dbs;
    });

    // Reload after clearing storage
    await page.goto('http://localhost:3000');
    await page.waitForLoadState('networkidle');

    // Should NOT have Google sign-in button
    const googleButton = page.locator('text=Sign In');
    await expect(googleButton).toHaveCount(0);

    // Should NOT have AuthDomainErrorModal
    const authModal = page.locator('text=unauthorized domain');
    await expect(authModal).toHaveCount(0);

    // Should show the empty state with search input
    const searchInput = page.locator('input[placeholder*="Search"]');
    await expect(searchInput).toBeVisible({ timeout: 5000 });

    // Should have the notebook empty message
    await expect(page.locator('text=Your notebook is empty')).toBeVisible();
  });

  test('frontend syncs items from server', async ({ page, request }) => {
    const baseUrl = 'http://localhost:3001';

    // Pre-populate server with an item
    const testItem = {
      type: 'vocab',
      data: { id: 'sync-test-001', word: 'serendipity', chinese: '意外发现', ipa: '/ˌsɛrənˈdɪpɪti/', definition: 'The occurrence of happy events by chance.', sense: 'noun', forms: [], synonyms: [], antonyms: [], confusables: [], examples: [], history: '', register: '', mnemonic: '', imagePrompt: '' },
      srs: { id: 'sync-test-001', type: 'vocab', nextReview: 0, interval: 0, memoryStrength: 0, lastReviewDate: 0, totalReviews: 0, correctStreak: 0, stability: 0 },
      savedAt: Date.now(),
    };
    await request.put(`${baseUrl}/api/items/sync-test-001`, { data: testItem });

    // Load app with clean storage
    await page.goto('http://localhost:3000');
    await page.evaluate(() => localStorage.clear());
    await page.goto('http://localhost:3000');
    await page.waitForLoadState('networkidle');

    // Wait for the item to appear (synced from server)
    await expect(page.locator('text=serendipity')).toBeVisible({ timeout: 10000 });

    // Cleanup
    await request.delete(`${baseUrl}/api/items/sync-test-001`);
  });

  test('static files served by Hono', async ({ request }) => {
    // Hono should serve index.html
    const res = await request.get('http://localhost:3001/');
    expect(res.ok()).toBeTruthy();
    const html = await res.text();
    expect(html).toContain('<!DOCTYPE html>');
    expect(html).toContain('root');
  });

  test('API proxy works through Vite', async ({ request }) => {
    const res = await request.get('http://localhost:3000/api/health');
    expect(res.ok()).toBeTruthy();
    const body = await res.json();
    expect(body.status).toBe('ok');
  });
});
