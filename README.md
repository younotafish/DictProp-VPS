# DictProp VPS

DictProp is a self-hosted vocabulary learning PWA for English learners. It generates word and phrase analysis with DeepInfra, stores the library in SQLite, and schedules reviews with FSRS v6.

Production: [dictprop.online](https://dictprop.online)

## Features

- AI definitions, examples, etymology, mnemonics, comparisons, and illustrations
- Independent scheduling for each saved sense with FSRS v6
- Due/new study sessions with meaning, production, cloze, and listening prompts
- `Again`, `Hard`, `Good`, and `Easy` grading with authoritative undo
- Offline-first IndexedDB storage and revision-based cross-device synchronization
- Durable, idempotent review outbox for reloads, retries, and concurrent devices
- Google OAuth, user-scoped SQLite data, and binary image storage
- Installable PWA with a generated core-module offline cache

## Stack

- React 19, TypeScript, Vite, Tailwind CSS
- Hono on Node.js 22
- SQLite via `better-sqlite3`
- `ts-fsrs` for deterministic FSRS v6 scheduling
- DeepInfra for text, image, speech, and transcription services
- Docker Compose behind Caddy in production

## Local Development

Requirements: Node.js 22 and npm 10.

```bash
npm ci
cd server && npm ci && cd ..
```

Create `.env` at the repository root:

```dotenv
DEEPINFRA_API_KEY=...
GOOGLE_CLIENT_ID=...
GOOGLE_CLIENT_SECRET=...
DEV_AUTH_BYPASS=1
PORT=3001
DATA_DIR=./data
```

Run the backend and frontend in separate terminals:

```bash
npm run dev:server
npm run dev
```

Open `http://localhost:3000`. Vite proxies `/api` to the server on port 3001.

## Verification

```bash
npm run check
```

The release check runs strict client/server type checks, route/database/storage tests, both production builds, service-worker syntax validation, and the 100 kB gzip initial-JavaScript budget.

## Data And Sync

- Library items use per-item IndexedDB records; the bounded compatibility journal supports rollback to the prior storage reader.
- Content changes use server revisions and paginated delta polling. BroadcastChannel signals make other tabs pull immediately.
- Reviews are appended and applied in one SQLite transaction. Event IDs make retries idempotent.
- Images are never returned with the full item dataset. They use separate binary endpoints and load on demand.
- The automatic image cache is limited to due-soon and recent cards. A full image pack is an explicit Notebook tool.
- Sentence review keeps the current lesson mounted and proactively warms the next five lessons' prepared analysis, images, audio, and word timings for unreliable connections.

## Deployment

Pushes to `main` run the GitHub Actions verification job before deployment. The VPS job creates an online SQLite backup, rebuilds the Docker service, checks readiness, and rebuilds the previous commit if the new release fails health checks.

```bash
git push vps main
```

Do not push this fork to the Firebase repository. The production remote is named `vps`.

## Scheduled Enrichment

- GitHub Actions runs `.github/workflows/incremental-enrichment.yml` at minute 23 every six hours. The production concurrency group prevents overlap with deploys and imports. Each run gives newly saved items a complete metadata-and-media pass, then drains the historical backlog of missing sentence explanations and generatable images until the queue is empty or its 70-minute deadline is reached; failed items do not block later batches. The run summary reports remaining gaps by content type plus exact prepared example-sentence analysis/image coverage, and the run fails if its actionable queue is not empty.
- macOS `launchd` runs `ops/launchd/com.dictprop.incremental-example-enrichment.plist` every 21,600 seconds. One resumable cycle enriches incomplete saved sentences with local GPT-5.5, then generates connected-speech IPA through independently bounded GPT, Claude, and Meta lanes. Each draft is reviewed by a different enabled model family before publication. Valid IPA output is checkpointed after every completed batch and reused on later cycles, so an exhausted provider batch cannot discard other workers' progress. `IPA_CODEX_CONCURRENCY`, `IPA_CLAUDE_CONCURRENCY`, `IPA_META_CONCURRENCY`, `IPA_BATCH_SIZE`, `IPA_CLAUDE_REQUEST_BATCH_SIZE`, and `IPA_META_REQUEST_BATCH_SIZE` control throughput; provider request sizes are bounded separately to avoid oversized structured-response stalls and resets. `IPA_DRAFT_PROVIDERS` can restrict drafting to selected enabled providers while retaining the others for cross-family review and fallback. Per-draft overrides such as `IPA_CODEX_REVIEW_PROVIDERS=meta,claude` control fallback review order. The cycle then prepares new vocab example sentences and images. A PID lock prevents duplicate cycles, and a cycle defers while another local sentence-analysis job is active.
- The encrypted corpus export carries per-example production coverage (analysis present and image present). The local bridge therefore repairs server-side gaps even for baseline sentences, reuses verified baseline analyses/images instead of regenerating them, and publishes only the content production reports missing. It keeps source, analysis-cache, publication-wave, and image state under `data/offline-backfill/incremental-example-enrichment/`. Publication identities include both item ID and sentence text hash, so interrupted runs resume and edited sentences can be republished safely.

Install or refresh the checked-in LaunchAgent definition with:

```bash
cp ops/launchd/com.dictprop.incremental-example-enrichment.plist \
  ~/Library/LaunchAgents/com.dictprop.incremental-example-enrichment.plist
launchctl bootout "gui/$(id -u)/com.dictprop.incremental-example-enrichment" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" \
  ~/Library/LaunchAgents/com.dictprop.incremental-example-enrichment.plist
launchctl print "gui/$(id -u)/com.dictprop.incremental-example-enrichment"
```

## Network Constraint

All outbound server HTTP must go through `server/src/proxy-fetch.ts`. It uses the configured corporate proxy locally and native fetch on the VPS; large proxied JSON bodies use its internal curl transport.
