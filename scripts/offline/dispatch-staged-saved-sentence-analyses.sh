#!/usr/bin/env bash
# Publishes detailed analyses of saved sentences to production in waves.

set -euo pipefail

ANALYSIS="${1:?Usage: dispatch-staged-saved-sentence-analyses.sh <analysis.json> [batch-size=5000] [required-deploy-sha]}"
BATCH_SIZE="${2:-5000}"
REQUIRED_DEPLOY_SHA="${3:-$(git rev-parse HEAD)}"
STATE_ROOT="${SAVED_SENTENCE_ANALYSIS_STATE_ROOT:-/tmp/dictprop-staged-saved-sentence-analyses}"
COOLDOWN_SECONDS="${SAVED_SENTENCE_ANALYSIS_COOLDOWN_SECONDS:-30}"

OFFLINE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$OFFLINE_DIR/wave-dispatch.sh"

manifest_count() {
  local analysis="$1"
  shift
  if [ "$#" -eq 0 ]; then printf '0\n'; return; fi
  # A publication older than the analysis manifest did not survive in production, so it does not count.
  "$NODE_BIN" -e 'const fs=require("fs"); const key=e=>`${e.id}\0${e.textHash}`; const analysis=JSON.parse(fs.readFileSync(process.argv[1])); const current=new Set(analysis.entries.map(key)); const published=new Set(); for(const path of process.argv.slice(2)){const manifest=JSON.parse(fs.readFileSync(path)); if(Number(manifest.generatedAt||0)<Number(analysis.generatedAt||0)) continue; for(const entry of manifest.entries) { const identity=key(entry); if(current.has(identity)) published.add(identity); }} console.log(published.size)' "$analysis" "$@"
}

if ! [[ "$BATCH_SIZE" =~ ^[0-9]+$ ]] || [ "$BATCH_SIZE" -lt 1 ] || [ "$BATCH_SIZE" -gt 5000 ]; then
  echo "Saved sentence analysis batch size must be between 1 and 5000" >&2
  exit 1
fi
require_positive_integer RELEASE_CREATE_ATTEMPTS "$RELEASE_CREATE_ATTEMPTS"
for required in "$ANALYSIS" "$KEY_FILE"; do
  if [ ! -s "$required" ]; then
    echo "Saved sentence analysis publication input is missing: $required" >&2
    exit 1
  fi
done

TOTAL_COUNT="$("$NODE_BIN" -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1])).entries.length)' "$ANALYSIS")"
load_published_waves

while :; do
  PUBLISHED_COUNT="$(manifest_count "$ANALYSIS" ${PUBLISHED_MANIFESTS[@]+"${PUBLISHED_MANIFESTS[@]}"})"
  if [ "$PUBLISHED_COUNT" -ge "$TOTAL_COUNT" ]; then
    date -u +%FT%TZ > "$STATE_ROOT/complete"
    log "saved sentence analysis publication complete: $PUBLISHED_COUNT/$TOTAL_COUNT"
    exit 0
  fi

  open_next_wave
  WAVE_COUNT="$(prepare_wave scripts/offline/prepare-saved-sentence-analysis-wave.mjs "$ANALYSIS" "$WAVE_DIR" "$BATCH_SIZE")"
  if [ "$WAVE_COUNT" -eq 0 ]; then
    discard_wave
    echo "No unpublished saved sentence analyses were found at $PUBLISHED_COUNT/$TOTAL_COUNT" >&2
    exit 1
  fi

  name_wave_release sentence-grammar
  # The archive is bound to this operation and release, so it decrypts for no other import.
  ARCHIVE="$WAVE_DIR/sentence-backfill.enc"
  seal_wave "$ARCHIVE" --purpose "import:import:$RELEASE_TAG" manifest.json
  ensure_release "Temporary encrypted saved sentence grammar $WAVE_NAME" \
    "Locally generated detailed sentence analyses; removed after import."
  publish_wave "$ARCHIVE" sentence-backfill.enc import
  cool_down_after_wave "$WAVE_COUNT analyses"
done
