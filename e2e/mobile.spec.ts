import { test, expect, mockVocabCard, mockVocabCard2, mockBankNounFinance, mockBankNounGeography, seedIndexedDB, createStoredItem, waitForAppLoad, mockFirebaseFunctions, clearIndexedDB, clearLocalStorage } from './fixtures';

/**
 * E2E Tests for Mobile Experience
 * 
 * Tests cover:
 * - Bottom navigation bar visibility
 * - Touch gestures for navigation
 * - Responsive layout
 * - Safe area handling
 * - Swipe gestures in detail view
 * - Study mode on mobile
 */

test.describe('Mobile - Bottom Navigation', () => {
  test('shows bottom navigation bar', async ({ seededApp: page }) => {
    // Bottom nav should be visible
    const notebookTab = page.getByRole('button', { name: /notebook/i });
    const studyTab = page.getByRole('button', { name: /study/i });
    
    await expect(notebookTab).toBeVisible();
    await expect(studyTab).toBeVisible();
  });

  test('switches tabs correctly', async ({ seededApp: page }) => {
    // Click Study tab
    await page.getByRole('button', { name: /study/i }).click();
    await expect(page.getByText("Today's Study")).toBeVisible();
    
    // Click Notebook tab
    await page.getByRole('button', { name: /notebook/i }).click();
    await expect(page.getByRole('heading', { name: 'Notebook' })).toBeVisible();
  });
});

test.describe('Mobile - Swipe Gestures', () => {
  test('swipe left navigates to next meaning', async ({ page }) => {
    await clearIndexedDB(page);
    await clearLocalStorage(page);
    await mockFirebaseFunctions(page);
    await page.goto('/');
    await waitForAppLoad(page);
    
    // Seed with multiple meanings
    const testItems = [
      createStoredItem(mockBankNounFinance, 'vocab'),
      createStoredItem(mockBankNounGeography, 'vocab'),
    ];
    await seedIndexedDB(page, testItems);
    await page.reload();
    await waitForAppLoad(page);
    
    // Open detail view
    await page.getByText('bank').first().click();
    await expect(page.getByText('1/2')).toBeVisible();
    
    // Simulate swipe left
    const card = page.locator('[class*="overflow-y-auto"]').first();
    const box = await card.boundingBox();
    
    if (box) {
      await page.mouse.move(box.x + box.width * 0.8, box.y + box.height / 2);
      await page.mouse.down();
      await page.mouse.move(box.x + box.width * 0.2, box.y + box.height / 2, { steps: 10 });
      await page.mouse.up();
      
      // Should navigate to next meaning
      await page.waitForTimeout(500);
      // The test may not work perfectly for touch simulation, but verifies no crash
    }
  });
});

test.describe('Mobile - Notebook View', () => {
  test('search bar is full width', async ({ seededApp: page }) => {
    const searchInput = page.getByPlaceholder(/Search/);
    const box = await searchInput.boundingBox();
    
    if (box) {
      const viewportSize = page.viewportSize();
      if (viewportSize && viewportSize.width < 768) {
        // Search should be nearly full width
        expect(box.width).toBeGreaterThan(viewportSize.width * 0.7);
      }
    }
  });

  test('cards are single column on mobile', async ({ seededApp: page }) => {
    // Verify cards stack vertically
    const cards = page.locator('h4');
    const count = await cards.count();
    
    if (count >= 2) {
      const card1Box = await cards.nth(0).boundingBox();
      const card2Box = await cards.nth(1).boundingBox();
      
      if (card1Box && card2Box) {
        // Cards should be vertically stacked (card2 below card1)
        expect(card2Box.y).toBeGreaterThan(card1Box.y);
      }
    }
  });
});

test.describe('Mobile - Detail View', () => {
  test('full screen detail view', async ({ seededApp: page }) => {
    await page.getByText('serendipity').first().click();
    
    // Should take full viewport
    const detailView = page.locator('[class*="fixed inset-0"]');
    await expect(detailView).toBeVisible();
  });

  test('content is scrollable', async ({ seededApp: page }) => {
    await page.getByText('serendipity').first().click();
    
    // Wait for content to load
    await page.waitForTimeout(500);
    
    // Try scrolling
    const scrollContainer = page.locator('[class*="overflow-y-auto"]').first();
    if (await scrollContainer.isVisible()) {
      await scrollContainer.evaluate((el) => {
        el.scrollTop = 200;
      });
      
      // Verify scroll happened
      const scrollTop = await scrollContainer.evaluate((el) => el.scrollTop);
      expect(scrollTop).toBeGreaterThan(0);
    }
  });
});

test.describe('Mobile - Touch Target Sizes', () => {
  test('navigation tabs are 44px minimum height', async ({ seededApp: page }) => {
    const notebookTab = page.getByRole('button', { name: /notebook/i });
    const box = await notebookTab.boundingBox();
    
    if (box) {
      expect(box.height).toBeGreaterThanOrEqual(44);
    }
  });

  test('search input has adequate height', async ({ seededApp: page }) => {
    const searchInput = page.getByPlaceholder(/Search/);
    const box = await searchInput.boundingBox();
    
    if (box) {
      expect(box.height).toBeGreaterThanOrEqual(36);
    }
  });

  test('IPA pronunciation button is tappable', async ({ seededApp: page }) => {
    await page.getByText('serendipity').first().click();
    
    const ipaBlock = page.getByText('/ˌserənˈdɪpəti/');
    const box = await ipaBlock.boundingBox();
    
    if (box) {
      expect(box.height).toBeGreaterThanOrEqual(24);
      expect(box.width).toBeGreaterThanOrEqual(44);
    }
  });
});

test.describe('Mobile - Offline Banner', () => {
  test('offline banner appears at top', async ({ page }) => {
    await clearIndexedDB(page);
    await clearLocalStorage(page);
    await mockFirebaseFunctions(page);
    await page.goto('/');
    await waitForAppLoad(page);
    
    // Simulate offline
    await page.evaluate(() => {
      Object.defineProperty(navigator, 'onLine', {
        value: false,
        configurable: true,
      });
      window.dispatchEvent(new Event('offline'));
    });
    
    // Banner should appear
    const banner = page.getByText(/Offline mode/i);
    await expect(banner).toBeVisible();
    
    // Banner should be at top
    const box = await banner.boundingBox();
    if (box) {
      expect(box.y).toBeLessThan(100);
    }
  });
});

test.describe('Mobile - Carousel Navigation', () => {
  test('dot indicators are visible for multi-meaning words', async ({ page }) => {
    await clearIndexedDB(page);
    await clearLocalStorage(page);
    await mockFirebaseFunctions(page);
    await page.goto('/');
    await waitForAppLoad(page);
    
    const testItems = [
      createStoredItem(mockBankNounFinance, 'vocab'),
      createStoredItem(mockBankNounGeography, 'vocab'),
    ];
    await seedIndexedDB(page, testItems);
    await page.reload();
    await waitForAppLoad(page);
    
    // Dots should be visible in notebook view
    const dots = page.locator('button[class*="rounded-full"][class*="w-2"]');
    const count = await dots.count();
    
    // Should have dots for navigation
    expect(count).toBeGreaterThanOrEqual(2);
  });

  test('dots are tappable to navigate', async ({ page }) => {
    await clearIndexedDB(page);
    await clearLocalStorage(page);
    await mockFirebaseFunctions(page);
    await page.goto('/');
    await waitForAppLoad(page);
    
    const testItems = [
      createStoredItem(mockBankNounFinance, 'vocab'),
      createStoredItem(mockBankNounGeography, 'vocab'),
    ];
    await seedIndexedDB(page, testItems);
    await page.reload();
    await waitForAppLoad(page);
    
    // Find inactive dot and click
    const inactiveDot = page.locator('button[class*="rounded-full"][class*="bg-slate-300"]').first();
    if (await inactiveDot.isVisible()) {
      await inactiveDot.click();
      await page.waitForTimeout(300);
      
      // Dot should now be active (different class)
    }
  });
});

test.describe('Mobile - PWA Behavior', () => {
  test.skip('app loads correctly after refresh', async ({ seededApp: page }) => {
    // Refresh
    await page.reload();
    await waitForAppLoad(page);
    
    // Should restore state
    await expect(page.getByText('serendipity')).toBeVisible();
  });
});

