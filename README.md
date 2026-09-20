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

- GitHub Actions runs `.github/workflows/incremental-enrichment.yml` at minute 23 every six hours. The VPS task is audit-only: it reads SQLite coverage, reports top-level and example-sentence gaps, and fails visibly when local repair work remains. It never invokes a text or image generation provider.
- macOS `launchd` runs `ops/launchd/com.dictprop.incremental-example-enrichment.plist` every 21,600 seconds. One resumable cycle fetches an encrypted production snapshot, repairs recent/structurally incomplete vocabulary cards and detailed sentence explanations with local MLX Qwen3, generates images with the local ERNIE image model, and judges those images with a local Qwen3-VL model. The recurring path sets Hugging Face offline mode and has no Codex, Claude, DeepInfra, or Replicate inference fallback.
- The encrypted corpus export carries both item image markers and per-example production coverage. The local bridge therefore repairs saved-word, phrase, saved-sentence, and example-sentence gaps without regenerating complete content. It keeps source, model checkpoints, publication waves, and image state under `data/offline-backfill/incremental-example-enrichment/`; optimistic hashes prevent an older local result from overwriting content edited after export.

Install the pinned MLX runtimes and local models once (about 23 GB of model weights):

```bash
scripts/offline/bootstrap-local-ai-runtime.sh
```

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
