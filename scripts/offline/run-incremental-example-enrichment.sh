#!/usr/bin/env bash

set -euo pipefail

ROOT="${1:-data/offline-backfill/incremental-example-enrichment}"
BASE_SOURCE="${2:-data/offline-backfill/example-sentence-pool/source.json}"
BASE_IMAGE_ROOT="${3:-data/offline-backfill/example-sentence-pool/final-images}"
REQUIRED_DEPLOY_SHA="${4:-$(git rev-parse HEAD)}"
GH_BIN="${GH_BIN:-./.gh}"
REPO="${GITHUB_REPOSITORY:-younotafish/DictProp-VPS}"
KEY_FILE="${SENTENCE_BRIDGE_KEY_FILE:-${XDG_CONFIG_HOME:-$HOME/.config}/dictprop/sentence_bridge_key}"
NODE_BIN="${NODE_BIN:-node}"
ANALYSIS_CONCURRENCY="${ANALYSIS_CONCURRENCY:-8}"
GRAMMAR_CONCURRENCY="${GRAMMAR_CONCURRENCY:-8}"
IMAGE_QA_CONCURRENCY="${IMAGE_QA_CONCURRENCY:-16}"
LOCK_DIR="$ROOT/.cycle-lock"
CURRENT_CORPUS="$ROOT/current-corpus.json"
CURRENT_POOL="$ROOT/current-source.json"
SOURCE="$ROOT/source.json"
ANALYSIS_CACHE="$ROOT/analysis-cache.json"
RECONCILIATION="$ROOT/final-reconciliation"
IMAGE_ROOT="$ROOT/final-images"
PUBLISH_STATE="$ROOT/publish-state"
ANALYSIS_PUBLISH_STATE="$ROOT/analysis-publish-state-grammar-v2"

log() {
  printf '[%s] %s\n' "$(date -u +%FT%TZ)" "$*"
}

mkdir -p "$ROOT"
if ! mkdir "$LOCK_DIR" 2>/dev/null; then
  log "another incremental example-enrichment cycle is already running"
  exit 0
fi
cleanup() {
  rm -rf "$LOCK_DIR"
}
trap cleanup EXIT INT TERM

for required in "$GH_BIN" "$KEY_FILE" "$BASE_SOURCE" "$BASE_IMAGE_ROOT/targets.json"; do
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
"$GH_BIN" run view "$EXPORT_RUN_ID" --repo "$REPO" --log > "$EXPORT_LOG_TMP"
"$NODE_BIN" scripts/offline/decrypt-workflow-export.mjs \
  "$EXPORT_LOG_TMP" CORPUS_EXPORT "$KEY_FILE" "$CORPUS_TMP"
mv "$CORPUS_TMP" "$CURRENT_CORPUS"
rm -f "$EXPORT_LOG_TMP"

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
"$NODE_BIN" scripts/offline/reconcile-sentence-analyses.mjs \
  "$SOURCE" "$ANALYSIS_CACHE" "$RECONCILIATION"
MISSING_COUNT="$($NODE_BIN -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1])).missing)' \
  "$RECONCILIATION/report.json")"
if [ "$MISSING_COUNT" -gt 0 ]; then
  log "generating local GPT-5.6 explanations for $MISSING_COUNT newly discovered example sentence(s)"
  NEW_ANALYSIS="$ROOT/new-analysis.json"
  rm -f "$NEW_ANALYSIS"
  env CODEX_CONCURRENCY="$ANALYSIS_CONCURRENCY" "$NODE_BIN" scripts/offline/enrich-sentences.mjs \
    "$RECONCILIATION/missing-source.json" "$NEW_ANALYSIS" "$ROOT/analysis-work"
  "$NODE_BIN" scripts/offline/reconcile-sentence-analyses.mjs \
    "$SOURCE" "$ANALYSIS_CACHE" "$RECONCILIATION" "$NEW_ANALYSIS"
fi
if [ ! -s "$RECONCILIATION/final-analysis.json" ]; then
  echo "Incremental sentence analysis reconciliation is incomplete" >&2
  exit 1
fi
MISSING_GRAMMAR_COUNT="$($NODE_BIN -e 'const v=JSON.parse(require("fs").readFileSync(process.argv[1])); console.log(v.entries.filter(entry => !entry.analysis?.grammar).length)' \
  "$RECONCILIATION/final-analysis.json")"
if [ "$MISSING_GRAMMAR_COUNT" -gt 0 ]; then
  log "generating local GPT-5.6 grammar analysis for $MISSING_GRAMMAR_COUNT example sentence(s)"
  GRAMMAR_ANALYSIS="$ROOT/grammar-analysis.json"
  env CODEX_CONCURRENCY="$GRAMMAR_CONCURRENCY" "$NODE_BIN" scripts/offline/enrich-sentence-grammar.mjs \
    "$SOURCE" "$RECONCILIATION/final-analysis.json" "$GRAMMAR_ANALYSIS" "$ROOT/grammar-work"
  cp "$GRAMMAR_ANALYSIS" "$RECONCILIATION/final-analysis.json.tmp"
  mv "$RECONCILIATION/final-analysis.json.tmp" "$RECONCILIATION/final-analysis.json"
fi
cp "$RECONCILIATION/final-analysis.json" "$ANALYSIS_CACHE.tmp"
mv "$ANALYSIS_CACHE.tmp" "$ANALYSIS_CACHE"
"$NODE_BIN" scripts/offline/verify-example-sentence-pool.mjs \
  "$SOURCE" "$RECONCILIATION/final-analysis.json"
log "publishing validated explanations before their images"
EXAMPLE_ANALYSIS_WAVE_STATE_ROOT="$ANALYSIS_PUBLISH_STATE" \
EXAMPLE_ANALYSIS_WAVE_COOLDOWN_SECONDS=30 GH_BIN="$GH_BIN" \
  scripts/offline/dispatch-staged-example-analyses.sh "$ROOT" 2000 "$REQUIRED_DEPLOY_SHA"

"$NODE_BIN" scripts/offline/prepare-sentence-images.mjs \
  "$SOURCE" "$RECONCILIATION/final-analysis.json" "$IMAGE_ROOT" baidu/ERNIE-Image-Turbo

BASE_EXPECTED="$($NODE_BIN -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1])).targets.length)' \
  "$BASE_IMAGE_ROOT/targets.json")"
BASE_ACCEPTED="$(find "$BASE_IMAGE_ROOT/images" -maxdepth 1 -type f -name '*.webp' 2>/dev/null | wc -l | tr -d ' ')"
if [ "$BASE_ACCEPTED" -lt "$BASE_EXPECTED" ] || \
    pgrep -f "run-streaming-image-quality-loop.sh $BASE_IMAGE_ROOT/targets.json" >/dev/null 2>&1; then
  log "bulk image pipeline is still active at $BASE_ACCEPTED/$BASE_EXPECTED; incremental images are queued"
  exit 0
fi

TARGET_FINGERPRINT="$($NODE_BIN -e 'const f=require("fs"),c=require("crypto");process.stdout.write(c.createHash("sha256").update(f.readFileSync(process.argv[1])).digest("hex").slice(0,16))' \
  "$IMAGE_ROOT/targets.json")"
log "generating and judging incremental example images locally"
env CODEX_CONCURRENCY="$IMAGE_QA_CONCURRENCY" IMAGE_MODEL=ernie-image-turbo \
  IMAGE_MODEL_QUANTIZE=8 KREA_SHARD_COUNT=1 \
  bash scripts/offline/run-streaming-image-quality-loop.sh \
  "$IMAGE_ROOT/targets.json" "$IMAGE_ROOT/candidates" "$IMAGE_ROOT/images" \
  "$IMAGE_ROOT/streaming-quality/$TARGET_FINGERPRINT" 1024 576 4 1 64

"$NODE_BIN" scripts/offline/verify-example-sentence-pool.mjs \
  "$SOURCE" "$RECONCILIATION/final-analysis.json" "$IMAGE_ROOT"
log "publishing verified incremental explanation-image pairs"
EXAMPLE_ENRICHMENT_WAVE_STATE_ROOT="$PUBLISH_STATE" \
EXAMPLE_ENRICHMENT_WAVE_COOLDOWN_SECONDS=30 GH_BIN="$GH_BIN" \
  scripts/offline/dispatch-staged-example-enrichments.sh "$ROOT" 100 "$REQUIRED_DEPLOY_SHA"
log "incremental example-enrichment cycle complete: $TOTAL_COUNT post-baseline sentence(s)"
