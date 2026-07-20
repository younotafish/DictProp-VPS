#!/usr/bin/env bash

set -euo pipefail

POOL_ROOT="${1:-data/offline-backfill/example-sentence-pool}"
VOCAB_IMAGE_ROOT="${2:-data/offline-backfill/authoritative-vocab-images}"
ANALYSIS_CONCURRENCY="${ANALYSIS_CONCURRENCY:-8}"
IMAGE_QA_CONCURRENCY="${IMAGE_QA_CONCURRENCY:-32}"
EXAMPLE_IMAGE_MODEL="${EXAMPLE_IMAGE_MODEL:-ernie-image-turbo}"
EXAMPLE_IMAGE_MODEL_LABEL="${EXAMPLE_IMAGE_MODEL_LABEL:-baidu/ERNIE-Image-Turbo}"
EXAMPLE_IMAGE_QUANTIZE="${EXAMPLE_IMAGE_QUANTIZE:-8}"
EXAMPLE_IMAGE_WIDTH="${EXAMPLE_IMAGE_WIDTH:-1024}"
EXAMPLE_IMAGE_HEIGHT="${EXAMPLE_IMAGE_HEIGHT:-576}"
EXAMPLE_IMAGE_STEPS="${EXAMPLE_IMAGE_STEPS:-8}"
SOURCE="$POOL_ROOT/source.json"
PRELIMINARY_SOURCE="$POOL_ROOT/preliminary-source.json"
PRELIMINARY_ANALYSIS="$POOL_ROOT/preliminary-analysis.json"
ANALYSIS_WORK="$POOL_ROOT/analysis-work"
RECONCILIATION="$POOL_ROOT/final-reconciliation"
FINAL_ONLY_ANALYSIS="$POOL_ROOT/final-only-analysis.json"
FINAL_ONLY_WORK="$POOL_ROOT/final-only-analysis-work"
FINAL_IMAGES="$POOL_ROOT/final-images"
AMERICAN_STATUS_OVERRIDES="$POOL_ROOT/american-status-adjudication.json"
USAGE_ADJUDICATION="$POOL_ROOT/usage-adjudication.json"
USAGE_ADJUDICATION_WORK="$POOL_ROOT/usage-adjudication-final-work"
AMERICAN_STATUS_WORK="$POOL_ROOT/american-status-final-work"
ORIGINAL_FINAL_SOURCE="$POOL_ROOT/source-pre-usage-adjudication.json"
BASE_CORPUS_MANIFEST="${BASE_CORPUS_MANIFEST:-data/offline-backfill/final-reconciliation/authoritative-final-corpus-manifest.json}"
ADJUDICATED_CORPUS_MANIFEST="${ADJUDICATED_CORPUS_MANIFEST:-data/offline-backfill/final-reconciliation/usage-adjudicated-corpus-manifest.json}"
BASE_CORPUS_EXPORT="${BASE_CORPUS_EXPORT:-data/offline-backfill/final-reconciliation/final-live-with-audits.json}"
CORPUS_READY_MARKER="$POOL_ROOT/corpus-publication-ready"

log() {
  printf '[%s] %s\n' "$(date -u +%FT%TZ)" "$*"
}

retry() {
  local attempt=0
  until "$@"; do
    attempt=$((attempt + 1))
    log "command failed (attempt $attempt); retrying in 60s: $*" >&2
    sleep 60
  done
}

log "waiting for the complete preliminary GPT-5.6 analysis manifest"
while [ ! -s "$PRELIMINARY_ANALYSIS" ]; do sleep 60; done

log "auditing the complete preliminary analysis cache"
retry node scripts/offline/audit-sentence-analysis-cache.mjs \
  "$PRELIMINARY_SOURCE" \
  "$ANALYSIS_WORK" \
  "$POOL_ROOT/cache-audit-final.json"

if [ -s "$USAGE_ADJUDICATION" ] && [ -s "$ORIGINAL_FINAL_SOURCE" ]; then
  log "incrementally adjudicating newly detected American-English usage conflicts"
  retry env CODEX_CONCURRENCY="$ANALYSIS_CONCURRENCY" node scripts/offline/adjudicate-sentence-usage-discrepancies.mjs \
    "$POOL_ROOT/cache-audit-final.json" \
    "$USAGE_ADJUDICATION" \
    "$USAGE_ADJUDICATION_WORK" \
    "$USAGE_ADJUDICATION" \
    "$ORIGINAL_FINAL_SOURCE"
  retry node scripts/offline/apply-sentence-usage-adjudications.mjs \
    "$BASE_CORPUS_MANIFEST" \
    "$ORIGINAL_FINAL_SOURCE" \
    "$USAGE_ADJUDICATION" \
    "$ADJUDICATED_CORPUS_MANIFEST"
  retry node scripts/offline/build-example-sentence-pool.mjs \
    "$ADJUDICATED_CORPUS_MANIFEST" \
    "$SOURCE"

  log "incrementally adjudicating sentence-level American-English labels"
  retry env CODEX_CONCURRENCY="$ANALYSIS_CONCURRENCY" node scripts/offline/adjudicate-sentence-american-status.mjs \
    "$USAGE_ADJUDICATION" \
    "$SOURCE" \
    "$AMERICAN_STATUS_OVERRIDES" \
    "$AMERICAN_STATUS_WORK" \
    "$AMERICAN_STATUS_OVERRIDES"

  log "verifying regenerated metadata, protected examples, and adjudicated lexical identities"
  retry node scripts/offline/verify-regenerated-metadata.mjs \
    "$BASE_CORPUS_EXPORT" \
    "$ADJUDICATED_CORPUS_MANIFEST" \
    "$USAGE_ADJUDICATION"
  date -u +%FT%TZ > "$CORPUS_READY_MARKER"
  log "corpus metadata is verified and ready for staged publication"
fi

log "reconciling cached analyses against the final adjudicated sentence source"
retry node scripts/offline/reconcile-sentence-analyses.mjs \
  "$SOURCE" \
  "$PRELIMINARY_ANALYSIS" \
  "$RECONCILIATION"

MISSING_COUNT="$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1])).missing)' "$RECONCILIATION/report.json")"
if [ "$MISSING_COUNT" -gt 0 ]; then
  log "generating GPT-5.6 metadata for $MISSING_COUNT rewritten or newly added examples"
  retry env CODEX_CONCURRENCY="$ANALYSIS_CONCURRENCY" node scripts/offline/enrich-sentences.mjs \
    "$RECONCILIATION/missing-source.json" \
    "$FINAL_ONLY_ANALYSIS" \
    "$FINAL_ONLY_WORK"
  retry node scripts/offline/reconcile-sentence-analyses.mjs \
    "$SOURCE" \
    "$PRELIMINARY_ANALYSIS" \
    "$RECONCILIATION" \
    "$FINAL_ONLY_ANALYSIS"
fi

if [ ! -s "$RECONCILIATION/final-analysis.json" ]; then
  echo "Final example-sentence analysis was not produced" >&2
  exit 1
fi
if [ -s "$AMERICAN_STATUS_OVERRIDES" ]; then
  log "applying independently adjudicated American-English sentence labels"
  retry node scripts/offline/apply-sentence-analysis-overrides.mjs \
    "$RECONCILIATION/final-analysis.json" \
    "$AMERICAN_STATUS_OVERRIDES" \
    "$RECONCILIATION/final-analysis.json"
fi

log "preparing realistic image targets for the reconciled example pool"
retry node scripts/offline/prepare-sentence-images.mjs \
  "$SOURCE" \
  "$RECONCILIATION/final-analysis.json" \
  "$FINAL_IMAGES" \
  "$EXAMPLE_IMAGE_MODEL_LABEL"

EXPECTED_VOCAB="$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1])).targets.length)' "$VOCAB_IMAGE_ROOT/targets.json")"
log "metadata is ready; waiting for $EXPECTED_VOCAB authoritative vocabulary images"
while :; do
  ACTUAL_VOCAB="$(find "$VOCAB_IMAGE_ROOT/images" -maxdepth 1 -type f -name '*.webp' 2>/dev/null | wc -l | tr -d ' ')"
  [ "$ACTUAL_VOCAB" -eq "$EXPECTED_VOCAB" ] && break
  sleep 600
done

log "generating and strictly judging example-sentence images with $EXAMPLE_IMAGE_MODEL_LABEL"
retry env CODEX_CONCURRENCY="$IMAGE_QA_CONCURRENCY" \
  IMAGE_MODEL="$EXAMPLE_IMAGE_MODEL" IMAGE_MODEL_QUANTIZE="$EXAMPLE_IMAGE_QUANTIZE" \
  KREA_SHARD_COUNT=1 bash scripts/offline/run-streaming-image-quality-loop.sh \
  "$FINAL_IMAGES/targets.json" \
  "$FINAL_IMAGES/candidates" \
  "$FINAL_IMAGES/images" \
  "$FINAL_IMAGES/streaming-quality" \
  "$EXAMPLE_IMAGE_WIDTH" "$EXAMPLE_IMAGE_HEIGHT" "$EXAMPLE_IMAGE_STEPS" 1 64

EXPECTED="$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1])).targets.length)' "$FINAL_IMAGES/targets.json")"
ACTUAL="$(find "$FINAL_IMAGES/images" -maxdepth 1 -type f -name '*.webp' | wc -l | tr -d ' ')"
if [ "$ACTUAL" -ne "$EXPECTED" ]; then
  echo "Example-sentence image count mismatch: $ACTUAL/$EXPECTED" >&2
  exit 1
fi

retry node scripts/offline/verify-example-sentence-pool.mjs \
  "$SOURCE" \
  "$RECONCILIATION/final-analysis.json" \
  "$FINAL_IMAGES"
log "example-sentence enrichment pool verified: $ACTUAL/$EXPECTED"
