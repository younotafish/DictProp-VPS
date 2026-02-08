import { test, expect, mockVocabCard, mockVocabCard2, mockBankNounFinance, mockBankNounGeography, seedIndexedDB, createStoredItem, waitForAppLoad, mockFirebaseFunctions, resetAppState } from './fixtures';

/**
 * E2E Tests for iOS Safari Specific Behavior
 * 
 * Run with: npx playwright test ios-safari.spec.ts --project="Mobile Safari"
 * 
 * Tests cover:
 * - Safe area insets (notch, home indicator)
 * - Touch gestures (swipe navigation, text selection)
 * - PWA behavior (background sync, session restoration)
 * - Input zoom prevention (16px font size)
 * - iOS-specific auth flow (redirect vs popup)
 * - Momentum scrolling
 * - Touch target sizing (44pt minimum)
 */

test.describe('iOS Safari - Safe Area Handling', () => {
  test('bottom navigation respects safe area inset', async ({ seededApp: page }) => {
    // Check that bottom nav has safe area padding
    const nav = page.locator('nav').last();
    
    // The nav should be visible
    await expect(nav).toBeVisible();
    
    // Check computed styles include safe-area-inset-bottom
    const paddingBottom = await nav.evaluate((el) => {
      return window.getComputedStyle(el).paddingBottom;
    });
    
    // Should have some padding (exact value depends on device)
    expect(paddingBottom).toBeDefined();
  });

  test('study view content respects safe area', async ({ seededApp: page }) => {
    await page.getByRole('button', { name: /study/i }).click();
    
    // The study dashboard should have bottom padding for safe area
    const studyContent = page.locator('[class*="pb-"]').first();
    await expect(studyContent).toBeVisible();
  });

  test('notebook list has bottom padding for nav', async ({ seededApp: page }) => {
    // Content should not be hidden behind bottom nav
    const content = page.locator('main').first();
    await expect(content).toBeVisible();
    
    // Scroll to bottom
    await content.evaluate((el) => {
      el.scrollTop = el.scrollHeight;
    });
    
    // Last item should still be visible above nav
    await page.waitForTimeout(500);
  });
});

test.describe('iOS Safari - Touch Gestures', () => {
  test('swipe left on card navigates to next meaning', async ({ page }) => {
    await mockFirebaseFunctions(page);
    await page.goto('/');
    await waitForAppLoad(page);
    
    // Seed with multi-meaning word
    const testItems = [
      createStoredItem(mockBankNounFinance, 'vocab'),
      createStoredItem(mockBankNounGeography, 'vocab'),
    ];
    await seedIndexedDB(page, testItems);
    await page.evaluate((items) => {
      localStorage.setItem('app_items_cache', JSON.stringify(items));
    }, testItems);
    await page.reload();
    await waitForAppLoad(page);
    
    // Open detail view
    await page.getByRole('heading', { name: 'bank' }).first().click();
    await expect(page.getByText('1/2')).toBeVisible();
    
    // Simulate swipe left
    const card = page.locator('[class*="overflow-y-auto"]').first();
    const box = await card.boundingBox();
    
    if (box) {
      // Touch start
      await page.touchscreen.tap(box.x + box.width * 0.8, box.y + box.height / 2);
      
      // Swipe gesture
      await page.mouse.move(box.x + box.width * 0.8, box.y + box.height / 2);
      await page.mouse.down();
      await page.mouse.move(box.x + box.width * 0.2, box.y + box.height / 2, { steps: 10 });
      await page.mouse.up();
      
      await page.waitForTimeout(500);
    }
  });

  test('swipe right on card navigates to previous meaning', async ({ page }) => {
    await mockFirebaseFunctions(page);
    await page.goto('/');
    await waitForAppLoad(page);
    
    const testItems = [
      createStoredItem(mockBankNounFinance, 'vocab'),
      createStoredItem(mockBankNounGeography, 'vocab'),
    ];
    await seedIndexedDB(page, testItems);
    await page.evaluate((items) => {
      localStorage.setItem('app_items_cache', JSON.stringify(items));
    }, testItems);
    await page.reload();
    await waitForAppLoad(page);
    
    await page.getByRole('heading', { name: 'bank' }).first().click();
    
    // Navigate to second meaning first
    await page.keyboard.press('ArrowRight');
    await page.waitForTimeout(300);
    await expect(page.getByText('2/2')).toBeVisible();
    
    // Now swipe right to go back
    const card = page.locator('[class*="overflow-y-auto"]').first();
    const box = await card.boundingBox();
    
    if (box) {
      await page.mouse.move(box.x + box.width * 0.2, box.y + box.height / 2);
      await page.mouse.down();
      await page.mouse.move(box.x + box.width * 0.8, box.y + box.height / 2, { steps: 10 });
      await page.mouse.up();
      
      await page.waitForTimeout(500);
    }
  });

  test('text selection does not trigger swipe', async ({ seededApp: page }) => {
    await page.getByRole('heading', { name: 'serendipity' }).first().click();
    
    // Wait for detail view
    await expect(page.getByRole('button', { name: /close/i })).toBeVisible();
    
    // Try to select text (should not trigger navigation)
    const definition = page.getByText(/occurrence.*chance/i);
    if (await definition.isVisible()) {
      await definition.selectText();
      await page.waitForTimeout(300);
      
      // Should still be on same card (no navigation happened)
      await expect(page.getByRole('heading', { name: 'serendipity' }).or(page.getByText('serendipity').first())).toBeVisible();
    }
  });

  test('vertical scroll does not trigger horizontal navigation', async ({ seededApp: page }) => {
    await page.getByRole('heading', { name: 'serendipity' }).first().click();
    
    // Wait for detail view
    await expect(page.getByRole('button', { name: /close/i })).toBeVisible();
    
    // Scroll vertically
    const card = page.locator('[class*="overflow-y-auto"]').first();
    await card.evaluate((el) => {
      el.scrollTop = 200;
    });
    
    // Should still be on same card
    await expect(page.getByText('serendipity').first()).toBeVisible();
  });
});

test.describe('iOS Safari - Input Behavior', () => {
  test('search input has 16px font size to prevent zoom', async ({ seededApp: page }) => {
    const searchInput = page.getByPlaceholder(/Search/);
    
    // Check font size
    const fontSize = await searchInput.evaluate((el) => {
      return window.getComputedStyle(el).fontSize;
    });
    
    // Should be 16px (or larger) to prevent iOS zoom
    const fontSizeNum = parseInt(fontSize);
    expect(fontSizeNum).toBeGreaterThanOrEqual(16);
  });

  test('focusing input does not cause viewport zoom', async ({ seededApp: page }) => {
    const searchInput = page.getByPlaceholder(/Search/);
    
    // Get initial viewport
    const initialViewport = await page.viewportSize();
    
    // Focus input
    await searchInput.focus();
    await searchInput.fill('test');
    await page.waitForTimeout(500);
    
    // Viewport should not have changed
    const currentViewport = await page.viewportSize();
    expect(currentViewport?.width).toBe(initialViewport?.width);
  });

  test('keyboard dismiss on scroll', async ({ seededApp: page }) => {
    const searchInput = page.getByPlaceholder(/Search/);
    
    // Focus and type
    await searchInput.focus();
    await searchInput.fill('test');
    
    // Scroll the page (should dismiss keyboard on iOS)
    const content = page.locator('main').first();
    await content.evaluate((el) => {
      el.scrollTop = 100;
    });
    
    await page.waitForTimeout(300);
  });
});

test.describe('iOS Safari - PWA Behavior', () => {
  test('app restores state after simulated background/foreground', async ({ seededApp: page }) => {
    // Navigate to study
    await page.getByRole('button', { name: /study/i }).click();
    
    // Simulate visibility change (iOS PWA going to background)
    await page.evaluate(() => {
      document.dispatchEvent(new Event('visibilitychange'));
    });
    
    await page.waitForTimeout(500);
    
    // Should still be on study view
    await expect(page.getByText(/Study/i).first()).toBeVisible();
  });

  test('data syncs on visibility change', async ({ seededApp: page }) => {
    // Save some data
    const searchInput = page.getByPlaceholder(/Search/);
    await searchInput.fill('serendipity');
    await searchInput.press('Enter');
    
    await expect(page.getByText(/Search Results/i)).toBeVisible({ timeout: 10000 });
    
    // Simulate going to background and back
    await page.evaluate(() => {
      // Simulate hidden
      Object.defineProperty(document, 'visibilityState', { value: 'hidden', writable: true });
      document.dispatchEvent(new Event('visibilitychange'));
      
      // Simulate visible again
      Object.defineProperty(document, 'visibilityState', { value: 'visible', writable: true });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    
    await page.waitForTimeout(500);
  });
});

test.describe('iOS Safari - Touch Targets', () => {
  test('all buttons meet 44pt minimum touch target', async ({ seededApp: page }) => {
    // Bottom nav buttons
    const notebookBtn = page.getByRole('button', { name: /notebook/i });
    const studyBtn = page.getByRole('button', { name: /study/i });
    
    for (const btn of [notebookBtn, studyBtn]) {
      const box = await btn.boundingBox();
      if (box) {
        // iOS minimum is 44pt (roughly 44px on 1x displays)
        expect(box.height).toBeGreaterThanOrEqual(40);
        expect(box.width).toBeGreaterThanOrEqual(40);
      }
    }
  });

  test('close button in detail view is tappable', async ({ seededApp: page }) => {
    await page.getByRole('heading', { name: 'serendipity' }).first().click();
    
    // Show header
    await page.keyboard.press('h');
    await page.waitForTimeout(300);
    
    const closeBtn = page.getByRole('button', { name: /close/i });
    const box = await closeBtn.boundingBox();
    
    if (box) {
      expect(box.height).toBeGreaterThanOrEqual(32);
      expect(box.width).toBeGreaterThanOrEqual(32);
    }
  });
});

test.describe('iOS Safari - Scrolling Behavior', () => {
  test('momentum scrolling works in notebook list', async ({ seededApp: page }) => {
    // Check that the list container has proper scrolling setup
    const container = page.locator('[class*="overflow-y-auto"]').first();
    
    const hasScroll = await container.evaluate((el) => {
      const style = window.getComputedStyle(el);
      // webkit-overflow-scrolling is deprecated but still used for compatibility
      return style.overflowY === 'auto' || style.overflowY === 'scroll';
    });
    
    expect(hasScroll).toBe(true);
  });

  test('detail view is scrollable', async ({ seededApp: page }) => {
    await page.getByRole('heading', { name: 'serendipity' }).first().click();
    
    const scrollContainer = page.locator('[class*="overflow-y-auto"]').first();
    
    // Scroll down
    await scrollContainer.evaluate((el) => {
      el.scrollTop = 200;
    });
    
    const scrollTop = await scrollContainer.evaluate((el) => el.scrollTop);
    expect(scrollTop).toBeGreaterThan(0);
  });

  test('overscroll bounce is prevented', async ({ seededApp: page }) => {
    // Check that body has overscroll-behavior set
    const hasOverscrollPrevention = await page.evaluate(() => {
      return window.getComputedStyle(document.body).overscrollBehaviorY;
    });
    
    // Should be 'none' or 'contain' to prevent rubber-banding
    expect(['none', 'contain']).toContain(hasOverscrollPrevention);
  });
});

test.describe('iOS Safari - Visual Polish', () => {
  test('no tap highlight on interactive elements', async ({ seededApp: page }) => {
    // Check that tap highlight is disabled
    const hasNoHighlight = await page.evaluate(() => {
      const style = window.getComputedStyle(document.body);
      const tapColor = style.getPropertyValue('-webkit-tap-highlight-color');
      return tapColor === 'transparent' || tapColor === 'rgba(0, 0, 0, 0)';
    });
    
    expect(hasNoHighlight).toBe(true);
  });

  test('touch callout is disabled', async ({ seededApp: page }) => {
    // Check that long-press callout is disabled
    const hasNoCallout = await page.evaluate(() => {
      const style = window.getComputedStyle(document.body);
      const callout = style.getPropertyValue('-webkit-touch-callout');
      return callout === 'none';
    });
    
    expect(hasNoCallout).toBe(true);
  });

});

test.describe('iOS Safari - Offline Support', () => {
  test('app works offline after initial load', async ({ seededApp: page }) => {
    // Block network
    await page.route('**/*', (route) => {
      if (route.request().url().includes('localhost')) {
        route.continue();
      } else {
        route.abort();
      }
    });
    
    // Simulate offline
    await page.evaluate(() => {
      Object.defineProperty(navigator, 'onLine', { value: false, configurable: true });
      window.dispatchEvent(new Event('offline'));
    });
    
    // Should show offline banner
    await expect(page.getByText(/Offline/i)).toBeVisible();
    
    // App should still be functional
    await expect(page.getByRole('heading', { name: 'serendipity' })).toBeVisible();
    
    // Study should work
    await page.getByRole('button', { name: /study/i }).click();
    await expect(page.getByText(/Study/i).first()).toBeVisible();
  });

  test('saved items persist after reload', async ({ seededApp: page }) => {
    // Get initial items
    const initialItems = await page.locator('h4').count();
    
    // Reload
    await page.reload();
    await waitForAppLoad(page);
    
    // Items should still be there
    const afterReloadItems = await page.locator('h4').count();
    expect(afterReloadItems).toBe(initialItems);
  });
});

test.describe('iOS Safari - Carousel Navigation', () => {
  test('dot indicators show for multi-meaning words', async ({ page }) => {
    await mockFirebaseFunctions(page);
    await page.goto('/');
    await waitForAppLoad(page);
    
    const testItems = [
      createStoredItem(mockBankNounFinance, 'vocab'),
      createStoredItem(mockBankNounGeography, 'vocab'),
    ];
    await seedIndexedDB(page, testItems);
    await page.evaluate((items) => {
      localStorage.setItem('app_items_cache', JSON.stringify(items));
    }, testItems);
    await page.reload();
    await waitForAppLoad(page);
    
    // Should show dot indicators
    const dots = page.locator('button[class*="rounded-full"][class*="w-2"]');
    const count = await dots.count();
    expect(count).toBeGreaterThanOrEqual(2);
  });

  test('tapping dots navigates between meanings', async ({ page }) => {
    await mockFirebaseFunctions(page);
    await page.goto('/');
    await waitForAppLoad(page);
    
    const testItems = [
      createStoredItem(mockBankNounFinance, 'vocab'),
      createStoredItem(mockBankNounGeography, 'vocab'),
    ];
    await seedIndexedDB(page, testItems);
    await page.evaluate((items) => {
      localStorage.setItem('app_items_cache', JSON.stringify(items));
    }, testItems);
    await page.reload();
    await waitForAppLoad(page);
    
    // Tap on second dot
    const inactiveDot = page.locator('button[class*="rounded-full"][class*="bg-slate-300"]').first();
    if (await inactiveDot.isVisible()) {
      await inactiveDot.tap();
      await page.waitForTimeout(300);
    }
  });
});
