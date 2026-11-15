#!/usr/bin/env bash
# Publishes completed corpus records, the cycle's advanced vocabulary metadata, to production in waves.

set -euo pipefail

SOURCE_MANIFEST="${1:?Usage: dispatch-staged-corpus-audit.sh <source-manifest.json> [batch-size=500] [required-deploy-sha]}"
BATCH_SIZE="${2:-500}"
REQUIRED_DEPLOY_SHA="${3:-$(git rev-parse HEAD)}"
STATE_ROOT="${CORPUS_AUDIT_WAVE_STATE_ROOT:-/tmp/dictprop-staged-corpus-audit}"
COOLDOWN_SECONDS="${CORPUS_AUDIT_WAVE_COOLDOWN_SECONDS:-120}"

OFFLINE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$OFFLINE_DIR/wave-dispatch.sh"

manifest_count() {
  if [ "$#" -eq 0 ]; then printf '0\n'; return; fi
  "$NODE_BIN" -e 'const fs=require("fs"); const ids=new Set(); for(const path of process.argv.slice(1)) for(const entry of JSON.parse(fs.readFileSync(path)).entries) ids.add(entry.id); console.log(ids.size)' "$@"
}

if ! [[ "$BATCH_SIZE" =~ ^[0-9]+$ ]] || [ "$BATCH_SIZE" -lt 1 ] || [ "$BATCH_SIZE" -gt 1000 ]; then
  echo "Corpus audit batch size must be between 1 and 1000" >&2
  exit 1
fi
require_positive_integer RELEASE_CREATE_ATTEMPTS "$RELEASE_CREATE_ATTEMPTS"
if [ ! -s "$SOURCE_MANIFEST" ]; then
  echo "Corpus audit source manifest is missing: $SOURCE_MANIFEST" >&2
  exit 1
fi
require_bridge_key

TOTAL_COUNT="$("$NODE_BIN" -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1])).entries.length)' "$SOURCE_MANIFEST")"
load_published_waves

while :; do
  PUBLISHED_COUNT="$(manifest_count ${PUBLISHED_MANIFESTS[@]+"${PUBLISHED_MANIFESTS[@]}"})"
  if [ "$PUBLISHED_COUNT" -ge "$TOTAL_COUNT" ]; then
    printf '%s\n' "$PUBLISHED_COUNT" > "$STATE_ROOT/complete"
    log "corpus metadata publication complete: $PUBLISHED_COUNT/$TOTAL_COUNT"
    exit 0
  fi

  open_next_wave
  WAVE_COUNT="$(prepare_wave scripts/offline/prepare-corpus-audit-wave.mjs "$SOURCE_MANIFEST" "$WAVE_DIR" "$BATCH_SIZE")"
  if [ "$WAVE_COUNT" -eq 0 ]; then
    discard_wave
    echo "No unpublished corpus records were found at $PUBLISHED_COUNT/$TOTAL_COUNT" >&2
    exit 1
  fi

  name_wave_release corpus-audit
  # The archive is bound to this operation and release, so it decrypts for no other import.
  ARCHIVE="$WAVE_DIR/corpus-audit.enc"
  seal_wave "$ARCHIVE" --purpose "import:corpus-import:$RELEASE_TAG" manifest.json
  ensure_release "Temporary encrypted corpus metadata $WAVE_NAME" \
    "Locally generated and verified advanced corpus metadata; removed after import."
  publish_wave "$ARCHIVE" corpus-audit.enc corpus-import
  cool_down_after_wave "$WAVE_COUNT records"
done
