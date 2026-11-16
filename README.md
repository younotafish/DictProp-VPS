# DictProp

DictProp is a vocabulary app for advanced English learners. You look up a word, phrase or sentence, get an AI-written card (meanings, Chinese, IPA, examples, etymology, a mnemonic, later a picture), save it, and review it with FSRS v6 spaced repetition, alongside sentence lessons and reading collections. This repository is the self-hosted version, an installable web app and a Hono + SQLite server on one VPS, live at [dictprop.online](https://dictprop.online).

[PRODUCT_SUMMARY.md](PRODUCT_SUMMARY.md) describes what the product does, feature by feature.

## Stack

| Part | What it uses |
|---|---|
| Client | React 19, TypeScript, Vite 6, Tailwind CSS 4; a service worker that precaches the app; IndexedDB for the library and pictures; `ts-fsrs` for scheduling; `kokoro-js` as an on-device fallback voice |
| Server | Hono on Node.js 22, SQLite through `better-sqlite3`, `jose` for Google sign-in tokens, `ts-fsrs` |
| Live AI (on the VPS) | DeepInfra: DeepSeek-V4-Flash for lookups, MiMo-V2.5 TTS for speech, Whisper large-v3-turbo for voice search; whisper.cpp (tiny.en) in the image for word timings |
| Offline enrichment (on the owner's Mac) | Claude Code (`claude-opus-5-5`) or Codex for card rewrites, sentence analyses and picture review; Krea-2-Turbo through mflux for pictures |
| Production | One Docker image built by GitHub Actions and pulled from GHCR, run by Docker Compose behind Caddy |

Server code makes outbound HTTP calls only through `proxyFetch()` in `server/src/proxy-fetch.ts`, which uses the local proxy when `HTTPS_PROXY` is set and native fetch otherwise. CLAUDE.md explains why.

## Local development

You need Node.js 22.18 or later in the 22 line (both `package.json` files require `>=22.18 <23`) and npm 10.

```bash
npm ci                 # on Linux, as CI does: ONNXRUNTIME_NODE_INSTALL_CUDA=skip npm ci
(cd server && npm ci)
cp .env.example .env   # then fill it in
```

`.env` lives at the repository root, and the server reads it from there:

| Variable | Purpose |
|---|---|
| `DEEPINFRA_API_KEY` | Lookups, comparisons, text analysis, speech and voice search. Without it those calls fail; the rest of the app works. |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | Google sign-in. |
| `OWNER_GOOGLE_EMAIL` | The one Google account allowed to sign in. On a fresh database, its first sign-in creates the admin account. |
| `DEV_AUTH_BYPASS=1` | Local only: skips Google sign-in and signs every request in as a local admin. The server then listens on 127.0.0.1 only, and it refuses to start with this set when `NODE_ENV=production`. |
| `PORT` | The server's port, 3001 by default. |
| `DATA_DIR` | Where the SQLite database lives, `data/` at the repository root by default. |
| `PUBLIC_ORIGIN` | Optional origin for the sign-in callback. |

Run the server and the client in two terminals:

```bash
npm run dev:server     # Hono on http://localhost:3001, restarting on changes
npm run dev            # Vite on http://localhost:3000, proxying /api to port 3001
```

Open http://localhost:3000. Vite listens on loopback unless `DEV_LAN=1`, and with `DEV_AUTH_BYPASS=1` the server does too. Browser storage is per origin, so the library on `localhost:3000` is separate from the one on dictprop.online.

## Checks

```bash
npm run check
```

`npm run check` is the release gate; the deploy workflow runs it on every push to `main`, and `check.yml` runs it on pull requests. In order, it runs:

- the client type check (`tsc --noEmit`, strict) and the server type check;
- the client, contract, offline-script and workflow tests in `test/`, then the server tests in `server/test/`;
- the client build (`vite build`) and the server build (`tsc -p server/tsconfig.build.json`);
- `scripts/check-bundle-budget.mjs`: the initial JavaScript must stay under 100 kB gzipped, and the service worker must precache every file the app needs to start offline;
- a syntax check of the service worker, `public/sw.js` and `dist/sw.js`.

```bash
npm run lint
```

`npm run lint` runs ESLint over the client, the server, the scripts and the tests. `npm run check` doesn't run it, so run it before you push and don't add warnings.

## Tests

Tests use Node's built-in test runner through `tsx`.

| Folder | Holds | Run with |
|---|---|---|
| `test/client/` | Client modules | `npm test` |
| `test/contracts/` | Agreements between client and server | `npm test` |
| `test/offline/` | `scripts/offline` | `npm test` |
| `test/workflows/` | Workflows, deploy files and configuration | `npm test` |
| `server/test/` | Server modules (no client imports) | `npm run test:server` |

Both suites preload `test/support/isolated-env.ts`, which gives every test process its own data folder and temp folder and keeps the real `.env`, GitHub CLI, bridge key and proxy out of reach. Run one file the same way:

```bash
npx tsx --import ./test/support/isolated-env.ts --test test/client/sync.test.ts
cd server && npx tsx --import ../test/support/isolated-env.ts --test test/db.test.ts
```

## Deploying

```bash
git push vps main
```

The production remote is `vps` (github.com/younotafish/DictProp-VPS). `origin` is the old Firebase repository; never push there.

A push to `main` starts `.github/workflows/deploy.yml`, about five minutes end to end:

1. **verify** runs `npm run check`.
2. **build-image** builds the `Dockerfile` and pushes `ghcr.io/younotafish/dictprop-vps:<sha>`.
3. **deploy** connects to the VPS over SSH with a pinned host key, backs up the database, pulls the image and swaps it in. If the new container fails its health check, the previous image comes back. After a healthy release it removes images no release runs.

A run deploys only its own commit, and only a commit on `main`, so a rollback is a revert commit. The other workflows in `.github/workflows/` run the encrypted data bridge, the six-hourly speech backfill and enrichment audit, the weekly dependency audit, off-site backups, production recovery and diagnosis, and the deploys of three static sites the owner hosts on the same VPS (Lake Loop, NZ Japan, SD Cards). CLAUDE.md describes the production workflows, and scripts/offline/README.md the bridge.

## Offline enrichment

The VPS answers a lookup at once with a card written by DeepSeek, but it never draws pictures or writes detailed sentence analyses. Those come from the owner's Mac: every six hours a LaunchAgent (`ops/launchd/com.dictprop.incremental-example-enrichment.plist`) runs `scripts/offline/run-incremental-example-enrichment.sh`. The cycle exports production's library as an encrypted GitHub artifact, has the model complete new cards with a one-time advanced rewrite and analyze saved and example sentences, renders pictures locally and has the model judge them, then publishes the results in encrypted waves that a workflow imports on the VPS. About once a week it also keeps an encrypted copy of production's database on the Mac. [scripts/offline/README.md](scripts/offline/README.md) documents every stage and script.

## Other documents

| Document | What it covers |
|---|---|
| [CLAUDE.md](CLAUDE.md) | How to work on and operate the project: network constraints, the deploy flow, project structure, sync rules, the offline data bridge, critical patterns |
| [PRODUCT_SUMMARY.md](PRODUCT_SUMMARY.md) | What the product does and how each flow behaves |
| [ops/RESTORE.md](ops/RESTORE.md) | Restoring production's database from the VPS's backup slot or an off-site copy |
| [scripts/offline/README.md](scripts/offline/README.md) | The enrichment cycle, its publishers, the encrypted bridge and the manual content tools |
