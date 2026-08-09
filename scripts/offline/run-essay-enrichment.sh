#!/usr/bin/env bash

set -euo pipefail

ESSAY_ID="${1:-}"
if [ -z "$ESSAY_ID" ]; then
  echo "Usage: run-essay-enrichment.sh <essay-id> [output-root]" >&2
  exit 2
fi

POOL_ROOT="${2:-data/offline-backfill/essays/$ESSAY_ID}"
SOURCE="$POOL_ROOT/source.json"
ANALYSIS="$POOL_ROOT/final-reconciliation/final-analysis.json"
ANALYSIS_WORK="$POOL_ROOT/analysis-work"
FINAL_IMAGES="$POOL_ROOT/final-images"
CODEX_MODEL="${CODEX_MODEL:-gpt-5.6-sol}"
CODEX_CONCURRENCY="${CODEX_CONCURRENCY:-8}"
IMAGE_QA_CONCURRENCY="${IMAGE_QA_CONCURRENCY:-16}"
IMAGE_WIDTH="${ESSAY_IMAGE_WIDTH:-768}"
IMAGE_HEIGHT="${ESSAY_IMAGE_HEIGHT:-432}"
IMAGE_STEPS="${ESSAY_IMAGE_STEPS:-6}"

mkdir -p "$POOL_ROOT/final-reconciliation"

node scripts/offline/build-essay-sentence-pool.mjs \
  content/essay-catalog.json "$SOURCE" "$ESSAY_ID"

env CODEX_MODEL="$CODEX_MODEL" CODEX_CONCURRENCY="$CODEX_CONCURRENCY" \
  node scripts/offline/enrich-sentences.mjs "$SOURCE" "$ANALYSIS" "$ANALYSIS_WORK"

node scripts/offline/prepare-sentence-images.mjs \
  "$SOURCE" "$ANALYSIS" "$FINAL_IMAGES" krea/Krea-2-Turbo

env CODEX_CONCURRENCY="$IMAGE_QA_CONCURRENCY" IMAGE_MODEL=krea2 KREA_QUANTIZE=8 \
  bash scripts/offline/run-streaming-image-quality-loop.sh \
    "$FINAL_IMAGES/targets.json" \
    "$FINAL_IMAGES/candidates" \
    "$FINAL_IMAGES/images" \
    "$FINAL_IMAGES/streaming-quality" \
    "$IMAGE_WIDTH" "$IMAGE_HEIGHT" "$IMAGE_STEPS" 1 64

node scripts/offline/verify-example-sentence-pool.mjs \
  "$SOURCE" "$ANALYSIS" "$FINAL_IMAGES"
