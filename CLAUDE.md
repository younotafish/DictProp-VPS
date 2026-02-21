# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

DictProp is an AI-powered vocabulary learning PWA (Progressive Web App) for English learners. Users search words/phrases, get AI-generated analysis (definitions, etymology, mnemonics, examples), and review them with spaced repetition. The app works offline-first with Firebase cloud sync across devices.

## Commands

```bash
# Development
npm run dev              # Vite dev server on port 3000 (0.0.0.0 for mobile testing)
npm run build            # Production build to dist/
npm run deploy           # firebase deploy --only hosting

# E2E Tests (Playwright)
npm run test:e2e         # Run all tests (auto-starts dev server on port 5173)
npm run test:e2e:headed  # Run with visible browser
npm run test:e2e:chromium                    # Desktop Chrome only
npm run test:e2e:mobile                      # Mobile Chrome only
npx playwright test e2e/notebook.spec.ts     # Run a single test file
npx playwright test -g "search for a word"   # Run tests matching a pattern

# Firebase Functions (run from functions/ directory)
cd functions && npm run build     # Compile TypeScript to lib/
cd functions && npm run deploy    # Build + deploy functions
cd functions && npm run serve     # Local emulator
```

## Architecture

### Data Model

Two item types stored as `StoredItem` wrappers in `types.ts`:
- **VocabCard** — single word with definition, IPA, examples, etymology, mnemonics, etc.
- **SearchResult** — phrase/sentence with multiple `VocabCard` meanings inside `vocabs[]`

Use type guards `isVocabItem()` and `isPhraseItem()` to narrow `StoredItem`. Helper functions `getItemTitle()`, `getItemSpelling()`, `getItemSense()`, `getItemImageUrl()` extract common fields.

### App Structure

`App.tsx` (~1700 lines) is the root component and owns all state. It manages two tab views:
- **Notebook** (`views/Notebook.tsx`) — search, browse, delete saved items
- **Study** (`views/StudyEnhanced.tsx`) — SRS review with 5 task types

Supporting full-screen views: `DetailView.tsx` (card carousel) and `ComparisonView.tsx` (compare similar words).

### Triple-Layer Persistence

Data flows: **React state** → **localStorage cache** (stripped images, instant reload) → **IndexedDB** (full data, primary local store) → **Firebase Firestore** (cloud sync).

Key services in `services/`:
- `storage.ts` — IndexedDB with fallback to in-memory (Safari private mode)
- `firebase.ts` — Auth (Google), Firestore
- `sync.ts` — Delta sync with content hashing, merge conflict resolution
- `srsAlgorithm.ts` — Fixed-schedule SRS with 12 steps: [1,2,3,5,7,12,20,25,47,84,143,180] days
- `aiService.ts` — AI word analysis (DeepSeek-V3 via DeepInfra cloud functions)

### Critical Pattern: Stale Closure Prevention

`App.tsx` uses `latestItemsRef` (a ref always updated via `useEffect`) so event handlers and callbacks get current data instead of stale closure state. This is essential for iOS PWA save-on-background reliability. Always use `latestItemsRef.current` in event handlers rather than closure-captured `syncState.items`.

### Sync Behavior

- Regular saves debounced to 5 seconds
- SRS updates, deletions, and archives trigger immediate saves (bypass debounce)
- Saves on `visibilitychange` and `beforeunload` events (iOS PWA safety)
- Delta sync compares content hashes to skip unchanged items

### Path Aliases

`@/*` maps to the project root (configured in `tsconfig.json`).

## Environment

- Cloud Functions secrets: `DEEPINFRA_API_KEY`, `REPLICATE_API_TOKEN` — used for AI analysis and image generation
- Firebase config is in `services/firebase.ts` (can be overridden via localStorage key `popdict_firebase_config`)
- Firebase project ID: `dictpropstore`
- Functions require Node 22

## Testing

Playwright tests in `e2e/` cover auth, sync, notebook, study, detail view, SRS, mobile, iOS Safari, keyboard/a11y, and edge cases. Tests run against a Vite dev server on port 5173 (auto-started by Playwright). Three browser projects: Desktop Chrome, Mobile Chrome (Pixel 5), Mobile Safari (iPhone 13).
