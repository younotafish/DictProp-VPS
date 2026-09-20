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
LOCAL_MLX_CONCURRENCY="${LOCAL_MLX_CONCURRENCY:-1}"
LOCAL_MLX_VLM_CONCURRENCY="${LOCAL_MLX_VLM_CONCURRENCY:-1}"
LOCAL_VOCAB_BATCH_SIZE="${LOCAL_VOCAB_BATCH_SIZE:-12}"
LOCAL_VOCAB_LOOKBACK_HOURS="${LOCAL_VOCAB_LOOKBACK_HOURS:-168}"
LOCK_FILE="$ROOT/.cycle.lock"
CURRENT_CORPUS="$ROOT/current-corpus.json"
CURRENT_POOL="$ROOT/current-source.json"
SOURCE="$ROOT/source.json"
ANALYSIS_CACHE="$ROOT/analysis-cache.json"
COMBINED_ANALYSIS_CACHE="$ROOT/combined-analysis-cache.json"
RECONCILIATION="$ROOT/final-reconciliation"
IMAGE_ROOT="$ROOT/final-images"
PUBLISH_STATE="$ROOT/publish-state-coverage-v2"
ANALYSIS_PUBLISH_STATE="$ROOT/analysis-publish-state-coverage-v2"
SAVED_ROOT="$ROOT/saved-sentences"
SAVED_SOURCE="$SAVED_ROOT/source.json"
SAVED_BASE_ANALYSIS="$SAVED_ROOT/current-base-analysis.json"
SAVED_ANALYSIS_CACHE="$SAVED_ROOT/analysis-cache.json"
SAVED_RECONCILIATION="$SAVED_ROOT/final-reconciliation"
SAVED_PUBLISH_STATE="$SAVED_ROOT/publish-state-detailed-v1"
VOCAB_ROOT="$ROOT/vocabulary"
VOCAB_SOURCE="$VOCAB_ROOT/source.json"
VOCAB_COMPLETED="$VOCAB_ROOT/completed.json"
ITEM_IMAGE_ROOT="$ROOT/item-images"

log() {
  printf '[%s] %s\n' "$(date -u +%FT%TZ)" "$*"
}

# GitHub occasionally resets the HTTP/2 stream while a completed workflow log is being downloaded.
# Retrying this read is safe and keeps one transient transport error from aborting a six-hour cycle.
download_workflow_log() {
  local run_id="$1"
  local destination="$2"
  local attempt
  for attempt in 1 2 3 4 5; do
    if "$GH_BIN" run view "$run_id" --repo "$REPO" --log > "$destination"; then
      return 0
    fi
    rm -f "$destination"
    if [ "$attempt" -lt 5 ]; then
      log "workflow log download failed (attempt $attempt/5); retrying"
      sleep "$((attempt * 5))"
    fi
  done
  echo "Could not download workflow log for run $run_id after 5 attempts" >&2
  return 1
}

mkdir -p "$ROOT"
if ! shlock -f "$LOCK_FILE" -p "$$"; then
  log "another incremental enrichment cycle is already running"
  exit 0
fi
cleanup() {
  rm -f "$LOCK_FILE"
}
trap cleanup EXIT INT TERM

if pgrep -f '[n]ode scripts/offline/(enrich-sentences|complete-corpus-fields|enrich-sentence-grammar)\.mjs' >/dev/null 2>&1; then
  log "another local sentence-analysis job is active; deferring this cycle"
  exit 0
fi

for required in "$GH_BIN" "$KEY_FILE" "$BASE_SOURCE" "$BASE_ANALYSIS" "$BASE_IMAGE_ROOT/targets.json" "$TSX_BIN"; do
  if [ ! -s "$required" ]; then
    echo "Required incremental enrichment input is missing: $required" >&2
    exit 1
  fi
done

PREVIOUS_RUN_ID="$($GH_BIN run list \
  --repo "$REPO" --workflow sentence-backfill.yml --event workflow_dispatch --limit 1 \
  --json databaseId --jq 'if length == 0 then 0 else .[0].databaseId end')"
if ! [[ "$PREVIOUS_RUN_ID" =~ ^[0-9]+$ ]]; then PREVIOUS_RUN_ID=0; fi
log "requesting a fresh encrypted production corpus export"
"$GH_BIN" workflow run sentence-backfill.yml --repo "$REPO" --ref main -f operation=corpus-export

EXPORT_RUN_ID=""
for _attempt in $(seq 1 120); do
  while IFS= read -r candidate; do
    if "$GH_BIN" run view "$candidate" --repo "$REPO" --json jobs \
      --jq '.jobs[] | select(.name == "corpus-export" and .conclusion != "skipped") | .name' 2>/dev/null \
      | grep -qx corpus-export; then
      EXPORT_RUN_ID="$candidate"
      break
    fi
  done < <("$GH_BIN" run list \
    --repo "$REPO" --workflow sentence-backfill.yml --event workflow_dispatch --limit 30 \
    --json databaseId --jq ".[] | select(.databaseId > $PREVIOUS_RUN_ID) | .databaseId" 2>/dev/null | sort -n)
  [ -n "$EXPORT_RUN_ID" ] && break
  sleep 5
done
if [ -z "$EXPORT_RUN_ID" ]; then
  echo "Could not identify the dispatched corpus export workflow" >&2
  exit 1
fi

"$GH_BIN" run watch "$EXPORT_RUN_ID" --repo "$REPO" --exit-status --interval 10
EXPORT_LOG_TMP="$ROOT/workflow-export.log.tmp"
CORPUS_TMP="$ROOT/current-corpus.json.tmp"
download_workflow_log "$EXPORT_RUN_ID" "$EXPORT_LOG_TMP"
"$NODE_BIN" scripts/offline/decrypt-workflow-export.mjs \
  "$EXPORT_LOG_TMP" CORPUS_EXPORT "$KEY_FILE" "$CORPUS_TMP"
mv "$CORPUS_TMP" "$CURRENT_CORPUS"
rm -f "$EXPORT_LOG_TMP"

mkdir -p "$VOCAB_ROOT"
VOCAB_SOURCE_TMP="$VOCAB_SOURCE.tmp"
"$NODE_BIN" scripts/offline/prepare-incremental-vocab-source.mjs \
  "$CURRENT_CORPUS" "$VOCAB_SOURCE_TMP" "$LOCAL_VOCAB_BATCH_SIZE" "$LOCAL_VOCAB_LOOKBACK_HOURS"
mv "$VOCAB_SOURCE_TMP" "$VOCAB_SOURCE"
VOCAB_COUNT="$($NODE_BIN -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1])).entries.length)' \
  "$VOCAB_SOURCE")"
VOCAB_OVERLAY="-"
if [ "$VOCAB_COUNT" -gt 0 ]; then
  log "completing $VOCAB_COUNT recent or structurally incomplete vocabulary record(s) with local MLX"
  rm -f "$VOCAB_COMPLETED"
  env LOCAL_MLX_CONCURRENCY="$LOCAL_MLX_CONCURRENCY" \
    "$NODE_BIN" scripts/offline/complete-corpus-fields.mjs \
      "$VOCAB_SOURCE" "$VOCAB_COMPLETED" "$VOCAB_ROOT/work"
  VOCAB_FINGERPRINT="$($NODE_BIN -e 'const f=require("fs"),c=require("crypto");process.stdout.write(c.createHash("sha256").update(f.readFileSync(process.argv[1])).digest("hex").slice(0,16))' \
    "$VOCAB_COMPLETED")"
  log "publishing locally completed vocabulary records"
  CORPUS_AUDIT_WAVE_STATE_ROOT="$VOCAB_ROOT/publish-state/$VOCAB_FINGERPRINT" \
  CORPUS_AUDIT_WAVE_COOLDOWN_SECONDS=30 GH_BIN="$GH_BIN" \
    scripts/offline/dispatch-staged-corpus-audit.sh \
      "$VOCAB_COMPLETED" 100 "$REQUIRED_DEPLOY_SHA"
  VOCAB_OVERLAY="$VOCAB_COMPLETED"
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
SAVED_COUNT="$($NODE_BIN -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1])).sentences.length)' \
  "$SAVED_SOURCE")"
if [ "$SAVED_COUNT" -gt 0 ]; then
  if [ ! -s "$SAVED_ANALYSIS_CACHE" ]; then
    "$NODE_BIN" -e 'require("fs").writeFileSync(process.argv[1], JSON.stringify({version:1,generatedAt:Date.now(),entries:[]},null,2)+"\n", {mode:0o600})' \
      "$SAVED_ANALYSIS_CACHE"
  fi
  "$NODE_BIN" scripts/offline/reconcile-sentence-analyses.mjs \
    "$SAVED_SOURCE" "$SAVED_ANALYSIS_CACHE" "$SAVED_RECONCILIATION"
  SAVED_MISSING_COUNT="$($NODE_BIN -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1])).missing)' \
    "$SAVED_RECONCILIATION/report.json")"
  if [ "$SAVED_MISSING_COUNT" -gt 0 ]; then
    log "generating detailed explanations for $SAVED_MISSING_COUNT saved sentence(s) with local MLX"
    SAVED_NEW_ANALYSIS="$SAVED_ROOT/new-analysis.json"
    rm -f "$SAVED_NEW_ANALYSIS"
    env LOCAL_MLX_CONCURRENCY="$LOCAL_MLX_CONCURRENCY" SENTENCE_ANALYSIS_BATCH_SIZE=1 \
      "$NODE_BIN" scripts/offline/enrich-sentences.mjs \
      "$SAVED_RECONCILIATION/missing-source.json" "$SAVED_NEW_ANALYSIS" \
      "$SAVED_ROOT/analysis-work" "$SAVED_BASE_ANALYSIS"
    "$NODE_BIN" scripts/offline/reconcile-sentence-analyses.mjs \
      "$SAVED_SOURCE" "$SAVED_ANALYSIS_CACHE" "$SAVED_RECONCILIATION" "$SAVED_NEW_ANALYSIS"
  fi
  if [ ! -s "$SAVED_RECONCILIATION/final-analysis.json" ]; then
    echo "Incremental saved-sentence analysis reconciliation is incomplete" >&2
    exit 1
  fi
  cp "$SAVED_RECONCILIATION/final-analysis.json" "$SAVED_ANALYSIS_CACHE.tmp"
  mv "$SAVED_ANALYSIS_CACHE.tmp" "$SAVED_ANALYSIS_CACHE"
  log "publishing detailed saved-sentence analyses"
  REQUIRE_DETAILED_SENTENCE_ANALYSIS=1 \
  SAVED_SENTENCE_ANALYSIS_STATE_ROOT="$SAVED_PUBLISH_STATE" \
  SAVED_SENTENCE_ANALYSIS_COOLDOWN_SECONDS=30 GH_BIN="$GH_BIN" \
    scripts/offline/dispatch-staged-saved-sentence-analyses.sh \
      "$SAVED_ANALYSIS_CACHE" 2000 "$REQUIRED_DEPLOY_SHA"
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
  baidu/ERNIE-Image-Turbo
ITEM_IMAGE_COUNT="$($NODE_BIN -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1])).targets.length)' \
  "$ITEM_IMAGE_ROOT/targets.json")"
if [ "$ITEM_IMAGE_COUNT" -gt 0 ]; then
  ITEM_IMAGE_FINGERPRINT="$($NODE_BIN -e 'const f=require("fs"),c=require("crypto");process.stdout.write(c.createHash("sha256").update(f.readFileSync(process.argv[1])).digest("hex").slice(0,16))' \
    "$ITEM_IMAGE_ROOT/targets.json")"
  log "generating and locally judging $ITEM_IMAGE_COUNT missing saved-word/phrase/sentence image(s)"
  env LOCAL_MLX_VLM_CONCURRENCY="$LOCAL_MLX_VLM_CONCURRENCY" \
    IMAGE_MODEL=ernie-image-turbo IMAGE_MODEL_QUANTIZE=8 KREA_SHARD_COUNT=1 \
    bash scripts/offline/run-streaming-image-quality-loop.sh \
      "$ITEM_IMAGE_ROOT/targets.json" "$ITEM_IMAGE_ROOT/candidates" "$ITEM_IMAGE_ROOT/images" \
      "$ITEM_IMAGE_ROOT/streaming-quality/$ITEM_IMAGE_FINGERPRINT" 1024 576 4 1 64
  log "publishing locally generated saved-word/phrase/sentence images"
  WAIT_FOR_SENTENCE_IMPORTS=0 \
  OFFLINE_IMAGE_CORPUS_MANIFEST=/dev/null \
  OFFLINE_IMAGE_WAVE_STATE_ROOT="$ITEM_IMAGE_ROOT/publish-state/$ITEM_IMAGE_FINGERPRINT" \
  OFFLINE_IMAGE_WAVE_COOLDOWN_SECONDS=30 GH_BIN="$GH_BIN" \
    scripts/offline/dispatch-staged-offline-images.sh \
      "$ITEM_IMAGE_ROOT" 100 "$REQUIRED_DEPLOY_SHA"
else
  log "production already covers every saved-word/phrase/sentence image"
fi

CURRENT_POOL_TMP="$ROOT/current-source.json.tmp"
"$NODE_BIN" scripts/offline/build-example-sentence-pool.mjs "$CURRENT_CORPUS" "$CURRENT_POOL_TMP"
mv "$CURRENT_POOL_TMP" "$CURRENT_POOL"
SOURCE_TMP="$ROOT/source.json.tmp"
if [ -s "$SOURCE" ]; then
  "$NODE_BIN" scripts/offline/prepare-incremental-example-source.mjs \
    "$CURRENT_POOL" "$BASE_SOURCE" "$SOURCE_TMP" "$SOURCE"
else
  "$NODE_BIN" scripts/offline/prepare-incremental-example-source.mjs \
    "$CURRENT_POOL" "$BASE_SOURCE" "$SOURCE_TMP"
fi
mv "$SOURCE_TMP" "$SOURCE"

TOTAL_COUNT="$($NODE_BIN -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1])).sentences.length)' "$SOURCE")"
if [ "$TOTAL_COUNT" -eq 0 ]; then
  log "no post-baseline example sentences need enrichment"
  exit 0
fi

if [ ! -s "$ANALYSIS_CACHE" ]; then
  "$NODE_BIN" -e 'require("fs").writeFileSync(process.argv[1], JSON.stringify({version:1,generatedAt:Date.now(),entries:[]},null,2)+"\n", {mode:0o600})' \
    "$ANALYSIS_CACHE"
fi
"$NODE_BIN" scripts/offline/merge-sentence-analysis-manifests.mjs \
  "$COMBINED_ANALYSIS_CACHE" "$BASE_ANALYSIS" "$ANALYSIS_CACHE"
ALLOW_PRODUCTION_COVERED_BASIC_ANALYSIS=1 \
"$NODE_BIN" scripts/offline/reconcile-sentence-analyses.mjs \
  "$SOURCE" "$COMBINED_ANALYSIS_CACHE" "$RECONCILIATION"
MISSING_COUNT="$($NODE_BIN -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1])).missing)' \
  "$RECONCILIATION/report.json")"
if [ "$MISSING_COUNT" -gt 0 ]; then
  log "generating explanations for $MISSING_COUNT production gap(s) with local MLX"
  NEW_ANALYSIS="$ROOT/new-analysis.json"
  rm -f "$NEW_ANALYSIS"
  env LOCAL_MLX_CONCURRENCY="$LOCAL_MLX_CONCURRENCY" SENTENCE_ANALYSIS_BATCH_SIZE=1 \
    "$NODE_BIN" scripts/offline/enrich-sentences.mjs \
      "$RECONCILIATION/missing-source.json" "$NEW_ANALYSIS" "$ROOT/analysis-work" "$ANALYSIS_CACHE"
  ALLOW_PRODUCTION_COVERED_BASIC_ANALYSIS=1 \
  "$NODE_BIN" scripts/offline/reconcile-sentence-analyses.mjs \
    "$SOURCE" "$COMBINED_ANALYSIS_CACHE" "$RECONCILIATION" "$NEW_ANALYSIS"
fi
if [ ! -s "$RECONCILIATION/final-analysis.json" ]; then
  echo "Incremental sentence analysis reconciliation is incomplete" >&2
  exit 1
fi
"$NODE_BIN" scripts/offline/merge-sentence-analysis-manifests.mjs \
  "$ANALYSIS_CACHE.next" "$ANALYSIS_CACHE" "$RECONCILIATION/final-analysis.json"
mv "$ANALYSIS_CACHE.next" "$ANALYSIS_CACHE"
"$NODE_BIN" scripts/offline/verify-example-sentence-pool.mjs \
  "$SOURCE" "$RECONCILIATION/final-analysis.json"
log "publishing validated explanations before their images"
REQUIRE_DETAILED_SENTENCE_ANALYSIS=1 \
EXAMPLE_ANALYSIS_WAVE_STATE_ROOT="$ANALYSIS_PUBLISH_STATE" \
EXAMPLE_ANALYSIS_WAVE_COOLDOWN_SECONDS=30 GH_BIN="$GH_BIN" \
  scripts/offline/dispatch-staged-example-analyses.sh "$ROOT" 2000 "$REQUIRED_DEPLOY_SHA"

"$NODE_BIN" scripts/offline/prepare-sentence-images.mjs \
  "$SOURCE" "$RECONCILIATION/final-analysis.json" "$IMAGE_ROOT" baidu/ERNIE-Image-Turbo \
  "$BASE_IMAGE_ROOT/images"
IMAGE_TARGET_COUNT="$($NODE_BIN -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1])).targets.length)' \
  "$IMAGE_ROOT/targets.json")"

if [ "$IMAGE_TARGET_COUNT" -gt 0 ]; then
  BASE_EXPECTED="$($NODE_BIN -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1])).targets.length)' \
    "$BASE_IMAGE_ROOT/targets.json")"
  BASE_ACCEPTED="$(find "$BASE_IMAGE_ROOT/images" -maxdepth 1 -type f -name '*.webp' 2>/dev/null | wc -l | tr -d ' ')"
  if pgrep -f '[r]un-streaming-image-quality-loop\.sh' >/dev/null 2>&1; then
    log "another local image pipeline is active; incremental images are queued"
    exit 0
  fi
  if [ "$BASE_ACCEPTED" -lt "$BASE_EXPECTED" ]; then
    # A tiny hard tail may exhaust the independent bulk QA loop. It remains visible in production
    # coverage reports, but must not permanently starve every example discovered afterwards.
    log "bulk image pipeline has $BASE_ACCEPTED/$BASE_EXPECTED accepted; continuing with incremental images"
  fi
  TARGET_FINGERPRINT="$($NODE_BIN -e 'const f=require("fs"),c=require("crypto");process.stdout.write(c.createHash("sha256").update(f.readFileSync(process.argv[1])).digest("hex").slice(0,16))' \
    "$IMAGE_ROOT/targets.json")"
  log "generating and judging $IMAGE_TARGET_COUNT missing example image(s) locally"
  env LOCAL_MLX_VLM_CONCURRENCY="$LOCAL_MLX_VLM_CONCURRENCY" IMAGE_MODEL=ernie-image-turbo \
    IMAGE_MODEL_QUANTIZE=8 KREA_SHARD_COUNT=1 \
    bash scripts/offline/run-streaming-image-quality-loop.sh \
    "$IMAGE_ROOT/targets.json" "$IMAGE_ROOT/candidates" "$IMAGE_ROOT/images" \
    "$IMAGE_ROOT/streaming-quality/$TARGET_FINGERPRINT" 1024 576 4 1 64
else
  log "production already covers every image in the repair source"
fi

"$NODE_BIN" scripts/offline/verify-example-sentence-pool.mjs \
  "$SOURCE" "$RECONCILIATION/final-analysis.json" "$IMAGE_ROOT"
log "publishing verified incremental explanation-image pairs"
EXAMPLE_ENRICHMENT_WAVE_STATE_ROOT="$PUBLISH_STATE" \
EXAMPLE_ENRICHMENT_WAVE_COOLDOWN_SECONDS=30 GH_BIN="$GH_BIN" \
  scripts/offline/dispatch-staged-example-enrichments.sh "$ROOT" 100 "$REQUIRED_DEPLOY_SHA"
log "incremental example-enrichment cycle complete: $TOTAL_COUNT post-baseline sentence(s)"
