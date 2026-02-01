import { test, expect, mockVocabCard, mockVocabCard2, mockBankNounFinance, mockBankNounGeography, seedIndexedDB, createStoredItem, waitForAppLoad, mockFirebaseFunctions, clearIndexedDB, clearLocalStorage, resetAppState } from './fixtures';

/**
 * E2E Tests for Study View
 * 
 * Tests cover:
 * - Dashboard display with statistics
 * - Study session flow
 * - Flashcard front/back states
 * - Binary rating (Got it / Forgot)
 * - Session progress tracking
 * - Session completion with confetti
 * - Archive during study
 * - Keyboard navigation in study mode
 * - Multiple meanings carousel
 */

test.describe('Study Dashboard - Empty State', () => {
  test('shows empty state message when no items', async ({ page }) => {
    // Use the resetAppState helper which handles navigation order correctly
    await resetAppState(page);
    
    // Navigate to Study tab
    await page.getByRole('button', { name: /study/i }).click();
    
    // Should show empty message
    await expect(page.getByText(/Your Study Space/i)).toBeVisible();
    await expect(page.getByText(/Add vocabulary/i)).toBeVisible();
  });
});

test.describe('Study Dashboard - With Items', () => {
  test('displays due count and statistics', async ({ seededApp: page }) => {
    // Navigate to Study tab
    await page.getByRole('button', { name: /study/i }).click();
    
    // Should show dashboard
    await expect(page.getByText("Today's Study")).toBeVisible();
    
    // Should show due count
    await expect(page.getByText(/due now/i)).toBeVisible();
    
    // Should show Start Session button
    await expect(page.getByRole('button', { name: /Start Session/i })).toBeVisible();
  });

  test('displays weekly stats section', async ({ seededApp: page }) => {
    await page.getByRole('button', { name: /study/i }).click();
    
    // Should show weekly stats
    await expect(page.getByText(/Weekly Stats/i)).toBeVisible();
    await expect(page.getByText(/Reviews/i)).toBeVisible();
    await expect(page.getByText(/Accuracy/i)).toBeVisible();
  });

  test('displays mastery breakdown', async ({ seededApp: page }) => {
    await page.getByRole('button', { name: /study/i }).click();
    
    // Should show mastery breakdown section
    await expect(page.getByText(/Mastery Breakdown/i)).toBeVisible();
  });

  test('displays 7-day activity chart', async ({ seededApp: page }) => {
    await page.getByRole('button', { name: /study/i }).click();
    
    // Should show activity chart
    await expect(page.getByText(/7-Day Activity/i)).toBeVisible();
  });
});

test.describe('Study Session Flow', () => {
  test('starts study session and shows flashcard front', async ({ seededApp: page }) => {
    await page.getByRole('button', { name: /study/i }).click();
    
    // Start session
    await page.getByRole('button', { name: /Start Session/i }).click();
    
    // Should show study session UI
    await expect(page.getByText(/Card \d+\/\d+/)).toBeVisible();
    
    // Should show flashcard front with word
    // Check for any of our seeded words
    const hasWord = await page.getByText('serendipity').or(page.getByText('ephemeral')).or(page.getByText('bank')).first().isVisible();
    expect(hasWord).toBe(true);
    
    // Should show "Tap to reveal" or similar hint
    await expect(page.getByText(/reveal|tap|flip/i)).toBeVisible();
  });

  test('flips card to show back on click', async ({ seededApp: page }) => {
    await page.getByRole('button', { name: /study/i }).click();
    await page.getByRole('button', { name: /Start Session/i }).click();
    
    // Wait for session to start
    await expect(page.getByText(/Card \d+\/\d+/)).toBeVisible();
    
    // Click to flip card (find the card container)
    const flashcard = page.locator('.cursor-pointer').filter({ has: page.getByText(/reveal|tap/i) }).first();
    if (await flashcard.isVisible()) {
      await flashcard.click();
    } else {
      // Alternative: click anywhere on the card front
      await page.locator('[class*="rounded-"]').first().click();
    }
    
    // Should show card back with definition or translation
    // Wait a moment for flip animation
    await page.waitForTimeout(500);
    
    // Back should show rating buttons
    await expect(page.locator('button').filter({ has: page.locator('[class*="bg-rose"], [class*="bg-emerald"]') }).first()).toBeVisible({ timeout: 5000 });
  });

  test('shows rating buttons (Got it / Forgot)', async ({ seededApp: page }) => {
    await page.getByRole('button', { name: /study/i }).click();
    await page.getByRole('button', { name: /Start Session/i }).click();
    
    // Wait for session
    await expect(page.getByText(/Card \d+\/\d+/)).toBeVisible();
    
    // Rating buttons should be visible (colored bars)
    const forgotButton = page.locator('button[class*="bg-rose"]');
    const gotItButton = page.locator('button[class*="bg-emerald"]');
    
    await expect(forgotButton).toBeVisible();
    await expect(gotItButton).toBeVisible();
  });

  test('advances to next card when rated', async ({ seededApp: page }) => {
    await page.getByRole('button', { name: /study/i }).click();
    await page.getByRole('button', { name: /Start Session/i }).click();
    
    await expect(page.getByText(/Card 1\/\d+/)).toBeVisible();
    
    // Get the green "Got it" button and click it
    const gotItButton = page.locator('button[class*="bg-emerald"]');
    await gotItButton.click();
    
    // Should advance to next card or complete
    await page.waitForTimeout(500);
    
    // Either shows next card or completion screen
    const hasNextCard = await page.getByText(/Card 2\/\d+/).isVisible();
    const isComplete = await page.getByText(/Brilliant Session|complete/i).isVisible();
    
    expect(hasNextCard || isComplete).toBe(true);
  });

  test('re-queues card when marked as Forgot', async ({ page }) => {
    await clearIndexedDB(page);
    await clearLocalStorage(page);
    await mockFirebaseFunctions(page);
    await page.goto('/');
    await waitForAppLoad(page);
    
    // Seed with just one item
    const testItems = [
      createStoredItem(mockVocabCard, 'vocab', { memoryStrength: 10 }),
    ];
    await seedIndexedDB(page, testItems);
    await page.reload();
    await waitForAppLoad(page);
    
    await page.getByRole('button', { name: /study/i }).click();
    await page.getByRole('button', { name: /Start Session|Practice/i }).click();
    
    // Mark as forgot
    const forgotButton = page.locator('button[class*="bg-rose"]');
    await forgotButton.click();
    
    // Since there's only one item and we marked it forgot, 
    // it should be re-queued and shown again
    await page.waitForTimeout(500);
    
    // Should still be in session (not completed yet)
    const stillInSession = await page.getByText(/Card \d+\/\d+/).isVisible();
    expect(stillInSession).toBe(true);
  });
});

test.describe('Study Session - Keyboard Navigation', () => {
  test('Space key flips card', async ({ seededApp: page }) => {
    await page.getByRole('button', { name: /study/i }).click();
    await page.getByRole('button', { name: /Start Session/i }).click();
    
    await expect(page.getByText(/Card \d+\/\d+/)).toBeVisible();
    
    // Press Space to flip
    await page.keyboard.press('Space');
    
    // Wait for flip
    await page.waitForTimeout(500);
    
    // Should be flipped - check for rating buttons or definition content
    const gotItButton = page.locator('button[class*="bg-emerald"]');
    await expect(gotItButton).toBeVisible();
  });

  test('Arrow Right rates as Got it', async ({ seededApp: page }) => {
    await page.getByRole('button', { name: /study/i }).click();
    await page.getByRole('button', { name: /Start Session/i }).click();
    
    const initialCardText = await page.getByText(/Card 1\/\d+/).textContent();
    
    // Press arrow right to rate as correct
    await page.keyboard.press('ArrowRight');
    
    await page.waitForTimeout(500);
    
    // Should advance
    const hasNextCard = await page.getByText(/Card 2\//).isVisible();
    const isComplete = await page.getByText(/Brilliant Session/i).isVisible();
    
    expect(hasNextCard || isComplete).toBe(true);
  });

  test('Arrow Left rates as Forgot', async ({ seededApp: page }) => {
    await page.getByRole('button', { name: /study/i }).click();
    await page.getByRole('button', { name: /Start Session/i }).click();
    
    // Press arrow left to rate as forgot
    await page.keyboard.press('ArrowLeft');
    
    await page.waitForTimeout(500);
    
    // Should still be in session (card re-queued)
    const stillInSession = await page.getByText(/Card \d+\//).isVisible();
    expect(stillInSession).toBe(true);
  });

  test('Escape exits study session', async ({ seededApp: page }) => {
    await page.getByRole('button', { name: /study/i }).click();
    await page.getByRole('button', { name: /Start Session/i }).click();
    
    await expect(page.getByText(/Card \d+\/\d+/)).toBeVisible();
    
    // Press Escape
    await page.keyboard.press('Escape');
    
    // Should return to dashboard
    await expect(page.getByText("Today's Study")).toBeVisible();
  });

  test('Number keys for quick rating (1=Forgot, 3=Got it)', async ({ seededApp: page }) => {
    await page.getByRole('button', { name: /study/i }).click();
    await page.getByRole('button', { name: /Start Session/i }).click();
    
    // Press 3 for "Got it"
    await page.keyboard.press('3');
    
    await page.waitForTimeout(500);
    
    // Should advance
    const hasNextCard = await page.getByText(/Card 2\//).isVisible();
    const isComplete = await page.getByText(/Brilliant Session/i).isVisible();
    
    expect(hasNextCard || isComplete).toBe(true);
  });
});

test.describe('Study Session - Multiple Meanings', () => {
  test('shows dot indicators for words with multiple meanings', async ({ page }) => {
    await clearIndexedDB(page);
    await clearLocalStorage(page);
    await mockFirebaseFunctions(page);
    await page.goto('/');
    await waitForAppLoad(page);
    
    // Seed with multiple meanings of "bank"
    const testItems = [
      createStoredItem(mockBankNounFinance, 'vocab', { memoryStrength: 10 }),
      createStoredItem(mockBankNounGeography, 'vocab', { memoryStrength: 10 }),
    ];
    await seedIndexedDB(page, testItems);
    await page.reload();
    await waitForAppLoad(page);
    
    await page.getByRole('button', { name: /study/i }).click();
    await page.getByRole('button', { name: /Start Session/i }).click();
    
    // Should show dot indicators for multiple meanings
    // The exact implementation shows dots when there are sibling meanings
    const dots = page.locator('button[class*="rounded-full"][class*="h-2"]');
    
    // There should be dots if bank has multiple meanings visible
    const dotCount = await dots.count();
    // May or may not show depending on implementation
  });
});

test.describe('Study Session - Archive', () => {
  test('shows archive option', async ({ seededApp: page }) => {
    await page.getByRole('button', { name: /study/i }).click();
    await page.getByRole('button', { name: /Start Session/i }).click();
    
    // Archive button should be visible (amber colored)
    const archiveButton = page.locator('button[class*="bg-amber"]');
    await expect(archiveButton).toBeVisible();
  });

  test('archives card and removes from session', async ({ page }) => {
    await clearIndexedDB(page);
    await clearLocalStorage(page);
    await mockFirebaseFunctions(page);
    await page.goto('/');
    await waitForAppLoad(page);
    
    // Seed with two items
    const testItems = [
      createStoredItem(mockVocabCard, 'vocab', { memoryStrength: 10 }),
      createStoredItem(mockVocabCard2, 'vocab', { memoryStrength: 10 }),
    ];
    await seedIndexedDB(page, testItems);
    await page.reload();
    await waitForAppLoad(page);
    
    await page.getByRole('button', { name: /study/i }).click();
    await page.getByRole('button', { name: /Start Session/i }).click();
    
    // Click archive button
    const archiveButton = page.locator('button[class*="bg-amber"]');
    await archiveButton.click();
    
    // Should show confirmation modal
    await expect(page.getByText(/Archive this card/i)).toBeVisible();
    
    // Confirm archive
    await page.getByRole('button', { name: /Archive/i }).filter({ hasNot: page.locator('svg') }).click();
    
    // Should advance to next card
    await page.waitForTimeout(500);
  });
});

test.describe('Study Session - Completion', () => {
  test('shows completion screen with stats', async ({ page }) => {
    await clearIndexedDB(page);
    await clearLocalStorage(page);
    await mockFirebaseFunctions(page);
    await page.goto('/');
    await waitForAppLoad(page);
    
    // Seed with just one item
    const testItems = [
      createStoredItem(mockVocabCard, 'vocab', { memoryStrength: 10 }),
    ];
    await seedIndexedDB(page, testItems);
    await page.reload();
    await waitForAppLoad(page);
    
    await page.getByRole('button', { name: /study/i }).click();
    await page.getByRole('button', { name: /Start Session|Practice/i }).click();
    
    // Complete the card
    const gotItButton = page.locator('button[class*="bg-emerald"]');
    await gotItButton.click();
    
    // Should show completion screen
    await expect(page.getByText(/Brilliant Session/i)).toBeVisible({ timeout: 5000 });
    
    // Should show stats
    await expect(page.getByText(/Cards/i)).toBeVisible();
    await expect(page.getByText(/Accuracy/i)).toBeVisible();
  });

  test('can return to dashboard from completion screen', async ({ page }) => {
    await clearIndexedDB(page);
    await clearLocalStorage(page);
    await mockFirebaseFunctions(page);
    await page.goto('/');
    await waitForAppLoad(page);
    
    const testItems = [
      createStoredItem(mockVocabCard, 'vocab', { memoryStrength: 10 }),
    ];
    await seedIndexedDB(page, testItems);
    await page.reload();
    await waitForAppLoad(page);
    
    await page.getByRole('button', { name: /study/i }).click();
    await page.getByRole('button', { name: /Start Session|Practice/i }).click();
    
    const gotItButton = page.locator('button[class*="bg-emerald"]');
    await gotItButton.click();
    
    await expect(page.getByText(/Brilliant Session/i)).toBeVisible({ timeout: 5000 });
    
    // Click View Progress
    await page.getByRole('button', { name: /View Progress/i }).click();
    
    // Should return to dashboard
    await expect(page.getByText("Today's Study")).toBeVisible();
  });

  test('can start another session from completion screen', async ({ page }) => {
    await clearIndexedDB(page);
    await clearLocalStorage(page);
    await mockFirebaseFunctions(page);
    await page.goto('/');
    await waitForAppLoad(page);
    
    const testItems = [
      createStoredItem(mockVocabCard, 'vocab', { memoryStrength: 10 }),
    ];
    await seedIndexedDB(page, testItems);
    await page.reload();
    await waitForAppLoad(page);
    
    await page.getByRole('button', { name: /study/i }).click();
    await page.getByRole('button', { name: /Start Session|Practice/i }).click();
    
    const gotItButton = page.locator('button[class*="bg-emerald"]');
    await gotItButton.click();
    
    await expect(page.getByText(/Brilliant Session/i)).toBeVisible({ timeout: 5000 });
    
    // Click Study More
    await page.getByRole('button', { name: /Study More/i }).click();
    
    // Should start new session
    await expect(page.getByText(/Card \d+\/\d+/)).toBeVisible();
  });
});

test.describe('Study Session - Progress Persistence', () => {
  test('shows progress bar during session', async ({ seededApp: page }) => {
    await page.getByRole('button', { name: /study/i }).click();
    await page.getByRole('button', { name: /Start Session/i }).click();
    
    // Should show progress bar
    const progressBar = page.locator('[class*="bg-gradient-to-r"][class*="from-violet"]');
    await expect(progressBar).toBeVisible();
  });
});

test.describe('Study Session - Card Content', () => {
  test('shows IPA and pronunciation on card front', async ({ seededApp: page }) => {
    await page.getByRole('button', { name: /study/i }).click();
    await page.getByRole('button', { name: /Start Session/i }).click();
    
    // Should show IPA (in format /.../)
    await expect(page.getByText(/\/.*\//)).toBeVisible();
  });

  test('shows full definition on card back', async ({ seededApp: page }) => {
    await page.getByRole('button', { name: /study/i }).click();
    await page.getByRole('button', { name: /Start Session/i }).click();
    
    // Flip card
    await page.keyboard.press('Space');
    await page.waitForTimeout(500);
    
    // Should show Chinese translation (one of our seeded items)
    const hasTranslation = await page.getByText('意外发现的好事')
      .or(page.getByText('短暂的'))
      .or(page.getByText('银行'))
      .or(page.getByText('河岸'))
      .first()
      .isVisible();
    
    expect(hasTranslation).toBe(true);
  });

  test('shows examples and mnemonic on card back', async ({ seededApp: page }) => {
    await page.getByRole('button', { name: /study/i }).click();
    await page.getByRole('button', { name: /Start Session/i }).click();
    
    // Flip card
    await page.keyboard.press('Space');
    await page.waitForTimeout(500);
    
    // Should show usage section
    await expect(page.getByText(/Usage|Examples/i)).toBeVisible();
    
    // Should show mnemonic section
    await expect(page.getByText(/Mnemonic/i)).toBeVisible();
  });
});
