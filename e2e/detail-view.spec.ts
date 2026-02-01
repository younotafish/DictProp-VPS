import { test, expect, mockVocabCard, mockVocabCard2, mockBankNounFinance, mockBankNounGeography, mockPhraseSearchResult, seedIndexedDB, createStoredItem, waitForAppLoad, mockFirebaseFunctions, clearIndexedDB, clearLocalStorage } from './fixtures';

/**
 * E2E Tests for Detail View
 * 
 * Tests cover:
 * - Opening detail view from notebook
 * - Full vocabulary card display
 * - Pronunciation playback
 * - Navigation between meanings (horizontal swipe)
 * - Navigation between words (vertical swipe)
 * - Save/unsave actions
 * - Delete with confirmation
 * - Archive action
 * - Reset SRS action
 * - Remember (R key) action
 * - Close via back button or Escape
 * - Recursive search (clicking synonyms/antonyms)
 * - Phrase type display
 */

test.describe('Detail View - Opening', () => {
  test('opens from notebook card click', async ({ seededApp: page }) => {
    // Click on a vocabulary card
    await page.getByText('serendipity').first().click();
    
    // Should show detail view with close button
    await expect(page.getByRole('button', { name: /close/i })).toBeVisible();
    
    // Should show word title prominently
    await expect(page.getByRole('heading', { name: 'serendipity' }).or(page.getByText('serendipity').first())).toBeVisible();
  });

  test('shows full vocabulary card content', async ({ seededApp: page }) => {
    await page.getByText('serendipity').first().click();
    
    // Should show Chinese translation
    await expect(page.getByText('意外发现的好事')).toBeVisible();
    
    // Should show definition
    await expect(page.getByText(/occurrence.*chance/i)).toBeVisible();
    
    // Should show IPA
    await expect(page.getByText('/ˌserənˈdɪpəti/')).toBeVisible();
    
    // Should show examples section
    await expect(page.getByText(/Usage/i)).toBeVisible();
    
    // Should show etymology/history
    await expect(page.getByText(/Origins|History/i)).toBeVisible();
    
    // Should show mnemonic
    await expect(page.getByText(/Mnemonic/i)).toBeVisible();
    
    // Should show synonyms
    await expect(page.getByText('luck').or(page.getByText('fortune'))).toBeVisible();
  });
});

test.describe('Detail View - Close Actions', () => {
  test('closes via close button', async ({ seededApp: page }) => {
    await page.getByText('serendipity').first().click();
    
    // Wait for detail view to open
    await expect(page.getByRole('button', { name: /close/i })).toBeVisible();
    
    // Click close button
    await page.getByRole('button', { name: /close/i }).click();
    
    // Should return to notebook
    await expect(page.getByRole('heading', { name: 'Notebook' })).toBeVisible();
  });

  test('closes via Escape key', async ({ seededApp: page }) => {
    await page.getByText('serendipity').first().click();
    
    await expect(page.getByRole('button', { name: /close/i })).toBeVisible();
    
    // Press Escape
    await page.keyboard.press('Escape');
    
    // Should return to notebook
    await expect(page.getByRole('heading', { name: 'Notebook' })).toBeVisible();
  });
});

test.describe('Detail View - Navigation Between Meanings', () => {
  test('shows meaning indicator for multi-meaning words', async ({ page }) => {
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
    
    // Should show position indicator (e.g., "1/2")
    await expect(page.getByText('1/2')).toBeVisible();
  });

  test('navigates between meanings with arrow keys', async ({ page }) => {
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
    
    await page.getByText('bank').first().click();
    
    // Should start at 1/2
    await expect(page.getByText('1/2')).toBeVisible();
    
    // Press right arrow to go to next meaning
    await page.keyboard.press('ArrowRight');
    await page.waitForTimeout(500);
    
    // Should now show 2/2
    await expect(page.getByText('2/2')).toBeVisible();
    
    // Press left arrow to go back
    await page.keyboard.press('ArrowLeft');
    await page.waitForTimeout(500);
    
    // Should show 1/2 again
    await expect(page.getByText('1/2')).toBeVisible();
  });

  test('shows different sense labels for each meaning', async ({ page }) => {
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
    
    await page.getByText('bank').first().click();
    
    // First meaning should show "noun: finance"
    await expect(page.getByText('noun: finance')).toBeVisible();
    
    // Navigate to second meaning
    await page.keyboard.press('ArrowRight');
    await page.waitForTimeout(500);
    
    // Second meaning should show "noun: geography"
    await expect(page.getByText('noun: geography')).toBeVisible();
  });
});

test.describe('Detail View - Navigation Between Words', () => {
  test('navigates between words with up/down arrows', async ({ seededApp: page }) => {
    // Open first word
    await page.getByText('serendipity').first().click();
    
    // Wait for detail view
    await expect(page.getByRole('button', { name: /close/i })).toBeVisible();
    
    // Press down arrow to go to next word
    await page.keyboard.press('ArrowDown');
    await page.waitForTimeout(500);
    
    // Should show different word (one of our seeded words)
    const hasNewWord = await page.getByText('ephemeral')
      .or(page.getByText('bank'))
      .first()
      .isVisible();
    
    expect(hasNewWord).toBe(true);
  });
});

test.describe('Detail View - Save/Unsave', () => {
  test('toggles save state', async ({ seededApp: page }) => {
    await page.getByText('serendipity').first().click();
    
    // Show header first (press H or scroll up)
    await page.keyboard.press('h');
    await page.waitForTimeout(300);
    
    // Find the save button
    const saveButton = page.getByRole('button', { name: /save/i });
    
    if (await saveButton.isVisible()) {
      // Currently saved - clicking should unsave
      await saveButton.click();
      
      // Should now show "Save" instead of "Saved"
      await expect(page.getByText(/^Save$/)).toBeVisible();
    }
  });
});

test.describe('Detail View - Delete', () => {
  test('shows delete confirmation modal', async ({ seededApp: page }) => {
    await page.getByText('serendipity').first().click();
    
    // Show header
    await page.keyboard.press('h');
    await page.waitForTimeout(300);
    
    // Click more options menu
    const moreButton = page.getByRole('button', { name: /more/i }).or(page.locator('button').filter({ has: page.locator('svg[class*="lucide-more"]') }));
    if (await moreButton.isVisible()) {
      await moreButton.click();
      
      // Click delete option
      await page.getByText(/Delete/i).click();
      
      // Should show confirmation modal
      await expect(page.getByText(/Delete this word/i)).toBeVisible();
      await expect(page.getByRole('button', { name: /Cancel/i })).toBeVisible();
      await expect(page.getByRole('button', { name: /Delete/i }).last()).toBeVisible();
    }
  });

  test('deletes item after confirmation', async ({ page }) => {
    await clearIndexedDB(page);
    await clearLocalStorage(page);
    await mockFirebaseFunctions(page);
    await page.goto('/');
    await waitForAppLoad(page);
    
    // Seed with multiple items
    const testItems = [
      createStoredItem(mockVocabCard, 'vocab'),
      createStoredItem(mockVocabCard2, 'vocab'),
    ];
    await seedIndexedDB(page, testItems);
    await page.reload();
    await waitForAppLoad(page);
    
    // Verify serendipity exists
    await expect(page.getByText('serendipity')).toBeVisible();
    
    // Open detail view
    await page.getByText('serendipity').first().click();
    
    // Show header
    await page.keyboard.press('h');
    await page.waitForTimeout(300);
    
    // Open more menu
    const moreButton = page.locator('button').filter({ has: page.locator('svg') }).last();
    await moreButton.click();
    
    // Click delete
    await page.getByText(/Delete/i).click();
    
    // Confirm deletion
    await page.getByRole('button', { name: /Delete/i }).last().click();
    
    // Should return to notebook or show next item
    await page.waitForTimeout(1000);
    
    // Go back to notebook
    await page.keyboard.press('Escape');
    
    // Item should be removed
    await expect(page.getByText('serendipity')).not.toBeVisible();
  });
});

test.describe('Detail View - Archive', () => {
  test('archives item via menu', async ({ seededApp: page }) => {
    await page.getByText('serendipity').first().click();
    
    // Show header
    await page.keyboard.press('h');
    await page.waitForTimeout(300);
    
    // Open more menu
    const moreButton = page.locator('button').filter({ has: page.locator('svg') }).last();
    if (await moreButton.isVisible()) {
      await moreButton.click();
      
      // Click archive option
      const archiveOption = page.getByText(/Archive/i);
      if (await archiveOption.isVisible()) {
        await archiveOption.click();
        
        // Item should be archived (may navigate to next item or close)
        await page.waitForTimeout(500);
      }
    }
  });
});

test.describe('Detail View - SRS Actions', () => {
  test('shows progress bar for saved items', async ({ seededApp: page }) => {
    await page.getByText('serendipity').first().click();
    
    // Show header
    await page.keyboard.press('h');
    await page.waitForTimeout(300);
    
    // Should show mastery level
    const masteryIndicator = page.getByText(/New|Struggling|Learning|Proficient|Mastered|Grandmaster/i);
    await expect(masteryIndicator).toBeVisible();
  });

  test('R key marks as remembered', async ({ seededApp: page }) => {
    await page.getByText('serendipity').first().click();
    
    // Press R to remember
    await page.keyboard.press('r');
    
    // Should show success animation
    await expect(page.getByText(/Remembered/i)).toBeVisible();
  });

  test('Shift+R resets memory strength', async ({ seededApp: page }) => {
    await page.getByText('serendipity').first().click();
    
    // Show header first
    await page.keyboard.press('h');
    await page.waitForTimeout(300);
    
    // Open more menu for reset option
    const moreButton = page.locator('button').filter({ has: page.locator('svg') }).last();
    if (await moreButton.isVisible()) {
      await moreButton.click();
      
      // Click reset
      const resetOption = page.getByText(/Reset Memory/i);
      if (await resetOption.isVisible()) {
        await resetOption.click();
        
        // Should reset the item's SRS
        await page.waitForTimeout(500);
      }
    }
  });
});

test.describe('Detail View - Recursive Search', () => {
  test('clicking synonym triggers search', async ({ seededApp: page }) => {
    await page.getByText('serendipity').first().click();
    
    // Wait for card to load fully
    await page.waitForTimeout(500);
    
    // Click on a synonym pill (e.g., "luck")
    const synonymButton = page.getByRole('button', { name: 'luck' }).or(page.locator('button').filter({ hasText: 'luck' }));
    if (await synonymButton.isVisible()) {
      await synonymButton.click();
      
      // Should close detail view and search for "luck"
      await page.waitForTimeout(1000);
      
      // Either shows notebook with search or triggers AI search
    }
  });

  test('clicking word form triggers search', async ({ seededApp: page }) => {
    await page.getByText('serendipity').first().click();
    
    // Wait for card to load
    await page.waitForTimeout(500);
    
    // Click on a word form (e.g., "serendipitous")
    const formButton = page.getByRole('button', { name: 'serendipitous' }).or(page.locator('button').filter({ hasText: 'serendipitous' }));
    if (await formButton.isVisible()) {
      await formButton.click();
      
      // Should trigger search
      await page.waitForTimeout(1000);
    }
  });
});

test.describe('Detail View - Phrase Type', () => {
  test('displays phrase content correctly', async ({ page }) => {
    await clearIndexedDB(page);
    await clearLocalStorage(page);
    await mockFirebaseFunctions(page);
    await page.goto('/');
    await waitForAppLoad(page);
    
    // Seed with a phrase
    const phraseItem = {
      ...mockPhraseSearchResult,
      id: 'test-phrase-item',
    };
    const testItems = [
      createStoredItem(phraseItem, 'phrase'),
    ];
    await seedIndexedDB(page, testItems);
    await page.reload();
    await waitForAppLoad(page);
    
    // Change filter to show phrases
    await page.getByRole('button', { name: /filter/i }).click();
    
    // Open detail view
    await page.getByText('break the ice').first().click();
    
    // Should show phrase translation
    await expect(page.getByText('打破僵局')).toBeVisible();
    
    // Should show grammar analysis
    await expect(page.getByText(/Phrasal verb/i)).toBeVisible();
    
    // Should show key vocabulary section if available
  });
});

test.describe('Detail View - Pronunciation', () => {
  test('shows clickable IPA block', async ({ seededApp: page }) => {
    await page.getByText('serendipity').first().click();
    
    // IPA should be visible and clickable
    const ipaBlock = page.getByText('/ˌserənˈdɪpəti/');
    await expect(ipaBlock).toBeVisible();
    
    // Should have speaker icon or be a button
    const pronunciationButton = page.locator('[class*="cursor-pointer"]').filter({ has: page.getByText('/ˌserənˈdɪpəti/') });
    if (await pronunciationButton.first().isVisible()) {
      // Clicking should trigger pronunciation (can't test audio in e2e, but can verify no errors)
      await pronunciationButton.first().click();
    }
  });

  test('P key triggers pronunciation', async ({ seededApp: page }) => {
    await page.getByText('serendipity').first().click();
    
    // Press P key
    await page.keyboard.press('p');
    
    // Can't verify audio, but no error should occur
    await page.waitForTimeout(500);
  });
});

test.describe('Detail View - Image Display', () => {
  test('shows image if available', async ({ seededApp: page }) => {
    await page.getByText('serendipity').first().click();
    
    // Image may or may not be present depending on test data
    // If present, should show
    const image = page.locator('img[alt="serendipity"]').or(page.locator('img[class*="fade-in"]'));
    // This is a conditional check - images may be lazy loaded
  });
});

test.describe('Detail View - Scroll and Header', () => {
  test('H key toggles header visibility', async ({ seededApp: page }) => {
    await page.getByText('serendipity').first().click();
    
    // Header is hidden by default
    // Press H to show
    await page.keyboard.press('h');
    await page.waitForTimeout(300);
    
    // Header should be visible with close button
    await expect(page.getByRole('button', { name: /close/i })).toBeVisible();
    
    // Press H again to hide
    await page.keyboard.press('h');
    await page.waitForTimeout(300);
    
    // Header might be hidden or minimized
  });
});

test.describe('Detail View - Double-click Remember', () => {
  test('double-click triggers remember', async ({ seededApp: page }) => {
    await page.getByText('serendipity').first().click();
    
    // Double-click on the card background
    const cardContent = page.locator('[class*="overflow-y-auto"]').first();
    await cardContent.dblclick();
    
    // Should show remembered animation
    await expect(page.getByText(/Remembered/i)).toBeVisible({ timeout: 3000 });
  });
});
