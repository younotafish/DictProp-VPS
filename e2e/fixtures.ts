import { test as base, Page, BrowserContext } from '@playwright/test';

/**
 * Custom fixtures for DictProp e2e tests
 * 
 * Provides:
 * - Pre-seeded IndexedDB data
 * - Mocked Firebase/AI API responses
 * - Helper functions for common test scenarios
 */

// Sample vocabulary data for tests
export const mockVocabCard = {
  id: 'test-vocab-1',
  word: 'serendipity',
  sense: 'noun: happy accident',
  chinese: '意外发现的好事',
  ipa: '/ˌserənˈdɪpəti/',
  definition: 'The occurrence and development of events by chance in a happy or beneficial way',
  forms: ['serendipities', 'serendipitous', 'serendipitously'],
  synonyms: ['luck', 'fortune', 'chance', 'coincidence'],
  antonyms: ['misfortune', 'bad luck'],
  confusables: ['synchronicity', 'coincidence'],
  examples: [
    'Finding that book was pure serendipity.',
    'Meeting her at the airport was serendipity.'
  ],
  history: 'Coined by Horace Walpole in 1754 from the fairy tale "The Three Princes of Serendip"',
  register: 'Slightly formal, literary',
  mnemonic: 'SERENE + DIP + IT = dip into serene luck',
  imagePrompt: 'A person finding treasure by accident'
};

export const mockVocabCard2 = {
  id: 'test-vocab-2',
  word: 'ephemeral',
  sense: 'adjective: short-lived',
  chinese: '短暂的',
  ipa: '/ɪˈfemərəl/',
  definition: 'Lasting for a very short time',
  forms: ['ephemerally'],
  synonyms: ['transient', 'fleeting', 'momentary'],
  antonyms: ['permanent', 'lasting', 'enduring'],
  confusables: ['eternal', 'ethereal'],
  examples: [
    'Fame is ephemeral.',
    'The ephemeral beauty of cherry blossoms.'
  ],
  history: 'From Greek ephemeros meaning "lasting only a day"',
  register: 'Formal, literary',
  mnemonic: 'E-FEM-eral: Think of a mayfly (ephemera) that lives for just one day'
};

export const mockBankNounFinance = {
  id: 'test-bank-finance',
  word: 'bank',
  sense: 'noun: finance',
  chinese: '银行',
  ipa: '/bæŋk/',
  definition: 'A financial institution that accepts deposits and channels the money into lending activities',
  forms: ['banks', 'banking', 'banked'],
  synonyms: ['financial institution', 'lender', 'credit union'],
  antonyms: ['debtor', 'borrower'],
  confusables: ['bench', 'blank'],
  examples: [
    'I need to go to the bank to deposit this check.',
    'The bank approved our mortgage application.'
  ],
  history: 'From Italian "banca" meaning bench, where medieval money changers conducted business',
  register: 'Neutral, everyday',
  mnemonic: 'Think of a piggy BANK where you store money'
};

export const mockBankNounGeography = {
  id: 'test-bank-geography',
  word: 'bank',
  sense: 'noun: geography',
  chinese: '河岸',
  ipa: '/bæŋk/',
  definition: 'The sloping land beside a river, lake, or canal',
  forms: ['banks'],
  synonyms: ['shore', 'edge', 'embankment', 'riverside'],
  antonyms: ['channel', 'riverbed'],
  confusables: ['beach', 'shore'],
  examples: [
    'We had a picnic on the bank of the river.',
    'The children played along the grassy bank.'
  ],
  history: 'From Old Norse "bakki" meaning ridge or hill',
  register: 'Neutral, slightly literary',
  mnemonic: 'Picture a river with steep BANKs on either side'
};

export const mockSearchResult = {
  id: 'test-search-1',
  query: 'serendipity',
  translation: '',
  grammar: '',
  visualKeyword: 'serendipity',
  pronunciation: '/ˌserənˈdɪpəti/',
  vocabs: [mockVocabCard],
  timestamp: Date.now()
};

export const mockPhraseSearchResult = {
  id: 'test-phrase-1',
  query: "break the ice",
  translation: '打破僵局',
  grammar: '**Phrasal verb** used to describe the action of making people feel more comfortable in a social situation.\n\n- "break" here means to disrupt or end\n- "ice" is a metaphor for the cold, uncomfortable silence between strangers',
  visualKeyword: 'ice breaking',
  pronunciation: '/breɪk ðə aɪs/',
  vocabs: [
    {
      id: 'test-vocab-break',
      word: 'break',
      sense: 'verb: to disrupt',
      chinese: '打破',
      ipa: '/breɪk/',
      definition: 'To interrupt or stop something',
      forms: ['breaks', 'breaking', 'broke', 'broken'],
      synonyms: ['interrupt', 'disrupt', 'end'],
      antonyms: ['continue', 'maintain'],
      confusables: ['brake'],
      examples: ['Let me break the silence.'],
      history: 'From Old English brecan',
      register: 'Neutral',
      mnemonic: 'BREAK sounds like the thing you press in a car to stop (brake)'
    }
  ],
  timestamp: Date.now()
};

// Helper to create SRS data
export const createMockSRS = (
  id: string, 
  type: 'vocab' | 'phrase',
  options: {
    memoryStrength?: number;
    nextReview?: number;
    totalReviews?: number;
    correctStreak?: number;
    stability?: number;
  } = {}
) => ({
  id,
  type,
  nextReview: options.nextReview ?? Date.now(), // Due now by default
  interval: 0,
  memoryStrength: options.memoryStrength ?? 0,
  lastReviewDate: Date.now(),
  totalReviews: options.totalReviews ?? 0,
  correctStreak: options.correctStreak ?? 0,
  stability: options.stability ?? 0.5,
});

// Helper to create a stored item
export const createStoredItem = (
  data: any,
  type: 'vocab' | 'phrase',
  options: {
    memoryStrength?: number;
    nextReview?: number;
    totalReviews?: number;
    isArchived?: boolean;
  } = {}
) => ({
  data,
  type,
  savedAt: Date.now() - 1000 * 60 * 60 * 24, // 1 day ago
  updatedAt: Date.now(),
  srs: createMockSRS(data.id, type, options),
  isDeleted: false,
  isArchived: options.isArchived ?? false,
});

/**
 * Mock AI API response for search
 */
export const mockAnalyzeInput = (query: string) => {
  const queryLower = query.toLowerCase().trim();
  
  if (queryLower === 'serendipity') {
    return mockSearchResult;
  }
  
  if (queryLower === 'ephemeral') {
    return {
      ...mockSearchResult,
      id: 'test-search-ephemeral',
      query: 'ephemeral',
      vocabs: [mockVocabCard2],
    };
  }
  
  if (queryLower === 'bank') {
    return {
      ...mockSearchResult,
      id: 'test-search-bank',
      query: 'bank',
      vocabs: [mockBankNounFinance, mockBankNounGeography],
    };
  }
  
  if (queryLower === 'break the ice') {
    return mockPhraseSearchResult;
  }
  
  // Default response for any other query
  return {
    id: `test-search-${Date.now()}`,
    query,
    translation: '',
    grammar: '',
    visualKeyword: query,
    pronunciation: '',
    vocabs: [{
      ...mockVocabCard,
      id: `test-vocab-${Date.now()}`,
      word: query,
      chinese: `Mock translation for ${query}`,
    }],
    timestamp: Date.now()
  };
};

/**
 * Seed IndexedDB with test data
 * Matches the app's actual storage schema: PopDictDB v2, store: library, key: items_guest
 */
export async function seedIndexedDB(page: Page, items: any[]) {
  await page.evaluate((data) => {
    return new Promise<void>((resolve, reject) => {
      const DB_NAME = 'PopDictDB';
      const DB_VERSION = 2;
      const STORE_NAME = 'library';
      const STORAGE_KEY = 'items_guest';
      
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      
      request.onerror = () => reject(request.error);
      
      request.onupgradeneeded = (event) => {
        const db = (event.target as IDBOpenDBRequest).result;
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          db.createObjectStore(STORE_NAME);
        }
        if (!db.objectStoreNames.contains('images')) {
          db.createObjectStore('images');
        }
      };
      
      request.onsuccess = () => {
        const db = request.result;
        const tx = db.transaction(STORE_NAME, 'readwrite');
        const store = tx.objectStore(STORE_NAME);
        
        // The app stores all items as an array under a single key
        store.put(data, STORAGE_KEY);
        
        tx.oncomplete = () => {
          db.close();
          resolve();
        };
        tx.onerror = () => reject(tx.error);
      };
    });
  }, items);
  
  // Also set up localStorage cache (the app uses this for fast initial load)
  await page.evaluate((data) => {
    localStorage.setItem('app_items_cache', JSON.stringify(data));
    console.log('Seeded localStorage with', data.length, 'items');
  }, items);
  
}

/**
 * Clear IndexedDB data
 * NOTE: Page must be navigated to a page on localhost first!
 */
export async function clearIndexedDB(page: Page) {
  await page.evaluate(() => {
    return new Promise<void>((resolve) => {
      // Delete the app's actual database
      const request = indexedDB.deleteDatabase('PopDictDB');
      request.onsuccess = () => resolve();
      request.onerror = () => resolve();
      request.onblocked = () => resolve();
    });
  });
}

/**
 * Reset app to a clean state - navigates first, then clears storage
 * Use this instead of manually calling clearIndexedDB in tests
 */
export async function resetAppState(page: Page) {
  // Mock Firebase first
  await mockFirebaseFunctions(page);
  
  // Navigate to the app (required for IndexedDB access)
  await page.goto('/');
  
  // Now clear storage
  await clearIndexedDB(page);
  await clearLocalStorage(page);
  
  // Reload to apply clean state
  await page.reload();
  await waitForAppLoad(page);
}

/**
 * Clear localStorage
 */
export async function clearLocalStorage(page: Page) {
  await page.evaluate(() => {
    localStorage.clear();
  });
}

/**
 * Mock Firebase functions
 */
export async function mockFirebaseFunctions(page: Page) {
  await page.route('**/cloudfunctions.net/**', async (route) => {
    const url = route.request().url();
    
    if (url.includes('analyzeInput')) {
      const postData = route.request().postDataJSON();
      const text = postData?.data?.text || '';
      const result = mockAnalyzeInput(text);
      
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ result: { data: result } })
      });
    } else if (url.includes('generateIllustration')) {
      // Return a small placeholder image
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          result: {
            data: {
              imageData: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='
            }
          }
        })
      });
    } else if (url.includes('transcribeAudio')) {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          result: { data: { text: 'serendipity' } }
        })
      });
    } else {
      await route.continue();
    }
  });
}

/**
 * Wait for app to be loaded and stable
 */
export async function waitForAppLoad(page: Page) {
  // Wait for DOM to be fully loaded
  await page.waitForLoadState('domcontentloaded');
  
  // Dismiss any Vite error overlay that might appear
  try {
    const viteOverlay = page.locator('vite-error-overlay');
    if (await viteOverlay.isVisible({ timeout: 1000 })) {
      await page.keyboard.press('Escape');
      await page.waitForTimeout(500);
    }
  } catch {
    // No error overlay, continue
  }
  
  // Also try to dismiss any generic error overlay
  await page.keyboard.press('Escape');
  await page.waitForTimeout(200);
  
  // Wait for the nav bar or a heading to appear (indicates React has mounted)
  try {
    await page.waitForSelector('nav, h2, h3', { timeout: 10000 });
  } catch {
    // If we still can't find any content, try reloading
    await page.reload();
    await page.waitForLoadState('domcontentloaded');
    await page.keyboard.press('Escape');
    await page.waitForSelector('nav, h2, h3', { timeout: 10000 });
  }
  
  // Additional wait for React state to settle
  await page.waitForTimeout(300);
}

/**
 * Extended test fixture with helpers
 */
export const test = base.extend<{
  emptyApp: Page;
  seededApp: Page;
}>({
  // Fresh app with no saved data
  emptyApp: async ({ page }, use) => {
    // Mock Firebase functions BEFORE navigating
    await mockFirebaseFunctions(page);
    
    // Navigate to app FIRST (required for IndexedDB access)
    await page.goto('/');
    await page.waitForLoadState('domcontentloaded');
    
    // Now we can clear ALL storage (after page is loaded)
    await clearIndexedDB(page);
    await clearLocalStorage(page);
    
    // Also clear any React state by reloading with cleared storage
    await page.reload();
    await waitForAppLoad(page);
    
    // Double-check that storage is cleared (for debugging)
    await page.evaluate(() => {
      localStorage.clear();
      sessionStorage.clear();
    });
    
    // One more reload to ensure clean state
    await page.reload();
    await waitForAppLoad(page);
    
    await use(page);
  },
  
  // App pre-seeded with vocabulary items
  seededApp: async ({ page }, use) => {
    // Prepare test data
    const testItems = [
      createStoredItem(mockVocabCard, 'vocab', { memoryStrength: 30, totalReviews: 3 }),
      createStoredItem(mockVocabCard2, 'vocab', { memoryStrength: 50, totalReviews: 5 }),
      createStoredItem(mockBankNounFinance, 'vocab', { memoryStrength: 10 }),
      createStoredItem(mockBankNounGeography, 'vocab', { memoryStrength: 10 }),
    ];
    
    // Mock Firebase functions BEFORE navigating
    await mockFirebaseFunctions(page);
    
    // First, navigate to set up IndexedDB schema
    await page.goto('/');
    await waitForAppLoad(page);
    
    // Seed BOTH IndexedDB and localStorage
    await seedIndexedDB(page, testItems);
    
    // Also set the localStorage cache (for instant restore on reload)
    await page.evaluate((items) => {
      localStorage.setItem('app_items_cache', JSON.stringify(items));
    }, testItems);
    
    // Reload to pick up seeded data
    await page.reload();
    await waitForAppLoad(page);
    
    
    await use(page);
  },
});

export { expect } from '@playwright/test';
