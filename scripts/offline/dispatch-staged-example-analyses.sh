#!/usr/bin/env bash
# Publishes detailed analyses of the example sentences production lacks one for, in waves, ahead of their
# images.

set -euo pipefail

POOL_ROOT="${1:-data/offline-backfill/example-sentence-pool}"
BATCH_SIZE="${2:-2000}"
REQUIRED_DEPLOY_SHA="${3:-$(git rev-parse HEAD)}"
STATE_ROOT="${EXAMPLE_ANALYSIS_WAVE_STATE_ROOT:-/tmp/dictprop-staged-example-analyses}"
COOLDOWN_SECONDS="${EXAMPLE_ANALYSIS_WAVE_COOLDOWN_SECONDS:-30}"
SOURCE="$POOL_ROOT/source.json"
ANALYSIS="${EXAMPLE_ANALYSIS_MANIFEST:-$POOL_ROOT/final-reconciliation/final-analysis.json}"

OFFLINE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$OFFLINE_DIR/wave-dispatch.sh"

manifest_count() {
  local source="$1"
  shift
  if [ "$#" -eq 0 ]; then printf '0\n'; return; fi
  "$NODE_BIN" -e 'const fs=require("fs"); const source=JSON.parse(fs.readFileSync(process.argv[1])); const targets=new Set(source.sentences.filter(entry => entry.hasAnalysis !== true).map(entry => entry.id)); const ids=new Set(); for(const path of process.argv.slice(2)){const manifest=JSON.parse(fs.readFileSync(path)); if(Number(manifest.generatedAt||0)<Number(source.exportedAt||0)) continue; for(const entry of manifest.entries) if(targets.has(entry.id)) ids.add(entry.id)} console.log(ids.size)' "$source" "$@"
}

if ! [[ "$BATCH_SIZE" =~ ^[0-9]+$ ]] || [ "$BATCH_SIZE" -lt 1 ] || [ "$BATCH_SIZE" -gt 2000 ]; then
  echo "Example analysis batch size must be between 1 and 2000" >&2
  exit 1
fi
require_positive_integer RELEASE_CREATE_ATTEMPTS "$RELEASE_CREATE_ATTEMPTS"
for required in "$SOURCE" "$ANALYSIS" "$KEY_FILE"; do
  if [ ! -s "$required" ]; then
    echo "Example analysis publication input is missing: $required" >&2
    exit 1
  fi
done

TOTAL_COUNT="$("$NODE_BIN" -e 'const x=JSON.parse(require("fs").readFileSync(process.argv[1])); console.log(x.sentences.filter(entry => entry.hasAnalysis !== true).length)' "$SOURCE")"
load_published_waves

while :; do
  PUBLISHED_COUNT="$(manifest_count "$SOURCE" ${PUBLISHED_MANIFESTS[@]+"${PUBLISHED_MANIFESTS[@]}"})"
  if [ "$PUBLISHED_COUNT" -ge "$TOTAL_COUNT" ]; then
    printf '%s\n' "$PUBLISHED_COUNT" > "$STATE_ROOT/complete"
    log "example-sentence analysis publication complete: $PUBLISHED_COUNT/$TOTAL_COUNT"
    exit 0
  fi

  open_next_wave
  WAVE_COUNT="$(prepare_wave scripts/offline/prepare-example-analysis-wave.mjs "$SOURCE" "$ANALYSIS" "$WAVE_DIR" "$BATCH_SIZE")"
  if [ "$WAVE_COUNT" -eq 0 ]; then
    discard_wave
    echo "No unpublished analyses were found at $PUBLISHED_COUNT/$TOTAL_COUNT" >&2
    exit 1
  fi

  name_wave_release example-analyses
  # The archive is bound to this operation and release, so it decrypts for no other import.
  ARCHIVE="$WAVE_DIR/sentence-enrichments.enc"
  seal_wave "$ARCHIVE" --purpose "import:enrichment-import:$RELEASE_TAG" manifest.json
  ensure_release "Temporary encrypted example analyses $WAVE_NAME" \
    "Locally generated and verified example-sentence analyses; removed after import."
  publish_wave "$ARCHIVE" sentence-enrichments.enc enrichment-import
  cool_down_after_wave "$WAVE_COUNT analyses"
done
