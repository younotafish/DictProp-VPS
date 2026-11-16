# scripts/offline

This folder is the Mac's side of DictProp. It holds:

- the enrichment cycle that runs every six hours;
- the publishers that send the cycle's results to production in waves;
- the encrypted bridge that every transfer between the Mac and production goes through, by way of GitHub;
- the manual tools that build the essay, Real Life and audio content.

Run everything from the repository root. Each file in this folder has exactly one entry below, under the heading that says how it runs. An entry is a line that starts with ``- `name` — ``. `test/offline/offline-script-index.test.ts` fails when a file has no entry, or when an entry names a file that no longer exists. When you add a script, give it an entry; when you delete one, remove its entry.

## Setup

The cycle and every publisher call the GitHub CLI at `.tools/gh` under the repository root; set `GH_BIN` to use another. Git ignores `.tools/`, so the binary stays out of the public repository and a fresh clone has none: put a `gh` binary there and make it executable. The cycle refuses to start while that file is missing, empty or not executable. The binary the repository tracked as `.gh` until 2026-11-15 can be restored from its history:

    mkdir -p .tools && git cat-file blob f40102e:.gh > .tools/gh && chmod 755 .tools/gh

Some scripts import server modules from `server/src` to share their contracts with production. Plain `node` loads those TypeScript files by stripping their types, which is on by default from Node 22.18, so both `package.json` files ask for that version. Such a module imports nothing but `node:` builtins, since plain node can't map a relative `./x.js` import to its `.ts` file; `test/offline/offline-server-imports.test.ts` checks both.

## The cycle

The LaunchAgent `ops/launchd/com.dictprop.incremental-example-enrichment.plist` starts `run-incremental-example-enrichment.sh` every six hours. The paths in the stages below are relative to the cycle's root, `data/offline-backfill/incremental-example-enrichment/`. Each publishing step waits until production has imported what it sent. When a stage fails without crashing, the runner logs it and usually carries on with the remaining stages, and the cycle then exits 1. To find where the runner calls a script, search the runner for the script's name.

1. **Guards.**
   - `vetted-checkout.sh` refuses to run code that differs from `vps/main`, or to run it on packages that differ from its lockfiles.
   - `sweep-bridge-leftovers.sh` clears what killed runs left behind.
   - `check-structured-model.mjs` checks that the model answers, before any production data is exported.
2. **Export.**
   - The runner dispatches `sentence-backfill.yml` with `operation=corpus-export`.
   - `fetch-workflow-export.sh` then decrypts that run's artifact into `current-corpus.json`.
3. **Vocabulary.**
   - `prepare-incremental-vocab-source.mjs` reads `current-corpus.json` and writes `vocabulary/source.json`.
   - `complete-corpus-fields.mjs` reads that and writes `vocabulary/completed.json`.
   - `dispatch-staged-corpus-audit.sh` publishes the completed records. Once production has them, later stages read them as an overlay on the corpus.
4. **Saved sentences.**
   - `server/src/scripts/prepare-incremental-saved-sentence-source.ts` reads `current-corpus.json` and writes `saved-sentences/source.json`.
   - `failure-ledger.mjs filter-sentences` writes `saved-sentences/cycle-source.json`.
   - `reconcile-sentence-analyses.mjs` compares that source with `saved-sentences/analysis-cache.json` and writes `saved-sentences/final-reconciliation/`.
   - `enrich-sentences.mjs` writes analyses for the sentences in that folder's `missing-source.json`, and reconciliation runs again.
   - `dispatch-staged-saved-sentence-analyses.sh` publishes the cache.
5. **Saved-item images.**
   - `prepare-incremental-item-images.mjs` reads the corpus, the saved-sentence analyses and the vocabulary overlay. It writes `item-images/targets.json` and `item-images/manifest.json`.
   - `failure-ledger.mjs filter-image-targets` writes `item-images/cycle-targets.json`.
   - `run-streaming-image-quality-loop.sh` renders each image, has it judged, and puts the accepted ones in `item-images/images/`.
   - `failure-ledger.mjs record-image-outcomes` records the deferred images.
   - `dispatch-staged-offline-images.sh` publishes the accepted images.
6. **Example-sentence analyses.**
   - `build-example-sentence-pool.mjs` reads the corpus and the overlay and writes `current-source.json`.
   - `prepare-incremental-example-source.mjs` compares that with the baseline pool's `source.json` (`data/offline-backfill/example-sentence-pool/`) and writes `unfiltered-source.json`.
   - `failure-ledger.mjs filter-sentences` writes `source.json`.
   - `merge-sentence-analysis-manifests.mjs` joins the baseline's analyses and `analysis-cache.json` into `combined-analysis-cache.json`.
   - `reconcile-sentence-analyses.mjs`, `enrich-sentences.mjs` and a second reconciliation write `final-reconciliation/final-analysis.json`, which is then merged back into `analysis-cache.json`.
   - `verify-example-sentence-pool.mjs` checks the analyses.
   - `dispatch-staged-example-analyses.sh` publishes them.
7. **Example images.**
   - `prepare-sentence-images.mjs` reads `source.json` and `final-analysis.json`. It writes `final-images/targets.json` and `final-images/manifest.json`, and links in images that the baseline already accepted.
   - The ledger filter, the image loop and the outcome record run as in stage 5.
   - `verify-example-sentence-pool.mjs` checks the analyses together with the images.
   - `dispatch-staged-example-enrichments.sh` publishes each sentence's analysis and image together.
8. **Summary.**
   - `failure-ledger.mjs summary` logs the items that are waiting out a backoff.

- `run-incremental-example-enrichment.sh` — Runs the whole cycle, in the stage order above, and holds `.cycle.lock` while it runs. Every model stage uses `ENRICHMENT_MODEL_PROVIDER` (`claude` or `codex`).
  `scripts/offline/run-incremental-example-enrichment.sh [root] [baseline-source.json] [baseline-image-root] [required-deploy-sha]`
- `vetted-checkout.sh` — Sourced by the runner. If the checkout is a clean `main` behind `vps/main`, it fast-forwards it. The runner exits 75 when the code it runs has uncommitted changes, when the checkout has a local commit, is on another branch or has a detached HEAD, when the fast-forward changed that code, or when the root's or `server/`'s `node_modules` differs from its `package-lock.json`.
- `check-installed-dependencies.mjs` — Checks that each tree's installed packages are the versions its `package-lock.json` locks, reading each installed `package.json`. A package the lockfile marks optional may be missing, since npm skips the platform packages that don't fit the machine, and packages installed but not locked are ignored. When a tree differs, it exits 1 and names up to five differences. `vetted-checkout.sh` runs it for the repository root and `server/`, so once main moves to a commit that changes a lockfile, every cycle exits 75 until `npm ci` has run in that folder; run it holding the cycle lock.
  `node scripts/offline/check-installed-dependencies.mjs <tree>...`
- `deadline.sh` — Sourced by the runner and by most of the shell scripts it calls, so that no wait holds the cycle lock forever. It provides wall-clock deadlines; `run_bounded` and `run_stage`, which run a command in its own process group under a time limit; `gh_bounded` for GitHub CLI calls; and `cap_publish_deadline`.
- `sweep-bridge-leftovers.sh` — Deletes the leftovers of killed runs:
  - publisher releases that have been idle for six hours;
  - failed waves, a wave a past cycle left unpublished among them, once idle for a week (later cycles publish whatever of it production still lacks);
  - the archives of published waves;
  - the plaintext temp files that a killed decryption left, once they are a day old.

  `scripts/offline/sweep-bridge-leftovers.sh [--dry-run] <wave-state-root>...`
- `bridge-leftovers.mjs` — The sweep's decisions: which releases, waves and temp files count as leftovers.
  `node scripts/offline/bridge-leftovers.mjs <releases|local|temp-files> ...`
- `check-structured-model.mjs` — Sends one small request with an image through `structured-model.mjs`. If it fails, the cycle stops before it exports anything.
  `node scripts/offline/check-structured-model.mjs`
- `fetch-workflow-export.sh` — Fetches the encrypted artifact that a `sentence-backfill.yml` export run left and decrypts it, for that run only. It replaces the output only once the JSON parses, then deletes the artifact and the run's log.
  `GH_BIN=.tools/gh scripts/offline/fetch-workflow-export.sh <run-id> <corpus-export|sentence-export> <output.json>`
- `prepare-incremental-vocab-source.mjs` — Selects the words and phrases whose cards have missing fields or lack the advanced rewrite. Recently saved items come first. An item saved before the lookback window is selected only when it lacks a field other than its examples. Items still waiting out a failure backoff are skipped. Whether an item is archived for its usage audit is the server's rule, imported from `server/src/shared/usage-audit.ts`.
  `node scripts/offline/prepare-incremental-vocab-source.mjs <corpus-export.json> <output.json> [limit=8] [lookback-hours=168] [provider-filter]`
- `complete-corpus-fields.mjs` — Vocabulary completion. It asks the model for each selected card's missing fields and its advanced rewrite, and checks each answer against `vocab-card-contract.mjs`. A batch that keeps failing is halved until the failure is pinned to single cards, and a parent item is published whole or not at all.
  `node scripts/offline/complete-corpus-fields.mjs <corpus-manifest> <completed-manifest> [work-directory]`
- `reconcile-sentence-analyses.mjs` — Matches a sentence source against cached analyses. It writes `report.json` and `missing-source.json`, which lists the sentences that still need an analysis. Only when nothing is missing does it also write `final-analysis.json`.
  `node scripts/offline/reconcile-sentence-analyses.mjs <final-source.json> <base-analysis.json> <output-directory> [supplemental-analysis.json]`
- `enrich-sentences.mjs` — Sentence analysis. It asks the model for each sentence's detailed explanation, checks it against `sentence-analysis-contract.mjs`, and checkpoints each batch. Sentences that keep failing go into the failure ledger.
  `node scripts/offline/enrich-sentences.mjs <sentence-export.json> <manifest.json> [work-directory] [base-analysis.json]`
- `failure-ledger.mjs` — Items that keep failing a stage wait out a growing backoff, recorded in `failure-ledger.json`. This tool filters the sentences and image targets that are waiting one out, records image outcomes, and prints a summary. The text stages also import it.
  `node scripts/offline/failure-ledger.mjs <filter-sentences|filter-image-targets|record-image-outcomes|summary> <ledger> ...`
- `prepare-incremental-item-images.mjs` — Writes image targets, with their prompts, for the live saved sentences, words and phrases that have no image, or whose advanced rewrite has no matching local image yet. It also writes the manifest that the image dispatcher publishes. The manifest's hashes and the markers it checks are the server's own, imported from `server/src/corpus-hash.ts` and `server/src/local-enrichment-markers.ts`.
  `node scripts/offline/prepare-incremental-item-images.mjs <corpus-export.json> <sentence-analysis.json|-> <vocab-completion.json|-> <output-directory> [model]`
- `run-streaming-image-quality-loop.sh` — Each round renders the next numbered candidate for the targets that are still open, while `stream-image-quality-pass.mjs` judges the candidates as they appear. Rejected targets get a refined prompt for the next round. An image that fails `IMAGE_QUALITY_DEFER_AFTER` candidates is left for a later cycle, and its candidates are removed.
  `bash scripts/offline/run-streaming-image-quality-loop.sh <targets.json> <candidates-dir> <images-dir> <work-dir> [width=768] [height=432] [steps=6] [candidate=1] [chunk-size=128]`
- `generate-krea-candidates.py` — Renders numbered candidates for each target in the local mflux runtime, with Krea-2-Turbo by default. It skips candidates that are already complete, so a killed batch resumes where it stopped. A target's `seedRound` sets its seeds.
  `~/.cache/dictprop/mflux/bin/python scripts/offline/generate-krea-candidates.py <targets.json> <output-dir> [--candidates N] [--candidate-start N] [--model krea2] [--steps N] [--accepted-directory DIR]`
- `stream-image-quality-pass.mjs` — One judging pass of the loop. It sends chunks of candidates to `judge-image-candidates.mjs`, and sends the rejected targets to `refine-rejected-image-prompts.mjs`.
  `node scripts/offline/stream-image-quality-pass.mjs <targets.json> <candidates-dir> <images-dir> <work-dir> <refined-output.json> [candidate=1] [chunk-size=128]`
- `judge-image-candidates.mjs` — Asks the model whether each candidate teaches its target at a glance, and copies the accepted ones into the image directory.
  `node scripts/offline/judge-image-candidates.mjs <targets.json> <candidate-directory> <image-directory> <work-directory> [candidate-number=1]`
- `refine-rejected-image-prompts.mjs` — Asks the model to write a new prompt for each rejected target, based on why the judge rejected it.
  `node scripts/offline/refine-rejected-image-prompts.mjs <rejected-targets.json> <output.json> <work-directory>`
- `build-example-sentence-pool.mjs` — Gathers every example sentence on a vocabulary or phrase card in the corpus export, with the completed vocabulary records laid over the corpus. It writes one record per normalized sentence, with production's coverage flags. Sentences that the user saved are left out.
  `node scripts/offline/build-example-sentence-pool.mjs <corpus-export-or-manifest.json> <output.json> [local-vocab-overlay.json|-]`
- `prepare-incremental-example-source.mjs` — Keeps the sentences in the pool that production still lacks an analysis or an image for. A sentence keeps the identity the previous source gave it. A pool that has no production coverage is refused.
  `node scripts/offline/prepare-incremental-example-source.mjs <current-source.json> <baseline-source.json> <output.json> [previous-incremental-source.json]`
- `merge-sentence-analysis-manifests.mjs` — Joins analysis manifests into one. For each sentence, the newest analysis wins.
  `node scripts/offline/merge-sentence-analysis-manifests.mjs <output.json> <analysis.json>...`
- `verify-example-sentence-pool.mjs` — Checks that every sentence in the source has an analysis that is complete under the import contract. Given an image bundle, it also checks every image target and image file. With `ALLOW_DEFERRED_IMAGES=1`, a missing image is allowed.
  `node scripts/offline/verify-example-sentence-pool.mjs <source.json> <analysis.json> [image-bundle-directory]`
- `prepare-sentence-images.mjs` — Writes image targets for sentences that have no image, with prompts taken from their analyses, and the manifest. An image that a fallback directory already holds is linked in instead of rendered again.
  `node scripts/offline/prepare-sentence-images.mjs <sentence-export.json> <analysis-manifest.json> <output-directory> [model] [fallback-image-directory]...`
- `bootstrap-mflux-runtime.sh` — Installs the pinned mflux runtime that the image loop renders with. Run it once.
  `scripts/offline/bootstrap-mflux-runtime.sh [runtime-root]`

## Publishing

Each dispatcher splits its stage's results into waves. Its wave preparer leaves out the entries that earlier waves already published. The dispatcher encrypts each wave with `bridge-crypto.mjs` and hands it to `publish-backfill-release.sh`. The dispatcher's `*_STATE_ROOT` variable names the folder where it keeps the waves. When a wave's publication fails, the dispatcher sets the wave aside and puts its entries into a fresh wave on the next run.

- `wave-dispatch.sh` — Sourced by the six `dispatch-staged-*.sh` scripts: the published waves, opening a fresh wave (setting an abandoned one aside), sealing it for `import:<op>:<tag>`, its release, and handing it to `publish-backfill-release.sh`.
- `publish-backfill-release.sh` — Uploads one encrypted wave to the release its dispatcher created. It waits for the required deploy, and dispatches that deploy itself if no deploy run exists. It then dispatches `sentence-backfill.yml`'s import, waits for the import to finish, and deletes the release.
  `scripts/offline/publish-backfill-release.sh <release-tag> <encrypted-archive> <asset-name> <operation> <required-deploy-sha> [poll-seconds]`
- `dispatch-staged-corpus-audit.sh` — Publishes vocabulary records with `corpus-import`.
  `GH_BIN=.tools/gh scripts/offline/dispatch-staged-corpus-audit.sh <source-manifest.json> [batch-size=500] [required-deploy-sha]`
- `prepare-corpus-audit-wave.mjs` — The corpus-audit wave preparer.
  `node scripts/offline/prepare-corpus-audit-wave.mjs <source-manifest.json> <output-directory> [max-entries=500] [published-manifest.json ...]`
- `dispatch-staged-saved-sentence-analyses.sh` — Publishes saved-sentence analyses with `import`.
  `GH_BIN=.tools/gh scripts/offline/dispatch-staged-saved-sentence-analyses.sh <analysis.json> [batch-size=5000] [required-deploy-sha]`
- `prepare-saved-sentence-analysis-wave.mjs` — The saved-sentence analysis wave preparer.
  `node scripts/offline/prepare-saved-sentence-analysis-wave.mjs <analysis.json> <output-directory> [max-entries=5000] [published-manifest.json ...]`
- `dispatch-staged-example-analyses.sh` — Publishes example-sentence analyses ahead of their images, with `enrichment-import`.
  `GH_BIN=.tools/gh scripts/offline/dispatch-staged-example-analyses.sh <pool-root> [batch-size=2000] [required-deploy-sha]`
- `prepare-example-analysis-wave.mjs` — The example-analysis wave preparer.
  `node scripts/offline/prepare-example-analysis-wave.mjs <source.json> <analysis.json> <output-directory> [max-entries=2000] [published-manifest.json ...]`
- `dispatch-staged-example-enrichments.sh` — Publishes each example sentence's analysis and image together, with `enrichment-import`. The pool root holds `source.json`, `final-reconciliation/final-analysis.json` and `final-images/`.
  `GH_BIN=.tools/gh scripts/offline/dispatch-staged-example-enrichments.sh <pool-root> [batch-size=100] [required-deploy-sha]`
- `prepare-example-enrichment-wave.mjs` — The example-enrichment wave preparer.
  `node scripts/offline/prepare-example-enrichment-wave.mjs <source.json> <analysis.json> <image-bundle-directory> <output-directory> [max-entries=100] [published-manifest.json ...]`
- `dispatch-staged-offline-images.sh` — Publishes images for saved words, phrases and sentences, with `image-import`.
  `GH_BIN=.tools/gh scripts/offline/dispatch-staged-offline-images.sh <source-root> [batch-size=100] [required-deploy-sha]`
- `prepare-offline-image-wave.mjs` — The image wave preparer.
  `node scripts/offline/prepare-offline-image-wave.mjs <source-directory> <output-directory> [max-entries=100] [published-manifest.json ...]`

## The bridge

The repository is public, so everything that crosses it is encrypted. `sentence-backfill.yml` runs these scripts on a GitHub runner, because the Mac can't reach the VPS.

- `bridge-crypto.mjs` — Encrypts and decrypts bridge bundles with AES-256-GCM, under a key derived from `SENTENCE_BRIDGE_KEY`. Each bundle is bound to the operation it was made for. Both the workflow and the Mac's dispatchers and fetcher use it.
  `node scripts/offline/bridge-crypto.mjs <encrypt|decrypt> --purpose <label> --out <file> [--in <file>] [--key-file <file>] [--gunzip]`
- `bridge-export.sh` — Runs on the runner. It streams an export from the VPS through `vps-ssh.sh` straight into the cipher, so no plaintext reaches the log or the disk.
  `REMOTE_SCRIPT=... bash scripts/offline/bridge-export.sh <artifact> <output>`
- `bridge-import.sh` — Runs on the runner. It downloads one release asset, decrypts it for that operation and release tag only, and streams it to the VPS.
  `RELEASE_TAG=... REMOTE_SCRIPT=... bash scripts/offline/bridge-import.sh <operation> <asset>`
- `vps-ssh.sh` — Runs one script on the VPS over OpenSSH, trusting only the host keys pinned in `VPS_KNOWN_HOSTS`.
  `bash scripts/offline/vps-ssh.sh <remote-script>`

## Shared modules

These modules are imported by other scripts and never run on their own.

- `offline-io.mjs` — `readJson`, `writePrivateJson` (a temp file renamed into place, mode 0600) and `linkOrCopy`.
- `atomic-file.mjs` — `writeFileAtomic`, `writeJsonAtomic` and `copyFileAtomic`, which write a private temp file beside the target and rename it over it, and `fileReady`, which treats an empty file as missing.
- `model-stage.mjs` — What the four model stages share: their settings, lifecycle and worker pool, the cached batch request with its three attempts, the halving of a batch that fails as a whole, and the pruning of cached batches older than two weeks.
- `vocab-completion.mjs` — The vocabulary-completion stage's own logic: which cards need work, what is sent for each, how an answer is checked and how it is merged into its card. `complete-corpus-fields.mjs` runs it. The source hash and the archive rule it writes are the server's own, imported from `server/src/corpus-hash.ts` and `server/src/shared/usage-audit.ts`.
- `sentence-analysis-checks.mjs` — The sentence-analysis stage's own logic: the records it sends and the checks a fresh analysis must pass, which are stricter than the import contract. `enrich-sentences.mjs` runs it.
- `image-review.mjs` — The image judge's and the prompt refiner's own logic: the records each sends and how each reads the model's answer. `judge-image-candidates.mjs` and `refine-rejected-image-prompts.mjs` run it.
- `wave-manifests.mjs` — The wave preparers' common parts: parsing the entry cap, reading earlier waves' published manifests, writing a wave's manifest, and printing its summary. Its header documents each wave's manifest.
- `sentence-pool.mjs` — Sentence identity: lookup normalization, the hashes, example ids, image filenames, and the shape of a pool record. The normalization, the hashes and the ids are the server's own, imported from `server/src/sentence-lookup.ts`.
- `image-model.mjs` — The label of the default local image model.
- `themed-collection-codex.mjs` — The `codex exec` call that the two themed-collection tools share.
- `structured-model.mjs` — Sends one schema-bound request to Claude Code or Codex, whichever `ENRICHMENT_MODEL_PROVIDER` selects.
- `codex-process.mjs` — Starts and stops `codex` child processes, and stops them when the parent gets a signal.
- `vocab-card-contract.mjs` — What a complete vocabulary card is. Both the vocabulary selector and the completion stage use it.
- `sentence-analysis-contract.mjs` — The detailed analysis schema and prompt, and the repairs for grammar excerpts. The import contract for sentence analyses is the server's own, imported from `server/src/sentence-analysis.ts`.
- `local-advanced-enrichment.mjs` — Writes the `advancedEnrichment` marker, which ties a card's advanced rewrite to a hash of its content. The hash, and what makes a marker current, are the server's own, imported from `server/src/local-enrichment-markers.ts`.

## Manual content tools

These tools are not part of the cycle. Run them by hand.

Essays:

- `build-essay-sentence-pool.mjs` — Builds an example-sentence source from `content/essay-catalog.json`, which `scripts/build-essay-catalog.mjs` generates. You can limit it to some essays.
  `node scripts/offline/build-essay-sentence-pool.mjs content/essay-catalog.json <output.json> [essay-id[,essay-id...]]`
- `run-essay-enrichment.sh` — Runs one essay through the pool, analysis, images and verification. Its output root has the layout that `dispatch-staged-example-enrichments.sh` publishes.
  `scripts/offline/run-essay-enrichment.sh <essay-id> [output-root]`
- `build-private-essay-catalog.mjs` — Builds the reader catalog for essays that are not checked in, from a private manifest, and picks each sentence's focus word.
  `node scripts/offline/build-private-essay-catalog.mjs <manifest.json> <catalog.json>`
- `publish-private-essay-catalog.sh` — Checks that catalog with the server importer's own validation (`server/src/scripts/validate-private-essay-catalog.ts`, run with tsx), then encrypts it and publishes it with `essay-import`.
  `GH_BIN=.tools/gh scripts/offline/publish-private-essay-catalog.sh <catalog.json> [required-deploy-sha] [poll-seconds]`

Real Life (`content/real-life-catalog.json`):

- `generate-themed-sentence-collection.mjs` — Writes one Real Life collection from a brief in `content/research/*-brief.json`, with one bounded Codex call per section. A section that fails validation is retried. Add the result to the catalog by hand.
  `node scripts/offline/generate-themed-sentence-collection.mjs content/research/<name>-brief.json <collection.json> [work-directory]`
- `audit-themed-sentence-collection.mjs` — Has Codex review a generated collection against its brief. It writes the report only once the report passes its checks.
  `node scripts/offline/audit-themed-sentence-collection.mjs <collection.json> <brief.json> <report.json>`
- `build-real-life-sentence-pool.mjs` — Builds an example-sentence source from the Real Life catalog. You can limit it to some collections, or to one section.
  `node scripts/offline/build-real-life-sentence-pool.mjs content/real-life-catalog.json <output.json> [collection-id[,collection-id...]] [section-id]`
- `generate-real-life-audio.py` — Renders the catalog's sentences with Qwen3-TTS, aligns their words, and checkpoints each clip under `data/offline-backfill/real-life-qwen3-audio/`. `content/research/offline-tts-evaluation.md` explains the choices.
  `<venv>/bin/python scripts/offline/generate-real-life-audio.py [--collection ID] [--style clear|casual|both] [--limit N] [--batch-size N]`
- `requirements-qwen-tts.txt` — The pinned Python packages that the Qwen TTS tools need on Apple Silicon.
  `python3 -m venv <venv> && <venv>/bin/pip install -r scripts/offline/requirements-qwen-tts.txt`
- `dispatch-staged-offline-audio.sh` — Publishes the rendered clips with `audio-import`.
  `GH_BIN=.tools/gh scripts/offline/dispatch-staged-offline-audio.sh [source-root] [batch-size=50] [required-deploy-sha]`
- `prepare-offline-audio-wave.mjs` — The audio wave preparer.
  `node scripts/offline/prepare-offline-audio-wave.mjs <source-root> <output-root> <limit> [published-manifest ...]`

## Research benchmarks

`content/research/offline-tts-evaluation.md` describes the listening study these tools render clips for.

- `generate-qwen-naturalness-benchmark.py` — Renders the connected-speech sentences with each Qwen recipe, for a blinded A/B test. It renders only the clips that are missing, unless you pass `--force`.
  `<venv>/bin/python scripts/offline/generate-qwen-naturalness-benchmark.py [--sentence-limit N] [--recipe ID] [--force]`
- `generate-mimo-naturalness-benchmark.mjs` — Renders the same sentences with the MiMo baseline, through curl, using `DEEPINFRA_API_KEY`.
  `node scripts/offline/generate-mimo-naturalness-benchmark.mjs [--output DIR] [--sentence-limit N]`
