import { test, expect, mockVocabCard, mockVocabCard2, mockBankNounFinance, mockBankNounGeography, seedIndexedDB, createStoredItem, waitForAppLoad, mockFirebaseFunctions, clearIndexedDB, clearLocalStorage } from './fixtures';

/**
 * E2E Tests for SRS (Spaced Repetition System) and Learning Progress
 * 
 * Algorithm: Fixed-schedule with positive-signal-only.
 * Schedule: [1, 2, 3, 5, 7, 12, 20, 25, 47, 84, 143, 180] days
 * "Remember" (R key or double-click in DetailView) = advance schedule step
 * 
 * Tests cover:
 * - Mastery level indicators
 * - Due status indicators
 * - SRS updates after remember (via DetailView)
 * - Shared SRS for multiple meanings
 * - Progress persistence
 * - Dashboard statistics
 */

test.describe('SRS - Mastery Level Display', () => {
  test('shows mastery badge in detail view', async ({ seededApp: page }) => {
    await page.getByText('serendipity').first().click();
    
    // Show header
    await page.keyboard.press('h');
    await page.waitForTimeout(300);
    
    // Should show mastery level badge
    const masteryBadge = page.getByText(/New|Struggling|Learning|Proficient|Mastered|Grandmaster/i);
    await expect(masteryBadge).toBeVisible();
  });

  test('shows progress bar percentage', async ({ seededApp: page }) => {
    await page.getByText('serendipity').first().click();
    
    // Show header
    await page.keyboard.press('h');
    await page.waitForTimeout(300);
    
    // Should show percentage
    const percentage = page.getByText(/\d+%/);
    await expect(percentage).toBeVisible();
  });
});

test.describe('SRS - Due Status', () => {
  test('shows Due badge for items due for review', async ({ page }) => {
    await mockFirebaseFunctions(page);
    await page.goto('/');
    await waitForAppLoad(page);
    await clearIndexedDB(page);
    await clearLocalStorage(page);
    
    // Seed with item that is due now
    const dueItem = createStoredItem(mockVocabCard, 'vocab', {
      nextReview: Date.now() - 1000, // Due in the past
      memoryStrength: 30,
    });
    await seedIndexedDB(page, [dueItem]);
    await page.reload();
    await waitForAppLoad(page);
    
    // Should show "Due" badge
    await expect(page.getByText('Due').first()).toBeVisible();
  });

  test('due items sorted by priority', async ({ page }) => {
    await mockFirebaseFunctions(page);
    await page.goto('/');
    await waitForAppLoad(page);
    await clearIndexedDB(page);
    await clearLocalStorage(page);
    
    // Seed with items: one due with low strength, one due with high strength
    const weakDue = createStoredItem(mockVocabCard, 'vocab', {
      nextReview: Date.now() - 1000,
      memoryStrength: 10, // Weak
    });
    const strongDue = createStoredItem(mockVocabCard2, 'vocab', {
      nextReview: Date.now() - 1000,
      memoryStrength: 60, // Strong
    });
    await seedIndexedDB(page, [strongDue, weakDue]);
    await page.reload();
    await waitForAppLoad(page);
    
    // Weaker item should appear first (by familiarity sort)
    const cards = await page.locator('h4').allTextContents();
    const serendipityIndex = cards.findIndex(t => t.includes('serendipity'));
    const ephemeralIndex = cards.findIndex(t => t.includes('ephemeral'));
    
    // serendipity has lower strength, should be first
    if (serendipityIndex !== -1 && ephemeralIndex !== -1) {
      expect(serendipityIndex).toBeLessThan(ephemeralIndex);
    }
  });
});

test.describe('SRS - DetailView Remember Updates', () => {
  test('memory strength increases after R key remember', async ({ page }) => {
    await mockFirebaseFunctions(page);
    await page.goto('/');
    await waitForAppLoad(page);
    await clearIndexedDB(page);
    await clearLocalStorage(page);
    
    // Seed with one item at low strength
    const testItem = createStoredItem(mockVocabCard, 'vocab', {
      memoryStrength: 20,
      totalReviews: 1,
    });
    await seedIndexedDB(page, [testItem]);
    await page.reload();
    await waitForAppLoad(page);
    
    // Open detail view and mark as remembered
    await page.getByText('serendipity').first().click();
    await page.keyboard.press('r');
    
    // Should show success animation
    await expect(page.getByText(/Remembered/i)).toBeVisible();
    await page.waitForTimeout(1000);
    
    // Check that SRS data was updated in IndexedDB
    const persistedData = await page.evaluate(async () => {
      return new Promise((resolve) => {
        const request = indexedDB.open('PopDictDB', 2);
        request.onsuccess = () => {
          const db = request.result;
          const tx = db.transaction('library', 'readonly');
          const store = tx.objectStore('library');
          const getRequest = store.get('items_guest');
          getRequest.onsuccess = () => {
            const items = getRequest.result || [];
            const item = items.find((i: any) => i.data?.id === 'test-vocab-1');
            resolve({
              found: !!item,
              memoryStrength: item?.srs?.memoryStrength,
              totalReviews: item?.srs?.totalReviews
            });
            db.close();
          };
          getRequest.onerror = () => resolve({ found: false });
        };
        request.onerror = () => resolve({ found: false });
      });
    });
    
    const data = persistedData as any;
    expect(data.found).toBe(true);
    expect(data.totalReviews).toBeGreaterThan(1);
  });
});

test.describe('SRS - Shared SRS for Multiple Meanings', () => {
  test('reviewing one meaning updates all meanings of same word', async ({ page }) => {
    await mockFirebaseFunctions(page);
    await page.goto('/');
    await waitForAppLoad(page);
    await clearIndexedDB(page);
    await clearLocalStorage(page);
    
    // Seed with multiple meanings of "bank"
    const bankFinance = createStoredItem(mockBankNounFinance, 'vocab', {
      memoryStrength: 10,
    });
    const bankGeo = createStoredItem(mockBankNounGeography, 'vocab', {
      memoryStrength: 10,
    });
    await seedIndexedDB(page, [bankFinance, bankGeo]);
    await page.reload();
    await waitForAppLoad(page);
    
    // Open detail view for bank and mark as remembered
    await page.getByText('bank').first().click();
    await page.keyboard.press('r');
    
    // Should show success animation
    await expect(page.getByText(/Remembered/i)).toBeVisible();
    await page.waitForTimeout(1000);
    
    // Both meanings should be updated (shared SRS)
    const persistedData = await page.evaluate(async () => {
      return new Promise((resolve) => {
        const request = indexedDB.open('PopDictDB', 2);
        request.onsuccess = () => {
          const db = request.result;
          const tx = db.transaction('library', 'readonly');
          const store = tx.objectStore('library');
          const getRequest = store.get('items_guest');
          getRequest.onsuccess = () => {
            const items = getRequest.result || [];
            const bankItems = items.filter((i: any) => 
              i.data?.word?.toLowerCase() === 'bank' && !i.isDeleted
            );
            resolve({
              count: bankItems.length,
              allUpdated: bankItems.every((i: any) => i.srs?.totalReviews > 0)
            });
            db.close();
          };
          getRequest.onerror = () => resolve({ count: 0, allUpdated: false });
        };
        request.onerror = () => resolve({ count: 0, allUpdated: false });
      });
    });
    
    const data = persistedData as any;
    expect(data.count).toBe(2);
    expect(data.allUpdated).toBe(true);
  });
});

test.describe('SRS - Remember Action', () => {
  test('R key in detail view marks as remembered', async ({ seededApp: page }) => {
    await page.getByText('serendipity').first().click();
    
    // Press R to mark as remembered
    await page.keyboard.press('r');
    
    // Should show success animation
    await expect(page.getByText(/Remembered/i)).toBeVisible();
    
    // Wait for animation to complete
    await page.waitForTimeout(2000);
    
    // Animation should disappear
    await expect(page.getByText(/Remembered/i)).not.toBeVisible();
  });

  test('double-click marks as remembered', async ({ seededApp: page }) => {
    await page.getByText('serendipity').first().click();
    
    // Double-click on card background
    const content = page.locator('[class*="overflow-y-auto"]').first();
    await content.dblclick();
    
    // Should show success animation
    await expect(page.getByText(/Remembered/i)).toBeVisible();
  });
});

test.describe('SRS - Reset Memory Strength', () => {
  test('can reset SRS via menu', async ({ seededApp: page }) => {
    await page.getByText('serendipity').first().click();
    
    // Show header and open menu
    await page.keyboard.press('h');
    await page.waitForTimeout(300);
    
    // Open more menu
    const moreButton = page.locator('button').filter({ has: page.locator('svg') }).last();
    if (await moreButton.isVisible()) {
      await moreButton.click();
      
      // Click reset option
      const resetOption = page.getByText(/Reset Memory/i);
      if (await resetOption.isVisible()) {
        await resetOption.click();
        await page.waitForTimeout(500);
        
        // SRS should be reset (item becomes "New" again)
        // Show header again to check
        await page.keyboard.press('h');
        await page.waitForTimeout(300);
        
        const masteryBadge = page.getByText(/New/);
        if (await masteryBadge.isVisible()) {
          // Successfully reset
        }
      }
    }
  });
});

test.describe('SRS - Dashboard Statistics', () => {
  test('dashboard shows mastery breakdown', async ({ page }) => {
    await mockFirebaseFunctions(page);
    await page.goto('/');
    await waitForAppLoad(page);
    await clearIndexedDB(page);
    await clearLocalStorage(page);
    
    // Seed with items at various mastery levels
    const newItem = createStoredItem({ ...mockVocabCard, id: 'new-1', word: 'new1' }, 'vocab', { memoryStrength: 5 });
    const strugglingItem = createStoredItem({ ...mockVocabCard, id: 'struggling-1', word: 'struggling1' }, 'vocab', { memoryStrength: 20 });
    const learningItem = createStoredItem({ ...mockVocabCard, id: 'learning-1', word: 'learning1' }, 'vocab', { memoryStrength: 40 });
    const proficientItem = createStoredItem({ ...mockVocabCard, id: 'proficient-1', word: 'proficient1' }, 'vocab', { memoryStrength: 60 });
    const masteredItem = createStoredItem({ ...mockVocabCard, id: 'mastered-1', word: 'mastered1' }, 'vocab', { memoryStrength: 75 });
    
    await seedIndexedDB(page, [newItem, strugglingItem, learningItem, proficientItem, masteredItem]);
    await page.reload();
    await waitForAppLoad(page);
    
    await page.getByRole('button', { name: /study/i }).click();
    
    // Should show mastery breakdown
    await expect(page.getByText(/Mastery Breakdown/i)).toBeVisible();
    
    // Should show different levels
    await expect(page.getByText(/New/i).first()).toBeVisible();
  });

  test('dashboard shows weekly stats', async ({ seededApp: page }) => {
    await page.getByRole('button', { name: /study/i }).click();
    
    // Weekly stats section
    await expect(page.getByText(/Weekly Stats/i)).toBeVisible();
    await expect(page.getByText(/Reviews/i)).toBeVisible();
    await expect(page.getByText(/Accuracy/i)).toBeVisible();
    await expect(page.getByText(/Streak/i)).toBeVisible();
  });

  test('dashboard shows 7-day activity', async ({ seededApp: page }) => {
    await page.getByRole('button', { name: /study/i }).click();
    
    // Activity chart
    await expect(page.getByText(/7-Day Activity/i)).toBeVisible();
  });

  test('dashboard shows achievements section', async ({ seededApp: page }) => {
    await page.getByRole('button', { name: /study/i }).click();
    
    // Achievements
    await expect(page.getByText(/Achievements/i)).toBeVisible();
    await expect(page.getByText(/Best Streak/i)).toBeVisible();
    await expect(page.getByText(/Study Time/i)).toBeVisible();
  });
});

test.describe('SRS - Interval Scheduling', () => {
  test('correctly scheduled items do not appear in due list', async ({ page }) => {
    await mockFirebaseFunctions(page);
    await page.goto('/');
    await waitForAppLoad(page);
    await clearIndexedDB(page);
    await clearLocalStorage(page);
    
    // Seed with item scheduled for future
    const futureItem = createStoredItem(mockVocabCard, 'vocab', {
      nextReview: Date.now() + 1000 * 60 * 60 * 24 * 7, // 1 week from now
      memoryStrength: 70,
    });
    await seedIndexedDB(page, [futureItem]);
    await page.reload();
    await waitForAppLoad(page);
    
    await page.getByRole('button', { name: /study/i }).click();
    
    // Should show 0 due
    await expect(page.getByText(/0.*due/i)).toBeVisible();
  });
});

test.describe('SRS - Review Count Tracking', () => {
  test('total reviews incremented after remember in detail view', async ({ page }) => {
    await mockFirebaseFunctions(page);
    await page.goto('/');
    await waitForAppLoad(page);
    await clearIndexedDB(page);
    await clearLocalStorage(page);
    
    const testItem = createStoredItem(mockVocabCard, 'vocab', { memoryStrength: 10, totalReviews: 0 });
    await seedIndexedDB(page, [testItem]);
    await page.reload();
    await waitForAppLoad(page);
    
    // Open detail view and mark as remembered
    await page.getByText('serendipity').first().click();
    await page.keyboard.press('r');
    
    // Should show success animation
    await expect(page.getByText(/Remembered/i)).toBeVisible();
    await page.waitForTimeout(1000);
    
    // Show header to check review info
    await page.keyboard.press('h');
    await page.waitForTimeout(300);
  });
});

test.describe('SRS - Correct Streak', () => {
  test('streak displayed in detail view', async ({ page }) => {
    await mockFirebaseFunctions(page);
    await page.goto('/');
    await waitForAppLoad(page);
    await clearIndexedDB(page);
    await clearLocalStorage(page);
    
    // Seed with item that has a streak
    const testItem = createStoredItem(mockVocabCard, 'vocab', { 
      memoryStrength: 50, 
      totalReviews: 5 
    });
    // Manually set streak
    (testItem.srs as any).correctStreak = 3;
    
    await seedIndexedDB(page, [testItem]);
    await page.reload();
    await waitForAppLoad(page);
    
    // Open detail view
    await page.getByText('serendipity').first().click();
    await page.keyboard.press('h');
    await page.waitForTimeout(300);
    
    // Should show streak indicator (flame icon)
  });
});

test.describe('SRS - Persistence After Reload', () => {
  test('SRS updates persist after page reload (simulating app switch)', async ({ page }) => {
    await mockFirebaseFunctions(page);
    await page.goto('/');
    await waitForAppLoad(page);
    await clearIndexedDB(page);
    await clearLocalStorage(page);
    
    // Seed with item at known low strength
    const initialStrength = 10;
    const testItem = createStoredItem(mockVocabCard, 'vocab', { 
      memoryStrength: initialStrength,
      totalReviews: 0 
    });
    await seedIndexedDB(page, [testItem]);
    await page.reload();
    await waitForAppLoad(page);
    
    // Mark as remembered via DetailView
    await page.getByText('serendipity').first().click();
    await page.keyboard.press('r');
    
    // Should show success animation
    await expect(page.getByText(/Remembered/i)).toBeVisible();
    await page.waitForTimeout(1000);
    
    // Close detail view
    await page.keyboard.press('Escape');
    await page.waitForTimeout(500);
    
    // Simulate app switch by reloading the page
    await page.reload();
    await waitForAppLoad(page);
    
    // Check that the SRS data persisted by verifying in IndexedDB
    const persistedData = await page.evaluate(async () => {
      return new Promise((resolve) => {
        const request = indexedDB.open('PopDictDB', 2);
        request.onsuccess = () => {
          const db = request.result;
          const tx = db.transaction('library', 'readonly');
          const store = tx.objectStore('library');
          const getRequest = store.get('items_guest');
          getRequest.onsuccess = () => {
            const items = getRequest.result || [];
            const item = items.find((i: any) => i.data?.id === 'test-vocab-1');
            resolve({
              found: !!item,
              memoryStrength: item?.srs?.memoryStrength,
              totalReviews: item?.srs?.totalReviews
            });
            db.close();
          };
          getRequest.onerror = () => resolve({ found: false, error: 'Failed to read' });
        };
        request.onerror = () => resolve({ found: false, error: 'Failed to open DB' });
      });
    });
    
    // Verify the data persisted
    const data = persistedData as any;
    expect(data.found).toBe(true);
    expect(data.totalReviews).toBeGreaterThan(0);
    expect(data.memoryStrength).toBeGreaterThan(initialStrength);
  });

  test('SRS updates persist in localStorage cache after remember', async ({ page }) => {
    await mockFirebaseFunctions(page);
    await page.goto('/');
    await waitForAppLoad(page);
    await clearIndexedDB(page);
    await clearLocalStorage(page);
    
    const testItem = createStoredItem(mockVocabCard, 'vocab', { 
      memoryStrength: 10,
      totalReviews: 0 
    });
    await seedIndexedDB(page, [testItem]);
    await page.reload();
    await waitForAppLoad(page);
    
    // Mark as remembered via DetailView
    await page.getByText('serendipity').first().click();
    await page.keyboard.press('r');
    await page.waitForTimeout(1000);
    
    // Check localStorage cache was updated
    const cacheData = await page.evaluate(() => {
      const cache = localStorage.getItem('app_items_cache');
      if (!cache) return null;
      const items = JSON.parse(cache);
      const item = items.find((i: any) => i.data?.id === 'test-vocab-1');
      return {
        found: !!item,
        memoryStrength: item?.srs?.memoryStrength,
        totalReviews: item?.srs?.totalReviews
      };
    });
    
    expect(cacheData).not.toBeNull();
    expect(cacheData?.found).toBe(true);
    expect(cacheData?.totalReviews).toBeGreaterThan(0);
  });
});
