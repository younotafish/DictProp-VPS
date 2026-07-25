#!/usr/bin/env bash

set -euo pipefail

POOL_ROOT="${1:-data/offline-backfill/example-sentence-pool}"
BATCH_SIZE="${2:-100}"
REQUIRED_DEPLOY_SHA="${3:-$(git rev-parse HEAD)}"
GH_BIN="${GH_BIN:-./.gh}"
REPO="${GITHUB_REPOSITORY:-younotafish/DictProp-VPS}"
KEY_FILE="${SENTENCE_BRIDGE_KEY_FILE:-${XDG_CONFIG_HOME:-$HOME/.config}/dictprop/sentence_bridge_key}"
MFLUX_PYTHON="${DICTPROP_MFLUX_PYTHON:-${XDG_CACHE_HOME:-$HOME/.cache}/dictprop/mflux/bin/python}"
CANONICAL_MFLUX_PYTHON="$HOME/.cache/dictprop/mflux/bin/python"
PYTHON_BIN="${PYTHON_BIN:-$MFLUX_PYTHON}"
# Publication can run for several days, so its completed-wave ledger must survive OS /tmp cleanup.
STATE_ROOT="${EXAMPLE_ENRICHMENT_WAVE_STATE_ROOT:-$POOL_ROOT/publish-state}"
COOLDOWN_SECONDS="${EXAMPLE_ENRICHMENT_WAVE_COOLDOWN_SECONDS:-60}"
SOURCE="$POOL_ROOT/source.json"
ANALYSIS="$POOL_ROOT/final-reconciliation/final-analysis.json"
IMAGE_ROOT="$POOL_ROOT/final-images"

log() {
  printf '[%s] %s\n' "$(date -u +%FT%TZ)" "$*"
}

python_has_pillow() {
  [ -x "$1" ] && "$1" -c 'from PIL import Image' >/dev/null 2>&1
}

if ! python_has_pillow "$PYTHON_BIN"; then
  if python_has_pillow "$MFLUX_PYTHON"; then
    log "configured Python lacks Pillow; using mflux runtime: $MFLUX_PYTHON"
    PYTHON_BIN="$MFLUX_PYTHON"
  elif python_has_pillow "$CANONICAL_MFLUX_PYTHON"; then
    log "configured Python lacks Pillow; using canonical mflux runtime: $CANONICAL_MFLUX_PYTHON"
    PYTHON_BIN="$CANONICAL_MFLUX_PYTHON"
  else
    echo "Example enrichment validation requires a Python runtime with Pillow" >&2
    exit 1
  fi
fi

publisher_state_dir() {
  local tag="$1"
  local state_key
  state_key="$(printf '%s' "$tag" | tr -c 'A-Za-z0-9._-' '_')"
  printf '%s/dictprop-publish-%s\n' "${TMPDIR:-/tmp}" "$state_key"
}

manifest_count() {
  if [ "$#" -eq 0 ]; then printf '0\n'; return; fi
  node -e 'const fs=require("fs"); const ids=new Set(); for(const path of process.argv.slice(1)) for(const entry of JSON.parse(fs.readFileSync(path)).entries) ids.add(entry.id); console.log(ids.size)' "$@"
}

next_wave_number() {
  local next=1 wave_dir suffix number
  while IFS= read -r wave_dir; do
    suffix="${wave_dir##*/wave-}"
    number=$((10#$suffix))
    if [ "$number" -ge "$next" ]; then next=$((number + 1)); fi
  done < <(find "$STATE_ROOT" -mindepth 1 -maxdepth 1 -type d \
    -name 'wave-[0-9][0-9][0-9][0-9]' | sort)
  printf '%s\n' "$next"
}

if ! [[ "$BATCH_SIZE" =~ ^[0-9]+$ ]] || [ "$BATCH_SIZE" -lt 1 ] || [ "$BATCH_SIZE" -gt 500 ]; then
  echo "Example enrichment batch size must be between 1 and 500" >&2
  exit 1
fi
if [ ! -s "$KEY_FILE" ]; then
  echo "Sentence bridge key is missing: $KEY_FILE" >&2
  exit 1
fi

log "waiting for reconciled example-sentence metadata and image targets"
while [ ! -s "$SOURCE" ] || [ ! -s "$ANALYSIS" ] || [ ! -s "$IMAGE_ROOT/manifest.json" ]; do sleep 300; done
TOTAL_COUNT="$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1])).sentences.length)' "$SOURCE")"
mkdir -p "$STATE_ROOT"

# Recover a remotely completed wave after a local publisher restart.
while IFS= read -r tag_file; do
  wave_dir="$(dirname "$tag_file")"
  release_tag="$(tr -d '[:space:]' < "$tag_file")"
  publisher_state="$(publisher_state_dir "$release_tag")"
  if [ -s "$publisher_state/complete" ]; then cp "$publisher_state/complete" "$wave_dir/published"; fi
done < <(find "$STATE_ROOT" -mindepth 2 -maxdepth 2 -type f -name release-tag | sort)

PUBLISHED_MANIFESTS=()
while IFS= read -r manifest; do
  if [ -s "$(dirname "$manifest")/published" ]; then PUBLISHED_MANIFESTS+=("$manifest"); fi
done < <(find "$STATE_ROOT" -mindepth 2 -maxdepth 2 -type f -name manifest.json | sort)

while :; do
  if [ "${#PUBLISHED_MANIFESTS[@]}" -eq 0 ]; then PUBLISHED_COUNT=0
  else PUBLISHED_COUNT="$(manifest_count "${PUBLISHED_MANIFESTS[@]}")"; fi
  if [ "$PUBLISHED_COUNT" -ge "$TOTAL_COUNT" ]; then
    printf '%s\n' "$PUBLISHED_COUNT" > "$STATE_ROOT/complete"
    log "example-sentence enrichment publication complete: $PUBLISHED_COUNT/$TOTAL_COUNT"
    exit 0
  fi

  ACCEPTED_COUNT="$(find "$IMAGE_ROOT/images" -maxdepth 1 -type f -name '*.webp' 2>/dev/null | wc -l | tr -d ' ')"
  READY_COUNT=$((ACCEPTED_COUNT - PUBLISHED_COUNT))
  if [ "$READY_COUNT" -lt "$BATCH_SIZE" ] && [ "$ACCEPTED_COUNT" -lt "$TOTAL_COUNT" ]; then
    log "$READY_COUNT unpublished enrichments ready; waiting for batch size $BATCH_SIZE"
    sleep 60
    continue
  fi

  WAVE_NUMBER="$(next_wave_number)"
  WAVE_NAME="wave-$(printf '%04d' "$WAVE_NUMBER")"
  WAVE_DIR="$STATE_ROOT/$WAVE_NAME"
  mkdir -p "$WAVE_DIR"
  if [ "${#PUBLISHED_MANIFESTS[@]}" -eq 0 ]; then
    RESULT="$(node scripts/offline/prepare-example-enrichment-wave.mjs \
      "$SOURCE" "$ANALYSIS" "$IMAGE_ROOT" "$WAVE_DIR" "$BATCH_SIZE")"
  else
    RESULT="$(node scripts/offline/prepare-example-enrichment-wave.mjs \
      "$SOURCE" "$ANALYSIS" "$IMAGE_ROOT" "$WAVE_DIR" "$BATCH_SIZE" \
      "${PUBLISHED_MANIFESTS[@]}")"
  fi
  WAVE_COUNT="$(printf '%s' "$RESULT" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).waveEntries))')"
  if [ "$WAVE_COUNT" -eq 0 ]; then
    log "no unpublished verified enrichments were found; retrying later"
    sleep 60
    continue
  fi

  "$PYTHON_BIN" - "$WAVE_DIR" <<'PY'
import json
import sys
from pathlib import Path
from PIL import Image

root = Path(sys.argv[1])
entries = json.loads((root / 'manifest.json').read_text())['entries']
for entry in entries:
    image_path = root / entry['imageFile']
    with Image.open(image_path) as image:
        if image.size not in {(1024, 576), (768, 432)} or image.format != 'WEBP':
            raise RuntimeError(f'invalid enrichment image: {image_path} {image.size} {image.format}')
        image.verify()
print(f'Validated {len(entries)} staged example enrichments')
PY

  ARCHIVE="$WAVE_DIR/sentence-enrichments.enc"
  rm -f "$ARCHIVE"
  tar -czf - -C "$WAVE_DIR" manifest.json images \
    | openssl enc -aes-256-cbc -pbkdf2 -salt -pass "file:$KEY_FILE" -out "$ARCHIVE"

  TAG_FILE="$WAVE_DIR/release-tag"
  if [ ! -s "$TAG_FILE" ]; then
    printf 'example-enrichments-%s-%s\n' "$WAVE_NAME" "$(date -u +%Y%m%dT%H%M%SZ)" > "$TAG_FILE"
  fi
  RELEASE_TAG="$(tr -d '[:space:]' < "$TAG_FILE")"
  PUBLISHER_STATE="$(publisher_state_dir "$RELEASE_TAG")"
  if [ ! -s "$PUBLISHER_STATE/complete" ]; then
    until "$GH_BIN" release view "$RELEASE_TAG" --repo "$REPO" >/dev/null 2>&1 \
      || "$GH_BIN" release create "$RELEASE_TAG" --repo "$REPO" \
        --title "Temporary encrypted example enrichment $WAVE_NAME" \
        --notes "Locally generated and verified example-sentence analysis and images; removed after import." \
        --latest=false; do
      log "GitHub release creation unavailable for $WAVE_NAME; retrying later"
      sleep 300
    done
  fi

  scripts/offline/publish-backfill-release.sh \
    "$RELEASE_TAG" "$ARCHIVE" sentence-enrichments.enc enrichment-import "$REQUIRED_DEPLOY_SHA" 300
  date -u +%FT%TZ > "$WAVE_DIR/published"
  PUBLISHED_MANIFESTS+=("$WAVE_DIR/manifest.json")
  log "$WAVE_NAME published ($WAVE_COUNT enrichments); cooling down for ${COOLDOWN_SECONDS}s"
  sleep "$COOLDOWN_SECONDS"
done
