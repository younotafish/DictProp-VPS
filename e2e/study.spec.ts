import { test, expect, resetAppState } from './fixtures';

/**
 * E2E Tests for Study Dashboard
 * 
 * Tests cover:
 * - Dashboard display with statistics
 * - Empty state
 * - Mastery breakdown
 * - Weekly stats
 * - 7-day activity chart
 * 
 * Note: Study session flow (flashcard review) has been deprecated.
 * SRS updates now happen through the DetailView (double-click or R key).
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
