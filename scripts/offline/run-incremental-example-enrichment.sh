#!/usr/bin/env bash

set -euo pipefail

ROOT="${1:-data/offline-backfill/incremental-example-enrichment}"
BASE_SOURCE="${2:-data/offline-backfill/example-sentence-pool/source.json}"
BASE_IMAGE_ROOT="${3:-data/offline-backfill/example-sentence-pool/final-images}"
BASE_ANALYSIS="${BASE_ANALYSIS:-$(dirname "$BASE_SOURCE")/final-reconciliation/final-analysis.json}"
REQUIRED_DEPLOY_SHA="${4:-$(git rev-parse HEAD)}"
GH_BIN="${GH_BIN:-./.gh}"
REPO="${GITHUB_REPOSITORY:-younotafish/DictProp-VPS}"
KEY_FILE="${SENTENCE_BRIDGE_KEY_FILE:-${XDG_CONFIG_HOME:-$HOME/.config}/dictprop/sentence_bridge_key}"
NODE_BIN="${NODE_BIN:-node}"
TSX_BIN="${TSX_BIN:-server/node_modules/.bin/tsx}"
ENRICHMENT_MODEL_PROVIDER="${ENRICHMENT_MODEL_PROVIDER:-claude}"
CLAUDE_MODEL="${CLAUDE_MODEL:-claude-opus-5-5}"
CLAUDE_REASONING_EFFORT="${CLAUDE_REASONING_EFFORT:-xhigh}"
CODEX_MODEL="${CODEX_MODEL:-gpt-5.6-sol}"
CODEX_REASONING_EFFORT="${CODEX_REASONING_EFFORT:-xhigh}"
# Same knob names as the sibling pipelines. The defaults are the scripts' own caps (16 text requests,
# 8 image judgments); the LaunchAgent leaves them unset so a new default applies without a reload.
ANALYSIS_CONCURRENCY="${ANALYSIS_CONCURRENCY:-16}"
IMAGE_QA_CONCURRENCY="${IMAGE_QA_CONCURRENCY:-8}"
# An image that fails this many candidates waits for the next cycle, which renders fresh ones; a long
# tail can take dozens of candidates and would hold back every accepted image.
IMAGE_MAX_CANDIDATES="${IMAGE_MAX_CANDIDATES:-8}"
# Local renderer for both image stages. In a side-by-side test on this Mac, Krea-2-Turbo drew the intended
# meaning far more often than ERNIE-Image-Turbo, at about 37 s instead of 8 s per image. A cycle renders
# tens of images, so accuracy outweighs speed. The bulk backfill keeps ERNIE for throughput.
IMAGE_MODEL="${IMAGE_MODEL:-krea2}"
IMAGE_MODEL_LABEL="${IMAGE_MODEL_LABEL:-krea/Krea-2-Turbo}"
IMAGE_MODEL_QUANTIZE="${IMAGE_MODEL_QUANTIZE:-}"
IMAGE_STEPS="${IMAGE_STEPS:-8}"
VOCAB_COMPLETION_BATCH_SIZE="${VOCAB_COMPLETION_BATCH_SIZE:-8}"
SENTENCE_ANALYSIS_BATCH_SIZE="${SENTENCE_ANALYSIS_BATCH_SIZE:-4}"
INCREMENTAL_VOCAB_BATCH_SIZE="${INCREMENTAL_VOCAB_BATCH_SIZE:-${LOCAL_VOCAB_BATCH_SIZE:-100}}"
INCREMENTAL_VOCAB_LOOKBACK_HOURS="${INCREMENTAL_VOCAB_LOOKBACK_HOURS:-${LOCAL_VOCAB_LOOKBACK_HOURS:-168}}"
INCREMENTAL_VOCAB_PROVIDER_FILTER="${INCREMENTAL_VOCAB_PROVIDER_FILTER:-}"
# Every wait below holds the cycle lock, so each one ends. A stage that runs out of time keeps the work
# it finished for the next cycle. The publishers' own limits suit a supervised bulk run; a cycle is
# retried six hours later.
TEXT_STAGE_TIMEOUT_SECONDS="${TEXT_STAGE_TIMEOUT_SECONDS:-10800}"
IMAGE_STAGE_TIMEOUT_SECONDS="${IMAGE_STAGE_TIMEOUT_SECONDS:-14400}"
CORPUS_EXPORT_WAIT_SECONDS="${CORPUS_EXPORT_WAIT_SECONDS:-7200}"
export PUBLISH_DEADLINE_SECONDS="${PUBLISH_DEADLINE_SECONDS:-7200}"
export DISPATCH_WAIT_DEADLINE_SECONDS="${DISPATCH_WAIT_DEADLINE_SECONDS:-3600}"
LOCK_FILE="$ROOT/.cycle.lock"
# Items that keep failing a stage wait out a growing backoff here instead of failing every cycle.
FAILURE_LEDGER="$ROOT/failure-ledger.json"
CURRENT_CORPUS="$ROOT/current-corpus.json"
CURRENT_POOL="$ROOT/current-source.json"
SOURCE="$ROOT/source.json"
UNFILTERED_SOURCE="$ROOT/unfiltered-source.json"
ANALYSIS_CACHE="$ROOT/analysis-cache.json"
COMBINED_ANALYSIS_CACHE="$ROOT/combined-analysis-cache.json"
RECONCILIATION="$ROOT/final-reconciliation"
IMAGE_ROOT="$ROOT/final-images"
IMAGE_TARGETS="$IMAGE_ROOT/cycle-targets.json"
PUBLISH_STATE="$ROOT/publish-state-coverage-v2"
ANALYSIS_PUBLISH_STATE="$ROOT/analysis-publish-state-coverage-v2"
SAVED_ROOT="$ROOT/saved-sentences"
SAVED_SOURCE="$SAVED_ROOT/source.json"
SAVED_CYCLE_SOURCE="$SAVED_ROOT/cycle-source.json"
SAVED_BASE_ANALYSIS="$SAVED_ROOT/current-base-analysis.json"
SAVED_ANALYSIS_CACHE="$SAVED_ROOT/analysis-cache.json"
SAVED_RECONCILIATION="$SAVED_ROOT/final-reconciliation"
SAVED_PUBLISH_STATE="$SAVED_ROOT/publish-state-detailed-v1"
VOCAB_ROOT="$ROOT/vocabulary"
VOCAB_SOURCE="$VOCAB_ROOT/source.json"
VOCAB_COMPLETED="$VOCAB_ROOT/completed.json"
ITEM_IMAGE_ROOT="$ROOT/item-images"
ITEM_IMAGE_TARGETS="$ITEM_IMAGE_ROOT/cycle-targets.json"

OFFLINE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$OFFLINE_DIR/deadline.sh"
. "$OFFLINE_DIR/vetted-checkout.sh"

case "$ENRICHMENT_MODEL_PROVIDER" in
  claude) MODEL_LABEL="Claude $CLAUDE_MODEL" ;;
  codex) MODEL_LABEL="Codex $CODEX_MODEL" ;;
  *)
    echo "ENRICHMENT_MODEL_PROVIDER must be claude or codex, not $ENRICHMENT_MODEL_PROVIDER" >&2
    exit 1
    ;;
esac
# Every model-calling stage, including the image loop's judge and prompt refiner, inherits this choice.
export ENRICHMENT_MODEL_PROVIDER CLAUDE_MODEL CLAUDE_REASONING_EFFORT CODEX_MODEL CODEX_REASONING_EFFORT
for setting in TEXT_STAGE_TIMEOUT_SECONDS IMAGE_STAGE_TIMEOUT_SECONDS CORPUS_EXPORT_WAIT_SECONDS \
  PUBLISH_DEADLINE_SECONDS DISPATCH_WAIT_DEADLINE_SECONDS; do
  if ! [[ "${!setting}" =~ ^[1-9][0-9]*$ ]]; then
    echo "$setting must be a positive integer" >&2
    exit 1
  fi
done

log() {
  printf '[%s] %s\n' "$(date -u +%FT%TZ)" "$*"
}

# The slowest request sets a text stage's wall time, so each stage spreads its sentences over every worker:
# one sentence per request until they outnumber the workers, then up to SENTENCE_ANALYSIS_BATCH_SIZE.
sentence_batch_size() {
  local size="$(( ($1 + ANALYSIS_CONCURRENCY - 1) / ANALYSIS_CONCURRENCY ))"
  if [ "$size" -gt "$SENTENCE_ANALYSIS_BATCH_SIZE" ]; then
    size="$SENTENCE_ANALYSIS_BATCH_SIZE"
  fi
  echo "$size"
}

# A stage that fails without crashing lets the rest of the cycle run, and the cycle still exits 1.
FAILED_STAGES=""
stage_failed() {
  FAILED_STAGES="${FAILED_STAGES:+$FAILED_STAGES, }$1"
  log "$1 did not complete this cycle"
}

finish_cycle() {
  log "$1"
  "$NODE_BIN" scripts/offline/failure-ledger.mjs summary "$FAILURE_LEDGER" || true
  if [ -n "$FAILED_STAGES" ]; then
    log "stages that did not complete this cycle: $FAILED_STAGES"
    exit 1
  fi
  exit 0
}

# Every later stage needs the model, so a model that stopped answering ends the cycle.
require_model() {
  if ! "$NODE_BIN" scripts/offline/check-structured-model.mjs; then
    finish_cycle "local $MODEL_LABEL stopped answering; ending this cycle"
  fi
}

# Text stages exit 3 when no item succeeded and 124 when they ran out of time; items that failed are in
# the failure ledger. Any other status is a crash and ends the cycle as before.
check_stage() {
  case "$2" in
    0) return 0 ;;
    3|124)
      stage_failed "$1"
      require_model
      return 1
      ;;
    *) exit "$2" ;;
  esac
}

mkdir -p "$ROOT"
if ! shlock -f "$LOCK_FILE" -p "$$"; then
  log "another incremental enrichment cycle is already running"
  exit 0
fi
cleanup() {
  stop_stage
  rm -f "$LOCK_FILE"
}
# A signal has to end the cycle; cleaning up and carrying on would run the rest without the lock.
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

# 75 (EX_TEMPFAIL) marks a refusal in the LaunchAgent log; the next cycle checks again.
if ! require_vetted_checkout; then
  log "refusing to run code that is not committed and on vps/main; exiting 75"
  exit 75
fi

ACTIVE_TEXT_JOBS="$(pgrep -f '[n]ode scripts/offline/(enrich-sentences|complete-corpus-fields)\.mjs' | tr '\n' ' ' || true)"
if [ -n "$ACTIVE_TEXT_JOBS" ]; then
  log "another local sentence-analysis job is active (pid ${ACTIVE_TEXT_JOBS% }); deferring this cycle"
  exit 0
fi

for required in "$GH_BIN" "$KEY_FILE" "$BASE_SOURCE" "$BASE_ANALYSIS" "$BASE_IMAGE_ROOT/targets.json" "$TSX_BIN"; do
  if [ ! -s "$required" ]; then
    echo "Required incremental enrichment input is missing: $required" >&2
    exit 1
  fi
done

# A publisher that was killed leaves its release, and the encrypted archive in it, on the public
# repository; this deletes publisher releases idle for six hours, which none of this cycle's publishers
# would still hold, and clears failed waves after a week and published waves' archives.
if ! GH_BIN="$GH_BIN" NODE_BIN="$NODE_BIN" GITHUB_REPOSITORY="$REPO" scripts/offline/sweep-bridge-leftovers.sh \
  "$PUBLISH_STATE" "$ANALYSIS_PUBLISH_STATE" "$SAVED_PUBLISH_STATE" \
  "$VOCAB_ROOT/publish-state" "$ITEM_IMAGE_ROOT/publish-state"; then
  log "the sweep of bridge leftovers did not finish; the next cycle tries again"
fi

log "checking that local $MODEL_LABEL can answer before exporting production data"
"$NODE_BIN" scripts/offline/check-structured-model.mjs

PREVIOUS_RUN_ID="$(gh_bounded run list \
  --repo "$REPO" --workflow sentence-backfill.yml --event workflow_dispatch --limit 1 \
  --json databaseId --jq 'if length == 0 then 0 else .[0].databaseId end')"
if ! [[ "$PREVIOUS_RUN_ID" =~ ^[0-9]+$ ]]; then PREVIOUS_RUN_ID=0; fi
# Only runs created after this dispatch qualify, so an older queued export is never taken for this one.
EXPORT_SINCE="$(utc_timestamp_ago 120)"
log "requesting a fresh encrypted production corpus export"
gh_bounded workflow run sentence-backfill.yml --repo "$REPO" --ref main -f operation=corpus-export

EXPORT_RUN_ID=""
DISCOVERY_DEADLINE="$(deadline_after 600)"
until [ -n "$EXPORT_RUN_ID" ] || deadline_passed "$DISCOVERY_DEADLINE"; do
  sleep 5
  while IFS= read -r candidate; do
    if gh_bounded run view "$candidate" --repo "$REPO" --json jobs \
      --jq '.jobs[] | select(.name == "corpus-export" and .conclusion != "skipped") | .name' 2>/dev/null \
      | grep -qx corpus-export; then
      EXPORT_RUN_ID="$candidate"
      break
    fi
  done < <(gh_bounded run list \
    --repo "$REPO" --workflow sentence-backfill.yml --event workflow_dispatch --limit 30 \
    --json databaseId,createdAt \
    --jq ".[] | select(.databaseId > $PREVIOUS_RUN_ID and .createdAt >= \"$EXPORT_SINCE\") | .databaseId" \
    2>/dev/null | sort -n)
done
if [ -z "$EXPORT_RUN_ID" ]; then
  echo "Could not identify the dispatched corpus export workflow" >&2
  exit 1
fi

log "waiting for corpus export run $EXPORT_RUN_ID"
EXPORT_DEADLINE="$(deadline_after "$CORPUS_EXPORT_WAIT_SECONDS")"
while :; do
  EXPORT_STATE="$(gh_bounded run view "$EXPORT_RUN_ID" --repo "$REPO" --json status,conclusion \
    --jq '[.status, .conclusion] | @tsv' 2>/dev/null || true)"
  IFS=$'\t' read -r EXPORT_STATUS EXPORT_CONCLUSION <<< "$EXPORT_STATE"
  if [ "$EXPORT_STATUS" = completed ]; then
    if [ "$EXPORT_CONCLUSION" != success ]; then
      echo "Corpus export run $EXPORT_RUN_ID ended as $EXPORT_CONCLUSION" >&2
      exit 1
    fi
    break
  fi
  if deadline_passed "$EXPORT_DEADLINE"; then
    echo "Corpus export run $EXPORT_RUN_ID did not finish within ${CORPUS_EXPORT_WAIT_SECONDS}s; ending this cycle" >&2
    exit 1
  fi
  sleep 10
done
# The run left the corpus as an encrypted artifact; fetching it deletes the artifact and the run's log.
GH_BIN="$GH_BIN" NODE_BIN="$NODE_BIN" SENTENCE_BRIDGE_KEY_FILE="$KEY_FILE" GITHUB_REPOSITORY="$REPO" \
  scripts/offline/fetch-workflow-export.sh "$EXPORT_RUN_ID" corpus-export "$CURRENT_CORPUS"

mkdir -p "$VOCAB_ROOT"
VOCAB_SOURCE_TMP="$VOCAB_SOURCE.tmp"
ENRICHMENT_FAILURE_LEDGER="$FAILURE_LEDGER" ENRICHMENT_FAILURE_STAGE=vocab \
"$NODE_BIN" scripts/offline/prepare-incremental-vocab-source.mjs \
  "$CURRENT_CORPUS" "$VOCAB_SOURCE_TMP" "$INCREMENTAL_VOCAB_BATCH_SIZE" "$INCREMENTAL_VOCAB_LOOKBACK_HOURS" \
  "$INCREMENTAL_VOCAB_PROVIDER_FILTER"
mv "$VOCAB_SOURCE_TMP" "$VOCAB_SOURCE"
VOCAB_COUNT="$($NODE_BIN -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1])).entries.length)' \
  "$VOCAB_SOURCE")"
VOCAB_OVERLAY="-"
if [ "$VOCAB_COUNT" -gt 0 ]; then
  log "creating advanced $MODEL_LABEL metadata for $VOCAB_COUNT new or incomplete vocabulary record(s)"
  rm -f "$VOCAB_COMPLETED"
  STAGE_STATUS=0
  run_stage "$TEXT_STAGE_TIMEOUT_SECONDS" env CODEX_CONCURRENCY="$ANALYSIS_CONCURRENCY" \
    VOCAB_COMPLETION_BATCH_SIZE="$VOCAB_COMPLETION_BATCH_SIZE" \
    ENRICHMENT_FAILURE_LEDGER="$FAILURE_LEDGER" ENRICHMENT_FAILURE_STAGE=vocab \
    "$NODE_BIN" scripts/offline/complete-corpus-fields.mjs \
      "$VOCAB_SOURCE" "$VOCAB_COMPLETED" "$VOCAB_ROOT/work" || STAGE_STATUS=$?
  if check_stage "vocabulary completion" "$STAGE_STATUS"; then
    VOCAB_FINGERPRINT="$($NODE_BIN -e 'const f=require("fs"),c=require("crypto");process.stdout.write(c.createHash("sha256").update(f.readFileSync(process.argv[1])).digest("hex").slice(0,16))' \
      "$VOCAB_COMPLETED")"
    log "publishing locally completed vocabulary records"
    # Later stages build on the completed records only once production has them.
    if CORPUS_AUDIT_WAVE_STATE_ROOT="$VOCAB_ROOT/publish-state/$VOCAB_FINGERPRINT" \
      CORPUS_AUDIT_WAVE_COOLDOWN_SECONDS=30 GH_BIN="$GH_BIN" \
      scripts/offline/dispatch-staged-corpus-audit.sh \
        "$VOCAB_COMPLETED" 100 "$REQUIRED_DEPLOY_SHA"; then
      VOCAB_OVERLAY="$VOCAB_COMPLETED"
    else
      stage_failed "vocabulary publication"
    fi
  fi
else
  log "no recent vocabulary records need structural completion"
fi

mkdir -p "$SAVED_ROOT"
SAVED_SOURCE_TMP="$SAVED_SOURCE.tmp"
if [ -s "$SAVED_SOURCE" ]; then
  "$TSX_BIN" server/src/scripts/prepare-incremental-saved-sentence-source.ts \
    "$CURRENT_CORPUS" "$SAVED_SOURCE_TMP" "$SAVED_SOURCE" "$SAVED_BASE_ANALYSIS"
else
  "$TSX_BIN" server/src/scripts/prepare-incremental-saved-sentence-source.ts \
    "$CURRENT_CORPUS" "$SAVED_SOURCE_TMP" - "$SAVED_BASE_ANALYSIS"
fi
mv "$SAVED_SOURCE_TMP" "$SAVED_SOURCE"
# The source keeps every sentence, so the next cycle still sees each one's first identity; this cycle
# works on those that are not waiting out a failure backoff.
SAVED_COUNT="$("$NODE_BIN" scripts/offline/failure-ledger.mjs filter-sentences \
  "$FAILURE_LEDGER" saved-sentence "$SAVED_SOURCE" "$SAVED_CYCLE_SOURCE")"
if [ "$SAVED_COUNT" -gt 0 ]; then
  if [ ! -s "$SAVED_ANALYSIS_CACHE" ]; then
    "$NODE_BIN" -e 'require("fs").writeFileSync(process.argv[1], JSON.stringify({version:1,generatedAt:Date.now(),entries:[]},null,2)+"\n", {mode:0o600})' \
      "$SAVED_ANALYSIS_CACHE"
  fi
  # Reconciliation writes final-analysis.json only when it is complete and never removes an old one.
  rm -f "$SAVED_RECONCILIATION/final-analysis.json"
  "$NODE_BIN" scripts/offline/reconcile-sentence-analyses.mjs \
    "$SAVED_CYCLE_SOURCE" "$SAVED_ANALYSIS_CACHE" "$SAVED_RECONCILIATION"
  SAVED_MISSING_COUNT="$($NODE_BIN -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1])).missing)' \
    "$SAVED_RECONCILIATION/report.json")"
  if [ "$SAVED_MISSING_COUNT" -gt 0 ]; then
    log "generating detailed $MODEL_LABEL explanations for $SAVED_MISSING_COUNT saved sentence(s)"
    SAVED_NEW_ANALYSIS="$SAVED_ROOT/new-analysis.json"
    rm -f "$SAVED_NEW_ANALYSIS"
    STAGE_STATUS=0
    run_stage "$TEXT_STAGE_TIMEOUT_SECONDS" env CODEX_CONCURRENCY="$ANALYSIS_CONCURRENCY" SENTENCE_ANALYSIS_BATCH_SIZE="$(sentence_batch_size "$SAVED_MISSING_COUNT")" \
      ENRICHMENT_FAILURE_LEDGER="$FAILURE_LEDGER" ENRICHMENT_FAILURE_STAGE=saved-sentence \
      "$NODE_BIN" scripts/offline/enrich-sentences.mjs \
      "$SAVED_RECONCILIATION/missing-source.json" "$SAVED_NEW_ANALYSIS" \
      "$SAVED_ROOT/analysis-work" "$SAVED_BASE_ANALYSIS" || STAGE_STATUS=$?
    check_stage "saved-sentence analysis" "$STAGE_STATUS" || true
    # Sentences that just failed now wait out their backoff, so the rest can still be published.
    SAVED_COUNT="$("$NODE_BIN" scripts/offline/failure-ledger.mjs filter-sentences \
      "$FAILURE_LEDGER" saved-sentence "$SAVED_SOURCE" "$SAVED_CYCLE_SOURCE")"
    if [ "$SAVED_COUNT" -gt 0 ] && [ -s "$SAVED_NEW_ANALYSIS" ]; then
      "$NODE_BIN" scripts/offline/reconcile-sentence-analyses.mjs \
        "$SAVED_CYCLE_SOURCE" "$SAVED_ANALYSIS_CACHE" "$SAVED_RECONCILIATION" "$SAVED_NEW_ANALYSIS" || true
    elif [ "$SAVED_COUNT" -gt 0 ]; then
      "$NODE_BIN" scripts/offline/reconcile-sentence-analyses.mjs \
        "$SAVED_CYCLE_SOURCE" "$SAVED_ANALYSIS_CACHE" "$SAVED_RECONCILIATION"
    fi
  fi
  if [ -s "$SAVED_RECONCILIATION/final-analysis.json" ]; then
    cp "$SAVED_RECONCILIATION/final-analysis.json" "$SAVED_ANALYSIS_CACHE.tmp"
    mv "$SAVED_ANALYSIS_CACHE.tmp" "$SAVED_ANALYSIS_CACHE"
    log "publishing detailed saved-sentence analyses"
    if ! REQUIRE_DETAILED_SENTENCE_ANALYSIS=1 \
      SAVED_SENTENCE_ANALYSIS_STATE_ROOT="$SAVED_PUBLISH_STATE" \
      SAVED_SENTENCE_ANALYSIS_COOLDOWN_SECONDS=30 GH_BIN="$GH_BIN" \
      scripts/offline/dispatch-staged-saved-sentence-analyses.sh \
        "$SAVED_ANALYSIS_CACHE" 2000 "$REQUIRED_DEPLOY_SHA"; then
      stage_failed "saved-sentence publication"
    fi
  elif [ "$SAVED_COUNT" -gt 0 ]; then
    echo "Incremental saved-sentence analysis reconciliation is incomplete" >&2
    stage_failed "saved-sentence reconciliation"
  fi
else
  log "no saved sentences need detailed analysis"
fi

mkdir -p "$ITEM_IMAGE_ROOT"
SAVED_ANALYSIS_INPUT="-"
if [ -s "$SAVED_ANALYSIS_CACHE" ]; then SAVED_ANALYSIS_INPUT="$SAVED_ANALYSIS_CACHE"; fi
"$NODE_BIN" scripts/offline/prepare-incremental-item-images.mjs \
  "$CURRENT_CORPUS" \
  "$SAVED_ANALYSIS_INPUT" \
  "$VOCAB_OVERLAY" \
  "$ITEM_IMAGE_ROOT" \
  "$IMAGE_MODEL_LABEL"
ITEM_IMAGE_COUNT="$("$NODE_BIN" scripts/offline/failure-ledger.mjs filter-image-targets \
  "$FAILURE_LEDGER" item-image "$ITEM_IMAGE_ROOT/targets.json" "$ITEM_IMAGE_TARGETS")"
if [ "$ITEM_IMAGE_COUNT" -gt 0 ]; then
  ITEM_IMAGE_FINGERPRINT="$($NODE_BIN -e 'const f=require("fs"),c=require("crypto");process.stdout.write(c.createHash("sha256").update(f.readFileSync(process.argv[1])).digest("hex").slice(0,16))' \
    "$ITEM_IMAGE_TARGETS")"
  log "generating locally and judging with $MODEL_LABEL $ITEM_IMAGE_COUNT missing saved-word/phrase/sentence image(s)"
  STAGE_STATUS=0
  run_stage "$IMAGE_STAGE_TIMEOUT_SECONDS" env CODEX_CONCURRENCY="$ANALYSIS_CONCURRENCY" CODEX_IMAGE_CONCURRENCY="$IMAGE_QA_CONCURRENCY" \
    IMAGE_MODEL="$IMAGE_MODEL" IMAGE_MODEL_QUANTIZE="$IMAGE_MODEL_QUANTIZE" KREA_SHARD_COUNT=1 \
    IMAGE_QUALITY_DEFER_AFTER="$IMAGE_MAX_CANDIDATES" \
    bash scripts/offline/run-streaming-image-quality-loop.sh \
      "$ITEM_IMAGE_TARGETS" "$ITEM_IMAGE_ROOT/candidates" "$ITEM_IMAGE_ROOT/images" \
      "$ITEM_IMAGE_ROOT/streaming-quality/$ITEM_IMAGE_FINGERPRINT" 1024 576 "$IMAGE_STEPS" 1 64 || STAGE_STATUS=$?
  # Deferred images go into the failure ledger, so later cycles stop rendering them every time.
  "$NODE_BIN" scripts/offline/failure-ledger.mjs record-image-outcomes \
    "$FAILURE_LEDGER" item-image "$ITEM_IMAGE_TARGETS" "$ITEM_IMAGE_ROOT/images" "$STAGE_STATUS"
  if [ "$STAGE_STATUS" -ne 0 ]; then
    stage_failed "saved-item images"
    require_model
  fi
  # The publisher waits for every manifest entry, so deferred images leave the manifest. They are still
  # missing in production, so a later cycle targets them again.
  ITEM_IMAGE_READY="$("$NODE_BIN" -e 'const f=require("fs"),p=require("path"),file=p.join(process.argv[1],"manifest.json"),m=JSON.parse(f.readFileSync(file,"utf8"));m.entries=m.entries.filter(e=>f.existsSync(p.join(process.argv[1],e.imageFile)));f.writeFileSync(file,JSON.stringify(m,null,2)+"\n",{mode:0o600});console.log(m.entries.length)' \
    "$ITEM_IMAGE_ROOT")"
  if [ "$ITEM_IMAGE_READY" -gt 0 ]; then
    log "publishing $ITEM_IMAGE_READY locally generated saved-word/phrase/sentence image(s)"
    if ! WAIT_FOR_SENTENCE_IMPORTS=0 \
      OFFLINE_IMAGE_CORPUS_MANIFEST=/dev/null \
      OFFLINE_IMAGE_WAVE_STATE_ROOT="$ITEM_IMAGE_ROOT/publish-state/$ITEM_IMAGE_FINGERPRINT" \
      OFFLINE_IMAGE_WAVE_COOLDOWN_SECONDS=30 GH_BIN="$GH_BIN" \
      scripts/offline/dispatch-staged-offline-images.sh \
        "$ITEM_IMAGE_ROOT" 100 "$REQUIRED_DEPLOY_SHA"; then
      stage_failed "saved-item image publication"
    fi
  fi
else
  log "no saved-word/phrase/sentence image needs generating this cycle"
fi

CURRENT_POOL_TMP="$ROOT/current-source.json.tmp"
"$NODE_BIN" scripts/offline/build-example-sentence-pool.mjs \
  "$CURRENT_CORPUS" "$CURRENT_POOL_TMP" "$VOCAB_OVERLAY"
mv "$CURRENT_POOL_TMP" "$CURRENT_POOL"
# The unfiltered source carries each sentence's first identity to the next cycle. source.json, which the
# verifier and the publishers read, leaves out sentences waiting out a failure backoff.
PREVIOUS_SOURCE="$UNFILTERED_SOURCE"
if [ ! -s "$PREVIOUS_SOURCE" ]; then PREVIOUS_SOURCE="$SOURCE"; fi
SOURCE_TMP="$ROOT/source.json.tmp"
if [ -s "$PREVIOUS_SOURCE" ]; then
  "$NODE_BIN" scripts/offline/prepare-incremental-example-source.mjs \
    "$CURRENT_POOL" "$BASE_SOURCE" "$SOURCE_TMP" "$PREVIOUS_SOURCE"
else
  "$NODE_BIN" scripts/offline/prepare-incremental-example-source.mjs \
    "$CURRENT_POOL" "$BASE_SOURCE" "$SOURCE_TMP"
fi
mv "$SOURCE_TMP" "$UNFILTERED_SOURCE"

TOTAL_COUNT="$("$NODE_BIN" scripts/offline/failure-ledger.mjs filter-sentences \
  "$FAILURE_LEDGER" example-sentence "$UNFILTERED_SOURCE" "$SOURCE")"
if [ "$TOTAL_COUNT" -eq 0 ]; then
  finish_cycle "no post-baseline example sentences need enrichment"
fi

if [ ! -s "$ANALYSIS_CACHE" ]; then
  "$NODE_BIN" -e 'require("fs").writeFileSync(process.argv[1], JSON.stringify({version:1,generatedAt:Date.now(),entries:[]},null,2)+"\n", {mode:0o600})' \
    "$ANALYSIS_CACHE"
fi
"$NODE_BIN" scripts/offline/merge-sentence-analysis-manifests.mjs \
  "$COMBINED_ANALYSIS_CACHE" "$BASE_ANALYSIS" "$ANALYSIS_CACHE"
rm -f "$RECONCILIATION/final-analysis.json"
ALLOW_PRODUCTION_COVERED_BASIC_ANALYSIS=1 \
"$NODE_BIN" scripts/offline/reconcile-sentence-analyses.mjs \
  "$SOURCE" "$COMBINED_ANALYSIS_CACHE" "$RECONCILIATION"
MISSING_COUNT="$($NODE_BIN -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1])).missing)' \
  "$RECONCILIATION/report.json")"
if [ "$MISSING_COUNT" -gt 0 ]; then
  log "generating detailed $MODEL_LABEL explanations for $MISSING_COUNT production gap(s)"
  NEW_ANALYSIS="$ROOT/new-analysis.json"
  rm -f "$NEW_ANALYSIS"
  STAGE_STATUS=0
  run_stage "$TEXT_STAGE_TIMEOUT_SECONDS" env CODEX_CONCURRENCY="$ANALYSIS_CONCURRENCY" SENTENCE_ANALYSIS_BATCH_SIZE="$(sentence_batch_size "$MISSING_COUNT")" \
    ENRICHMENT_FAILURE_LEDGER="$FAILURE_LEDGER" ENRICHMENT_FAILURE_STAGE=example-sentence \
    "$NODE_BIN" scripts/offline/enrich-sentences.mjs \
      "$RECONCILIATION/missing-source.json" "$NEW_ANALYSIS" "$ROOT/analysis-work" "$ANALYSIS_CACHE" || STAGE_STATUS=$?
  check_stage "example-sentence analysis" "$STAGE_STATUS" || true
  TOTAL_COUNT="$("$NODE_BIN" scripts/offline/failure-ledger.mjs filter-sentences \
    "$FAILURE_LEDGER" example-sentence "$UNFILTERED_SOURCE" "$SOURCE")"
  if [ "$TOTAL_COUNT" -eq 0 ]; then
    finish_cycle "every post-baseline example sentence is waiting out a failure backoff"
  fi
  if [ -s "$NEW_ANALYSIS" ]; then
    ALLOW_PRODUCTION_COVERED_BASIC_ANALYSIS=1 \
    "$NODE_BIN" scripts/offline/reconcile-sentence-analyses.mjs \
      "$SOURCE" "$COMBINED_ANALYSIS_CACHE" "$RECONCILIATION" "$NEW_ANALYSIS" || true
  else
    ALLOW_PRODUCTION_COVERED_BASIC_ANALYSIS=1 \
    "$NODE_BIN" scripts/offline/reconcile-sentence-analyses.mjs \
      "$SOURCE" "$COMBINED_ANALYSIS_CACHE" "$RECONCILIATION"
  fi
fi
if [ ! -s "$RECONCILIATION/final-analysis.json" ]; then
  echo "Incremental sentence analysis reconciliation is incomplete" >&2
  stage_failed "example-sentence reconciliation"
  finish_cycle "example sentences are not published this cycle"
fi
"$NODE_BIN" scripts/offline/merge-sentence-analysis-manifests.mjs \
  "$ANALYSIS_CACHE.next" "$ANALYSIS_CACHE" "$RECONCILIATION/final-analysis.json"
mv "$ANALYSIS_CACHE.next" "$ANALYSIS_CACHE"
"$NODE_BIN" scripts/offline/verify-example-sentence-pool.mjs \
  "$SOURCE" "$RECONCILIATION/final-analysis.json"
log "publishing validated explanations before their images"
if ! REQUIRE_DETAILED_SENTENCE_ANALYSIS=1 \
  EXAMPLE_ANALYSIS_WAVE_STATE_ROOT="$ANALYSIS_PUBLISH_STATE" \
  EXAMPLE_ANALYSIS_WAVE_COOLDOWN_SECONDS=30 GH_BIN="$GH_BIN" \
  scripts/offline/dispatch-staged-example-analyses.sh "$ROOT" 2000 "$REQUIRED_DEPLOY_SHA"; then
  stage_failed "example-sentence analysis publication"
fi

"$NODE_BIN" scripts/offline/prepare-sentence-images.mjs \
  "$SOURCE" "$RECONCILIATION/final-analysis.json" "$IMAGE_ROOT" "$IMAGE_MODEL_LABEL" \
  "$BASE_IMAGE_ROOT/images"
IMAGE_TARGET_COUNT="$("$NODE_BIN" scripts/offline/failure-ledger.mjs filter-image-targets \
  "$FAILURE_LEDGER" example-image "$IMAGE_ROOT/targets.json" "$IMAGE_TARGETS")"

if [ "$IMAGE_TARGET_COUNT" -gt 0 ]; then
  BASE_EXPECTED="$($NODE_BIN -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1])).targets.length)' \
    "$BASE_IMAGE_ROOT/targets.json")"
  BASE_ACCEPTED="$(find "$BASE_IMAGE_ROOT/images" -maxdepth 1 -type f -name '*.webp' 2>/dev/null | wc -l | tr -d ' ')"
  if pgrep -f '[r]un-streaming-image-quality-loop\.sh' >/dev/null 2>&1; then
    finish_cycle "another local image pipeline is active; incremental images are queued"
  fi
  if [ "$BASE_ACCEPTED" -lt "$BASE_EXPECTED" ]; then
    # A tiny hard tail may exhaust the independent bulk QA loop. It remains visible in production
    # coverage reports, but must not permanently starve every example discovered afterwards.
    log "bulk image pipeline has $BASE_ACCEPTED/$BASE_EXPECTED accepted; continuing with incremental images"
  fi
  TARGET_FINGERPRINT="$($NODE_BIN -e 'const f=require("fs"),c=require("crypto");process.stdout.write(c.createHash("sha256").update(f.readFileSync(process.argv[1])).digest("hex").slice(0,16))' \
    "$IMAGE_TARGETS")"
  log "generating $IMAGE_TARGET_COUNT missing example image(s) locally and judging them with $MODEL_LABEL"
  STAGE_STATUS=0
  run_stage "$IMAGE_STAGE_TIMEOUT_SECONDS" env CODEX_CONCURRENCY="$ANALYSIS_CONCURRENCY" CODEX_IMAGE_CONCURRENCY="$IMAGE_QA_CONCURRENCY" \
    IMAGE_MODEL="$IMAGE_MODEL" \
    IMAGE_MODEL_QUANTIZE="$IMAGE_MODEL_QUANTIZE" KREA_SHARD_COUNT=1 \
    IMAGE_QUALITY_DEFER_AFTER="$IMAGE_MAX_CANDIDATES" \
    bash scripts/offline/run-streaming-image-quality-loop.sh \
    "$IMAGE_TARGETS" "$IMAGE_ROOT/candidates" "$IMAGE_ROOT/images" \
    "$IMAGE_ROOT/streaming-quality/$TARGET_FINGERPRINT" 1024 576 "$IMAGE_STEPS" 1 64 || STAGE_STATUS=$?
  "$NODE_BIN" scripts/offline/failure-ledger.mjs record-image-outcomes \
    "$FAILURE_LEDGER" example-image "$IMAGE_TARGETS" "$IMAGE_ROOT/images" "$STAGE_STATUS"
  if [ "$STAGE_STATUS" -ne 0 ]; then
    stage_failed "example images"
    require_model
  fi
else
  log "no example image needs generating this cycle"
fi

# Explanations are already published, so a deferred image only delays its own sentence's image.
ALLOW_DEFERRED_IMAGES=1 \
"$NODE_BIN" scripts/offline/verify-example-sentence-pool.mjs \
  "$SOURCE" "$RECONCILIATION/final-analysis.json" "$IMAGE_ROOT"
log "publishing verified incremental explanation-image pairs"
if ! ALLOW_DEFERRED_IMAGES=1 \
  EXAMPLE_ENRICHMENT_WAVE_STATE_ROOT="$PUBLISH_STATE" \
  EXAMPLE_ENRICHMENT_WAVE_COOLDOWN_SECONDS=30 GH_BIN="$GH_BIN" \
  scripts/offline/dispatch-staged-example-enrichments.sh "$ROOT" 100 "$REQUIRED_DEPLOY_SHA"; then
  stage_failed "example enrichment publication"
fi
finish_cycle "incremental example-enrichment cycle complete: $TOTAL_COUNT post-baseline sentence(s)"
