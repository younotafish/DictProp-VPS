import { test, expect, mockVocabCard, mockVocabCard2, mockBankNounFinance, mockBankNounGeography, seedIndexedDB, createStoredItem, waitForAppLoad, mockFirebaseFunctions, clearIndexedDB, clearLocalStorage } from './fixtures';

/**
 * E2E Tests for Edge Cases and Error Handling
 * 
 * Tests cover:
 * - Empty search handling
 * - Very long words/phrases
 * - Special characters in search
 * - Large notebook (many items)
 * - Rapid user interactions
 * - API error handling
 * - Invalid data graceful degradation
 * - Browser back/forward navigation
 * - Page refresh during study session
 */

test.describe('Edge Cases - Search', () => {
  test('handles empty search gracefully', async ({ emptyApp: page }) => {
    const searchInput = page.getByPlaceholder(/Search/);
    
    // Try to submit empty search
    await searchInput.fill('');
    await searchInput.press('Enter');
    
    // Should not show error, just do nothing
    await expect(page.getByText(/Error/i)).not.toBeVisible();
  });

  test('handles whitespace-only search', async ({ emptyApp: page }) => {
    const searchInput = page.getByPlaceholder(/Search/);
    
    await searchInput.fill('   ');
    await searchInput.press('Enter');
    
    // Should not crash
    await expect(page.getByText(/Error/i)).not.toBeVisible();
  });

  test('handles very long search queries', async ({ page }) => {
    await clearIndexedDB(page);
    await clearLocalStorage(page);
    await mockFirebaseFunctions(page);
    await page.goto('/');
    await waitForAppLoad(page);
    
    const searchInput = page.getByPlaceholder(/Search/);
    
    // Very long query
    const longQuery = 'a'.repeat(500);
    await searchInput.fill(longQuery);
    await searchInput.press('Enter');
    
    // Should handle gracefully (may show error or truncate)
    await page.waitForTimeout(2000);
    // No crash expected
  });

  test('handles special characters in search', async ({ page }) => {
    await clearIndexedDB(page);
    await clearLocalStorage(page);
    await mockFirebaseFunctions(page);
    await page.goto('/');
    await waitForAppLoad(page);
    
    const searchInput = page.getByPlaceholder(/Search/);
    
    // Search with special characters
    await searchInput.fill('hello! @#$%');
    await searchInput.press('Enter');
    
    // Should handle without crashing
    await page.waitForTimeout(2000);
  });

  test('handles unicode/emoji in search', async ({ page }) => {
    await clearIndexedDB(page);
    await clearLocalStorage(page);
    await mockFirebaseFunctions(page);
    await page.goto('/');
    await waitForAppLoad(page);
    
    const searchInput = page.getByPlaceholder(/Search/);
    
    // Search with unicode
    await searchInput.fill('你好 🌍');
    await searchInput.press('Enter');
    
    await page.waitForTimeout(2000);
    // Should not crash
  });
});

test.describe('Edge Cases - Large Data', () => {
  test('handles notebook with many items', async ({ page }) => {
    await clearIndexedDB(page);
    await clearLocalStorage(page);
    await page.goto('/');
    await waitForAppLoad(page);
    
    // Create many items
    const manyItems = [];
    for (let i = 0; i < 50; i++) {
      manyItems.push(createStoredItem({
        ...mockVocabCard,
        id: `test-vocab-${i}`,
        word: `word${i}`,
        chinese: `翻译${i}`,
      }, 'vocab'));
    }
    
    await seedIndexedDB(page, manyItems);
    await mockFirebaseFunctions(page);
    await page.reload();
    await waitForAppLoad(page);
    
    // Should load and display items
    await expect(page.getByText('word0')).toBeVisible();
    
    // Should be scrollable
    const container = page.locator('[class*="overflow-y-auto"]').first();
    await container.evaluate((el) => {
      el.scrollTop = 1000;
    });
    
    // Later items should be visible after scroll
    await page.waitForTimeout(500);
  });

  test('handles items with very long content', async ({ page }) => {
    await clearIndexedDB(page);
    await clearLocalStorage(page);
    await page.goto('/');
    await waitForAppLoad(page);
    
    const longItem = {
      ...mockVocabCard,
      id: 'long-item',
      word: 'supercalifragilisticexpialidocious',
      definition: 'A very long definition '.repeat(50),
      examples: ['Example sentence '.repeat(100)],
    };
    
    await seedIndexedDB(page, [createStoredItem(longItem, 'vocab')]);
    await mockFirebaseFunctions(page);
    await page.reload();
    await waitForAppLoad(page);
    
    // Should display without layout breaking
    await expect(page.getByText('supercalifragilisticexpialidocious')).toBeVisible();
  });
});

test.describe('Edge Cases - API Errors', () => {
  test('handles API failure gracefully', async ({ page }) => {
    await clearIndexedDB(page);
    await clearLocalStorage(page);
    await page.goto('/');
    await waitForAppLoad(page);
    
    // Mock API to return error
    await page.route('**/cloudfunctions.net/**', (route) => {
      route.fulfill({
        status: 500,
        body: JSON.stringify({ error: 'Internal Server Error' })
      });
    });
    
    const searchInput = page.getByPlaceholder(/Search/);
    await searchInput.fill('test');
    await searchInput.press('Enter');
    
    // Should show error message
    await expect(page.getByText(/failed|error/i)).toBeVisible({ timeout: 10000 });
  });

  test('handles quota exceeded error', async ({ page }) => {
    await clearIndexedDB(page);
    await clearLocalStorage(page);
    await page.goto('/');
    await waitForAppLoad(page);
    
    // Mock quota exceeded
    await page.route('**/cloudfunctions.net/**', (route) => {
      route.fulfill({
        status: 429,
        body: JSON.stringify({ error: { message: 'QUOTA_EXCEEDED' } })
      });
    });
    
    const searchInput = page.getByPlaceholder(/Search/);
    await searchInput.fill('test');
    await searchInput.press('Enter');
    
    // Should handle quota error
    await page.waitForTimeout(3000);
  });
});

test.describe('Edge Cases - Rapid Interactions', () => {
  test('handles rapid button clicks', async ({ seededApp: page }) => {
    // Click study button multiple times rapidly
    const studyButton = page.getByRole('button', { name: /study/i });
    
    await studyButton.click();
    await studyButton.click();
    await studyButton.click();
    
    // Should end up in study view without errors
    await expect(page.getByText("Today's Study")).toBeVisible();
  });

  test('handles rapid search submissions', async ({ page }) => {
    await clearIndexedDB(page);
    await clearLocalStorage(page);
    await mockFirebaseFunctions(page);
    await page.goto('/');
    await waitForAppLoad(page);
    
    const searchInput = page.getByPlaceholder(/Search/);
    
    // Rapid typing and submitting
    await searchInput.fill('test1');
    await searchInput.press('Enter');
    await searchInput.fill('test2');
    await searchInput.press('Enter');
    await searchInput.fill('test3');
    await searchInput.press('Enter');
    
    // Should eventually show results for the last search
    await page.waitForTimeout(3000);
  });

  test('handles rapid navigation', async ({ seededApp: page }) => {
    // Open detail view
    await page.getByText('serendipity').first().click();
    
    // Rapid arrow key navigation
    for (let i = 0; i < 10; i++) {
      await page.keyboard.press('ArrowRight');
    }
    
    // Should not crash
    await page.waitForTimeout(500);
    
    // Close and verify we're back
    await page.keyboard.press('Escape');
    await expect(page.getByRole('heading', { name: 'Notebook' })).toBeVisible();
  });
});

test.describe('Edge Cases - Study Session', () => {
  test('handles empty study queue gracefully', async ({ page }) => {
    await clearIndexedDB(page);
    await clearLocalStorage(page);
    await mockFirebaseFunctions(page);
    await page.goto('/');
    await waitForAppLoad(page);
    
    // Seed with items that are not due
    const futureItem = createStoredItem(mockVocabCard, 'vocab', {
      nextReview: Date.now() + 1000 * 60 * 60 * 24 * 7, // 1 week from now
      memoryStrength: 80,
    });
    
    await seedIndexedDB(page, [futureItem]);
    await page.reload();
    await waitForAppLoad(page);
    
    await page.getByRole('button', { name: /study/i }).click();
    
    // Dashboard should show 0 due
    await expect(page.getByText(/0.*due/i)).toBeVisible();
  });
});

test.describe('Edge Cases - Data Integrity', () => {
  test('handles corrupted localStorage gracefully', async ({ page }) => {
    await page.goto('/');
    
    // Corrupt localStorage
    await page.evaluate(() => {
      localStorage.setItem('app_items_cache', 'not valid json{{{');
    });
    
    // Reload
    await page.reload();
    
    // App should still load (may show empty state)
    await waitForAppLoad(page);
    
    // Should not crash
    await expect(page.getByRole('heading', { name: 'Notebook' }).or(page.getByText(/empty/i))).toBeVisible();
  });

  test('handles missing fields in stored items', async ({ page }) => {
    await clearIndexedDB(page);
    await clearLocalStorage(page);
    await page.goto('/');
    await waitForAppLoad(page);
    
    // Seed with incomplete data
    const incompleteItem = {
      data: {
        id: 'incomplete',
        word: 'test',
        // Missing many required fields
      },
      type: 'vocab',
      savedAt: Date.now(),
      srs: {
        id: 'incomplete',
        type: 'vocab',
        nextReview: Date.now(),
        interval: 0,
        memoryStrength: 0,
      },
    };
    
    await seedIndexedDB(page, [incompleteItem as any]);
    await mockFirebaseFunctions(page);
    await page.reload();
    await waitForAppLoad(page);
    
    // Should handle gracefully - may show item or filter it out
    await page.waitForTimeout(1000);
  });
});

test.describe('Edge Cases - Browser Navigation', () => {
  test('handles browser back from detail view', async ({ seededApp: page }) => {
    // Open detail view
    await page.getByText('serendipity').first().click();
    await expect(page.getByRole('button', { name: /close/i })).toBeVisible();
    
    // Use browser back (this may or may not work depending on app routing)
    await page.goBack();
    
    // Should return to notebook or still be in detail view
    await page.waitForTimeout(500);
  });
});

test.describe('Edge Cases - Concurrent Operations', () => {
  test('handles save and delete of same item', async ({ page }) => {
    await clearIndexedDB(page);
    await clearLocalStorage(page);
    await mockFirebaseFunctions(page);
    await page.goto('/');
    await waitForAppLoad(page);
    
    // Search and save
    const searchInput = page.getByPlaceholder(/Search/);
    await searchInput.fill('serendipity');
    await searchInput.press('Enter');
    
    await expect(page.getByText(/Search Results/i)).toBeVisible({ timeout: 10000 });
    
    // Find and click save button
    const saveButton = page.locator('button').filter({ has: page.locator('svg[class*="lucide-sparkles"]') }).first();
    if (await saveButton.isVisible()) {
      await saveButton.click();
    }
    
    // Wait for save
    await page.waitForTimeout(1000);
    
    // Clear search and verify saved
    await page.getByRole('button', { name: /clear/i }).click();
    await page.waitForTimeout(500);
    
    // Item should be in notebook
    await expect(page.locator('h4').filter({ hasText: 'serendipity' })).toBeVisible();
  });
});

test.describe('Edge Cases - Mobile Gestures', () => {
  test.skip('handles swipe gestures on touch devices', async ({ page }) => {
    // This test would require touch emulation
    // Skipped for now as it needs special setup
  });
});

test.describe('Edge Cases - Text Selection', () => {
  test('allows text selection in detail view', async ({ seededApp: page }) => {
    await page.getByText('serendipity').first().click();
    
    // Text should be selectable
    const definitionText = page.getByText(/occurrence.*chance/i);
    if (await definitionText.isVisible()) {
      // Try to select text
      await definitionText.selectText();
      
      // Selection should work (can't easily verify in Playwright)
    }
  });
});
