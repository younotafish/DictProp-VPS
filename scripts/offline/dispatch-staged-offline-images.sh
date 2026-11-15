#!/usr/bin/env bash
# Publishes locally generated item images, for saved words, phrases and sentences, to production in waves of
# BATCH_SIZE as accepted images come in.

set -euo pipefail

SOURCE_ROOT="${1:?Usage: dispatch-staged-offline-images.sh <image-root> [batch-size=100] [required-deploy-sha]}"
BATCH_SIZE="${2:-100}"
REQUIRED_DEPLOY_SHA="${3:-$(git rev-parse HEAD)}"
STATE_ROOT="${OFFLINE_IMAGE_WAVE_STATE_ROOT:-/tmp/dictprop-staged-offline-images}"
COOLDOWN_SECONDS="${OFFLINE_IMAGE_WAVE_COOLDOWN_SECONDS:-60}"
DISPATCH_WAIT_SECONDS="${DISPATCH_WAIT_DEADLINE_SECONDS:-86400}"

OFFLINE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$OFFLINE_DIR/wave-dispatch.sh"

accepted_count() {
  find "$SOURCE_ROOT/images" -maxdepth 1 -type f -name '*.webp' 2>/dev/null | wc -l | tr -d ' '
}

manifest_count() {
  if [ "$#" -eq 0 ]; then printf '0\n'; return; fi
  "$NODE_BIN" -e 'const fs=require("fs"); const ids=new Set(); for (const path of process.argv.slice(1)) { for (const entry of JSON.parse(fs.readFileSync(path,"utf8")).entries) ids.add(entry.imageId); } console.log(ids.size)' "$@"
}

if ! [[ "$BATCH_SIZE" =~ ^[0-9]+$ ]] || [ "$BATCH_SIZE" -lt 1 ]; then
  echo "Image batch size must be a positive integer" >&2
  exit 1
fi
require_positive_integer DISPATCH_WAIT_DEADLINE_SECONDS "$DISPATCH_WAIT_SECONDS"
require_positive_integer RELEASE_CREATE_ATTEMPTS "$RELEASE_CREATE_ATTEMPTS"
if [ ! -s "$SOURCE_ROOT/manifest.json" ]; then
  echo "Offline-image manifest is missing: $SOURCE_ROOT/manifest.json" >&2
  exit 1
fi
require_bridge_key

TOTAL_COUNT="$("$NODE_BIN" -e 'const fs=require("fs"); console.log(JSON.parse(fs.readFileSync(process.argv[1], "utf8")).entries.length)' "$SOURCE_ROOT/manifest.json")"
load_published_waves
WAIT_DEADLINE="$(deadline_after "$DISPATCH_WAIT_SECONDS")"

while :; do
  PUBLISHED_COUNT="$(manifest_count ${PUBLISHED_MANIFESTS[@]+"${PUBLISHED_MANIFESTS[@]}"})"
  if [ "$PUBLISHED_COUNT" -ge "$TOTAL_COUNT" ]; then
    log "all $TOTAL_COUNT item images are published"
    break
  fi

  ACCEPTED_COUNT="$(accepted_count)"
  READY_COUNT=$((ACCEPTED_COUNT - PUBLISHED_COUNT))
  if [ "$READY_COUNT" -lt "$BATCH_SIZE" ] && [ "$ACCEPTED_COUNT" -lt "$TOTAL_COUNT" ]; then
    log "$READY_COUNT unpublished images ready; waiting for batch size $BATCH_SIZE"
    wait_or_give_up "still waiting for a batch of $BATCH_SIZE unpublished images" 60
    continue
  fi

  open_wave "$((${#PUBLISHED_MANIFESTS[@]} + 1))"
  WAVE_COUNT="$(prepare_wave scripts/offline/prepare-offline-image-wave.mjs "$SOURCE_ROOT" "$WAVE_DIR" "$BATCH_SIZE")"
  if [ "$WAVE_COUNT" -eq 0 ]; then
    log "no unpublished verified images were found; retrying later"
    wait_or_give_up "still no unpublished verified images" 60
    continue
  fi
  verify_wave_images "staged offline images"

  # The vocab-images- prefix is the one the release sweep recognizes (bridge-leftovers.mjs).
  name_wave_release vocab-images
  # The archive is bound to this operation and release, so it decrypts for no other import.
  ARCHIVE="$WAVE_DIR/offline-images.enc"
  seal_wave "$ARCHIVE" --purpose "import:image-import:$RELEASE_TAG" manifest.json images
  ensure_release "Temporary encrypted item images $WAVE_NAME" \
    "Locally generated and strictly reviewed item images; removed after verified import."
  publish_wave "$ARCHIVE" offline-images.enc image-import
  WAIT_DEADLINE="$(deadline_after "$DISPATCH_WAIT_SECONDS")"
  cool_down_after_wave "$WAVE_COUNT new images"
done

printf '%s\n' "$PUBLISHED_COUNT" > "$STATE_ROOT/complete"
log "item image publication complete: $PUBLISHED_COUNT/$TOTAL_COUNT"
