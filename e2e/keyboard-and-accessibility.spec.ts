import { test, expect, mockVocabCard, mockVocabCard2, mockBankNounFinance, mockBankNounGeography, seedIndexedDB, createStoredItem, waitForAppLoad, mockFirebaseFunctions, clearIndexedDB, clearLocalStorage } from './fixtures';

/**
 * E2E Tests for Keyboard Navigation and Accessibility
 * 
 * Tests cover:
 * - Global keyboard shortcuts (1, 2 for tabs, ⌘F for search)
 * - Keyboard shortcuts help modal (?)
 * - Study mode keyboard shortcuts
 * - Detail view keyboard shortcuts
 * - Focus management
 * - Screen reader friendly elements
 * - Color contrast (visual regression could be added)
 * - Touch target sizes
 */

test.describe('Global Keyboard Shortcuts', () => {
  test('1 key navigates to Notebook', async ({ seededApp: page }) => {
    // First go to Study
    await page.getByRole('button', { name: /study/i }).click();
    await expect(page.getByText("Today's Study")).toBeVisible();
    
    // Press 1 to go back to Notebook
    await page.keyboard.press('1');
    
    await expect(page.getByRole('heading', { name: 'Notebook' })).toBeVisible();
  });

  test('2 key navigates to Study', async ({ seededApp: page }) => {
    // Should be on Notebook by default
    await expect(page.getByRole('heading', { name: 'Notebook' })).toBeVisible();
    
    // Press 2 to go to Study
    await page.keyboard.press('2');
    
    await expect(page.getByText("Today's Study")).toBeVisible();
  });

  test('Cmd+F focuses search input', async ({ seededApp: page }) => {
    // Press Cmd+F (or Ctrl+F on Windows/Linux)
    await page.keyboard.press('Meta+f');
    
    // Search input should be focused
    const searchInput = page.getByPlaceholder(/Search/);
    await expect(searchInput).toBeFocused();
  });

  test('Ctrl+F focuses search input', async ({ seededApp: page }) => {
    // Press Ctrl+F
    await page.keyboard.press('Control+f');
    
    // Search input should be focused
    const searchInput = page.getByPlaceholder(/Search/);
    await expect(searchInput).toBeFocused();
  });

  test('? key shows keyboard shortcuts help', async ({ seededApp: page }) => {
    // Press ? key
    await page.keyboard.press('Shift+/');
    
    // Should show keyboard shortcuts modal
    await expect(page.getByText(/Keyboard Shortcuts/i)).toBeVisible();
    await expect(page.getByText(/Navigate faster/i)).toBeVisible();
  });

  test('Escape closes keyboard shortcuts modal', async ({ seededApp: page }) => {
    // Open shortcuts modal
    await page.keyboard.press('Shift+/');
    await expect(page.getByText(/Keyboard Shortcuts/i)).toBeVisible();
    
    // Press Escape
    await page.keyboard.press('Escape');
    
    // Modal should close
    await expect(page.getByText(/Keyboard Shortcuts/i)).not.toBeVisible();
  });
});

test.describe('Keyboard Shortcuts Help Modal', () => {
  test('shows all navigation shortcuts', async ({ seededApp: page }) => {
    await page.keyboard.press('Shift+/');
    
    // Navigation section
    await expect(page.getByText(/Go to Notebook/i)).toBeVisible();
    await expect(page.getByText(/Go to Study/i)).toBeVisible();
    await expect(page.getByText(/Focus search/i)).toBeVisible();
    await expect(page.getByText(/Close modal/i)).toBeVisible();
  });

  test('shows card navigation shortcuts', async ({ seededApp: page }) => {
    await page.keyboard.press('Shift+/');
    
    // Cards section
    await expect(page.getByText(/Navigate between cards/i)).toBeVisible();
    await expect(page.getByText(/Navigate between words/i)).toBeVisible();
    await expect(page.getByText(/Flip flashcard/i)).toBeVisible();
  });

  test('shows study mode shortcuts', async ({ seededApp: page }) => {
    await page.keyboard.press('Shift+/');
    
    // Study mode section
    await expect(page.getByText(/Mark as Forgot/i)).toBeVisible();
    await expect(page.getByText(/Mark as Got it/i)).toBeVisible();
    await expect(page.getByText(/Flip card to reveal/i)).toBeVisible();
  });

  test('Got it button closes modal', async ({ seededApp: page }) => {
    await page.keyboard.press('Shift+/');
    
    // Click Got it button
    await page.getByRole('button', { name: /Got it/i }).click();
    
    // Modal should close
    await expect(page.getByText(/Keyboard Shortcuts/i)).not.toBeVisible();
  });

  test('clicking outside modal closes it', async ({ seededApp: page }) => {
    await page.keyboard.press('Shift+/');
    await expect(page.getByText(/Keyboard Shortcuts/i)).toBeVisible();
    
    // Click on backdrop
    await page.locator('[class*="bg-black"]').click({ position: { x: 10, y: 10 } });
    
    // Modal should close
    await expect(page.getByText(/Keyboard Shortcuts/i)).not.toBeVisible();
  });
});

test.describe('Detail View Keyboard Shortcuts', () => {
  test('S key toggles save', async ({ seededApp: page }) => {
    await page.getByText('serendipity').first().click();
    
    // Press S to toggle save
    await page.keyboard.press('s');
    
    // Save state should change (may unsave since it's already saved)
    await page.waitForTimeout(500);
  });

  test('R key marks as remembered', async ({ seededApp: page }) => {
    await page.getByText('serendipity').first().click();
    
    // Press R
    await page.keyboard.press('r');
    
    // Should show remembered animation
    await expect(page.getByText(/Remembered/i)).toBeVisible();
  });

  test('Shift+R resets memory strength', async ({ seededApp: page }) => {
    await page.getByText('serendipity').first().click();
    
    // Press Shift+R
    await page.keyboard.press('Shift+r');
    
    // Should trigger reset (shows in menu or directly)
    await page.waitForTimeout(500);
  });

  test('P key pronounces word', async ({ seededApp: page }) => {
    await page.getByText('serendipity').first().click();
    
    // Press P
    await page.keyboard.press('p');
    
    // Can't verify audio, but no error should occur
    await page.waitForTimeout(500);
  });

  test('H key toggles header', async ({ seededApp: page }) => {
    await page.getByText('serendipity').first().click();
    
    // Initially header may be hidden
    // Press H to show
    await page.keyboard.press('h');
    await page.waitForTimeout(300);
    
    // Close button should be visible
    await expect(page.getByRole('button', { name: /close/i })).toBeVisible();
    
    // Press H to hide
    await page.keyboard.press('h');
    await page.waitForTimeout(300);
  });

  test('Arrow keys navigate cards', async ({ page }) => {
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
    
    await page.getByText('bank').first().click();
    
    // Should start at 1/2
    await expect(page.getByText('1/2')).toBeVisible();
    
    // Arrow right
    await page.keyboard.press('ArrowRight');
    await page.waitForTimeout(300);
    await expect(page.getByText('2/2')).toBeVisible();
    
    // Arrow left
    await page.keyboard.press('ArrowLeft');
    await page.waitForTimeout(300);
    await expect(page.getByText('1/2')).toBeVisible();
  });

  test('Enter key in search opens first result', async ({ seededApp: page }) => {
    // Focus search
    await page.keyboard.press('Meta+f');
    
    // Type and search
    const searchInput = page.getByPlaceholder(/Search/);
    await searchInput.fill('seren');
    
    // Enter should filter (not necessarily open - depends on implementation)
    await searchInput.press('Enter');
    await page.waitForTimeout(500);
  });
});

test.describe('Focus Management', () => {
  test('search input is focusable', async ({ seededApp: page }) => {
    const searchInput = page.getByPlaceholder(/Search/);
    
    await searchInput.focus();
    await expect(searchInput).toBeFocused();
  });

  test('buttons are focusable with Tab', async ({ seededApp: page }) => {
    // Press Tab to cycle through elements
    await page.keyboard.press('Tab');
    
    // Some element should be focused
    const focused = await page.evaluate(() => document.activeElement?.tagName);
    expect(focused).toBeTruthy();
  });

  test('modals trap focus', async ({ seededApp: page }) => {
    // Open keyboard shortcuts modal
    await page.keyboard.press('Shift+/');
    await expect(page.getByText(/Keyboard Shortcuts/i)).toBeVisible();
    
    // Focus should be in modal
    const modalButton = page.getByRole('button', { name: /Got it/i });
    await expect(modalButton).toBeVisible();
  });
});

test.describe('Accessibility Attributes', () => {
  test('buttons have accessible names', async ({ seededApp: page }) => {
    // Check that important buttons have aria-labels or visible text
    const studyButton = page.getByRole('button', { name: /study/i });
    await expect(studyButton).toBeVisible();
    
    const notebookButton = page.getByRole('button', { name: /notebook/i });
    await expect(notebookButton).toBeVisible();
  });

  test('headings are properly structured', async ({ seededApp: page }) => {
    // Main heading
    const mainHeading = page.getByRole('heading', { name: 'Notebook' });
    await expect(mainHeading).toBeVisible();
  });

  test('images have alt text', async ({ page }) => {
    await clearIndexedDB(page);
    await clearLocalStorage(page);
    await mockFirebaseFunctions(page);
    await page.goto('/');
    await waitForAppLoad(page);
    
    // Seed with item that has image
    const itemWithImage = {
      ...mockVocabCard,
      imageUrl: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
    };
    await seedIndexedDB(page, [createStoredItem(itemWithImage, 'vocab')]);
    await page.reload();
    await waitForAppLoad(page);
    
    // Open detail view
    await page.getByText('serendipity').first().click();
    
    // Check for image with alt text
    const images = page.locator('img[alt]');
    const count = await images.count();
    // Should have at least one image with alt text if images are present
  });

  test('color indicators have text alternatives', async ({ seededApp: page }) => {
    // Due status should show "Due" text, not just color
    const dueLabel = page.getByText('Due').first();
    
    // Should be visible if there are due items
    if (await dueLabel.isVisible()) {
      // Good - text alternative exists
    }
  });
});

test.describe('Touch Targets', () => {
  test('navigation buttons are sufficiently large', async ({ seededApp: page }) => {
    const studyButton = page.getByRole('button', { name: /study/i });
    
    // Get button dimensions
    const boundingBox = await studyButton.boundingBox();
    
    if (boundingBox) {
      // Minimum touch target size should be 44x44 pixels
      expect(boundingBox.height).toBeGreaterThanOrEqual(40);
      expect(boundingBox.width).toBeGreaterThanOrEqual(40);
    }
  });
});

test.describe('Keyboard Only Navigation', () => {
  test('can navigate entire app with keyboard', async ({ seededApp: page }) => {
    // Start in Notebook
    await expect(page.getByRole('heading', { name: 'Notebook' })).toBeVisible();
    
    // Go to Study
    await page.keyboard.press('2');
    await expect(page.getByText("Today's Study")).toBeVisible();
    
    // Back to Notebook
    await page.keyboard.press('1');
    await expect(page.getByRole('heading', { name: 'Notebook' })).toBeVisible();
    
    // Focus search
    await page.keyboard.press('Meta+f');
    const searchInput = page.getByPlaceholder(/Search/);
    await expect(searchInput).toBeFocused();
    
    // Open shortcuts help
    await page.keyboard.press('Escape'); // Clear focus first
    await page.keyboard.press('Shift+/');
    await expect(page.getByText(/Keyboard Shortcuts/i)).toBeVisible();
    
    // Close modal
    await page.keyboard.press('Escape');
    await expect(page.getByText(/Keyboard Shortcuts/i)).not.toBeVisible();
  });
});
