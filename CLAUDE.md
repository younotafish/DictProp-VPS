# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

DictProp is an AI-powered vocabulary learning web app for English learners. Users search words/phrases, get AI-generated analysis (definitions, etymology, mnemonics, examples), and review them with spaced repetition.

**This is the VPS fork** — self-hosted on a personal VPS with Hono + SQLite, replacing the original Firebase version. The Firebase version at dictpropstore.web.app continues running untouched.

- **Domain**: https://dictprop.online (Caddy reverse proxy with auto-HTTPS)
- **VPS**: 107.152.47.101, Ubuntu 22.04, 2 vCPUs, 2GB RAM, 60GB SSD, Docker
- **GitHub**: github.com/younotafish/DictProp-VPS (public)

## CRITICAL: Network & Environment Constraints

### System-level firewall blocks outbound from Node.js
- `ssh`, `node` native `fetch`, and direct TCP connections to external IPs are **blocked** by a system-level firewall (not network-level — persists across WiFi networks)
- `curl` works because it goes through the corporate HTTP proxy at `localhost:10054`
- **ALL outbound HTTP in server code MUST use `proxyFetch()`** from `server/src/proxy-fetch.ts` — NEVER use native `fetch()` in server routes
- The proxy is auto-detected from `HTTPS_PROXY` env var; on VPS (no proxy) it falls back to native fetch

### Cannot SSH to VPS from Claude Code
- SSH, SCP, rsync to `107.152.47.101` are all blocked
- **GitHub is the bridge**: push code → GitHub Actions deploys to VPS automatically
- NEVER attempt `ssh`, `scp`, or `rsync` to the VPS — it will always fail with EPERM

### Automated verification
- `npm run check` runs strict client/server type checks, Node tests, both builds, the bundle budget, and service-worker syntax validation
- Keep curl-based production-server smoke tests for route/header behavior (see Local Verification below)
- Browser-driven testing isn't viable here anyway: Chromium headless shell segfaults (SIGSEGV) on this macOS machine

## Deploy Flow (Fully Automated)

```bash
# 1. Make changes, test locally
# 2. Commit and push:
git add <files> && git commit -m "description" && git push vps main

# 3. GitHub Actions (.github/workflows/deploy.yml) runs three jobs, ~5 minutes in all:
#    - verify: npm run check
#    - build-image: builds the multi-stage Dockerfile and pushes ghcr.io/younotafish/dictprop-vps:<sha>
#    - deploy: SSHs into the VPS (host key pinned), backs up the database, pulls that image and swaps it in;
#      if the new container fails its health check, the previous image comes back
```

To check deploy status:
```bash
/Users/cjs/DictProp-VPS/.gh run list --repo younotafish/DictProp-VPS --limit 1
/Users/cjs/DictProp-VPS/.gh run view <RUN_ID> --repo younotafish/DictProp-VPS     # lists the job IDs
/Users/cjs/DictProp-VPS/.gh api repos/younotafish/DictProp-VPS/actions/jobs/<JOB_ID>/logs
```
`run view --log` prints nothing from this sandbox, so fetch a job's log through the API instead.

**IMPORTANT**: The git remote for VPS is named `vps`, not `origin`. Use `git push vps main`.
- `origin` = git@github.com:younotafish/DictProp.git (old Firebase repo, do NOT push here)
- `vps` = https://github.com/younotafish/DictProp-VPS.git (VPS fork)

### GitHub CLI
- Located at `/Users/cjs/DictProp-VPS/.gh` (not on PATH)
- Authenticated as `younotafish` with `workflow` scope
- Use for: checking deploy status, managing secrets, repo operations

## Development Setup

Two processes needed locally:

```bash
# Terminal 1: Backend (port 3001)
cd server && npm run dev

# Terminal 2: Frontend (port 3000, proxies /api → 3001)
npm run dev
```

Open http://localhost:3000. Vite proxies `/api/*` to the Hono backend.

### Local Verification

After making changes, verify with curl-based tests:
```bash
# Start both servers, then:
curl http://localhost:3001/api/health                    # Backend alive
curl http://localhost:3001/api/items | python3 -c "..."  # Items count
curl -X POST http://localhost:3001/api/analyze ...       # AI search works
```

## Commands

```bash
# Frontend
npm run dev              # Vite dev server (port 3000)
npm run build            # Production build to dist/
npm run check            # Full release gate

# Server (run from server/ directory)
npm run dev              # Hono dev server with hot reload (port 3001)
npm run build            # TypeScript compile to server/dist/
npx tsc --noEmit         # Server type-check (frontend: use `npm run build`)

# Deploy
git push vps main        # Triggers GitHub Actions → auto-deploy to VPS

# Check deploy status
/Users/cjs/DictProp-VPS/.gh run list --repo younotafish/DictProp-VPS --limit 1
```

### IMPORTANT: Type-checking
- Server: `cd server && npx tsc --noEmit`
- Frontend: `npm run typecheck` (strict) plus `npm run build`

## Project Structure

```
├── App.tsx                    # Root component (~500 lines): wires the hooks to screens, overlays and toasts
├── types.ts                   # StoredItem, VocabCard, SearchResult, SRS types
├── services/
│   ├── api.ts                 # REST + AI client for the Hono backend
│   ├── auth.ts                # Client auth helpers (calls /api/auth/*)
│   ├── storage.ts             # Per-item IndexedDB v4 storage + compatibility journal
│   ├── sync.ts                # mergeDatasets() for local↔server conflict resolution
│   ├── srsAlgorithm.ts        # Deterministic FSRS v6 + lazy legacy migration
│   ├── reviewQueue.ts         # Durable idempotent review outbox (one localStorage key per review) + refused-review log
│   ├── appUpdate.ts           # New-version detection and the flush-then-reload flow
│   ├── libraryImages.ts       # Image marker helpers for lazy and offline images
│   ├── mergeDuplicates.ts     # Duplicate-card merging
│   ├── speech.ts              # Browser speech synthesis
│   └── logger.ts              # Console logging (silenced in production)
├── server/
│   ├── src/
│   │   ├── index.ts           # Process startup and graceful shutdown
│   │   ├── app.ts             # Injectable Hono app, middleware, routes, static serving
│   │   ├── db.ts              # SQLite schema + CRUD (better-sqlite3)
│   │   ├── env.ts             # Environment variables (.env from project root)
│   │   ├── proxy-fetch.ts     # MUST use for ALL outbound HTTP (proxy-aware)
│   │   ├── middleware/auth.ts # requireAuth — session-cookie gate for /api/*
│   │   └── routes/
│   │       ├── auth.ts        # /api/auth/* — Google OAuth login + session
│   │       ├── items.ts       # GET/PUT/DELETE /api/items, POST /api/import
│   │       └── ai.ts          # /api/analyze, /api/compare, /api/extract-vocabulary, /api/transcribe
│   └── package.json
├── views/                     # Notebook, StudyEnhanced, SentencesView, DetailView, ComparisonView
├── components/                # UI components (incl. UserMenu — Google auth is active)
├── hooks/                     # App state and behavior, split out of App.tsx:
│   ├── useLibrary.ts          # The library in memory: latestItemsRef, updateItems(), pushNow(), pulls
│   ├── useLibrarySync.ts      # Device load/save, first sync, background pulls, debounced pushes, flush before sign-out/reload
│   ├── useLibraryActions.ts   # Save, delete, archive and reset handlers
│   ├── useReviewOutbox.ts     # Review outbox drain and refused reviews
│   ├── useUndoOffer.ts        # The undo toast for deletes, archives and resets
│   └── ...                    # Detail view, overlays, offline images, batch import, shortcuts, keyboard/gestures
├── scripts/offline/           # The Mac's enrichment cycle and the encrypted bridge to production (see Offline Data Bridge)
├── Dockerfile                 # Multi-stage: npm ci + vite build + tsc inside Docker
├── docker-compose.yml         # Single service, SQLite volume at ./data
├── .github/workflows/deploy.yml  # Auto-deploy on push to main
└── .env                       # DEEPINFRA_API_KEY, PORT (not committed)
```

## Data Model

Three item types stored as `StoredItem` wrappers in `types.ts`:
- **VocabCard** (`type: 'vocab'`) — single word with definition, IPA, examples, etymology, mnemonics
- **SearchResult** (`type: 'phrase'`) — phrase/sentence with multiple VocabCards in `vocabs[]`
- **SentenceData** (`type: 'sentence'`) — saved example sentence linked to a word

Type guards: `isVocabItem()`, `isPhraseItem()`, `isSentenceItem()`

## SQLite & Images

Images are stored as binary blobs in the server `image_blobs`/`item_images` tables and in a separate browser IndexedDB store. Item JSON carries only image markers.

- `GET /api/items` — always strips images for fast loading (~3MB response)
- `GET /api/items?images=true` — rejected; bulk image responses are disabled
- `GET /api/items/:id` — single item with images
- `GET /api/items/:id/image` — binary image endpoint used by lazy loading
- `POST /api/import` — bulk import endpoint (used for Firebase migration)

### IMPORTANT: Response size awareness
The full dataset with images is ~150MB. NEVER return all items with images in a single response — the browser will hang parsing it. The `stripImages` default in `db.ts` exists for this reason.

## Sync Behavior

- On app load: `GET /api/items` (no images) → merge with local IndexedDB → display
- On save (5s debounce): bounded `PUT /api/items` batches push dirty items
- Visible clients pull paginated server-revision deltas every 8 seconds and on focus/reconnect/tab signals
- Reviews use a local outbox plus atomic `POST /api/reviews/apply`; retries are idempotent
- Deletions, archives and SRS resets stay on the device while their 6-second undo toast is open (`undoOfferRef` in `pushNow`), then push at once
- Per-item dirty tracking via `lastSyncedHash` content hashing

## Offline Data Bridge

Enrichment runs on this Mac (`scripts/offline/`, LaunchAgent `com.dictprop.incremental-example-enrichment`, every six hours) and reaches production only through GitHub, since the Mac can't SSH to the VPS. The repository is public, so everything that crosses is encrypted by `scripts/offline/bridge-crypto.mjs`: AES-256-GCM under a key derived from the `SENTENCE_BRIDGE_KEY` secret, bound to the operation it was made for.

- **Exports** (production → Mac): `sentence-backfill.yml` leaves an encrypted artifact that expires within a day; the run's log shows only its size and hash.
  ```bash
  ./.gh workflow run sentence-backfill.yml --repo younotafish/DictProp-VPS --ref main -f operation=corpus-export   # saved sentences: operation=export
  (umask 077 && GH_BIN=./.gh scripts/offline/fetch-workflow-export.sh <run-id> corpus-export <out.json>)       # saved sentences: sentence-export
  ```
  The fetch decrypts the artifact and checks the JSON, then deletes the artifact and the run's log. An export is plaintext production data: keep it out of the repository and delete it when done.
- **Imports** (Mac → production): the publisher uploads an encrypted release asset; the workflow decrypts it on the runner, for that operation and release tag only, and streams it to the VPS through `scripts/offline/vps-ssh.sh`, which trusts only the pinned host keys.
- `~/.config/dictprop/sentence_bridge_key` must match the `SENTENCE_BRIDGE_KEY` secret. To rotate: write a new key to the file (mode 0600), set the secret from the file, and fetch an export to check both.
- A cycle runs only the code at `vps/main`, the code GitHub deployed (`scripts/offline/vetted-checkout.sh`). A clean `main` behind it is fast-forwarded first, and when that changes the cycle's own code the cycle exits 75 so the next one runs the new code. Uncommitted changes to that code, local commits, another branch or a detached HEAD make it log why and exit 75.
- Each cycle sweeps what the bridge leaves behind (`scripts/offline/sweep-bridge-leftovers.sh`): releases idle for six hours, failed waves idle for a week, the archives of published waves, and the plaintext temp files a killed decryption leaves under `data/offline-backfill` once a day old. No publisher waits longer than five hours (`cap_publish_deadline` in `deadline.sh`), so the sweep never takes a live release.
- Before a deploy, an export or a publish by hand, check that no cycle is running and hold its lock, `data/offline-backfill/incremental-example-enrichment/.cycle.lock` (`shlock`). Afterwards, `launchctl kickstart` the agent. Never `launchctl bootout` it: the sandbox can't bootstrap it again.

## Critical Patterns

### Stale Closure Prevention
`hooks/useLibrary.ts` owns `latestItemsRef`. Every library change goes through `updateItems()`/`replaceItem()`, which set the ref before returning, so the next handler, IndexedDB write or push sees the change. Always read `latestItemsRef.current` in event handlers and async work, not a closure-captured `savedItems`.

### Storage Keys (per-origin)
- IndexedDB: `PopDictDB` v4 → `items_v2` per-item records; `item_updates` is the rollback-compatible journal
- localStorage holds only small state (the `review_mutations_pending_*` outbox, settings); never mirror the library there — it doesn't fit, and stripped copies once overwrote full items on the server
- **Each domain/origin has separate browser storage** — data on `localhost:3000` is separate from `dictprop.online` and `107.152.47.101:3000`

### Docker Build Pitfalls
- `canvas` npm package (used only by `generate-icons.js`) requires Python + native build tools — excluded from the image via `npm pkg delete` in the Dockerfile
- Rollup needs platform-specific binaries — do NOT use `--ignore-scripts` with npm ci
- VPS has 2GB RAM, but local Docker builds can still OOM. Keep swap available: `fallocate -l 2G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile`

### Caddy (HTTPS)
- Caddyfile at `/etc/caddy/Caddyfile` on VPS
- Auto-provisions Let's Encrypt certificates
- If cert fails, clear stale state: `caddy stop && rm -rf /var/lib/caddy/.local/share/certmagic && systemctl start caddy`
- Caddyfile must NOT have leading whitespace in domain names (heredoc indentation can cause `eof` identifier errors)
- `www.dictprop.online` reaches the app, which redirects it to the apex with a 308 (`server/src/canonical-host.ts`), so sign-in cookies live on one origin

## Environment

- `.env` file at project root (not committed):
  - `DEEPINFRA_API_KEY` — required for immediate AI analysis, speech, and transcription (the VPS never generates images or detailed explanations)
  - `PORT` — server port (default: 3001 local, 3000 in Docker)
  - `DATA_DIR` — SQLite database directory (default: ./data)
  - `PUBLIC_ORIGIN` — optional canonical OAuth origin (production safely defaults to `https://dictprop.online`)
  - `OWNER_GOOGLE_EMAIL` — owner allowlist for bootstrapping a fresh database; existing deployments also require the first admin account
- VPS `.env` is at `/opt/dictprop-vps/.env` (not managed by git)
- GitHub Actions secret `VPS_SSH_KEY` — VPS SSH private key for automated deploys
