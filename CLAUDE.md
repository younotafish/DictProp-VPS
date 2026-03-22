# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

DictProp is an AI-powered vocabulary learning web app for English learners. Users search words/phrases, get AI-generated analysis (definitions, etymology, mnemonics, examples), and review them with spaced repetition.

**This is the VPS fork** — self-hosted on a personal VPS (107.152.47.101) with Hono + SQLite, replacing the original Firebase version. The Firebase version at dictpropstore.web.app continues running untouched.

## VPS Architecture

```
Browser → Hono server (port 3000) → SQLite (data/dictprop.db)
                                   → DeepInfra API (AI analysis)
                                   → Replicate API (image generation fallback)
```

- **No auth** — single user, no login
- **No real-time subscriptions** — pull-on-open + push-on-save
- **SQLite** instead of Firestore — `data/dictprop.db`
- **Hono** serves both API and static files in production

## Development Setup

Two processes needed locally:

```bash
# Terminal 1: Backend (port 3001)
cd server && npm run dev

# Terminal 2: Frontend (port 3000, proxies /api → 3001)
npm run dev

# Or both at once:
npm run dev:all
```

Open http://localhost:3000. Vite proxies `/api/*` to the Hono backend.

## CRITICAL: Network Restrictions

**The dev machine has a system-level firewall** that blocks outbound connections from Node.js (SSH, direct HTTPS). All external API calls MUST go through the corporate HTTP proxy.

- **Proxy**: `localhost:10054` (auto-detected from `HTTPS_PROXY` env var)
- **`server/src/proxy-fetch.ts`** wraps `fetch()` with `undici.ProxyAgent` — ALL outbound HTTP in server code MUST use `proxyFetch()` instead of native `fetch()`
- **`curl` works** (uses proxy automatically) but `node` native `fetch` does NOT
- **SSH to VPS is blocked** — cannot deploy or run commands on VPS directly from Claude Code
- **Playwright Chromium crashes** on this machine (SEGV) — use Node.js fetch-based smoke tests instead

## Deploy Flow

Claude Code CANNOT access the VPS directly. The deploy flow is:

1. **Claude Code**: Make changes, build, test locally, commit
2. **Claude Code**: `git push vps main` (pushes to github.com/younotafish/DictProp-VPS)
3. **User** (from separate terminal with VPS access): `ssh root@107.152.47.101 "cd /opt/dictprop-vps && git pull && docker compose up -d --build"`

The GitHub repo is the bridge between Claude Code and the VPS. The `gh` CLI is at `/Users/cjs/DictProp/.gh` (not on PATH).

To verify after deploy, ask the user to run:
```bash
curl http://107.152.47.101:3000/api/health
```

## Commands

```bash
# Frontend
npm run dev              # Vite dev server (port 3000)
npm run build            # Production build to dist/

# Server
cd server && npm run dev     # Hono dev server with hot reload (port 3001)
cd server && npm run build   # TypeScript compile to server/dist/
cd server && npx tsc --noEmit  # Type-check only

# Both
npm run dev:all          # Frontend + backend concurrently
npm run build:all        # Build both

# Deploy (via GitHub)
git push vps main        # Push to GitHub, user pulls on VPS

# Smoke tests (use this instead of Playwright — Chromium crashes on this machine)
# Run from server/ directory after starting both servers
node --input-type=module < e2e/vps-smoke-test.js

# E2E Tests (Playwright — may not work due to Chromium SEGV)
npm run test:e2e
```

## Project Structure

```
├── App.tsx                    # Root component (~1800 lines), owns all state
├── types.ts                   # StoredItem, VocabCard, SearchResult, SRS types
├── services/
│   ├── api.ts                 # REST client — replaces firebase.ts + aiService.ts
│   ├── storage.ts             # IndexedDB local storage (key: 'items_vps')
│   ├── sync.ts                # mergeDatasets() for local↔server conflict resolution
│   ├── srsAlgorithm.ts        # Fixed-schedule SRS (12 steps)
│   ├── speech.ts              # Browser speech synthesis
│   └── logger.ts              # Console logging (silenced in production)
├── server/
│   ├── src/
│   │   ├── index.ts           # Hono app + static file serving
│   │   ├── db.ts              # SQLite schema + CRUD (better-sqlite3)
│   │   ├── env.ts             # Environment variables
│   │   ├── proxy-fetch.ts     # Proxy-aware fetch wrapper (MUST use for all outbound HTTP)
│   │   └── routes/
│   │       ├── items.ts       # GET/PUT/DELETE /api/items, POST /api/import
│   │       ├── ai.ts          # /api/analyze, /api/compare, /api/extract-vocabulary, /api/transcribe
│   │       └── images.ts      # /api/generate-image
│   └── package.json
├── views/                     # Notebook, StudyEnhanced, SentencesView, DetailView, ComparisonView
├── components/                # UI components
├── hooks/                     # Keyboard/gesture hooks
├── Dockerfile                 # Multi-stage: builds frontend + server inside Docker
├── docker-compose.yml         # Single service, SQLite volume at ./data
├── deploy.sh                  # rsync-based deploy (doesn't work from corporate network)
└── .env                       # DEEPINFRA_API_KEY, PORT (not committed)
```

## Data Model

Three item types stored as `StoredItem` wrappers in `types.ts`:
- **VocabCard** (`type: 'vocab'`) — single word with definition, IPA, examples, etymology, mnemonics
- **SearchResult** (`type: 'phrase'`) — phrase/sentence with multiple VocabCards in `vocabs[]`
- **SentenceData** (`type: 'sentence'`) — saved example sentence linked to a word

Type guards: `isVocabItem()`, `isPhraseItem()`, `isSentenceItem()`
Helpers: `getItemTitle()`, `getItemSpelling()`, `getItemSense()`, `getItemImageUrl()`

## SQLite Schema

```sql
CREATE TABLE items (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL CHECK(type IN ('vocab', 'phrase', 'sentence')),
  data TEXT NOT NULL,          -- JSON blob (full item data including base64 images)
  srs TEXT NOT NULL,           -- JSON blob (SRS scheduling data)
  saved_at INTEGER NOT NULL,
  updated_at INTEGER,
  is_deleted INTEGER DEFAULT 0,
  is_archived INTEGER DEFAULT 0
);
```

Images are stored as base64 data URIs inline in `data.imageUrl`. The `/api/items` endpoint strips images by default for fast loading; use `?images=true` to include them.

## Sync Behavior

- On app load: `GET /api/items` → merge with local IndexedDB → display
- On save (5s debounce): `PUT /api/items` → push dirty items to server
- SRS updates, deletions, archives: immediate push (bypass debounce)
- Saves on `visibilitychange` and `beforeunload` (background safety)
- Per-item dirty tracking via `lastSyncedHash` content hashing
- `mergeDatasets()` in `sync.ts` handles conflict resolution (most recent wins)

## Critical Pattern: Stale Closure Prevention

`App.tsx` uses `latestItemsRef` (ref updated via `useEffect`) so event handlers get current data instead of stale closure state. Always use `latestItemsRef.current` in event handlers.

## Storage Keys

- IndexedDB: `PopDictDB` → `library` store → key `items_vps`
- localStorage cache: `vps_items_cache` (lightweight, no images)
- One-time cleanup flag: `vps_clean_v2` (nukes old Firebase-era storage on first load)

## Environment

- `.env` file at project root (not committed):
  - `DEEPINFRA_API_KEY` — required for AI analysis and image generation
  - `REPLICATE_API_TOKEN` — optional fallback for image generation
  - `PORT` — server port (default: 3001 local, 3000 in Docker)
  - `DATA_DIR` — SQLite database directory (default: ./data)
- VPS: Ubuntu 22.04, 1 CPU, 1GB RAM, Docker
- VPS IP: 107.152.47.101, app on port 3000
- GitHub repo: github.com/younotafish/DictProp-VPS (public)
- GitHub CLI: `/Users/cjs/DictProp/.gh` (authenticated as younotafish)

## Testing

For local verification, use Node.js fetch-based smoke tests (Playwright Chromium crashes on this machine). Start both servers, then run the smoke test script to verify health, CRUD, proxy, and bundle integrity.
