#!/usr/bin/env bash
# Publishes example-sentence images with their analyses to production in waves of BATCH_SIZE, as accepted
# images come in. With ALLOW_DEFERRED_IMAGES=1, as in the cycle, image generation has finished, so it
# publishes the accepted images and is done.

set -euo pipefail

POOL_ROOT="${1:-data/offline-backfill/example-sentence-pool}"
BATCH_SIZE="${2:-100}"
REQUIRED_DEPLOY_SHA="${3:-$(git rev-parse HEAD)}"
# Publication can run for several days, so its completed-wave ledger must survive OS /tmp cleanup.
STATE_ROOT="${EXAMPLE_ENRICHMENT_WAVE_STATE_ROOT:-$POOL_ROOT/publish-state}"
COOLDOWN_SECONDS="${EXAMPLE_ENRICHMENT_WAVE_COOLDOWN_SECONDS:-60}"
DISPATCH_WAIT_SECONDS="${DISPATCH_WAIT_DEADLINE_SECONDS:-86400}"
SOURCE="$POOL_ROOT/source.json"
ANALYSIS="$POOL_ROOT/final-reconciliation/final-analysis.json"
IMAGE_ROOT="$POOL_ROOT/final-images"

OFFLINE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$OFFLINE_DIR/wave-dispatch.sh"

manifest_count() {
  local source="$1"
  shift
  if [ "$#" -eq 0 ]; then printf '0\n'; return; fi
  "$NODE_BIN" -e 'const fs=require("fs"); const source=JSON.parse(fs.readFileSync(process.argv[1])); const current=new Map(source.sentences.filter(entry => entry.hasImage !== true).map(entry => [entry.id, entry.textHash])); const ids=new Set(); for(const path of process.argv.slice(2)){const manifest=JSON.parse(fs.readFileSync(path)); if(Number(manifest.generatedAt||0)<Number(source.exportedAt||0)) continue; for(const entry of manifest.entries) if(typeof entry.imageFile === "string" && entry.imageFile && current.get(entry.id) === entry.textHash) ids.add(entry.id)} console.log(ids.size)' "$source" "$@"
}

# The accepted images ready to publish: those the image manifest lists for a sentence that production still lacks
# an image for, at the sentence's current text, whose file is inside IMAGE_ROOT and not empty. The wave preparer
# publishes from the same manifest, so an image it doesn't list could never go out.
accepted_count() {
  "$NODE_BIN" - "$SOURCE" "$IMAGE_ROOT" <<'NODE'
const fs = require('node:fs');
const path = require('node:path');

const [sourcePath, imageRoot] = process.argv.slice(2);
const source = JSON.parse(fs.readFileSync(sourcePath, 'utf8'));
const lacking = new Map(source.sentences.filter(entry => entry.hasImage !== true).map(entry => [entry.id, entry.textHash]));
const root = path.resolve(imageRoot);
const ready = new Set();
for (const entry of JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8')).entries) {
  if (typeof entry.imageFile !== 'string' || lacking.get(entry.id) !== entry.textHash) continue;
  const file = path.resolve(root, entry.imageFile);
  if (!file.startsWith(root + path.sep)) continue;
  try {
    if (fs.statSync(file).size > 0) ready.add(entry.id);
  } catch {
    // Not accepted yet, or deferred to a later cycle.
  }
}
console.log(ready.size);
NODE
}

if ! [[ "$BATCH_SIZE" =~ ^[0-9]+$ ]] || [ "$BATCH_SIZE" -lt 1 ] || [ "$BATCH_SIZE" -gt 500 ]; then
  echo "Example enrichment batch size must be between 1 and 500" >&2
  exit 1
fi
require_positive_integer DISPATCH_WAIT_DEADLINE_SECONDS "$DISPATCH_WAIT_SECONDS"
require_positive_integer RELEASE_CREATE_ATTEMPTS "$RELEASE_CREATE_ATTEMPTS"
require_bridge_key

WAIT_DEADLINE="$(deadline_after "$DISPATCH_WAIT_SECONDS")"
log "waiting for reconciled example-sentence metadata and image targets"
while [ ! -s "$SOURCE" ] || [ ! -s "$ANALYSIS" ] || [ ! -s "$IMAGE_ROOT/manifest.json" ]; do
  wait_or_give_up "still waiting for reconciled example-sentence metadata and image targets" 300
done
if [ "${ALLOW_DEFERRED_IMAGES:-0}" = 1 ]; then
  # Image generation has finished and deferred images wait for a later cycle, so only accepted ones remain.
  TOTAL_COUNT="$(accepted_count)"
else
  TOTAL_COUNT="$("$NODE_BIN" -e 'const x=JSON.parse(require("fs").readFileSync(process.argv[1])); console.log(x.sentences.filter(entry => entry.hasImage !== true).length)' "$SOURCE")"
fi
load_published_waves

while :; do
  PUBLISHED_COUNT="$(manifest_count "$SOURCE" ${PUBLISHED_MANIFESTS[@]+"${PUBLISHED_MANIFESTS[@]}"})"
  if [ "$PUBLISHED_COUNT" -ge "$TOTAL_COUNT" ]; then
    printf '%s\n' "$PUBLISHED_COUNT" > "$STATE_ROOT/complete"
    log "example-sentence enrichment publication complete: $PUBLISHED_COUNT/$TOTAL_COUNT"
    exit 0
  fi

  ACCEPTED_COUNT="$(accepted_count)"
  READY_COUNT=$((ACCEPTED_COUNT - PUBLISHED_COUNT))
  if [ "$READY_COUNT" -lt "$BATCH_SIZE" ] && [ "$ACCEPTED_COUNT" -lt "$TOTAL_COUNT" ]; then
    log "$READY_COUNT unpublished enrichments ready; waiting for batch size $BATCH_SIZE"
    wait_or_give_up "still waiting for a batch of $BATCH_SIZE unpublished enrichments" 60
    continue
  fi

  open_next_wave
  WAVE_COUNT="$(prepare_wave scripts/offline/prepare-example-enrichment-wave.mjs \
    "$SOURCE" "$ANALYSIS" "$IMAGE_ROOT" "$WAVE_DIR" "$BATCH_SIZE")"
  if [ "$WAVE_COUNT" -eq 0 ]; then
    discard_wave
    # With image generation finished, nothing will change while this waits.
    if [ "${ALLOW_DEFERRED_IMAGES:-0}" = 1 ]; then
      echo "No unpublished verified enrichments were found for $READY_COUNT accepted image(s) at $PUBLISHED_COUNT/$TOTAL_COUNT" >&2
      exit 1
    fi
    log "no unpublished verified enrichments were found; retrying later"
    wait_or_give_up "still no unpublished verified enrichments" 60
    continue
  fi
  verify_wave_images "staged example enrichments"

  name_wave_release example-enrichments
  # The archive is bound to this operation and release, so it decrypts for no other import.
  ARCHIVE="$WAVE_DIR/sentence-enrichments.enc"
  seal_wave "$ARCHIVE" --purpose "import:enrichment-import:$RELEASE_TAG" manifest.json images
  ensure_release "Temporary encrypted example enrichment $WAVE_NAME" \
    "Locally generated and verified example-sentence analysis and images; removed after import."
  publish_wave "$ARCHIVE" sentence-enrichments.enc enrichment-import
  WAIT_DEADLINE="$(deadline_after "$DISPATCH_WAIT_SECONDS")"
  cool_down_after_wave "$WAVE_COUNT enrichments"
done
