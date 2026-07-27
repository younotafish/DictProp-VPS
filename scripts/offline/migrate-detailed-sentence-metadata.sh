#!/usr/bin/env bash

set -euo pipefail

SAVED_SOURCE="${1:?Usage: migrate-detailed-sentence-metadata.sh <saved-sentence-source.json> <prepared-example-source.json> [output-directory] [saved-base-analysis.json] [example-base-analysis.json]}"
EXAMPLE_SOURCE="${2:?Usage: migrate-detailed-sentence-metadata.sh <saved-sentence-source.json> <prepared-example-source.json> [output-directory] [saved-base-analysis.json] [example-base-analysis.json]}"
OUTPUT_ROOT="${3:-data/offline-backfill/detailed-sentence-metadata}"
SAVED_BASE="${4:-}"
EXAMPLE_BASE="${5:-}"
MODEL="${CODEX_MODEL:-gpt-5.5}"

run_dataset() {
  local name="$1"
  local source="$2"
  local base="$3"
  local output_dir="$OUTPUT_ROOT/$name"
  local output="$output_dir/analysis.json"
  local work="$output_dir/work"
  local args=("$source" "$output" "$work")
  if [ -n "$base" ]; then args+=("$base"); fi

  mkdir -p "$output_dir"
  printf '[%s] generating %s detailed metadata with %s\n' "$(date -u +%FT%TZ)" "$name" "$MODEL" >&2
  CODEX_MODEL="$MODEL" node scripts/offline/enrich-sentences.mjs "${args[@]}"
}

run_dataset saved-sentences "$SAVED_SOURCE" "$SAVED_BASE"
run_dataset prepared-examples "$EXAMPLE_SOURCE" "$EXAMPLE_BASE"

cat <<EOF
Detailed sentence metadata is ready under $OUTPUT_ROOT.

Saved analysis manifest:
  $OUTPUT_ROOT/saved-sentences/analysis.json

Prepared-example analysis manifest:
  $OUTPUT_ROOT/prepared-examples/analysis.json

Generation is resumable from each work directory. Matching grammar from the optional base manifests
is preserved verbatim. The existing import paths replace only sentence analysis metadata and retain
sentence identity, SRS state, saved timestamps, images, vocabulary cards, and example provenance.
EOF
