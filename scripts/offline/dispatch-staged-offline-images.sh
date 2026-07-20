#!/usr/bin/env bash

set -euo pipefail

SOURCE_ROOT="${1:-data/offline-backfill/authoritative-vocab-images}"
BATCH_SIZE="${2:-500}"
REQUIRED_DEPLOY_SHA="${3:-$(git rev-parse HEAD)}"
GH_BIN="${GH_BIN:-./.gh}"
REPO="${GITHUB_REPOSITORY:-younotafish/DictProp-VPS}"
KEY_FILE="${SENTENCE_BRIDGE_KEY_FILE:-/tmp/dictprop_sentence_bridge_key}"
STATE_ROOT="${OFFLINE_IMAGE_WAVE_STATE_ROOT:-/tmp/dictprop-staged-offline-images}"

log() {
  printf '[%s] %s\n' "$(date -u +%FT%TZ)" "$*"
}

accepted_count() {
  find "$SOURCE_ROOT/images" -maxdepth 1 -type f -name '*.webp' 2>/dev/null | wc -l | tr -d ' '
}

manifest_count() {
  if [ "$#" -eq 0 ]; then
    printf '0\n'
    return
  fi
  node -e 'const fs=require("fs"); const ids=new Set(); for (const path of process.argv.slice(1)) { for (const entry of JSON.parse(fs.readFileSync(path,"utf8")).entries) ids.add(entry.imageId); } console.log(ids.size)' "$@"
}

if ! [[ "$BATCH_SIZE" =~ ^[0-9]+$ ]] || [ "$BATCH_SIZE" -lt 1 ]; then
  echo "Image batch size must be a positive integer" >&2
  exit 1
fi
if [ ! -s "$SOURCE_ROOT/manifest.json" ]; then
  echo "Offline-image manifest is missing: $SOURCE_ROOT/manifest.json" >&2
  exit 1
fi
if [ ! -s "$KEY_FILE" ]; then
  echo "Sentence bridge key is missing: $KEY_FILE" >&2
  exit 1
fi

TOTAL_COUNT="$(node -e 'const fs=require("fs"); console.log(JSON.parse(fs.readFileSync(process.argv[1], "utf8")).entries.length)' "$SOURCE_ROOT/manifest.json")"
mkdir -p "$STATE_ROOT"

log "waiting for staged saved-sentence imports before publishing vocabulary images"
while pgrep -f '[d]ispatch-staged-sentence-backfill.sh' >/dev/null; do
  sleep 300
done

PUBLISHED_MANIFESTS=()
while IFS= read -r manifest; do
  if [ -s "$(dirname "$manifest")/published" ]; then
    PUBLISHED_MANIFESTS+=("$manifest")
  fi
done < <(find "$STATE_ROOT" -mindepth 2 -maxdepth 2 -type f -name manifest.json | sort)

while :; do
  if [ "${#PUBLISHED_MANIFESTS[@]}" -eq 0 ]; then
    PUBLISHED_COUNT=0
  else
    PUBLISHED_COUNT="$(manifest_count "${PUBLISHED_MANIFESTS[@]}")"
  fi
  if [ "$PUBLISHED_COUNT" -ge "$TOTAL_COUNT" ]; then
    log "all $TOTAL_COUNT authoritative vocabulary images are published"
    break
  fi

  ACCEPTED_COUNT="$(accepted_count)"
  READY_COUNT=$((ACCEPTED_COUNT - PUBLISHED_COUNT))
  if [ "$READY_COUNT" -lt "$BATCH_SIZE" ] && [ "$ACCEPTED_COUNT" -lt "$TOTAL_COUNT" ]; then
    log "$READY_COUNT unpublished images ready; waiting for batch size $BATCH_SIZE"
    sleep 300
    continue
  fi

  WAVE_NUMBER=$((${#PUBLISHED_MANIFESTS[@]} + 1))
  WAVE_NAME="wave-$(printf '%04d' "$WAVE_NUMBER")"
  WAVE_DIR="$STATE_ROOT/$WAVE_NAME"
  mkdir -p "$WAVE_DIR"
  if [ "${#PUBLISHED_MANIFESTS[@]}" -eq 0 ]; then
    RESULT="$(node scripts/offline/prepare-offline-image-wave.mjs \
      "$SOURCE_ROOT" \
      "$WAVE_DIR" \
      "$BATCH_SIZE")"
  else
    RESULT="$(node scripts/offline/prepare-offline-image-wave.mjs \
      "$SOURCE_ROOT" \
      "$WAVE_DIR" \
      "$BATCH_SIZE" \
      "${PUBLISHED_MANIFESTS[@]}")"
  fi
  WAVE_COUNT="$(printf '%s' "$RESULT" | node -e 'let s=""; process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).waveEntries))')"
  if [ "$WAVE_COUNT" -eq 0 ]; then
    log "no unpublished verified images were found; retrying later"
    sleep 300
    continue
  fi

  /tmp/dictprop-mflux/bin/python - "$WAVE_DIR" <<'PY'
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
            raise RuntimeError(f'invalid final image: {image_path} {image.size} {image.format}')
        image.verify()
print(f'Validated {len(entries)} staged offline images')
PY

  ARCHIVE="$WAVE_DIR/offline-images.enc"
  rm -f "$ARCHIVE"
  tar -czf - -C "$WAVE_DIR" manifest.json images \
    | openssl enc -aes-256-cbc -pbkdf2 -salt -pass "file:$KEY_FILE" -out "$ARCHIVE"

  TAG_FILE="$WAVE_DIR/release-tag"
  if [ ! -s "$TAG_FILE" ]; then
    printf 'vocab-images-%s-%s\n' "$WAVE_NAME" "$(date -u +%Y%m%dT%H%M%SZ)" > "$TAG_FILE"
  fi
  RELEASE_TAG="$(tr -d '[:space:]' < "$TAG_FILE")"
  until "$GH_BIN" release view "$RELEASE_TAG" --repo "$REPO" >/dev/null 2>&1 \
    || "$GH_BIN" release create "$RELEASE_TAG" \
      --repo "$REPO" \
      --title "Temporary encrypted vocabulary image $WAVE_NAME" \
      --notes "Locally generated and strictly reviewed vocabulary images; removed after verified import." \
      --latest=false; do
    log "GitHub release creation unavailable for $WAVE_NAME; retrying later"
    sleep 300
  done

  scripts/offline/publish-backfill-release.sh \
    "$RELEASE_TAG" \
    "$ARCHIVE" \
    offline-images.enc \
    image-import \
    "$REQUIRED_DEPLOY_SHA" \
    300
  date -u +%FT%TZ > "$WAVE_DIR/published"
  PUBLISHED_MANIFESTS+=("$WAVE_DIR/manifest.json")
  log "$WAVE_NAME published ($WAVE_COUNT new images)"
done
